/**
 * 亲密推进动作的**独立每日配额**（成本刹车）
 *
 * 为什么单独一个配额：性爱动作的「立刻反馈」要求**每一下都过一次模型**
 * （`routes/intimateActions.js` ⑤ 即时反应，一次 500 token 的小调用）。
 * 连点推进 / 开自动插送时这是唯一会真的花钱的地方，而现有的两个刹车都不合适：
 *   · `features.touchInstant = false` 是**触摸系统**的总开关，管不到性爱动作，而且一关就全哑；
 *   · 触摸的 `touch_instant_daily_limit`（100/天）是触摸自己的账，混用会让两个玩法互相吃额度。
 * 所以这里按同一个口径再开一本账：**默认 200 次/天，0 = 不限制**。
 *
 * 与触摸/aiJudge 配额完全同口径（照抄它们的语义，别自创）：
 *   · 上限是**全局设置**（`intimate_action_daily_limit`），不是按角色的；
 *   · 计数落 `system_settings`（`intimate_action_quota`，一行 `{ date, used }`），**按本地日期翻篇**、重启不重置；
 *   · 额度用完：状态照常推进（玩法不哑），只是**不调模型**，反应留到她下一轮聊天里演
 *     —— 与「省额度模式」同一个出口，前端拿到的 `mode` 是 `implicit`。
 *
 * 边界：本模块只服务成年角色档案。
 */

import { getDb } from '../db/index.js';
import { localDateKey } from './intimateAiJudge.js';

/** 全局设置键：每天允许跑多少次即时反应（次/天；0 = 不限制） */
export const INTIMATE_ACTION_LIMIT_SETTING_KEY = 'intimate_action_daily_limit';
/** 计数键：一行存"今天用了几次"（JSON { date, used }），跨天自动归零 */
export const INTIMATE_ACTION_QUOTA_SETTING_KEY = 'intimate_action_quota';
/** 用户没配过时的默认上限（与触摸即时反应 100、AI 判断 200 同量级：性爱动作每下必过模型，取 200） */
export const DEFAULT_INTIMATE_ACTION_DAILY_LIMIT = 200;

// 与 intimateAiJudge 同样用 system_settings 的裸 SQL（不复用 db/settings 的 setSetting：
// 它会对没登记进 SETTING_TO_CONFIG 的键打「重启后会丢」的 warn，而本模块是自己读回来的、确实存活）。
function readSettingValue(key) {
  return getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get(key) ?? null;
}

function writeSettingValue(key, value) {
  getDb().prepare(
    'INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
  ).run(key, String(value));
}

/** 配额相关的降级日志只打一次，避免每一下都刷屏 */
let quotaWarned = false;
function warnQuotaOnce(message) {
  if (quotaWarned) return;
  quotaWarned = true;
  console.warn(`[intimateActionQuota] ${message}`);
}

/**
 * 规整 dailyLimit：0（不限制）或正整数有效，其余（负数 / 小数 / 非数字 / 空）返回 null。
 * 与 `normalizeAiJudgeDailyLimit` 逐字同口径 —— 前端两个输入框的校验规则必须一致。
 */
export function normalizeIntimateActionDailyLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 全局每日上限（读不到 / 读坏了就是默认值） */
export function getIntimateActionDailyLimit() {
  try {
    const parsed = normalizeIntimateActionDailyLimit(readSettingValue(INTIMATE_ACTION_LIMIT_SETTING_KEY));
    return parsed === null ? DEFAULT_INTIMATE_ACTION_DAILY_LIMIT : parsed;
  } catch (err) {
    warnQuotaOnce(`读取每日上限失败，按默认 ${DEFAULT_INTIMATE_ACTION_DAILY_LIMIT} 计：${err?.message || err}`);
    return DEFAULT_INTIMATE_ACTION_DAILY_LIMIT;
  }
}

