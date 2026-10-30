import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../db/index.js');
const router = (await import('../routes/library.js')).default;
afterEach(closeDb);

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    router.handle({ method, url, body }, res, err => err ? reject(err) : resolve(null));
  });
}

function seed(name, source) {
  return Number(getDb().prepare('INSERT INTO moment_topics (name, source) VALUES (?, ?)').run(name, source).lastInsertRowid);
}

test('自定义话题允许与系统话题同名，同来源重复仍返回 409', async () => {
  seed('同名测试话题', 'default');
  const created = await call('POST', '/topics', { name: '同名测试话题', desc: '自定义内容' });
  assert.equal(created.status, 200);
  assert.equal(created.payload.name, '同名测试话题');
  assert.equal(created.payload.source, 'custom');
  assert.equal((await call('POST', '/topics', { name: '同名测试话题' })).status, 409);
});

for (const source of ['default', 'custom']) {
  test(`话题编辑按原来源判重，并允许跨来源同名：${source}`, async () => {
    const id = seed('待编辑话题', source);
    const opposite = seed('目标话题', source === 'default' ? 'custom' : 'default');
    seed('同来源已用话题', source);
    const renamed = await call('PUT', `/topics/${id}`, { name: '目标话题', source: 'ignored' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.payload.name, '目标话题');
    assert.equal(renamed.payload.source, source);
    for (const topicId of [id, opposite]) {
      const edited = await call('PUT', `/topics/${topicId}`, { desc: '修改描述', checked: false });
      assert.equal(edited.status, 200);
      const row = getDb().prepare('SELECT desc, checked FROM moment_topics WHERE id = ?').get(topicId);
      assert.deepEqual(row, { desc: '修改描述', checked: 0 });
    }
    assert.equal((await call('PUT', `/topics/${id}`, { name: '同来源已用话题' })).status, 409);
  });
}

test('批量保存只给自定义来源内的重复名称加后缀', async () => {
  seed('批量同名话题', 'default');
  const result = await call('POST', '/topics/save-batch', {
    items: [{ name: '批量同名话题' }, { name: '批量同名话题' }],
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.errors, []);
  assert.deepEqual(result.payload.saved.map(row => row.name), ['批量同名话题', '批量同名话题_1']);
  const again = await call('POST', '/topics/save-batch', { items: [{ name: '批量同名话题' }] });
  assert.equal(again.payload.saved[0].name, '批量同名话题_2');
});
