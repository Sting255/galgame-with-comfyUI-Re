import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../config.js');
config.dbPath = ':memory:';
config.llm.freeEgg = false;
config.llm.apiKey = 'test-only';
config.llm.baseURL = 'http://127.0.0.1:9';
config.features.town = false;
config.features.serializeBackgroundLLM = false;
const { resetClient } = await import('../llm/llm-client.js');
resetClient();
const { getDb, closeDb } = await import('../db/index.js');
const { default: router } = await import('../routes/moments.js');
afterEach(closeDb);

function seedCharacter() {
  const db = getDb();
  return Number(db.prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES ('test', '测试角色', '喜欢散步')").run().lastInsertRowid);
}

function generate(body) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    router.handle({ method: 'POST', url: '/generate', body }, res, err => err ? reject(err) : resolve(null));
  });
}

test('指定话题：参数错误或条目已删除时拒绝发送，不创建帖子或改变调度', async () => {
  const characterId = seedCharacter();
  const db = getDb();
  db.prepare("UPDATE characters SET next_moment_at = '2030-01-01 00:00:00' WHERE id = ?").run(characterId);
  const deletedId = Number(db.prepare("INSERT INTO moment_topics (name, source, is_active) VALUES ('已删除测试话题', 'custom', 0)").run().lastInsertRowid);
  for (const id of [0, -1, 1.5, '', '1', {}, []]) {
    assert.equal((await generate({ character_id: characterId, topic_id: id })).status, 400);
  }
  for (const id of [deletedId, 999999]) {
    assert.equal((await generate({ character_id: characterId, topic_id: id })).status, 404);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM moment_posts').get().n, 0);
  assert.equal(db.prepare('SELECT next_moment_at FROM characters WHERE id = ?').get(characterId).next_moment_at, '2030-01-01 00:00:00');
});

test('指定话题：未勾选、同名不同来源和空描述均按所选 id 进入生成提示词', async t => {
  const characterId = seedCharacter();
  const db = getDb();
  db.prepare("INSERT INTO moment_topics (name, desc, source) VALUES ('同名测试', '不应选到的系统描述', 'default')").run();
  const topicId = Number(db.prepare("INSERT INTO moment_topics (name, desc, source, checked) VALUES ('同名测试', '指定的雨后花园', 'custom', 0)").run().lastInsertRowid);
  const emptyId = Number(db.prepare("INSERT INTO moment_topics (name, desc, source) VALUES ('仅名称话题', '', 'custom')").run().lastInsertRowid);
  const requests = [];
  // 在真正的 LLM 边界截获请求后终止，不调用网络、生图或发布真实内容。
  t.mock.method(OpenAI.Chat.Completions.prototype, 'create', async params => {
    requests.push(structuredClone(params));
    throw Object.assign(new Error('TEST_PROMPT_CAPTURED'), { status: 400 });
  });
  t.mock.method(Math, 'random', () => 0.5);
  const firstRequestOf = [];
  for (const [id, name, desc] of [[topicId, '同名测试', '指定的雨后花园'], [emptyId, '仅名称话题', '仅名称话题']]) {
    const start = requests.length;
    const result = await generate({ character_id: characterId, topic_id: id });
    assert.equal(result.payload.error, 'TEST_PROMPT_CAPTURED');
    firstRequestOf.push(start);
    const { messages } = requests[start];
    const selected = messages.find(m => m.content.startsWith('【用户指定的朋友圈话题】'));
    assert.equal(selected.role, 'system');
    assert.ok(selected.content.includes(`名称：${name}\n描述：${desc}`));
    assert.equal(messages.at(-1).role, 'user');
    assert.match(messages.at(-1).content, /围绕用户指定话题/);
    assert.ok(!messages.at(-1).content.includes('【此刻正在做】'));
    assert.ok(!JSON.stringify(messages).includes('不应选到的系统描述'));
    const post = db.prepare('SELECT style, status FROM moment_posts ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual(post, { style: name, status: 'failed' });
  }
  // 每次生成最多两次请求：首次 + 网关 400 降级重试；重试必须去掉可选参数。
  assert.equal(requests.length, 2 * firstRequestOf.length);
  for (const start of firstRequestOf) {
    assert.ok(Object.hasOwn(requests[start], 'thinking') || Object.hasOwn(requests[start], 'reasoning_effort'));
    assert.ok(!Object.hasOwn(requests[start + 1], 'thinking'));
    assert.ok(!Object.hasOwn(requests[start + 1], 'reasoning_effort'));
  }
  // 不同指定话题保持前面的任务和人格层稳定，话题只出现在变量尾层。
  assert.deepEqual(requests[firstRequestOf[0]].messages.slice(0, 3), requests[firstRequestOf[1]].messages.slice(0, 3));
});
