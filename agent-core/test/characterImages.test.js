import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { collectCharacterImageUrls } = await import('../src/services/characterImages.js');
const db = getDb();
after(closeDb);
afterEach(() => {
  db.prepare('DELETE FROM image_tasks').run();
  db.prepare('DELETE FROM characters').run();
});

function character(name = 'test') {
  return Number(db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run(name, name, 'test persona').lastInsertRowid);
}

function standing(id, scene, url, time = '2026-10-11 01:00:00') {
  db.prepare('INSERT INTO character_standings(character_id, scene, image_url, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, scene, url, time);
}

test('recent images include existing default and outfit images without image task records', () => {
  const id = character();
  standing(id, 'work', '/images/standing/default.png');
  standing(id, 'casual', '/images/standing/casual.png', '2026-10-11 02:00:00');
  standing(id, 'home', '/images/standing/upload.png', '2026-10-11 03:00:00');
  standing(character('other'), 'work', '/images/standing/other.png');
  assert.deepEqual(collectCharacterImageUrls(String(id)), [
    '/images/standing/upload.png', '/images/standing/casual.png', '/images/standing/default.png',
  ]);
  assert.deepEqual(collectCharacterImageUrls(id, { limit: 1 }), ['/images/standing/upload.png']);
});

test('scene images are deduplicated against task records and the legacy default image', () => {
  const id = character();
  const url = '/images/standing/shared.png';
  standing(id, 'work', url);
  standing(id, 'casual', url);
  db.prepare('UPDATE characters SET standing_url = ?, avatar_path = ? WHERE id = ?')
    .run(url, '/avatars/avatar.png', id);
  db.prepare("INSERT INTO image_tasks(conversation_id, prompt_original, status, output_paths) VALUES (?, ?, 'done', ?)")
    .run(`char_${id}_standing`, 'test', JSON.stringify([url]));
  assert.deepEqual(collectCharacterImageUrls(id), [url, '/avatars/avatar.png']);
});

test('empty scene slots keep the legacy default available and removed images disappear', () => {
  const id = character();
  standing(id, 'work', null);
  standing(id, 'casual', '');
  standing(id, 'home', '/images/standing/home.png');
  db.prepare('UPDATE characters SET standing_url = ? WHERE id = ?').run('/images/standing/legacy.png', id);
  assert.deepEqual(collectCharacterImageUrls(id), ['/images/standing/home.png', '/images/standing/legacy.png']);
  db.prepare("DELETE FROM character_standings WHERE character_id = ? AND scene = 'home'").run(id);
  assert.deepEqual(collectCharacterImageUrls(id), ['/images/standing/legacy.png']);
});

test('uploaded chat and galgame backgrounds are included in the matching character gallery', () => {
  const id = character();
  db.prepare('UPDATE characters SET chat_bg_path=?, galgame_bg_path=? WHERE id=?')
    .run('/images/chatbg/chat.jpg', '/images/chatbg/stage.jpg', id);
  const other = character('other');
  db.prepare('UPDATE characters SET galgame_bg_path=? WHERE id=?').run('/images/chatbg/other.jpg', other);
  assert.deepEqual(collectCharacterImageUrls(id), ['/images/chatbg/chat.jpg', '/images/chatbg/stage.jpg']);
});
