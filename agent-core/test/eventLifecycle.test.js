import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.COMFYUI_URL = 'http://127.0.0.1:9';
const { getDb, closeDb } = await import('../src/db/index.js');
const { default: eventsRouter } = await import('../src/routes/events.js');
const { concludeEvent } = await import('../src/services/eventGenerator.js');
const { withEventProcessing } = await import('../src/services/eventProcessing.js');
const { expireTownNpcEvent } = await import('../src/services/town/townNpcEventGenerator.js');

const app = express();
app.use(express.json());
app.use('/events', eventsRouter);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
after(async () => { await new Promise(resolve => server.close(resolve)); closeDb(); });
const call = (id, action, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}/events/${id}${action ? '/' + action : ''}`, { method, signal: AbortSignal.timeout(5000) });

function seed(town = false) {
  const db = getDb();
  if (town) {
    const npc = db.prepare("INSERT INTO town_npcs(map_id,display_name) VALUES(1,'邻居')").run().lastInsertRowid;
    const id = Number(db.prepare("INSERT INTO town_npc_events(npc_id,title,description,expires_at,created_at) VALUES(?,'散步','沿河散步','2099-01-01 00:00:00','2026-01-01 12:00:00')").run(npc).lastInsertRowid);
    return { db, id, routeId: `town:${id}`, active: 'town_npc_events', history: 'town_npc_event_history' };
  }
  const charId = db.prepare("INSERT INTO characters(name,display_name,base_prompt) VALUES(?,'旅人','热爱自然')").run(`event-${Math.random()}`).lastInsertRowid;
  const id = Number(db.prepare("INSERT INTO character_events(character_id,event_type_key,title,description,expires_at,created_at) VALUES(?,'test','散步','沿河散步','2099-01-01 00:00:00','2026-01-01 12:00:00')").run(charId).lastInsertRowid);
  return { db, id, routeId: id, active: 'character_events', history: 'event_history', character: db.prepare('SELECT * FROM characters WHERE id=?').get(charId) };
}

for (const town of [false, true]) {
  test(`busy ${town ? 'legacy NPC' : 'character'} event cannot be deleted, dismissed or concluded`, async () => {
    const { db, id, routeId, active, history } = seed(town);
    db.prepare(`UPDATE ${active} SET processing=1 WHERE id=?`).run(id);
    for (const [action, method] of [['', 'DELETE'], ['dismiss', 'POST'], ['conclude', 'POST']]) {
      assert.equal((await call(routeId, action, method)).status, 409);
      assert.ok(db.prepare(`SELECT id FROM ${active} WHERE id=?`).get(id));
      assert.equal(db.prepare(`SELECT id FROM ${history} WHERE id=?`).get(id), undefined);
    }
  });

  test(`dismiss ${town ? 'legacy NPC' : 'character'} event preserves creation time and rolls back on deletion failure`, async () => {
    const { db, id, routeId, active, history } = seed(town);
    db.exec(`CREATE TEMP TRIGGER fail_delete BEFORE DELETE ON ${active} WHEN OLD.id=${id} BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    try {
      assert.equal((await call(routeId, 'dismiss')).status, 500);
      assert.ok(db.prepare(`SELECT id FROM ${active} WHERE id=?`).get(id));
      assert.equal(db.prepare(`SELECT id FROM ${history} WHERE id=?`).get(id), undefined);
    } finally { db.exec('DROP TRIGGER fail_delete'); }
    assert.equal((await call(routeId, 'dismiss')).status, 200);
    assert.equal(db.prepare(`SELECT created_at FROM ${history} WHERE id=?`).get(id).created_at, '2026-01-01 12:00:00');
  });
}

test('conclusion owns processing until archived and duplicate conclusion makes no LLM request', async () => {
  const { db, id, character } = seed();
  const event = db.prepare('SELECT * FROM character_events WHERE id=?').get(id);
  let finish;
  let calls = 0;
  const deps = { chatSync: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  const pending = concludeEvent(character, event, 'expired', deps);
  assert.equal(db.prepare('SELECT processing FROM character_events WHERE id=?').get(id).processing, 1);
  await assert.rejects(concludeEvent(character, event, 'expired', deps), /ALREADY_PROCESSING/);
  assert.equal(calls, 1);
  finish(JSON.stringify({ conclusion: '旅人回到家中。', summary: '旅人沿河散步后回家。' }));
  await pending;
  assert.equal(db.prepare('SELECT id FROM character_events WHERE id=?').get(id), undefined);
  assert.equal(db.prepare('SELECT created_at FROM event_history WHERE id=?').get(id).created_at, event.created_at);
});

test('processing ownership is released on unexpected failure', async () => {
  const { db, id } = seed();
  await assert.rejects(withEventProcessing('character_events', id, async () => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(db.prepare('SELECT processing FROM character_events WHERE id=?').get(id).processing, 0);
});

test('failed conclusion archive rolls back memory and history, then permits retry', async () => {
  const { db, id, character } = seed();
  db.prepare('UPDATE character_events SET engaged=1 WHERE id=?').run(id);
  const event = db.prepare('SELECT * FROM character_events WHERE id=?').get(id);
  const deps = { chatSync: async () => JSON.stringify({ conclusion: '一起回家。', summary: '沿河散步后一起回家。' }) };
  db.exec(`CREATE TEMP TRIGGER fail_conclusion BEFORE DELETE ON character_events WHEN OLD.id=${id} BEGIN SELECT RAISE(ABORT, 'archive failed'); END`);
  try {
    await assert.rejects(concludeEvent(character, event, 'completed', deps), /archive failed/);
    assert.equal(db.prepare('SELECT processing FROM character_events WHERE id=?').get(id).processing, 0);
    assert.equal(db.prepare('SELECT id FROM event_history WHERE id=?').get(id), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_fragments WHERE conversation_id=?').get(`char_${character.id}`).n, 0);
  } finally { db.exec('DROP TRIGGER fail_conclusion'); }
  await concludeEvent(character, event, 'completed', deps);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_fragments WHERE conversation_id=?').get(`char_${character.id}`).n, 1);
});

test('legacy expiry rechecks processing after the scheduler snapshot was taken', () => {
  const { db, id, active, history } = seed(true);
  const event = db.prepare(`SELECT * FROM ${active} WHERE id=?`).get(id);
  const npc = db.prepare('SELECT * FROM town_npcs WHERE id=?').get(event.npc_id);
  db.prepare(`UPDATE ${active} SET processing=1 WHERE id=?`).run(id);
  assert.equal(expireTownNpcEvent(npc, event), null);
  assert.ok(db.prepare(`SELECT id FROM ${active} WHERE id=?`).get(id));
  assert.equal(db.prepare(`SELECT id FROM ${history} WHERE id=?`).get(id), undefined);
});
