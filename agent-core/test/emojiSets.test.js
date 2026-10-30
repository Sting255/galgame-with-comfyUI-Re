import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('network forbidden in emoji tests'); };
const {
  createEmojiSet, activateEmojiSet, setEmojiSetEnabled, deleteEmojiSet,
  listEmojiSets, getCharacterEmojiMap, parseEmojiText, parseGroupEmojiText,
} = await import('../src/services/emojiService.js');

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE emoji_sets (
      id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL, name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE character_emojis (
      id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL,
      set_id INTEGER REFERENCES emoji_sets(id) ON DELETE CASCADE,
      emoji_key TEXT, image_path TEXT, status TEXT, UNIQUE(set_id, emoji_key)
    );
  `);
  const sets = ['A', 'B', 'C'].map(name => {
    const set = createEmojiSet(1, name, db);
    return setEmojiSetEnabled(set.id, false, db);
  });
  const add = (set, key, status = 'done', url = `/${set.name}-${key}.png`, characterId = set.character_id) => {
    db.prepare('INSERT INTO character_emojis (character_id, set_id, emoji_key, image_path, status) VALUES (?, ?, ?, ?, ?)')
      .run(characterId, set.id, key, url, status);
  };
  for (const set of sets) for (const key of ['开心', '悲伤', '卖萌', '震惊']) add(set, key);
  return { db, sets, add };
}

test('新建套装默认启用，已有套装的启用和停用状态保持不变', t => {
  const { db, sets } = fixture(t);
  activateEmojiSet(sets[0].id, db);
  const created = createEmojiSet(1, '新套装', db);
  assert.equal(created.is_active, 1);
  assert.deepEqual(listEmojiSets(1, db).filter(s => s.is_active).map(s => s.name), ['A', '新套装']);
  assert.deepEqual(listEmojiSets(1, db).filter(s => !s.is_active).map(s => s.name), ['B', 'C']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM character_emojis WHERE set_id = ?').get(created.id).count, 0);
  assert.deepEqual([...getCharacterEmojiMap(1, db).values()], ['开心', '悲伤', '卖萌', '震惊'].map(key => `/A-${key}.png`));
});

test('套装可独立启用与停用，重复设置幂等，允许全部取消', t => {
  const { db, sets } = fixture(t);
  for (const set of sets) activateEmojiSet(set.id, db);
  activateEmojiSet(sets[0].id, db);
  assert.equal(listEmojiSets(1, db).filter(s => s.is_active).length, 3);
  setEmojiSetEnabled(sets[1].id, false, db);
  assert.deepEqual(listEmojiSets(1, db).filter(s => s.is_active).map(s => s.name), ['A', 'C']);
  assert.throws(() => setEmojiSetEnabled(sets[0].id, 'false', db), /布尔值/);
  assert.equal(setEmojiSetEnabled(999, true, db), null);
  for (const set of sets) setEmojiSetEnabled(set.id, false, db);
  assert.equal(getCharacterEmojiMap(1, db).size, 0);
});

test('勾选 AB 时各类别独立随机，C 不会入选；同轮重复解析保持相同图片', t => {
  const { db, sets } = fixture(t);
  activateEmojiSet(sets[0].id, db);
  activateEmojiSet(sets[1].id, db);
  const draws = [0, 0.99, 0, 0.99];
  const map = getCharacterEmojiMap(1, db, () => draws.shift());
  assert.equal(map.get('开心'), '/A-开心.png');
  assert.equal(map.get('悲伤'), '/B-悲伤.png');
  const streamed = parseEmojiText('[开心]你好[悲伤]', map);
  assert.deepEqual(streamed.images, ['/A-开心.png', '/B-悲伤.png']);
  assert.deepEqual(parseEmojiText('[开心]你好[悲伤]', map), streamed);
  assert.deepEqual(parseGroupEmojiText('[开心]你好[悲伤]', map, ['开心', '悲伤']), { ...streamed, invalidEmoji: false });
  assert.equal(getCharacterEmojiMap(1, db, () => 0.99).get('开心'), '/B-开心.png', '下一轮可以抽到另一套同名表情');
});

test('勾选 ABC 可混用 A 开心、B 悲伤、C 卖萌和 A 震惊', t => {
  const { db, sets } = fixture(t);
  for (const set of sets) activateEmojiSet(set.id, db);
  const draws = [0, 0.5, 0.99, 0];
  const map = getCharacterEmojiMap(1, db, () => draws.shift());
  assert.deepEqual(parseEmojiText('[开心][悲伤][卖萌][震惊]', map).images,
    ['/A-开心.png', '/B-悲伤.png', '/C-卖萌.png', '/A-震惊.png']);
});

test('缺失、未完成、空白图片和其他角色套装不参与随机，类别取已选套装并集', t => {
  const { db, sets, add } = fixture(t);
  for (const set of sets) activateEmojiSet(set.id, db);
  db.prepare("UPDATE character_emojis SET status = 'failed' WHERE set_id = ?").run(sets[0].id);
  db.prepare("UPDATE character_emojis SET image_path = ' ' WHERE set_id = ?").run(sets[1].id);
  db.prepare('DELETE FROM character_emojis WHERE set_id = ?').run(sets[2].id);
  add(sets[2], '开心');
  add(sets[2], '悲伤', 'generating');
  add(sets[2], '卖萌', 'done', null);
  const foreign = createEmojiSet(2, '其他角色', db);
  activateEmojiSet(foreign.id, db);
  add(foreign, '震惊');
  add(foreign, '损坏归属', 'done', '/foreign.png', 1);
  const map = getCharacterEmojiMap(1, db, () => 0.99);
  assert.deepEqual([...map], [['开心', '/C-开心.png']]);
  assert.equal(parseGroupEmojiText('[悲伤]', map, ['悲伤']).invalidEmoji, true);
});

test('删除已选套装保留其余选择，不自动启用未选套装，已解析消息保持原 URL', t => {
  const { db, sets } = fixture(t);
  activateEmojiSet(sets[0].id, db);
  activateEmojiSet(sets[1].id, db);
  const sent = parseEmojiText('[开心]', getCharacterEmojiMap(1, db, () => 0));
  deleteEmojiSet(sets[0].id, db);
  assert.deepEqual(listEmojiSets(1, db).filter(s => s.is_active).map(s => s.name), ['B']);
  assert.deepEqual(sent.images, ['/A-开心.png']);
  deleteEmojiSet(sets[1].id, db);
  assert.equal(getCharacterEmojiMap(1, db).size, 0);
  assert.equal(listEmojiSets(1, db)[0].is_active, 0);
});
