import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateMediaAvatarLibrary } from '../src/db/mediaAvatarSchema.js';

const temporary = mkdtempSync(path.join(tmpdir(), 'media-avatar-test-'));
process.env.DB_PATH = path.join(temporary, 'test.db');
process.env.IMAGES_DIR = path.join(temporary, 'images');
const requests = [];
let response;
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://avatar-test.invalid/v1/chat/completions');
  requests.push(JSON.parse(options.body));
  const content = typeof response === 'function' ? response(requests.at(-1)) : response;
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
};
await import('openai/shims/web');
const { getDb, closeDb } = await import('../src/db/index.js');
const { config } = await import('../src/config.js');
const { designMediaAvatars, normalizeAvatarPrompts, MEDIA_AVATAR_PROMPT } = await import('../src/services/mediaAvatarDesigner.js');
const { createMediaAvatarLibrary } = await import('../src/services/mediaAvatarLibrary.js');
const { listPosts } = await import('../src/services/mediaService.js');
let db = getDb();
config.llm.freeEgg = false;
config.llm._baseURL = 'https://avatar-test.invalid/v1';
config.llm._apiKey = 'test-only';
after(() => { closeDb(); rmSync(temporary, { recursive: true, force: true }); });
const prompts = Array.from({ length: 10 }, (_, i) => `A distinct square illustration of subject ${i + 1}, vivid composition, no text`);
const dependencies = {
  database: () => db, design: async () => prompts, snapshot: () => ({}),
  generate: async () => ({ success: true, images: [{ base64: 'image' }] }),
  save: (_category, name) => `https://test.invalid/${name}`, invalidate: () => {}, notify: () => {},
};

test('designer returns ten unnamed prompts with stable prefix and no concrete scene examples', async () => {
  response = JSON.stringify({ prompts });
  assert.deepEqual(await designMediaAvatars(), prompts);
  assert.deepEqual(await designMediaAvatars('可爱植物'), prompts);
  assert.deepEqual(requests[0].messages.slice(0, -1), requests[1].messages.slice(0, -1));
  assert.equal(requests[0].messages.at(-2).content, MEDIA_AVATAR_PROMPT);
  assert.doesNotMatch(MEDIA_AVATAR_PROMPT, /两张|两次|两遍|"title"|撞镜橘子|倒挂山谷/);
  assert.equal(requests[0].messages.at(-1).content, '设计10套头像提示词，按指定JSON结构输出。');
  assert.match(requests[1].messages.at(-1).content, /可爱植物/);
  assert.throws(() => normalizeAvatarPrompts({ prompts: prompts.slice(1) }), /10套/);
  assert.throws(() => normalizeAvatarPrompts({ prompts: Array(10).fill(prompts[0]) }), /重复/);
  assert.throws(() => normalizeAvatarPrompts({ prompts: prompts.map(prompt => ({ title: '旧名称', prompt })) }), /格式/);
  assert.throws(() => normalizeAvatarPrompts({ prompts: prompts.map(() => '') }), /格式/);
  assert.throws(() => normalizeAvatarPrompts({ prompts }, 10, [prompts[0]]), /重复/);
  let attempts = 0;
  response = () => ++attempts === 1 ? '{invalid' : JSON.stringify({ prompts: prompts.slice(0, 3) });
  assert.deepEqual(await designMediaAvatars('', 3, ['An earlier scene']), prompts.slice(0, 3));
  assert.equal(attempts, 2);
  assert.match(requests.at(-1).messages.at(-2).content, /An earlier scene/);
  assert.match(requests.at(-1).messages.at(-1).content, /设计3套.*\n上次输出校验失败/);
  response = 'not json';
  const before = requests.length;
  await assert.rejects(designMediaAvatars(), /JSON/);
  assert.equal(requests.length - before, 2);
});

