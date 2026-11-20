import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { getDb, closeDb } from '../src/db/index.js';
import { startLlmStub } from './harness/llmStub.js';
import { getProgramDateKey, getProgramNow } from '../src/services/programTime.js';
import { invalidateCache } from '../src/services/scheduleManager.js';

test('全员睡眠时延期且不花模型请求，醒来后刊出文字', async t => {
  const db = getDb();
  t.after(closeDb);
  const stub = await startLlmStub(t, [{ text: JSON.stringify({ news: [{ title: '合成新闻', content: '今天河边开了花。', image_prompt: '' }], character_event: { title: '合成特稿', content: '测试角色在河边散步。', note: '记得带相机。', image_prompt: '' }, world_state: null }) }]);
  Object.assign(config.llm, { baseURL: stub.url, apiKey: 'fixture-key', model: 'fixture-model', freeEgg: false, connectionType: 'openai', headers: {}, extraBody: {} });
  config.comfyui.url = 'http://127.0.0.1:9';
  const { generateDailyNewspaper, pickFeaturedCharacter } = await import('../src/services/newspaperService.js');
  db.prepare('UPDATE characters SET events_disabled=1').run();
  const id = db.prepare("INSERT INTO characters(name,display_name,base_prompt,short_prompt,is_system,is_sleeping,sleep_until,events_disabled,moments_disabled) VALUES('paper','日报样本','','',0,1,datetime('now','+30 minutes'),0,0)").run().lastInsertRowid;
  db.prepare('INSERT INTO daily_schedules(character_id,schedule_date,schedule_json) VALUES(?,?,?)')
    .run(id, getProgramDateKey(getProgramNow()), JSON.stringify([{ startTime: '00:00', endTime: '23:59', activity: '睡觉', replyDelay: -1 }]));
  await assert.rejects(generateDailyNewspaper(), { code: 'NEWSPAPER_PUBLISH_DEFERRED' });
  assert.equal(stub.requests.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM town_newspapers').get().n, 0);
  db.prepare('UPDATE characters SET is_sleeping=0,sleep_until=NULL WHERE id=?').run(id);
  db.prepare("UPDATE daily_schedules SET schedule_json='[]' WHERE character_id=?").run(id);
  invalidateCache(id);
  assert.equal(pickFeaturedCharacter(db).id, id);
  const row = await generateDailyNewspaper();
  assert.equal(row.character_id, id);
  assert.match(row.character_event_json, /合成特稿/);
  assert.equal(stub.requests.length, 1);
});
