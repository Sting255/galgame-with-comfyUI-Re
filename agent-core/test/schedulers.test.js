import test from 'node:test';
import assert from 'node:assert/strict';
import { createSchedulerRegistry } from '../src/services/schedulerRegistry.js';

function clock() {
  let time = 1000;
  const callbacks = new Map();
  const registry = createSchedulerRegistry({ now: () => time,
    setTimer: (fn, ms) => { const handle = { ms }; callbacks.set(handle, fn); return handle; },
    clearTimer: handle => callbacks.delete(handle), onError() {},
  });
  return { ...registry, callbacks, advance: ms => { time += ms; }, fire: handle => callbacks.get(handle)() };
}

test('后台任务登记幂等，异常三次告警、成功恢复、停止后移除', async () => {
  const r = clock();
  let fails = true;
  const fn = () => { if (fails) throw new Error('offline'); };
  const timer = r.register('reply-queue', 1000, fn);
  assert.equal(r.register('reply-queue', 1000, fn), timer);
  for (let i = 0; i < 3; i++) await r.fire(timer);
  assert.equal(r.snapshot()[0].consecutiveFailures, 3);
  assert.equal(r.snapshot()[0].lastError, 'offline');
  assert.equal(r.snapshot()[0].unhealthy, true);
  fails = false;
  await r.fire(timer);
  assert.equal(r.snapshot()[0].unhealthy, false);
  assert.equal(r.snapshot()[0].lastError, '');
  r.unregister(timer);
  assert.deepEqual(r.snapshot(), []);
  assert.equal(r.callbacks.size, 0);
});

test('未完成的异步任务不重叠，三个周期后报告停滞并记录用时', async () => {
  const r = clock();
  let release;
  const timer = r.register('diary-retry', 1000, () => new Promise(resolve => { release = resolve; }));
  const pending = r.fire(timer);
  await r.fire(timer);
  assert.equal(r.snapshot()[0].skipped, 1);
  r.advance(3001);
  assert.equal(r.snapshot()[0].stalled, true);
  release();
  await pending;
  assert.equal(r.snapshot()[0].durationMs, 3001);
  assert.equal(r.snapshot()[0].stalled, false);
});

test('内部捕获的错误仍可记为失败，异步上下文不污染其它任务', async () => {
  const r = clock();
  let release;
  const timer = r.register('media-refill', 1000, async () => {
    await new Promise(resolve => { release = resolve; });
    r.noteFailure(new Error('render failed'));
  });
  const other = r.register('healthy', 1000, () => {});
  const pending = r.fire(timer);
  await r.fire(other);
  release();
  await pending;
  const states = Object.fromEntries(r.snapshot().map(s => [s.name, s]));
  assert.equal(states['media-refill'].consecutiveFailures, 1);
  assert.equal(states.healthy.consecutiveFailures, 0);
  r.noteFailure(new Error('outside task'));
  assert.equal(r.snapshot().find(s => s.name === 'healthy').lastError, '');
});

test('从未触发的任务停滞可见，重新登记使用全新状态', () => {
  const r = clock();
  const timer = r.register('waiting', 1000, () => {});
  r.advance(3001);
  assert.equal(r.snapshot()[0].stalled, true);
  r.unregister(timer);
  r.register('waiting', 1000, () => {});
  assert.equal(r.snapshot()[0].stalled, false);
});