test('calls ComfyUI once per prompt, keeps successful images, and stores no task history or names', async () => {
  let designs = 0;
  const seen = [];
  const events = [];
  const beforeTasks = db.prepare('SELECT COUNT(*) AS n FROM image_tasks').get().n;
  const library = createMediaAvatarLibrary({
    ...dependencies,
    design: async direction => { designs++; assert.equal(direction, '小动物'); return prompts; },
    generate: async (prompt, opts) => {
      seen.push(prompt);
      assert.equal(opts.imageProvider, 'comfyui');
      assert.equal(opts.priority, 'high');
      assert.equal(opts.alreadyPrepared, true);
      assert.equal(opts.width, opts.height);
      assert.equal(opts.artist, '@custom_artist');
      if (seen.length === 3) throw new Error('GPU offline');
      if (seen.length === 6) return { success: false, error: 'No output' };
      return { success: true, images: [{ base64: 'image' }] };
    },
    notify: (type, data) => events.push({ type, data }),
  });
  assert.equal(library.list().artist, '@ebora');
  assert.throws(() => library.start(42), /方向/);
  assert.throws(() => library.start('', 42), /画师串/);
  assert.throws(() => library.start('', 'a'.repeat(2001)), /画师串/);
  for (const count of [9, 51, 10.5, '10', null, NaN]) {
    assert.throws(() => library.start('', '@ebora', count), error => error.statusCode === 400);
  }
  assert.deepEqual(library.start('  小动物  ', ' @custom_artist '), { started: true });
  assert.equal(library.list().artist, '@custom_artist');
  assert.equal(library.list().busy, true);
  assert.equal(library.list().progress.stage, 'designing');
  assert.throws(() => library.start(), error => error.statusCode === 409);
  await library.wait();
  assert.equal(designs, 1);
  assert.deepEqual(seen, prompts);
  assert.equal(library.list().busy, false);
  assert.deepEqual(library.list().progress, { stage: 'failed', total: 10, completed: 8, failed: 2, error: 'No output' });
  assert.equal(library.list().avatars.length, 8);
  assert.ok(library.list().avatars.every(a => Object.keys(a).sort().join(',') === 'id,image'));
  assert.equal('batches' in library.list(), false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'media_avatar_batches'").get(), undefined);
  assert.deepEqual(db.prepare('PRAGMA table_info(media_avatars)').all().map(c => c.name), ['id', 'image', 'enabled']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_tasks').get().n, beforeTasks);
  assert.equal(events.at(-1).type, 'media_avatars_updated');
});

test('polling returns current progress, and a new task replaces it instead of accumulating history', async () => {
  let resume;
  let startedImage;
  const imageStarted = new Promise(resolve => { startedImage = resolve; });
  const blocked = new Promise(resolve => { resume = resolve; });
  let calls = 0;
  const library = createMediaAvatarLibrary({ ...dependencies, generate: async () => {
    if (++calls === 2) { startedImage(); await blocked; }
    return { success: true, images: [{ base64: 'image' }] };
  } });
  library.start();
  await imageStarted;
  assert.equal(library.list().progress.completed, 1);
  assert.equal(library.list().progress.stage, 'generating');
  const copy = library.list().progress;
  copy.completed = 100;
  assert.equal(library.list().progress.completed, 1);
  resume();
  await library.wait();
  assert.equal(library.list().progress.completed, 10);
  assert.equal(library.list().progress.stage, 'done');
  library.start();
  assert.equal(library.list().progress.completed, 0);
  await library.wait();
  assert.equal(calls, 20);
  assert.equal(library.list().progress.completed, 10);
  assert.equal(createMediaAvatarLibrary(dependencies).list().progress, null);
});

test('50 avatars use five design batches and remainder batches generate exactly the requested count', async () => {
  for (const total of [50, 23, 11]) {
    const sizes = [];
    const seen = [];
    const library = createMediaAvatarLibrary({ ...dependencies,
      design: async (direction, count, previous) => {
        assert.equal(direction, '自由发挥');
        assert.deepEqual(previous, seen);
        sizes.push(count);
        return Array.from({ length: count }, (_, i) => `Unique composition ${previous.length + i}`);
      },
      generate: async prompt => {
        seen.push(prompt);
        assert.equal(library.list().progress.total, total);
        return { success: true, images: [{ base64: 'image' }] };
      },
    });
    library.start('自由发挥', '@ebora', total);
    await library.wait();
    assert.deepEqual(sizes, total === 50 ? [10, 10, 10, 10, 10] : total === 23 ? [10, 10, 3] : [10, 1]);
    assert.equal(seen.length, total);
    assert.deepEqual(library.list().progress, { stage: 'done', total, completed: total, failed: 0, error: null });
  }
});

test('failed design batches preserve earlier images and allow later batches to finish', async () => {
  let batch = 0;
  let generated = 0;
  const library = createMediaAvatarLibrary({ ...dependencies,
    design: async (_direction, count, previous) => {
      if (++batch === 2) throw new Error('Invalid batch JSON');
      if (batch === 3) assert.equal(previous.length, 10);
      return Array.from({ length: count }, (_, i) => `Batch ${batch} subject ${i}`);
    },
    generate: async () => { generated++; return { success: true, images: [{ base64: 'image' }] }; },
  });
  library.start('', '@ebora', 23);
  await library.wait();
  assert.equal(batch, 3);
  assert.equal(generated, 13);
  assert.deepEqual(library.list().progress, { stage: 'failed', total: 23, completed: 13, failed: 10, error: 'Invalid batch JSON' });
});

test('shared avatars lose all NPC bindings on removal and are reassigned on next appearance', () => {
  const outlet = db.prepare("INSERT INTO media_outlets (name, prompt, layout) VALUES ('头像测试媒体', 'test', 'feed')").run().lastInsertRowid;
  const otherOutlet = db.prepare("INSERT INTO media_outlets (name, prompt, layout) VALUES ('另一媒体', 'test', 'feed')").run().lastInsertRowid;
  db.prepare('UPDATE media_avatars SET enabled = 0').run();
  const first = 'https://test.invalid/shared.png';
  const firstId = db.prepare('INSERT INTO media_avatars (image) VALUES (?)').run(first).lastInsertRowid;
  const library = createMediaAvatarLibrary(dependencies);
  assert.equal(library.resolve(outlet, '小路人'), first);
  assert.equal(library.resolve(outlet, '另一个路人'), first);
  assert.equal(library.resolve(otherOutlet, '小路人'), first);
  const second = 'https://test.invalid/replacement.png';
  const secondId = db.prepare('INSERT INTO media_avatars (image) VALUES (?)').run(second).lastInsertRowid;
  db.prepare('INSERT INTO media_npc_avatars (outlet_id, author_name, avatar_id) VALUES (?, ?, ?)').run(otherOutlet, '不受影响的路人', secondId);
  assert.deepEqual(library.remove(firstId), { success: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_npc_avatars WHERE avatar_id = ?').get(firstId).n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM media_npc_avatars').all(), [{ outlet_id: otherOutlet, author_name: '不受影响的路人', avatar_id: secondId }]);
  assert.throws(() => library.remove(firstId), error => error.statusCode === 404);
  assert.equal(library.resolve(outlet, '小路人'), second);
  assert.equal(library.resolve(outlet, '另一个路人'), second);
  assert.equal(library.resolve(otherOutlet, '小路人'), second);
  db.prepare(`INSERT INTO media_posts (outlet_id, title, content, author_type, author_name, author_avatar, comments_json)
    VALUES (?, '旧帖', '内容', 'character', '角色', '/avatars/character.png', '[]')`).run(outlet);
  assert.equal(listPosts({ outletId: Number(outlet) }).posts[0].author_avatar, '/avatars/character.png');
  db.prepare(`INSERT INTO media_posts (outlet_id, title, content, author_type, author_name, comments_json)
    VALUES (?, '旧路人帖', '内容', 'anonymous', '小路人', ?)`).run(outlet, JSON.stringify([{ author: '小路人', content: '评论' }]));
  const npc = listPosts({ outletId: Number(outlet) }).posts.find(p => p.author_type === 'anonymous');
  assert.equal(npc.author_avatar, second);
  assert.equal(npc.comments[0].author_avatar, second);
  closeDb(); db = getDb();
  assert.equal(library.resolve(outlet, '小路人'), second);
  library.remove(secondId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_npc_avatars').get().n, 0);
  assert.equal(library.resolve(outlet, '空库新路人'), null);
  assert.equal(library.resolve(outlet, '小路人'), null);
  db.prepare('UPDATE media_avatars SET enabled = 1, image = ?').run('/images/media_avatars/missing.png');
  assert.equal(library.resolve(outlet, '文件缺失'), null);
});

test('avatar removal rolls back if clearing NPC assignments fails', () => {
  const outlet = db.prepare("INSERT INTO media_outlets (name, prompt, layout) VALUES ('事务测试媒体', 'test', 'feed')").run().lastInsertRowid;
  const id = db.prepare('INSERT INTO media_avatars (image) VALUES (?)').run('https://test.invalid/atomic.png').lastInsertRowid;
  db.prepare('INSERT INTO media_npc_avatars (outlet_id, author_name, avatar_id) VALUES (?, ?, ?)').run(outlet, '路人', id);
  db.exec("CREATE TEMP TRIGGER fail_avatar_unbind BEFORE DELETE ON media_npc_avatars BEGIN SELECT RAISE(ABORT, 'unbind failed'); END");
  try {
    assert.throws(() => createMediaAvatarLibrary(dependencies).remove(id), /unbind failed/);
    assert.equal(db.prepare('SELECT enabled FROM media_avatars WHERE id = ?').get(id).enabled, 1);
    assert.equal(db.prepare('SELECT avatar_id FROM media_npc_avatars WHERE outlet_id = ?').get(outlet).avatar_id, id);
  } finally {
    db.exec('DROP TRIGGER fail_avatar_unbind');
  }
});

test('artist defaults and explicit blank reach image generation, while design failures leave no database job', async () => {
  const artists = [];
  const directions = [];
  const library = createMediaAvatarLibrary({ ...dependencies,
    design: async (...args) => { directions.push(args); return prompts; },
    generate: async (_prompt, opts) => { artists.push(opts.artist); return { success: true, images: [{ base64: 'image' }] }; },
  });
  library.start(); await library.wait();
  assert.deepEqual(artists, Array(10).fill('@ebora'));
  library.start('', '  '); await library.wait();
  assert.deepEqual(artists.slice(10), Array(10).fill(''));
  assert.deepEqual(directions, [['', 10, []], ['', 10, []]]);
  assert.equal(library.list().artist, '');
  const before = db.prepare('SELECT COUNT(*) AS n FROM media_avatars').get().n;
  const failed = createMediaAvatarLibrary({ ...dependencies, design: async () => { throw new Error('LLM unavailable'); } });
  failed.start(); await failed.wait();
  assert.equal(failed.list().progress.stage, 'failed');
  assert.match(failed.list().progress.error, /LLM unavailable/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_avatars').get().n, before);
});

test('single-avatar regeneration replaces one image and keeps shared NPC assignments', async () => {
  const outlet = db.prepare("INSERT INTO media_outlets (name, prompt, layout) VALUES ('重生测试媒体', 'test', 'feed')").run().lastInsertRowid;
  const id = db.prepare('INSERT INTO media_avatars (image) VALUES (?)').run('https://test.invalid/original.png').lastInsertRowid;
  const bind = db.prepare('INSERT INTO media_npc_avatars (outlet_id, author_name, avatar_id) VALUES (?, ?, ?)');
  bind.run(outlet, '甲', id); bind.run(outlet, '乙', id);
  const before = db.prepare('SELECT COUNT(*) AS n FROM media_avatars').get().n;
  let calls = 0;
  const library = createMediaAvatarLibrary({ ...dependencies,
    design: async (direction, count) => { assert.equal(direction, '植物'); assert.equal(count, 1); return [prompts[0]]; },
    generate: async (_prompt, opts) => { calls++; assert.equal(opts.artist, '@new'); return { success: true, images: [{ base64: 'image' }] }; },
    save: () => 'https://test.invalid/recreated.png',
  });
  assert.deepEqual(library.regenerate(id, '植物', '@new'), { started: true });
  assert.equal(library.list().progress.avatarId, id);
  assert.throws(() => library.regenerate(id), error => error.statusCode === 409);
  assert.throws(() => library.start(), error => error.statusCode === 409);
  await library.wait();
  assert.equal(calls, 1);
  assert.equal(library.list().progress.total, 1);
  assert.equal(library.list().progress.completed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_avatars').get().n, before);
  assert.equal(library.resolve(outlet, '甲'), 'https://test.invalid/recreated.png');
  assert.equal(library.resolve(outlet, '乙'), 'https://test.invalid/recreated.png');
  const failed = createMediaAvatarLibrary({ ...dependencies, design: async () => [prompts[0]], generate: async () => { throw new Error('ComfyUI offline'); } });
  failed.regenerate(id); await failed.wait();
  assert.equal(failed.list().progress.failed, 1);
  assert.equal(library.resolve(outlet, '甲'), 'https://test.invalid/recreated.png');
  library.remove(id);
  assert.throws(() => library.regenerate(id), error => error.statusCode === 404);
});

test('removal during regeneration never restores the removed avatar or its bindings', async () => {
  const id = db.prepare('INSERT INTO media_avatars (image) VALUES (?)').run('https://test.invalid/removed.png').lastInsertRowid;
  let resume;
  const pending = new Promise(resolve => { resume = resolve; });
  const discarded = [];
  const library = createMediaAvatarLibrary({ ...dependencies,
    design: async () => { await pending; return [prompts[0]]; },
    save: () => 'https://test.invalid/discard.png', discard: image => discarded.push(image),
  });
  library.regenerate(id);
  library.remove(id);
  resume(); await library.wait();
  assert.equal(library.list().progress.failed, 1);
  assert.deepEqual(discarded, ['https://test.invalid/discard.png']);
  assert.equal(db.prepare('SELECT enabled FROM media_avatars WHERE id = ?').get(id).enabled, 0);
});

test('legacy migration deletes only history and unfinished placeholders, preserving images and foreign keys', () => {
  const legacy = new Database(':memory:');
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE media_avatar_batches (id INTEGER PRIMARY KEY, direction TEXT);
      CREATE TABLE media_avatars (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES media_avatar_batches(id), title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT, image TEXT, error TEXT, enabled INTEGER DEFAULT 1);
      CREATE INDEX idx_media_avatars_batch ON media_avatars(batch_id);
      CREATE TABLE media_npc_avatars (outlet_id INTEGER, author_name TEXT, avatar_id INTEGER REFERENCES media_avatars(id));
      CREATE TABLE image_tasks (id INTEGER PRIMARY KEY, conversation_id TEXT);
      INSERT INTO media_avatar_batches VALUES (1, 'old direction');
      INSERT INTO media_avatars VALUES (1, 1, 'old name', 'old prompt', 'done', '/images/kept.png', NULL, 0);
      INSERT INTO media_avatars VALUES (2, 1, 'unfinished', 'old prompt', 'failed', NULL, 'error', 1);
      INSERT INTO media_npc_avatars VALUES (1, 'NPC', 1);
      INSERT INTO image_tasks VALUES (1, 'media_avatar'), (2, 'media_post');
    `);
    migrateMediaAvatarLibrary(legacy);
    migrateMediaAvatarLibrary(legacy);
    assert.deepEqual(legacy.prepare('SELECT * FROM media_avatars').all(), [{ id: 1, image: '/images/kept.png', enabled: 0 }]);
    assert.equal(legacy.prepare('SELECT avatar_id FROM media_npc_avatars').get().avatar_id, 1);
    assert.equal(legacy.prepare("SELECT name FROM sqlite_master WHERE name='media_avatar_batches'").get(), undefined);
    assert.deepEqual(legacy.prepare('SELECT * FROM image_tasks').all(), [{ id: 2, conversation_id: 'media_post' }]);
    assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(legacy.prepare('INSERT INTO media_avatars (image) VALUES (?)').run('/images/new.png').lastInsertRowid, 3);
  } finally { legacy.close(); }
});
