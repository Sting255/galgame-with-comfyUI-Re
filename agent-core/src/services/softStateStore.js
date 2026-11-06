/**
 * 软状态落库（2026-10-15）—— 通用「单键 JSON 记忆」小工具
 *
 * ## 背景
 * 仓里有若干「进程内变量、重启即丢」的软状态（`接手必读.md` §6.3-11）：
 *   · `imageSkill.lastHighTime` —— 高优先生图任务的时刻，决定低优队列的静默期与防饿死判定；
 *   · `chat.imageJudgeCounters` / `chat.guessCooldowns` —— 每会话的智能配图配额与候选词冷却。
 * 重启后这些归零/清空的表现：`lastHighTime` 变成 0 ⇒ 静默期判定被绕过；
 * 计数变空 ⇒ 下一次读取回落到默认配额，而默认值恰是"满额"。
 *
 * 为什么用「单键 JSON」而不是给每个会话开一张表：这些状态都是**小而短命**的
 * （计数几小时归零、冷却 20 秒、静默期 3 分钟），按行写库反而是负担；
 * 一张 `system_settings` 里的 JSON 键足够，且**完全复用既有读写口径**
 * （与 `intimateActionQuota` / `touch` 配额同一张表的裸 SQL 习惯一致）。
 *
 * ## 契约
 *   · 懒加载：第一次 `load()` 才读库（模块 import 期不碰 DB —— 避免迁移顺序问题）；
 *   · 写入去抖：`schedule()` 默认 1 秒合并一次写；进程被杀时最多丢 1 秒内的增量（可接受）；
 *   · 读失败**不炸**：读坏一律回空 Map（软状态丢了不该拖垮主流程）；
 *   · 只认 JSON 对象：数组 / 非对象一律当作空（防脏数据把 Map 变成垃圾箱）。
 *
 * 边界：本模块只做「记忆」，不负责业务语义 —— 计数怎么算、冷却多久由调用方决定。
 */

import { getDb } from '../db/index.js';

/** 软状态键名的统一前缀（方便一眼认出哪些是这类东西） */
export const SOFT_STATE_PREFIX = 'soft_state_';

/** 单个软状态的序列化大小上限（超过就不落库，只留内存 —— 防止某个键把 system_settings 撑爆） */
const MAX_BYTES = 64 * 1024;

/** 单个软状态的条目数上限（超出按插入顺序淘汰最旧的；见 prune 的说明） */
const DEFAULT_MAX_ENTRIES = 500;

// 与 services/intimateAiJudge.js 同样用 system_settings 的裸 SQL：
// 不复用 db/settings 的 setSetting —— 它会对没登记进 SETTING_TO_CONFIG 的键打「重启后会丢」的 warn，
// 而本模块是自己读回来的、确实存活。
function readSettingValue(key) {
  return getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get(key) ?? null;
}

function writeSettingValue(key, value) {
  getDb().prepare(
    'INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
  ).run(key, String(value));
}

/**
 * 为一个软状态键建一份「内存 Map + 落库」的视图。
 *
 * @param {string} key 不带前缀的键名（本函数会自动加 `soft_state_` 前缀，避免与其它设置撞名）
 * @param {{ debounceMs?: number, maxEntries?: number }} [opts]
 *        `debounceMs` 写入去抖（默认 1000ms）；`maxEntries` 条目上限（默认 500，
 *        超出按**插入顺序**淘汰最旧的 —— 见 `prune()` 的说明）
 * @returns {{get:Function, set:Function, delete:Function, clear:Function, load:Function, size:Function, flush:Function, key:string}}
 */
export function createSoftState(key, opts = {}) {
  const fullKey = key.startsWith(SOFT_STATE_PREFIX) ? key : `${SOFT_STATE_PREFIX}${key}`;
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 1000;
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
    ? Math.floor(opts.maxEntries)
    : DEFAULT_MAX_ENTRIES;
  let map = null;         // 懒加载：null = 还没读过库
  let timer = null;

  /**
   * 条目上限：超了按**插入顺序**淘汰最旧的。
   * ⚠️ 是"插入顺序"不是"最近使用顺序" —— 这里刻意不做 LRU：软状态的键是
   * `char_<id>` / `group_<id>` 这类**有界**标识，数量本来就上不去；
   * 而 LRU 要维护访问顺序，反而把一份"便宜的小记忆"做成需要小心维护的状态。
   * 真出现爆炸式增长（比如真的按会话 id 无限裂开），那是调用方该修的地方，不该靠这里兜。
   */
  function prune() {
    if (map.size <= maxEntries) return;
    const overflow = map.size - maxEntries;
    let dropped = 0;
    for (const k of map.keys()) {
      if (dropped >= overflow) break;
      map.delete(k);
      dropped += 1;
    }
    console.warn(`[softState] ${fullKey} 超过条目上限 ${maxEntries}，按插入顺序淘汰了 ${dropped} 条`);
  }

  function load() {
    if (map) return map;
    map = new Map();
    try {
      const raw = readSettingValue(fullKey);
      if (!raw) return map;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) map.set(k, v);
      }
    } catch (err) {
      console.warn(`[softState] 读取 ${fullKey} 失败，按空状态继续：${err?.message || err}`);
      map = new Map();   // 读坏也别半坏着用
    }
    return map;
  }

  function persistNow() {
    try {
      const obj = Object.fromEntries(map || new Map());
      const serialized = JSON.stringify(obj);
      if (serialized.length > MAX_BYTES) {
        console.warn(`[softState] ${fullKey} 序列化后超过 ${Math.round(MAX_BYTES / 1024)}KB，本次不落库（仅内存）`);
        return;
      }
      writeSettingValue(fullKey, serialized);
    } catch (err) {
      console.warn(`[softState] 写入 ${fullKey} 失败（内存继续有效，重启会丢）：${err?.message || err}`);
    }
  }

  function schedule() {
    if (debounceMs <= 0) { persistNow(); return; }
    if (timer) return;
    timer = setTimeout(() => { timer = null; persistNow(); }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();   // 不要因为这份定时器拖住进程退出
  }

  return {
    /** 读一个键；不存在/没加载过给 undefined */
    get(k) { return load().get(String(k)); },
    /** 写一个键并安排落库（超过 maxEntries 时按插入顺序淘汰最旧的） */
    set(k, v) { load().set(String(k), v); prune(); schedule(); },
    /** 删一个键并安排落库 */
    delete(k) { load().delete(String(k)); schedule(); },
    /** 清空并立刻落库（用于「重置软状态」这类操作） */
    clear() { map = new Map(); persistNow(); },
    /** 手动触发一次落库（收尾/测试用） */
    flush() { if (timer) { clearTimeout(timer); timer = null; } if (map) persistNow(); },
    /** 强制读库（测试用；正常路径靠懒加载即可） */
    load,
    /** 当前条数（测试/观测用） */
    size() { return load().size; },
    /** 这份软状态背后的键名（观测用） */
    key: fullKey,
  };
}
