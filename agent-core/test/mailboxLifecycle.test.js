import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { getDb, closeDb } from '../src/db/index.js';
import mailboxRouter from '../src/routes/mailbox.js';

const app = express();
app.use(express.json());
app.use('/mailbox', mailboxRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
after(async () => { await new Promise(resolve => server.close(resolve)); closeDb(); });
const call = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}/mailbox${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
});
function seed(status = 'failed') {
  const db = getDb();
  const characterId = Number(db.prepare("INSERT INTO characters(name,display_name,base_prompt) VALUES(?,'测试收信人','合成资料')").run(`mail-${Math.random()}`).lastInsertRowid);
  const id = Number(db.prepare("INSERT INTO mailbox_letters(character_id,direction,content,status,retry_count) VALUES(?,'user_to_char','保留这封原信',?,5)").run(characterId, status).lastInsertRowid);
  return { db, characterId, id, row: () => db.prepare('SELECT * FROM mailbox_letters WHERE id=?').get(id) };
}

test('retry preserves the original letter, resets attempts and returns UTC timestamps', async () => {
  const { id, row } = seed();
  const response = await call(`/${id}/retry`, 'POST');
  assert.equal(response.status, 200);
  const { letter } = await response.json();
  assert.equal(letter.status, 'pending');
  assert.equal(letter.retry_count, 0);
  assert.equal(letter.content, '保留这封原信');
  assert.ok(Number.isFinite(Date.parse(letter.reply_at)));
  assert.match(letter.reply_at, /Z$/);
  assert.equal(row().status, 'pending');
});

test('processing starts after a stale detail was opened: delete and retry both reject without altering the record', async () => {
  const { db, id, row } = seed('pending');
  assert.equal((await (await call('')).json()).letters.find(l => l.id === id).status, 'pending');
  db.prepare("UPDATE mailbox_letters SET status='processing' WHERE id=?").run(id);
  for (const [path, method] of [[`/${id}`, 'DELETE'], [`/${id}/retry`, 'POST']]) {
    const response = await call(path, method);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /回信中/);
    assert.equal(row().status, 'processing');
  }
  db.prepare("UPDATE mailbox_letters SET status='failed' WHERE id=?").run(id);
  assert.equal((await call(`/${id}`, 'DELETE')).status, 200);
  assert.equal(row(), undefined);
  assert.equal((await call(`/${id}/retry`, 'POST')).status, 404);
});

test('completed replies cannot be overwritten by retry; marking detail read returns the persisted state', async () => {
  const { db, id, row } = seed('completed');
  db.prepare("UPDATE mailbox_letters SET direction='char_to_user', reply_content='保留回信', is_read=0 WHERE id=?").run(id);
  assert.equal((await call(`/${id}/retry`, 'POST')).status, 409);
  const detail = await (await call(`/${id}`)).json();
  assert.equal(detail.is_read, 1);
  assert.equal(row().is_read, 1);
  assert.equal(row().reply_content, '保留回信');
});

test('invalid send payloads do not create letters, and valid sends retain their selected recipient', async () => {
  const { db, characterId } = seed();
  const before = db.prepare('SELECT COUNT(*) n FROM mailbox_letters').get().n;
  for (const body of [{ content: 42 }, { content: {} }, { content: ' ' }, { content: '正文', title: [] }]) {
    assert.equal((await call('/send', 'POST', { character_id: characterId, ...body })).status, 400);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mailbox_letters').get().n, before);
  const response = await call('/send', 'POST', { character_id: characterId, content: ' 正文 ' });
  assert.equal(response.status, 200);
  const { letter } = await response.json();
  assert.equal(letter.character_id, characterId);
  assert.equal(letter.content, '正文');
});