/** 写每日上限；非法值返回 { ok:false }（路由翻成 400），写库失败返回 { ok:false, error } */
export function setIntimateActionDailyLimit(value) {
  const parsed = normalizeIntimateActionDailyLimit(value);
  if (parsed === null) return { ok: false, error: 'dailyLimit must be 0 (unlimited) or a positive integer' };
  try {
    writeSettingValue(INTIMATE_ACTION_LIMIT_SETTING_KEY, parsed);
    return { ok: true, dailyLimit: parsed };
  } catch (err) {
    return { ok: false, error: err?.message || 'failed to persist intimate action dailyLimit' };
  }
}

// 库读写出错时的内存兜底：至少同进程内还算得住（重启会重置，已在 warn 里说明）
let memoryQuota = { date: null, used: 0 };

/** 今天已用次数；null 表示读不到（交给内存兜底） */
function readUsedToday(date) {
  try {
    const raw = readSettingValue(INTIMATE_ACTION_QUOTA_SETTING_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (parsed?.date !== date) return 0;   // 跨天：昨天的不算今天
    const used = Number.parseInt(parsed?.used, 10);
    return Number.isFinite(used) && used > 0 ? used : 0;
  } catch (err) {
    warnQuotaOnce(`配额计数读库失败，暂用内存计数：${err?.message || err}`);
    return null;
  }
}

export function getIntimateActionUsedToday({ now = new Date() } = {}) {
  const date = localDateKey(now);
  const stored = readUsedToday(date);
  if (stored !== null) return stored;
  return memoryQuota.date === date ? memoryQuota.used : 0;
}

/** 配额状态五件套：上限 / 今日已用 / 剩余 / 是否不限制 / 是否耗尽 */
export function buildIntimateActionQuotaStatus(dailyLimit, usedToday) {
  const limit = normalizeIntimateActionDailyLimit(dailyLimit) ?? DEFAULT_INTIMATE_ACTION_DAILY_LIMIT;
  const used = Math.max(0, Number.parseInt(usedToday, 10) || 0);
  const unlimited = limit === 0;
  return {
    dailyLimit: limit,
    usedToday: used,
    // 不限制时剩余次数没有意义，如实给 null（不编一个大数字）
    remaining: unlimited ? null : Math.max(0, limit - used),
    unlimited,
    exhausted: !unlimited && used >= limit,
  };
}

export function getIntimateActionQuotaStatus({ now = new Date() } = {}) {
  const date = localDateKey(now);
  const stored = readUsedToday(date);
  const used = stored !== null ? stored : (memoryQuota.date === date ? memoryQuota.used : 0);
  return buildIntimateActionQuotaStatus(getIntimateActionDailyLimit(), used);
}

/** 给接口用的精简载荷（与 GET /api/config 的 aiJudge 同形状，前端两种取法都能用） */
export function getIntimateActionQuotaPayload({ now = new Date() } = {}) {
  const status = getIntimateActionQuotaStatus({ now });
  return {
    dailyLimit: status.dailyLimit,
    usedToday: status.usedToday,
    remaining: status.remaining,
    unlimited: status.unlimited,
  };
}

/** 真正要调模型之前消耗一次配额；返回消耗后的状态 */
export function consumeIntimateActionQuota({ now = new Date() } = {}) {
  const date = localDateKey(now);
  const stored = readUsedToday(date);
  const base = stored !== null ? stored : (memoryQuota.date === date ? memoryQuota.used : 0);
  const used = base + 1;
  memoryQuota = { date, used };
  try {
    writeSettingValue(INTIMATE_ACTION_QUOTA_SETTING_KEY, JSON.stringify({ date, used }));
  } catch (err) {
    warnQuotaOnce(`配额计数写库失败，计数暂只存在内存：${err?.message || err}`);
  }
  return buildIntimateActionQuotaStatus(getIntimateActionDailyLimit(), used);
}

/** 测试用：清掉进程内计数与降级日志开关（库里的计数由用例自己清） */
export function __resetIntimateActionQuotaForTest() {
  memoryQuota = { date: null, used: 0 };
  quotaWarned = false;
}
