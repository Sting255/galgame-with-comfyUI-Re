import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('network forbidden in emoji outfit tests'); };
const { getDb } = await import('../src/db/index.js');
const { generateEmojiPrompts, saveEmojiStyleMode } = await import('../src/services/emojiService.js');
const { getLocalDateKey } = await import('../src/utils/localDate.js');
const db = getDb();
afterEach(() => { db.prepare('DELETE FROM characters').run(); saveEmojiStyleMode('half_body'); });
after(() => db.close());

function fixture() {
  const id = Number(db.prepare('INSERT INTO characters(name,display_name,short_prompt,base_prompt) VALUES(?,?,?,?)')
    .run('test', '测试角色', 'A friendly character.', '你是测试角色。\n## 你的外观\nSilver hair, blue eyes, white uniform.').lastInsertRowid);
  const clothes = { work: 'Old work uniform', casual: 'Red casual jacket', home: 'Green home shirt', sleep: 'Blue nightdress' };
  for (const [scene, description] of Object.entries(clothes)) {
    db.prepare('INSERT INTO character_outfits(character_id,name,description,scene) VALUES(?,?,?,?)').run(id, scene, description, scene);
  }
  db.prepare('INSERT INTO daily_schedules(character_id,schedule_date,schedule_json) VALUES(?,?,?)')
    .run(id, getLocalDateKey(new Date()), JSON.stringify([{ startTime: '00:00', endTime: '24:00', replyDelay: -1, outfit: 'sleep' }]));
  return { char: db.prepare('SELECT * FROM characters WHERE id=?').get(id), clothes };
}

async function capture(char, options = {}, style = '') {
  let request;
  const prompts = await generateEmojiPrompts(char, style, ['开心', '难过'], options, {
    chat: async (messages, opts) => { request = { messages, opts }; return JSON.stringify({ 开心: 'A happy character.', 难过: 'A sad character.' }); },
  });
  assert.match(prompts.开心, /A happy character/);
  return request;
}

test('default and each explicit emoji outfit ignore the sleeping schedule', async () => {
  const { char, clothes } = fixture();
  for (const scene of ['work', 'casual', 'home', 'sleep']) {
    const { messages } = await capture(char, { outfitScene: scene });
    const appearance = messages[3].content;
    assert.match(appearance, /Silver hair/);
    assert.ok(appearance.includes(scene === 'work' ? 'white uniform' : clothes[scene]));
    for (const [other, description] of Object.entries(clothes)) {
      if (other !== scene || scene === 'work') assert.ok(!appearance.includes(description));
    }
  }
  assert.deepEqual((await capture(char)).messages, (await capture(char, { outfitScene: 'work' })).messages);
});

test('missing and blank outfits require a choice; fallback never reads the schedule', async () => {
  const { char } = fixture();
  db.prepare("UPDATE character_outfits SET description='  ' WHERE character_id=? AND scene='casual'").run(char.id);
  await assert.rejects(capture(char, { outfitScene: 'casual' }), error => error.status === 409);
  const fallback = await capture(char, { outfitScene: 'casual', missingOutfitPolicy: 'fallback' });
  assert.equal(fallback.messages[3].content, (await capture(char)).messages[3].content);
});

test('automatic outfit completion is saved before prompting; existing outfits are preserved', async () => {
  const { char } = fixture();
  db.prepare("DELETE FROM character_outfits WHERE character_id=? AND scene='casual'").run(char.id);
  let designs = 0;
  const deps = {
    outfitGenerator: async (_, opts) => {
      designs++;
      assert.deepEqual(opts.scenes, ['casual']);
      assert.match(opts.baseAppearance, /white uniform/);
      return [{ scene: 'casual', name: '便装', description: 'New yellow jacket' }];
    },
    chat: async messages => { assert.match(messages[3].content, /New yellow jacket/); return '{"开心":"Smiling character."}'; },
  };
  for (let i = 0; i < 2; i++) await generateEmojiPrompts(char, '', ['开心'], { outfitScene: 'casual', missingOutfitPolicy: 'generate' }, deps);
  assert.equal(designs, 1);
});

