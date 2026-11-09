/**
 * 后台发布前闸门（2026-11-09，方案 A03）
 *
 * ── 解决什么问题 ──
 *
 * 后台自动产生的内容（信件、媒体、事件提醒、朋友圈…）流程都是：
 * 「到点挑候选人 → 异步生成文本与图片（几十秒到几分钟）→ 落库 → 广播给用户」。
 *
 * 以前的状态校验只发生在**第一步**：候选 SQL 里带上 `is_sleeping = 0`、`events_disabled = 0`。
 * 但生成要花时间，等结果出来时角色可能已经睡着、被关掉对应开关、甚至被删除 ——
 * 于是「生成时醒着、公开时已睡着」这段时间差里，内容照样发到了用户眼前。
 *
 * 真机已经踩过三次同类问题（默认外观被生成覆盖、日程拍照漏身份锚点、群聊全员睡眠仍说话），
 * 所以这里做成**唯一判定入口**：调度层挑候选用它，落库/公开前再用它复查一次。
 *
 * ── 设计口径 ──
 *
 * · 睡眠判定只调 `scheduleManager.isSleeping()`（全仓唯一判定点），不自己拿时间算。
 * · 开关按入口传 `flag`：朋友圈看 moments_disabled、主动聊天看 proactive_disabled、
 *   奇遇看 events_disabled、日程看 schedule_enabled。
 * · 后台自动化永远跳过系统内置角色（`is_system = 1`），不受「默认助手开关」影响 ——
 *   那个开关只管它是否出现在用户列表里。
 * · 理由要能区分「可恢复」与「不可恢复」：睡眠/关开关是临时的，给 retryAt；
 *   角色删除是终态，不给。调用方据此决定「延期」还是「丢弃」，不要一律当失败重试。
 *
 * ── 用法 ──
 *
 *   import { checkCharacterPublishable } from './publishGate.js'
 *
 *   // 调度层挑候选（可选：SQL 里已经筛过，这里再兜一次）
 *   const gate = checkCharacterPublishable(db, charId, { flag: 'moments_disabled' })
 *   if (!gate.allowed) { ... }
 *
 *   // 落库 / 广播前复查（**必做**）
 *   const final = checkCharacterPublishable(db, charId, { flag: 'moments_disabled' })
 *   if (!final.allowed) {
 *     if (final.retryAt) { deferTo(final.retryAt); return }   // 可恢复：延期，不扣额度
 *     return                                                   // 终态：丢弃
 *   }
 *   // 只有通过闸门才写库 / 广播
 *
 * 注意：这个 helper 只做**判定**，不做延期调度 —— 延期队列由各入口按自己的表去存
 * （reply_queue、moment_comment_queue 各有一套）。把调度逻辑塞进来会让它变成一个
 * 谁都依赖的巨型服务，反而不好改。
 */

import { getDb } from '../db/index.js';
import { isSleeping } from './scheduleManager.js';

/** 各入口对应的角色开关列。key 是调用方传的 flag 名。 */
const FLAG_COLUMNS = {
  moments_disabled: 'moments_disabled',
  proactive_disabled: 'proactive_disabled',
  events_disabled: 'events_disabled',
  schedule_enabled: 'schedule_enabled',
};

/** 判定结果不可用的理由 */
export const GATE_REASON = {
  OK: 'ok',
  NOT_FOUND: 'character_deleted',   // 终态：角色已被删除
  SYSTEM: 'system_character',       // 终态：系统内置角色不参与后台自动化
  SLEEPING: 'sleeping',             // 可恢复：等醒
  FLAG_OFF: 'feature_disabled',     // 可恢复：等用户重新打开
};

/**
 * 判断某角色此刻是否可以被后台流程公开内容。
 *
 * @param {object} db better-sqlite3 句柄
 * @param {number|string} characterId
 * @param {object} [opts]
 * @param {string} [opts.flag] 要检查的角色开关列名（见 FLAG_COLUMNS）；不传则只查睡眠
 * @param {boolean} [opts.skipSleepCheck] 跳过睡眠判定（用于「历史提及」这类不要求本人醒着的场景）
 * @param {boolean} [opts.allowSystem] 允许系统内置角色（默认 false）
 * @returns {{ allowed: boolean, reason: string, retryAt: string|null, detail: object }}
 */
export function checkCharacterPublishable(db, characterId, opts = {}) {
  const handle = db || getDb();
  const id = Number(characterId);

  if (!Number.isFinite(id) || id <= 0) {
    return deny(GATE_REASON.NOT_FOUND, null, { characterId });
  }

  const row = handle.prepare(
    'SELECT id, display_name, COALESCE(is_system, 0) AS sys, is_sleeping, sleep_until, '
    + 'moments_disabled, proactive_disabled, events_disabled, schedule_enabled '
    + 'FROM characters WHERE id = ?'
  ).get(id);

  // 生成期间被删掉了 —— 不产生无效署名、不反复重试
  if (!row) return deny(GATE_REASON.NOT_FOUND, null, { characterId: id });

  // 后台自动化永远跳过系统角色，与「默认助手开关」无关
  if (row.sys === 1 && !opts.allowSystem) {
    return deny(GATE_REASON.SYSTEM, null, { characterId: id, name: row.display_name });
  }

  // 开关：用户把它关了，这一轮就不该公开
  if (opts.flag) {
    const column = FLAG_COLUMNS[opts.flag];
    if (!column) {
      // 传了不认识的 flag 是调用方的 bug，不要静默放过
      throw new Error(`publishGate: unknown flag "${opts.flag}"`);
    }
    if (row[column] === 1) {
      // schedule_enabled 语义相反：1 = 开，0 = 关；其余 *_disabled 是 1 = 关
      if (column !== 'schedule_enabled') {
        return deny(GATE_REASON.FLAG_OFF, null, { characterId: id, name: row.display_name, flag: column });
      }
    } else if (column === 'schedule_enabled') {
      return deny(GATE_REASON.FLAG_OFF, null, { characterId: id, name: row.display_name, flag: column });
    }
  }

  // 睡眠：唯一判定点是 scheduleManager.isSleeping（它会顺手纠正 DB 里的陈旧标志）
  if (!opts.skipSleepCheck) {
    const state = isSleeping(id);
    if (state.sleeping) {
      return deny(GATE_REASON.SLEEPING, state.sleepUntil || null, {
        characterId: id,
        name: row.display_name,
        sleepKind: state.kind,
      });
    }
  }

  return { allowed: true, reason: GATE_REASON.OK, retryAt: null, detail: { characterId: id, name: row.display_name } };
}

/**
 * 批量版：把一组角色逐个过闸门，返回可通过的与不可通过的。
 *
 * 多人同场（群聊、多人奇遇、媒体多角色）用它一次判完，避免调用点自己循环时
 * 漏掉某个人或者把「被提及」误当「要发言」。
 *
 * @returns {{ allowed: number[], blocked: Array<{id:number, reason:string, retryAt:string|null}> }}
 */
export function filterPublishable(db, characterIds, opts = {}) {
  const allowed = [];
  const blocked = [];
  for (const id of (Array.isArray(characterIds) ? characterIds : [])) {
    const gate = checkCharacterPublishable(db, id, opts);
    if (gate.allowed) allowed.push(Number(id));
    else blocked.push({ id: Number(id), reason: gate.reason, retryAt: gate.retryAt });
  }
  return { allowed, blocked };
}

function deny(reason, retryAt, detail) {
  return { allowed: false, reason, retryAt: retryAt || null, detail };
}
