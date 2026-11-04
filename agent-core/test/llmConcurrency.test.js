import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setMaxConcurrency, acquireSlot, releaseSlot, runWithLimit } from '../src/services/llmConcurrency.js';

test('关闭限制释放等待者，重新开启仍计入已有任务，重复释放不影响其它任务', async () => {
  setMaxConcurrency(1);
  const a = await acquireSlot();
  let admitted = false;
  const pending = acquireSlot().then(slot => { admitted = true; return slot; });
  await Promise.resolve();
  assert.equal(admitted, false);
  setMaxConcurrency(null);
  const b = await pending;
  setMaxConcurrency(1);
  admitted = false;
  const next = acquireSlot().then(slot => { admitted = true; return slot; });
  releaseSlot(a);
  releaseSlot(a);
  await Promise.resolve();
  assert.equal(admitted, false);
  releaseSlot(b);
  releaseSlot(await next);
  setMaxConcurrency(null);
});

test('取消排队不占位；增大限制按顺序放行', async () => {
  setMaxConcurrency(1);
  const first = await acquireSlot();
  const controller = new AbortController();
  const cancelled = acquireSlot({ signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const second = acquireSlot();
  setMaxConcurrency(2);
  releaseSlot(await second);
  releaseSlot(first);
  await assert.rejects(runWithLimit(() => { throw new Error('test failure'); }), /test failure/);
  releaseSlot(await acquireSlot());
  setMaxConcurrency(null);
});

test('无限制时取得的凭证跨开关仍可释放；非法限制不会卡死队列', async () => {
  setMaxConcurrency(null);
  const slot = await acquireSlot();
  setMaxConcurrency(1);
  assert.throws(() => setMaxConcurrency(0), RangeError);
  let admitted = false;
  const pending = acquireSlot().then(value => { admitted = true; return value; });
  await Promise.resolve();
  assert.equal(admitted, false);
  releaseSlot(slot);
  releaseSlot(await pending);
  setMaxConcurrency(null);
});
