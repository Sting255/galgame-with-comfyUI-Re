/**
 * 后台 LLM 任务并发限制器 (Semaphore)
 *
 * - 仅当 config.features.serializeBackgroundLLM 为 true 时生效
 * - 限制后台任务（朋友圈/奇遇/主动聊天配图）的 LLM+ComfyUI 全流程并发数
 * - 云端 API 用户（maxConcurrency = null）零开销
 */

let maxConcurrency = null;
const activeSlots = new Set();
const waitQueue = [];

export function setMaxConcurrency(n) {
  if (n != null && (!Number.isInteger(n) || n < 1)) throw new RangeError('Concurrency must be a positive integer or null');
  maxConcurrency = n ?? null;
  if (maxConcurrency !== null) {
    console.log(`[llmConcurrency] Max background concurrency set to ${maxConcurrency}`);
  } else {
    console.log('[llmConcurrency] Disabled (unlimited)');
  }
  processQueue();
}

function processQueue() {
  while (waitQueue.length > 0 && (maxConcurrency === null || activeSlots.size < maxConcurrency)) {
    const next = waitQueue.shift();
    next.signal?.removeEventListener('abort', next.abort);
    const slot = Symbol('llm-slot');
    activeSlots.add(slot);
    next.resolve(slot);
  }
}

export async function acquireSlot({ signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const waiter = { resolve, signal, abort: () => {
      const index = waitQueue.indexOf(waiter);
      if (index !== -1) waitQueue.splice(index, 1);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    } };
    signal?.addEventListener('abort', waiter.abort, { once: true });
    waitQueue.push(waiter);
    processQueue();
  });
}

export function releaseSlot(slot) {
  // 凭证只释放一次；运行中开关切换不能丢计数或释放其它任务的占位。
  if (activeSlots.delete(slot)) processQueue();
}

/**
 * 包裹后台 LLM 全流程函数，限制并发
 * @param {() => Promise<T>} fn 后台任务全流程（LLM → ComfyUI）
 * @returns {Promise<T>}
 *
 * ⚠️ 死导出（2026-10-15 标注，**只标注不删**）：零调用点 —— 调用方一律直接用下面两件套
 * （`acquireSlot()` / `releaseSlot()`，见 `imageSkill._execute`）。这是"更好用的封装"，
 * 只是因为改动点都写成了手动的两件套，封装没被接上。
 * 顺手接的话注意：`maxConcurrency === null` 时它是**直接执行**（不排队），与两件套的语义一致。
 */
export async function runWithLimit(fn) {
  if (maxConcurrency === null) return fn();
  const slot = await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot(slot);
  }
}

/**
 * 从 config 对象读取并应用并发限制
 * @param {object} cfg - config 对象
 */
export function applyFromConfig(cfg) {
  const enabled = cfg.features?.serializeBackgroundLLM;
  if (enabled) {
    setMaxConcurrency(cfg.features.backgroundLLMMaxConcurrency ?? 3);
  } else {
    setMaxConcurrency(null);
  }
}
