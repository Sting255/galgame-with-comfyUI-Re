import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createCharacterBackgroundRouter } from '../src/routes/characterBackgrounds.js';
import { buildDialogueBackgroundMessages } from '../src/services/dialogueBackground.js';
import { migrateChatBgSchema } from '../src/db/index.js';

const IMAGE = 'data:image/png;base64,aGVsbG8=';
function call(router, url, body) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { resolve({ status: this.statusCode, payload }); } };
    router.handle({ method: 'POST', url, body }, res, err => err ? reject(err) : resolve(null));
  });
}

function fixture(t, generateBackground = async () => ({ base64: IMAGE, prompt: 'scene', promptRefined: 'scene', workflow: 'base' })) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE characters(id INTEGER PRIMARY KEY, chat_bg_path TEXT);
    INSERT INTO characters VALUES (1, '/images/chatbg/existing.png'), (2, '/images/chatbg/other.png');
    CREATE TABLE image_tasks(conversation_id TEXT, prompt_original TEXT, prompt_refined TEXT, status TEXT, output_paths TEXT, workflow_template TEXT, finished_at TEXT);`);
  migrateChatBgSchema(db); migrateChatBgSchema(db);
  t.after(() => db.close());
  const saved = [], deleted = [];
  const router = createCharacterBackgroundRouter({ getDb: () => db, saveBase64Image: (category, name) => { const url = `/images/${category}/${name}`; saved.push(url); return url; }, deleteImageFileByUrl: url => deleted.push(url), invalidateGalleryCache() {}, generateBackground });
  return { db, router, saved, deleted };
}

test('background migration, upload and reset keep chat and galgame slots independent', async t => {
  const { db, router, deleted } = fixture(t);
  const upload = await call(router, '/1/chat-bg', { base64: IMAGE, target: 'galgame' });
  assert.equal(upload.status, 200);
  assert.match(upload.payload.galgame_bg_path, /^\/images\/chatbg\/galgamebg_1_/);
  assert.equal(upload.payload.characterId, 1);
  assert.equal(db.prepare('SELECT chat_bg_path FROM characters WHERE id=1').get().chat_bg_path, '/images/chatbg/existing.png');
  const reset = await call(router, '/1/chat-bg', { base64: '', target: 'galgame' });
  assert.equal(reset.payload.galgame_bg_path, null);
  assert.deepEqual(deleted, []);
  const legacy = await call(router, '/1/chat-bg', { base64: IMAGE });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.payload.target, 'chat');
  assert.deepEqual(deleted, ['/images/chatbg/existing.png']);
  assert.equal(db.prepare('SELECT chat_bg_path FROM characters WHERE id=2').get().chat_bg_path, '/images/chatbg/other.png');
});

test('generation persists its result and task, while invalid requests leave existing backgrounds untouched', async t => {
  const { db, router, saved } = fixture(t);
  assert.equal((await call(router, '/1/chat-bg', { base64: IMAGE, target: '__proto__' })).status, 400);
  assert.equal((await call(router, '/1/chat-bg', { base64: 'not an image', target: 'galgame' })).status, 400);
  assert.equal((await call(router, '/999/chat-bg', { base64: IMAGE })).status, 404);
  assert.equal(saved.length, 0);
  const generated = await call(router, '/1/generate-chat-bg', { requirement: '黄昏的花园' });
  assert.equal(generated.status, 200);
  assert.equal(db.prepare('SELECT galgame_bg_path FROM characters WHERE id=1').get().galgame_bg_path, generated.payload.galgame_bg_path);
  assert.equal(db.prepare('SELECT conversation_id FROM image_tasks').get().conversation_id, 'char_1_galgamebg');
});

test('preview generation keeps both backgrounds until a crop is explicitly saved', async t => {
  const { db, router, deleted } = fixture(t);
  db.prepare('UPDATE characters SET galgame_bg_path=? WHERE id=1').run('/images/chatbg/old-stage.png');
  const preview = await call(router, '/1/generate-chat-bg', { previewOnly: true });
  assert.equal(preview.status, 200);
  assert.ok(preview.payload.imageUrl);
  assert.equal(preview.payload.galgame_bg_path, undefined);
  assert.deepEqual(db.prepare('SELECT chat_bg_path, galgame_bg_path FROM characters WHERE id=1').get(), { chat_bg_path: '/images/chatbg/existing.png', galgame_bg_path: '/images/chatbg/old-stage.png' });
  assert.equal(db.prepare('SELECT output_paths FROM image_tasks').get().output_paths, JSON.stringify([preview.payload.imageUrl]));
  assert.deepEqual(deleted, []);
  const saved = await call(router, '/1/chat-bg', { target: 'galgame', base64: IMAGE });
  assert.equal(db.prepare('SELECT galgame_bg_path FROM characters WHERE id=1').get().galgame_bg_path, saved.payload.galgame_bg_path);
});

test('a failing generation preserves the old image and prevents competing writes until it completes', async t => {
  let finish;
  const { db, router, saved } = fixture(t, () => new Promise((resolve, reject) => { finish = () => reject(new Error('生成失败')); }));
  db.prepare('UPDATE characters SET galgame_bg_path=? WHERE id=1').run('/images/chatbg/old-stage.png');
  const generation = call(router, '/1/generate-chat-bg', {});
  assert.equal((await call(router, '/1/chat-bg', { target: 'galgame', base64: '' })).status, 409);
  finish();
  assert.equal((await generation).status, 500);
  assert.equal(db.prepare('SELECT galgame_bg_path FROM characters WHERE id=1').get().galgame_bg_path, '/images/chatbg/old-stage.png');
  assert.equal(saved.length, 0);
  assert.equal((await call(router, '/1/chat-bg', { target: 'galgame', base64: '' })).status, 200);
});

test('background prompts keep a stable prefix before persona and user requirements', () => {
  const base = { systemRules: 'rules and world', worldRule: 'world integration', persona: 'character A', requirement: '花园' };
  const a = buildDialogueBackgroundMessages(base);
  const b = buildDialogueBackgroundMessages({ ...base, persona: 'character B', requirement: '书房' });
  assert.deepEqual(a.slice(0, 3), b.slice(0, 3));
  assert.match(a[2].content, /不画人物/);
  assert.match(a[3].content, /character A/);
  assert.equal(a.at(-1).role, 'user');
  assert.match(a.at(-1).content, /花园/);
  assert.equal(buildDialogueBackgroundMessages({ ...base, worldRule: '' }).length, 4);
});
