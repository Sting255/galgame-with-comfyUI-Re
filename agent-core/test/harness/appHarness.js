import express from 'express';
import { once } from 'node:events';
import { config } from '../../src/config.js';
import { getDb, closeDb } from '../../src/db/index.js';
import { startLlmStub } from './llmStub.js';

/** 仅加载被测路由，使用内存库和随机回环端口；不启动 app.js 的后台任务。 */
export async function appHarness(t, responses = [], { groups = false, moments = false } = {}) {
  const db = getDb();
  if (db.name !== ':memory:') throw new Error('路由测试只能使用内存库');
  const stub = await startLlmStub(t, responses);
  Object.assign(config.llm, { baseURL: stub.url, apiKey: 'fixture-key', model: 'fixture-model',
    connectionType: 'openai', freeEgg: false, headers: {}, extraBody: {}, maxTokens: 2048 });
  for (const key of Object.keys(config.features)) if (typeof config.features[key] === 'boolean') config.features[key] = false;
  config.features.groupChat = true;
  config.comfyui.url = 'http://127.0.0.1:9';
  if (config.vector) config.vector.url = 'http://127.0.0.1:9';
  const app = express();
  app.use(express.json());
  const { default: router } = await import(groups ? '../../src/routes/groups.js' : moments ? '../../src/routes/moments.js' : '../../src/routes/chat.js');
  app.use(groups ? '/api/groups' : moments ? '/api/moments' : '/api', router);
  app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); closeDb(); });
  return { db, stub, url: `http://127.0.0.1:${server.address().port}`,
    async post(path, body, options = {}) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), ...options });
      return { status: res.status, text: await res.text() };
    },
    character(name) {
      return db.prepare('INSERT INTO characters(name,display_name,base_prompt,short_prompt) VALUES(?,?,?,?)').run(name, name, '合成测试人格', '合成测试人格').lastInsertRowid;
    },
  };
}
