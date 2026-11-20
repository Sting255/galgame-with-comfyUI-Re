/**
 * ComfyUI 可达熔断（2026-11-20，规划 N1 / A1）。
 *
 * 动机（logs/backend-2026-11-19.log）：ComfyUI 没开的 14 小时里，媒体模块每批出刊都去生图，
 * 每张图走满「4 次连接 × 3s/9s/15s 等待」才放弃 —— 共 1120 条 attempt 失败日志、281 张图白等，
 * 出刊文字却一直挂着「等待配图后发布」，用户什么也看不到。
 *
 * 这里只维护一件事：**ComfyUI 现在连不连得上**。
 *   - 一整轮提交重试都是「连不上」类错误 ⇒ 进入离线（open）；
 *   - 离线期间按 30s → 60s → … → 5min 指数退避探测 `/system_stats`；
 *   - 任意一次真实提交成功、或 ComfyUI 有响应（哪怕是拒绝）、或探测成功 ⇒ 恢复，并通知订阅方补图。
 *
 * 离线时的行为由调用方决定（imageSkill 让后台请求直接失败、用户请求先探测一次；
 * 媒体把文字先发出去、配图记账等恢复）。本模块不依赖任何业务模块，避免循环导入。
 */
import { config } from '../config.js';

/** 连续几轮「整轮都连不上」才进入离线。一轮本身已含 4 次连接、约 27 秒，1 轮足够说明问题。 */
const OPEN_AFTER_ROUNDS = 1;
const PROBE_MIN_MS = 30_000;
const PROBE_MAX_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 2_500;
/** 离线期间汇总日志的间隔：只说「还离线、跳过了几次」，不逐条刷屏 */
const SUMMARY_INTERVAL_MS = 10 * 60_000;

const state = {
  offline: false,
  failedRounds: 0,
  since: 0,
  lastError: '',
  skipped: 0,
  probeDelayMs: PROBE_MIN_MS,
  nextProbeAt: 0,
  lastSummaryAt: 0,
};
let probeTimer = null;
let probing = null;
const recoveredListeners = new Set();

function comfyBase() {
  return String(config.comfyui?.url || 'http://localhost:8188').replace(/\/+$/, '');
}

function clearProbeTimer() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  state.nextProbeAt = 0;
}

function scheduleProbe() {
  clearProbeTimer();
  state.nextProbeAt = Date.now() + state.probeDelayMs;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    probeComfyNow().then(ok => {
      if (ok || !state.offline) return;
      state.probeDelayMs = Math.min(state.probeDelayMs * 2, PROBE_MAX_MS);
      maybeLogSummary();
      scheduleProbe();
    });
  }, state.probeDelayMs);
  if (typeof probeTimer.unref === 'function') probeTimer.unref();
}

function maybeLogSummary(now = Date.now()) {
  if (!state.offline || now - state.lastSummaryAt < SUMMARY_INTERVAL_MS) return;
  state.lastSummaryAt = now;
  const minutes = Math.round((now - state.since) / 60_000);
  console.log(`[comfyGate] ComfyUI 仍连不上（已 ${minutes} 分钟），期间跳过 ${state.skipped} 次生图；`
    + `下次探测约 ${Math.round(state.probeDelayMs / 1000)} 秒后`);
}

function goOffline(error) {
  state.offline = true;
  state.since = Date.now();
  state.lastSummaryAt = state.since;
  state.skipped = 0;
  state.probeDelayMs = PROBE_MIN_MS;
  console.warn(`[comfyGate] ComfyUI 连不上，进入离线保护：后台生图暂停，文字内容照常发布；`
    + `${Math.round(PROBE_MIN_MS / 1000)} 秒后开始探测（${comfyBase()}）。最后错误：${error || '未知'}`);
  scheduleProbe();
}

function goOnline(reason) {
  const wasOffline = state.offline;
  state.failedRounds = 0;
  state.lastError = '';
  if (!wasOffline) return;
  const minutes = Math.round((Date.now() - state.since) / 60_000);
  const skipped = state.skipped;
  state.offline = false;
  state.since = 0;
  state.skipped = 0;
  state.probeDelayMs = PROBE_MIN_MS;
  clearProbeTimer();
  console.log(`[comfyGate] ComfyUI 已恢复（${reason}；离线约 ${minutes} 分钟、跳过 ${skipped} 次生图），开始补图`);
  for (const listener of [...recoveredListeners]) {
    try {
      const pending = listener();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(err => console.warn('[comfyGate] 恢复回调失败:', err?.message || err));
      }
    } catch (err) {
      console.warn('[comfyGate] 恢复回调失败:', err?.message || err);
    }
  }
}

/**
 * 记录一次真实提交的最终结果（由 imageSkill 在整轮重试结束后调用）。
 * @param {{ok: boolean, unreachable?: boolean, error?: string}} outcome
 *   ok=true 提交成功；ok=false 且 unreachable=true 表示整轮都连不上；
 *   ok=false 且 unreachable=false 表示 ComfyUI 有响应但拒绝（缺节点、超时等），说明它在线。
 */
export function recordComfyOutcome({ ok, unreachable = false, error = '' } = {}) {
  if (ok || !unreachable) {
    goOnline(ok ? '生图成功' : 'ComfyUI 有响应');
    return;
  }
  state.lastError = String(error || '').slice(0, 200);
  state.failedRounds += 1;
  if (!state.offline && state.failedRounds >= OPEN_AFTER_ROUNDS) goOffline(state.lastError);
}

/** 当前是否处于离线保护 */
export function isComfyOffline() {
  return state.offline;
}

/** 离线期间被直接跳过的生图请求计一次（只用于汇总日志与状态面板） */
export function noteComfySkipped() {
  if (!state.offline) return;
  state.skipped += 1;
  maybeLogSummary();
}

/**
 * 立刻探测一次（并发调用共用同一次请求）。成功则恢复并通知订阅方。
 * @returns {Promise<boolean>}
 */
export function probeComfyNow(timeoutMs = PROBE_TIMEOUT_MS) {
  if (probing) return probing;
  probing = (async () => {
    try {
      const res = await fetch(`${comfyBase()}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return false;
      goOnline('探测成功');
      return true;
    } catch {
      return false;
    } finally {
      probing = null;
    }
  })();
  return probing;
}

/**
 * 订阅「离线 → 恢复」。回调可返回 Promise；异常只记日志，不影响其它订阅方。
 * @returns {() => void} 取消订阅
 */
export function onComfyRecovered(listener) {
  recoveredListeners.add(listener);
  return () => recoveredListeners.delete(listener);
}

/** ComfyUI 地址改了：旧的离线判断不再可信，立即按新地址探测一次。 */
export function resetComfyAvailability() {
  state.failedRounds = 0;
  if (!state.offline) return;
  state.probeDelayMs = PROBE_MIN_MS;
  clearProbeTimer();
  probeComfyNow().then(ok => { if (!ok && state.offline) scheduleProbe(); });
}

/** 设置页「运行状态」用 */
export function getComfyAvailability() {
  return {
    offline: state.offline,
    sinceMs: state.offline ? Date.now() - state.since : 0,
    skipped: state.skipped,
    nextProbeInMs: state.offline && state.nextProbeAt ? Math.max(0, state.nextProbeAt - Date.now()) : null,
    lastError: state.lastError,
  };
}
