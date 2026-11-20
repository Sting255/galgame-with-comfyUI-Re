import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { recordComfyOutcome, getComfyAvailability, noteComfySkipped, onComfyRecovered, probeComfyNow } from '../src/services/comfyAvailability.js';
import { getDb, closeDb } from '../src/db/index.js';
import { pruneOfflineImageBacklog } from '../src/services/mediaService.js';
import { MEDIA_IMAGE_OFFLINE, MEDIA_IMAGE_SKIPPED_OFFLINE } from '../src/services/mediaPublication.js';

test('离线熔断退避、并发探测共用请求、恢复只通知一次', async t => {
  config.comfyui.url = 'http://127.0.0.1:9';
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return { ok: false }; });
  let recovered = 0;
  const unsubscribe = onComfyRecovered(() => { recovered++; });
  t.after(() => { unsubscribe(); recordComfyOutcome({ ok: true }); });
  recordComfyOutcome({ ok: false, unreachable: true, error: 'ECONNREFUSED' });
  noteComfySkipped();
  assert.equal(getComfyAvailability().offline, true);
  assert.equal(getComfyAvailability().skipped, 1);
  assert.equal(getComfyAvailability().nextProbeInMs, 30_000);
  t.mock.timers.tick(30_000);
  await new Promise(setImmediate);
  assert.equal(getComfyAvailability().nextProbeInMs, 60_000);
  let release;
  globalThis.fetch.mock.mockImplementation(() => { requests++; return new Promise(resolve => { release = resolve; }); });
  const first = probeComfyNow();
  const second = probeComfyNow();
  assert.equal(first, second);
  release({ ok: true });
  assert.equal(await first, true);
  assert.equal(getComfyAvailability().offline, false);
  assert.equal(recovered, 1);
  recordComfyOutcome({ ok: true });
  assert.equal(recovered, 1);
  assert.equal(requests, 2);
});

test('ComfyUI 有响应的拒绝不当作离线', () => {
  recordComfyOutcome({ ok: false, unreachable: false, error: 'missing node' });
  assert.equal(getComfyAvailability().offline, false);
});

test('离线补图按媒体各保留最近两条，不裁掉未发布或其他失败的内容', t => {
  const db = getDb();
  t.after(closeDb);
  const outlets = db.prepare('SELECT id FROM media_outlets ORDER BY id LIMIT 2').all();
  assert.equal(outlets.length, 2);
  const insert = db.prepare('INSERT INTO media_posts(outlet_id,title,content,image_status,image_error,published_seq) VALUES(?,?,?,?,?,?)');
  const expected = [];
  for (const outlet of outlets) {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(Number(insert.run(outlet.id, '合成离线内容', '文字已发布', i % 2 ? 'failed' : 'pending', MEDIA_IMAGE_OFFLINE, i + 1).lastInsertRowid));
    expected.push(...ids.slice(-2));
  }
  const unpublished = Number(insert.run(outlets[0].id, '未发布', '正文', 'pending', MEDIA_IMAGE_OFFLINE, null).lastInsertRowid);
  const otherError = Number(insert.run(outlets[0].id, '其他错误', '正文', 'failed', 'invalid workflow', 5).lastInsertRowid);
  assert.equal(pruneOfflineImageBacklog(db), 4);
  assert.deepEqual(db.prepare('SELECT id FROM media_posts WHERE published_seq IS NOT NULL AND image_error=? ORDER BY id').all(MEDIA_IMAGE_OFFLINE).map(r => r.id), expected);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_posts WHERE image_status=?').get(MEDIA_IMAGE_SKIPPED_OFFLINE).n, 4);
  assert.equal(db.prepare('SELECT image_status FROM media_posts WHERE id=?').get(unpublished).image_status, 'pending');
  assert.equal(db.prepare('SELECT image_error FROM media_posts WHERE id=?').get(otherError).image_error, 'invalid workflow');
  assert.equal(pruneOfflineImageBacklog(db), 0);
});
