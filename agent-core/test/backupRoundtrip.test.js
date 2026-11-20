import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { config } from '../src/config.js';
import { getDb, closeDb } from '../src/db/index.js';
import { createBackup, importBackup, collectCounts } from '../src/services/dataBackup.js';

test('备份往返保留合成数据与资产、默认清除凭据、更高版本导入不改当前库', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'linshe-backup-test-'));
  const originalDb = config.dbPath;
  const originalData = process.env.LINSHE_DATA_DIR;
  const originalEnv = process.env.LINSHE_ENV_PATH;
  t.after(async () => {
    closeDb(); config.dbPath = originalDb;
    if (originalData === undefined) delete process.env.LINSHE_DATA_DIR; else process.env.LINSHE_DATA_DIR = originalData;
    if (originalEnv === undefined) delete process.env.LINSHE_ENV_PATH; else process.env.LINSHE_ENV_PATH = originalEnv;
    await fs.rm(temp, { recursive: true, force: true });
  });
  const rootsFor = name => {
    const agentCoreDir = path.join(temp, name, 'agent-core');
    const dataDir = path.join(agentCoreDir, 'data');
    return { agentCoreDir, dataDir, dbPath: path.join(dataDir, 'agent.db'), envPath: path.join(agentCoreDir, '.env'), audioDir: null };
  };
  const use = async roots => {
    closeDb(); config.dbPath = roots.dbPath;
    process.env.LINSHE_DATA_DIR = roots.dataDir; process.env.LINSHE_ENV_PATH = roots.envPath;
    await fs.mkdir(roots.dataDir, { recursive: true });
    return getDb();
  };
  const source = rootsFor('source');
  let db = await use(source);
  const id = db.prepare("INSERT INTO characters(name,display_name,base_prompt,short_prompt) VALUES('fixture','备份样本','人格','短人格')").run().lastInsertRowid;
  db.prepare("INSERT INTO raw_messages(conversation_id,role,content) VALUES(?,'user','合成聊天')").run(`char_${id}`);
  db.prepare("INSERT INTO messages(conversation_id,role,content,images,seq) VALUES(?,'user','合成聊天',?,0)").run(`char_${id}`, '["/images/chat/fixture.png"]');
  const put = db.prepare('INSERT OR REPLACE INTO system_settings(setting_key,setting_value) VALUES(?,?)');
  put.run('llm_profiles', JSON.stringify([{ id: 'test', apiKey: 'fixture-llm-secret', baseURL: 'http://127.0.0.1:9/v1', model: 'fixture' }]));
  put.run('tts_api_key', 'fixture-tts-secret');
  put.run('maibot_webui_token', 'fixture-admin-secret');
  await fs.mkdir(path.join(source.dataDir, 'images', 'chat'), { recursive: true });
  await fs.writeFile(path.join(source.dataDir, 'images', 'chat', 'fixture.png'), 'synthetic image bytes');
  await fs.writeFile(source.envPath, 'LLM_API_KEY=fixture-env-secret\n');
  const expected = collectCounts(db);
  const exported = await createBackup({ roots: source, outDir: temp });
  t.after(exported.cleanup);
  const archive = gunzipSync(await fs.readFile(exported.file));
  for (const secret of ['fixture-llm-secret', 'fixture-tts-secret', 'fixture-admin-secret', 'fixture-env-secret']) {
    assert.equal(archive.includes(Buffer.from(secret)), false, '脱敏归档不应含合成凭据');
  }
  assert.equal(archive.includes(Buffer.from('config/.env')), false);
  assert.equal(db.prepare("SELECT setting_value FROM system_settings WHERE setting_key='tts_api_key'").pluck().get(), 'fixture-tts-secret');
  const target = rootsFor('target');
  await use(target);
  const restored = await importBackup(exported.file, { roots: target });
  db = getDb();
  assert.deepEqual(restored.restored.counts, expected);
  assert.equal(await fs.readFile(path.join(target.dataDir, 'images', 'chat', 'fixture.png'), 'utf8'), 'synthetic image bytes');
  assert.equal(db.prepare("SELECT setting_value FROM system_settings WHERE setting_key='tts_api_key'").pluck().get(), '');
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.prepare("UPDATE system_settings SET setting_value='9.9.9' WHERE setting_key='app_release_version'").run();
  const future = await createBackup({ roots: target, outDir: temp });
  t.after(future.cleanup);
  db.prepare("UPDATE system_settings SET setting_value='4.5.0' WHERE setting_key='app_release_version'").run();
  const before = db.serialize();
  await assert.rejects(importBackup(future.file, { roots: target }), /备份|版本|导入/);
  assert.deepEqual(getDb().serialize(), before);
});
