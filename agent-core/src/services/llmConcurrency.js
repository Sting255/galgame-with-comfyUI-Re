/**
 * 后台 LLM 任务并发限制器 (Semaphore)
 *
 * - 仅当 config.features.serializeBackgroundLLM 为 true 时生效
 * - 限制后台任务（朋友圈/奇遇/主动聊天配图）的 LLM+ComfyUI 全流程并发数
 * - 云端 API 用户（maxConcurrency = null）零开销
 */

let maxConcurrency = null;
let activeCount = 0;
let waitQueue = [];

export function setMaxConcurrency(n) {
  maxConcurrency = n ?? null;
  if (maxConcurrency !== null) {
    console.log(`[llmConcurrency] Max background concurrency set to ${maxConcurrency}`);
  } else {
    console.log('[llmConcurrency] Disabled (unlimited)');
  }
  processQueue();
}

function processQueue() {
  while (maxConcurrency !== null && activeCount < maxConcurrency && waitQueue.length > 0) {
    const next = waitQueue.shift();
    activeCount++;
    next();
  }
}

export async function acquireSlot() {
  if (maxConcurrency === null) return;
  if (activeCount < maxConcurrency) {
    activeCount++;
    return;
  }
  return new Promise(resolve => {
    waitQueue.push(() => {
      resolve();
    });
    processQueue();
  });
}

export function releaseSlot() {
  if (maxConcurrency === null) return;
  activeCount--;
  processQueue();
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
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
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
