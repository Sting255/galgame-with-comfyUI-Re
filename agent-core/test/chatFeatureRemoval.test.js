import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const chatRouter = (await import('../src/routes/chat.js')).default;
const relationshipRouter = (await import('../src/routes/relationships.js')).default;

function call(router, method, url, body = {}, query = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    router.handle({ method, url, body, query }, res, err => err ? reject(err) : resolve(null));
  });
}

test('聊天上传入口已移除，只发图片或空白消息不会进入聊天生成链路', async () => {
  assert.equal(await call(chatRouter, 'POST', '/chat/upload-image', { base64: 'data:image/png;base64,AAAA' }), null);
  for (const message of [undefined, '', '   ', 123]) {
    const result = await call(chatRouter, 'POST', '/characters/1/chat', { message, images: ['/images/chat/old.png'] });
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'message is required');
  }
});

test('角色关系查询只返回角色之间的边，用户关系资料仍保留', async t => {
  const db = getDb();
  t.after(closeDb);
  const insert = db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)');
  const a = Number(insert.run('graph_a', '甲', '测试').lastInsertRowid);
  const b = Number(insert.run('graph_b', '乙', '测试').lastInsertRowid);
  db.prepare('INSERT INTO character_relationships (from_character_id, to_character_id, relationship_text) VALUES (?, ?, ?)').run(a, b, '朋友');
  db.prepare('INSERT INTO user_relationships (character_id, relationship_text) VALUES (?, ?)').run(a, '同学');
  const result = await call(relationshipRouter, 'GET', '/', {}, { character_id: a });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.payload), ['relationships']);
  assert.equal(result.payload.relationships.length, 1);
  assert.equal(result.payload.relationships[0].to_character_id, b);
  assert.equal('intimacy' in result.payload.relationships[0], false);
  assert.equal(db.prepare('SELECT relationship_text FROM user_relationships WHERE character_id = ?').get(a).relationship_text, '同学');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'user_emojis'").get(), undefined);
});

for (const legacySchema of [false, true]) {
  test(`关系增改查不再使用亲密度（${legacySchema ? '已有旧列' : '新数据库'}）`, async t => {
    const db = getDb();
    t.after(closeDb);
    if (legacySchema) db.exec('ALTER TABLE character_relationships ADD COLUMN intimacy INTEGER');
    const insert = db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)');
    const a = Number(insert.run('rel_a', '甲', '测试').lastInsertRowid);
    const b = Number(insert.run('rel_b', '乙', '测试').lastInsertRowid);
    const created = await call(relationshipRouter, 'POST', '/', {
      from_character_id: a, to_character_id: b, relationship_text: '同事', intimacy: 3,
    });
    assert.equal(created.status, 201);
    const row = db.prepare('SELECT * FROM character_relationships WHERE from_character_id = ?').get(a);
    if (legacySchema) {
      assert.equal(row.intimacy, null);
      db.prepare('UPDATE character_relationships SET intimacy = 3 WHERE id = ?').run(row.id);
    }
    const updated = await call(relationshipRouter, 'PUT', `/${row.id}`, { relationship_text: '不是恋人，只是同事', intimacy: 0 });
    assert.equal(updated.status, 200);
    const listed = await call(relationshipRouter, 'GET', '/', {}, { character_id: a });
    assert.equal(listed.payload.relationships[0].relationship_text, '不是恋人，只是同事');
    assert.equal('intimacy' in listed.payload.relationships[0], false);
    if (legacySchema) assert.equal(db.prepare('SELECT intimacy FROM character_relationships WHERE id = ?').get(row.id).intimacy, 3);
  });
}