test('failed completion does not generate emoji prompts or silently fall back', async () => {
  const { char } = fixture();
  db.prepare("DELETE FROM character_outfits WHERE character_id=? AND scene='casual'").run(char.id);
  await assert.rejects(generateEmojiPrompts(char, '', ['开心'], { outfitScene: 'casual', missingOutfitPolicy: 'generate' }, {
    outfitGenerator: async () => { throw new Error('outfit generation failed'); },
    chat: async () => assert.fail('must not submit emoji generation'),
  }), /outfit generation failed/);
});

test('invalid outfit selections are rejected before generation', async () => {
  const { char } = fixture();
  for (const outfitScene of ['auto', '', null, 'winter']) {
    await assert.rejects(capture(char, { outfitScene }), error => error.status === 400);
  }
  await assert.rejects(capture(char, { missingOutfitPolicy: 'skip' }), error => error.status === 400);
});

test('outfit and user direction change only dynamic content; lorebook boundary excludes outfits', async () => {
  const { char } = fixture();
  const a = await capture(char, { outfitScene: 'casual' }, '黑发');
  const b = await capture(char, { outfitScene: 'sleep' }, '红发');
  assert.deepEqual(a.messages.slice(0, 3), b.messages.slice(0, 3));
  assert.deepEqual(a.opts.lorebook.cacheBoundary, { index: 3, offset: 0 });
  assert.deepEqual(a.opts.lorebook.personaTexts, [a.messages[3].content]);
  assert.deepEqual(a.opts.lorebook.staticTexts, a.messages.slice(0, 3).map(m => m.content));
  assert.equal(a.messages.filter(m => m.role === 'user').length, 1);
  assert.match(a.messages.at(-1).content, /黑发/);
  assert.deepEqual(a.opts.lorebook.history, [a.messages.at(-1)]);
  const example = JSON.parse(a.messages[2].content.split('\n').find(line => line.startsWith('{')));
  assert.deepEqual(Object.keys(example), ['开心', '难过']);
});

test('head-only style retains clothing prohibition after selecting an outfit', async () => {
  const { char } = fixture();
  saveEmojiStyleMode('chibi_head');
  const { messages } = await capture(char, { outfitScene: 'home' });
  assert.match(messages[1].content, /禁止项：任何服装/);
  assert.match(messages[2].content, /猪鼻大头模式仍禁止描写服装/);
});

test('HTTP preflight reports missing clothes and rejects unconfirmed generation without changing saved prompts', async t => {
  const { default: router } = await import('../src/routes/emoji.js');
  const { char } = fixture();
  db.prepare("DELETE FROM character_outfits WHERE character_id=? AND scene='casual'").run(char.id);
  const setId = Number(db.prepare("INSERT INTO emoji_sets(character_id,name,is_active) VALUES(?,'test',1)").run(char.id).lastInsertRowid);
  db.prepare("INSERT INTO character_emojis(character_id,set_id,emoji_key,prompt,status) VALUES(?,?,'开心','Existing prompt','done')").run(char.id, setId);
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const body = { character_ids: [char.id], outfitScene: 'casual', set_id: setId };
  const preview = await post('/outfits/preflight', body);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.sceneLabel, '私服');
  assert.deepEqual(preview.body.missingCharacters, [{ id: char.id, name: char.display_name }]);
  assert.equal((await post('/prompts', body)).status, 409);
  assert.equal((await post(`/${char.id}/开心/prompt`.replace('开心', encodeURIComponent('开心')), { set_id: setId, outfitScene: 'casual' })).status, 409);
  assert.equal((await post('/prompts', { ...body, outfitScene: 'auto' })).status, 400);
  assert.equal((await post('/outfits/preflight', { ...body, character_ids: [-1] })).status, 404);
  const row = db.prepare('SELECT prompt,status FROM character_emojis WHERE set_id=?').get(setId);
  assert.deepEqual(row, { prompt: 'Existing prompt', status: 'done' });
});
