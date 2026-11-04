import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'Asia/Shanghai';
const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
config.llm.freeEgg = false;
config.llm._model = 'queue-test';
config.llm._apiKey = 'test-key';
config.features.serializeBackgroundLLM = false;
const { getDb, closeDb } = await import('../src/db/index.js');
const { processWakeUp } = await import('../src/services/wakeService.js');
const { processReplyQueue, buildDelayedReplyContext } = await import('../src/services/replyQueueScheduler.js');
const { toSqlUtc } = await import('../src/services/programTime.js');
let reply = '我醒了，早上好。';
let onRequest = () => {};
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    await onRequest();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
server.unref();
config.llm._baseURL = `http://127.0.0.1:${server.address().port}/v1`;
after(() => { server.closeAllConnections(); server.close(); closeDb(); });

function seed() {
  const db = getDb();
  db.exec('DELETE FROM reply_queue');
  reply = '我醒了，早上好。';
  onRequest = () => {};
  const id = Number(db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run(`queue-${Date.now()}-${Math.random()}`, '测试角色', '喜欢散步。').lastInsertRowid);
  const add = (status = 'waiting') => Number(db.prepare(`INSERT INTO reply_queue
    (character_id, conversation_id, user_raw_msg_id, user_msg_id, user_content, scheduled_reply_at, delay_minutes, status)
    VALUES (?, ?, 1, 1, '早上好', datetime('now'), -1, ?)`).run(id, `char_${id}`, status).lastInsertRowid);
  return { db, id, add };
}

test('叫醒空白回复恢复自己的队列，保留其它 processing 批次', async () => {
  const { db, id, add } = seed();
  const ownedElsewhere = add('processing'), ownedHere = add();
  reply = '   ';
  await assert.rejects(processWakeUp(id, 'phone'), /Empty reply/);
  assert.equal(db.prepare('SELECT status FROM reply_queue WHERE id = ?').get(ownedElsewhere).status, 'processing');
  const row = db.prepare('SELECT *, scheduled_reply_at > datetime(\'now\') AS deferred FROM reply_queue WHERE id = ?').get(ownedHere);
  assert.equal(row.status, 'waiting');
  assert.equal(row.deferred, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(`char_${id}`).n, 0);
});

test('叫醒成功只完成已认领条目，生成中新增消息保持 waiting', async () => {
  const { db, id, add } = seed();
  const other = add('processing'), own = add();
  let later;
  onRequest = () => { later = add(); };
  await processWakeUp(id, 'door');
  assert.equal(db.prepare('SELECT * FROM reply_queue WHERE id = ?').get(own), undefined);
  assert.equal(db.prepare('SELECT status FROM reply_queue WHERE id = ?').get(other).status, 'processing');
  assert.equal(db.prepare('SELECT status FROM reply_queue WHERE id = ?').get(later).status, 'waiting');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(`char_${id}`).n, 1);
});

for (const mode of ['wake', 'scheduler']) {
  test(`${mode} 写入气泡失败会回滚正文并恢复 waiting，可重试成功`, async () => {
    const { db, id, add } = seed();
    const own = add();
    db.exec("CREATE TEMP TRIGGER reject_reply BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    try {
      if (mode === 'wake') await assert.rejects(processWakeUp(id, 'phone'), /test write failure/);
      else await processReplyQueue();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(`char_${id}`).n, 0);
      assert.equal(db.prepare('SELECT status FROM reply_queue WHERE id = ?').get(own).status, 'waiting');
    } finally { db.exec('DROP TRIGGER reject_reply'); }
    db.prepare("UPDATE reply_queue SET scheduled_reply_at = datetime('now') WHERE id = ?").run(own);
    if (mode === 'wake') await processWakeUp(id, 'phone');
    else await processReplyQueue();
    assert.equal(db.prepare('SELECT * FROM reply_queue WHERE id = ?').get(own), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(`char_${id}`).n, 1);
  });
}

test('上海时区延迟上下文按 UTC 计算收到消息与预定起床时间', () => {
  const { db, id, add } = seed();
  const queueId = add();
  const entry = { ...db.prepare('SELECT * FROM reply_queue WHERE id = ?').get(queueId),
    display_name: '测试角色', base_prompt: '喜欢散步。',
    created_at: toSqlUtc(Date.now() - 3600_000), scheduled_reply_at: toSqlUtc(Date.now() - 60_000) };
  const text = buildDelayedReplyContext(entry, [entry], true).map(m => m.content).join('\n');
  assert.match(text, /1 小时前/);
  assert.doesNotMatch(text, /9 小时前/);
  assert.doesNotMatch(text, /已经起床/);
});
