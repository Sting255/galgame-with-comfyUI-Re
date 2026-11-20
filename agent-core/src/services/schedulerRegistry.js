import { AsyncLocalStorage } from 'node:async_hooks';

/** 只登记进程级后台任务；请求心跳、进度刷新和小镇冻结任务保持原样。 */
export function createSchedulerRegistry({
  now = Date.now, setTimer = setInterval, clearTimer = clearInterval,
  onError = (name, err) => console.error(`[scheduler:${name}]`, err?.message || err),
} = {}) {
  const jobs = new Map();
  const context = new AsyncLocalStorage();

  function noteFailure(error) {
    const run = context.getStore();
    if (run?.active) run.error = error instanceof Error ? error : new Error(String(error));
  }

  function register(name, intervalMs, fn) {
    if (!name || typeof fn !== 'function' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError('调度任务需要名称、正数间隔和回调');
    }
    const prior = jobs.get(name);
    if (prior) return prior.timer;
    const job = { name, intervalMs, registeredAt: now(), lastStartAt: null, lastEndAt: null,
      durationMs: null, consecutiveFailures: 0, lastError: '', running: false, runs: 0, skipped: 0 };
    job.run = async () => {
      if (job.running) { job.skipped++; return; }
      job.running = true;
      job.lastStartAt = now();
      const run = { active: true, error: null };
      try {
        await context.run(run, fn);
      } catch (err) {
        run.error = err;
        onError(name, err);
      } finally {
        run.active = false;
        job.lastEndAt = now();
        job.durationMs = Math.max(0, job.lastEndAt - job.lastStartAt);
        job.runs++;
        if (run.error) {
          job.consecutiveFailures++;
          job.lastError = String(run.error?.message || run.error).slice(0, 500);
        } else {
          job.consecutiveFailures = 0;
          job.lastError = '';
        }
        job.running = false;
      }
    };
    jobs.set(name, job);
    try { job.timer = setTimer(job.run, intervalMs); }
    catch (err) { jobs.delete(name); throw err; }
    return job.timer;
  }

  function unregister(timer) {
    clearTimer(timer);
    for (const [name, job] of jobs) if (job.timer === timer) jobs.delete(name);
  }

  function snapshot() {
    const current = now();
    return [...jobs.values()].map(({ run, timer, ...job }) => {
      const reference = job.running ? job.lastStartAt : (job.lastEndAt ?? job.registeredAt);
      const stalled = current - reference > job.intervalMs * 3;
      return { ...job, stalled, unhealthy: stalled || job.consecutiveFailures >= 3 };
    }).sort((a, b) => Number(b.unhealthy) - Number(a.unhealthy) || a.name.localeCompare(b.name));
  }

  return { register, unregister, noteFailure, snapshot };
}

const registry = createSchedulerRegistry();
export const registerScheduler = registry.register;
export const unregisterScheduler = registry.unregister;
export const noteSchedulerFailure = registry.noteFailure;
export const getSchedulerStatus = registry.snapshot;
