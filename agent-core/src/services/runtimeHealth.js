/**
 * 运行状态（进程内内存，不落库）。
 *
 * 为什么要有它：2026-11-06 真机日志里，报纸 / 日程 / 朋友圈 / 事件 / 群聊在 9 分钟内
 * **连续失败几十次**，而界面上一点提示都没有 —— 用户只有把两万行日志发给别人看才知道。
 * 同一天还有「输出额度填成 340000」「ComfyUI 路径一直没推导出来」「低优生图等满上限」
 * 三件事，全都只活在日志里。
 *
 * 这里的定位很窄：**只回答「现在哪儿坏了、坏了几次」**，不追求可观测性平台那一套。
 * 口径：
 *   - 只统计最近 60 分钟；窗口过期自动丢弃
 *   - 通过包一层 console.error / console.warn 自动采集，业务代码零侵入
 *     （日志本来是给人看的，格式统一是 `[模块名] 内容`，正好拿来归类）
 *   - 采集本身绝不影响主流程：所有异常吞掉
 *   - 不记录用户对话内容：只保留每条失败的前 200 字符，日志里本来就有的那段
 */

const WINDOW_MS = 60 * 60 * 1000;
const MAX_MODULES = 24;
const MAX_MESSAGE = 200;

/** module -> { count, lastMessage, lastAt, windowStart } */
const errorBuckets = new Map();
const warnBuckets = new Map();
let installed = false;

/** 从 `[module] 正文` 里取模块名；取不到归到 other */
function moduleOf(text) {
  const m = /^\[([a-zA-Z][\w.-]*)\]/.exec(text);
  return m ? m[1] : 'other';
}

function bump(map, module, message) {
  const now = Date.now();
  const cur = map.get(module);
  if (!cur || now - cur.windowStart > WINDOW_MS) {
    if (!map.has(module) && map.size >= MAX_MODULES) {
      // 丢掉最久没动的那个，防止模块名爆炸式增长
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, val] of map) if (val.lastAt < oldestAt) { oldestAt = val.lastAt; oldestKey = key; }
      if (oldestKey) map.delete(oldestKey);
    }
    map.set(module, { count: 1, lastMessage: String(message).slice(0, MAX_MESSAGE), lastAt: now, windowStart: now });
    return;
  }
  cur.count += 1;
  cur.lastMessage = String(message).slice(0, MAX_MESSAGE);
  cur.lastAt = now;
}

/** 把一条 console 调用记进运行状态（供 console 钩子调用） */
export function recordConsole(level, args) {
  if (level !== 'error' && level !== 'warn') return;
  let text = '';
  try {
    text = args
      .map(a => (typeof a === 'string' ? a : a instanceof Error ? a.message : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
  } catch {
    return;
  }
  if (!text) return;
  bump(level === 'error' ? errorBuckets : warnBuckets, moduleOf(text), text);
}

/**
 * 挂钩 console.error / console.warn。重复调用只装一次。
 * 注意：本模块内部**不能**再 console.error，否则自我递归。
 */
export function installRuntimeHealthConsoleHook() {
  if (installed) return;
  installed = true;
  for (const level of ['error', 'warn']) {
    const original = console[level];
    console[level] = (...args) => {
      original.apply(console, args);
      try { recordConsole(level, args); } catch { /* 采集失败不影响日志 */ }
    };
  }
}

function snapshot(map) {
  const now = Date.now();
  const out = [];
  for (const [module, v] of map) {
    if (now - v.lastAt > WINDOW_MS) continue;
    out.push({
      module,
      count: v.count,
      lastMessage: v.lastMessage,
      lastAt: new Date(v.lastAt).toISOString(),
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/** 最近 60 分钟的错误/警告汇总 */
export function getRuntimeFailures() {
  return { windowMinutes: WINDOW_MS / 60000, errors: snapshot(errorBuckets), warnings: snapshot(warnBuckets) };
}

/** 测试接缝：清空统计（真机上没有调用点） */
export function resetRuntimeHealth() {
  errorBuckets.clear();
  warnBuckets.clear();
  selfCheck = { llm: null, comfy: null, checkedAt: null };
}

// ── 启动自检 ──
// 启动后跑一次 LLM 与 ComfyUI 的连通性，把结论留下来。
// 目的不是"保证能用"，而是让"配置坏了"这件事在界面上可见，而不是让后台空转几十次。
let selfCheck = { llm: null, comfy: null, checkedAt: null };

export function setSelfCheckResult(patch) {
  selfCheck = { ...selfCheck, ...patch, checkedAt: new Date().toISOString() };
}

export function getSelfCheck() {
  return selfCheck;
}
