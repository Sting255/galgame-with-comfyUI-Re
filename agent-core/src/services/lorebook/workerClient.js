import { Worker } from 'node:worker_threads';

const MAX_WORKERS = 2;
const MAX_QUEUE = 32;
const queue = [];
let running = 0;

function drain() {
  while (running < MAX_WORKERS && queue.length) queue.shift().start();
}

/** Bound the entire scan/layout, including recursion and all imported regexes.
 * Queueing counts toward the deadline; timed-out jobs never keep running.
 */
export function runLorebookTask(operation, args, { timeoutMs = 1500 } = {}) {
  if (queue.length >= MAX_QUEUE) return Promise.reject(new Error('世界书处理队列繁忙，本次跳过世界书'));
  return new Promise((resolve, reject) => {
    let worker;
    let done = false;
    let started = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      if (worker) {
        // Release the slot only after termination, including on timeout.
        worker.terminate().finally(() => { running--; drain(); });
      } else if (started) { running--; drain(); }
      if (error) reject(error); else resolve(result);
    };
    const job = { start() {
      started = true;
      running++;
      try {
        worker = new Worker(new URL('./worker.js', import.meta.url), {
          workerData: { operation, args }, execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        });
        worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
        worker.once('error', error => finish(error));
        worker.once('exit', code => finish(new Error(`世界书工作线程退出（${code}）`)));
      } catch (error) { finish(error); }
    } };
    const timer = setTimeout(() => finish(new Error('世界书处理超时，已终止扫描或正文正则；本次跳过世界书')), timeoutMs);
    queue.push(job);
    drain();
  });
}
