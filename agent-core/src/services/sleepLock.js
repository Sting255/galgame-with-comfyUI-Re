/**
 * 催眠手机的「无法醒来」开关（2026-11-03 用户：「再在催眠手机里加入一个选项 控制角色无法醒来 持续睡眠
 * 这又是一种全新的玩法 而且是非常好玩的玩法 过程中角色醒来也会有独特的反应」）。
 *
 * 它**不是**新的睡眠系统：睡眠仍然由日程块 + scheduleManager 那一套说了算。这里只做三件事：
 *   1. 记一个**角色级**的锁（开/关 + 到期时刻），跨场景、跨进程都有效
 *   2. 开锁 ＝ 立刻入睡并写一个足够长的睡眠块（走既有的 `forceSleepNow`，不自己造睡块）
 *   3. 关锁 ＝ 立刻唤醒（走既有的 `forceWakeNow`），一个开关就能完整撤销
 *
 * 为什么锁要单独一张表而不是塞进 `character_intimate_scene.forced_sleep`：
 * 亲密场景行是**玩法进行中**的状态，会被开新场景/清空带走；而"她醒不过来"是角色级设定，
 * 没有亲密场景时（比如只是睡觉）也应当生效，且要在她下一次进场景时自动继承。
 * 两张表的关系：场景行上的 `forced_sleep` 是"这个场景里她被锁着"，
 * 本表的锁是"这个角色被锁着"——读取时取并集（见 intimateActionService.getIntimateScene）。
 *
 * 时长口径：最长 `MAX_LOCK_HOURS`（= 日程允许的最大睡眠块 24 小时，见 programTime.MAX_SLEEP_MINUTES）。
 * 给上限是安全阀：忘了关也不会永久把她关在睡眠里，24 小时后自然醒。
 */

import { getDb } from '../db/index.js';
import { getProgramNow, getProgramDateKey, MAX_SLEEP_MINUTES } from './programTime.js';
import { forceSleepNow, forceWakeNow } from './scheduleEditor.js';
import { getSleepStatus } from './scheduleManager.js';

/** 锁最长持续多久（分钟）：与日程允许的单块最长睡眠一致 */
export const MAX_LOCK_MINUTES = MAX_SLEEP_MINUTES;
/** 默认持续多久：用户点一下就是"让她一直睡"，默认给满 24 小时 */
export const DEFAULT_LOCK_MINUTES = MAX_SLEEP_MINUTES;

function toId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/** 'YYYY-MM-DD HH:MM:SS'（程序墙上的本地时间，与 scheduleManager 写入口径一致） */
function toProgramText(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 'YYYY-MM-DDTHH:MM'：`resolveSleepUntil` 认识的绝对时刻写法 */
function toUntilArg(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + `T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function readRow(characterId) {
  try {
    return getDb().prepare(
      'SELECT sleep_lock, sleep_lock_until FROM character_hypnosis WHERE character_id = ?'
    ).get(characterId) || null;
  } catch (err) {
    // 列还没补上（老库首次启动）或读失败：一律当没锁 —— 这是玩法开关，不能把接口打成 500
    console.warn('[sleep-lock] 读取睡眠锁失败（按未锁处理）:', err?.message || err);
    return null;
  }
}

/**
 * 睡眠锁是否生效（角色级）。
 * 到期自动视为关闭（并顺手把标记清掉，避免面板上一直显示"锁着"）。
 * @param {number} characterId
 * @returns {boolean}
 */
export function isSleepLocked(characterId) {
  const id = toId(characterId);
  if (!id) return false;
  const row = readRow(id);
  if (!row || Number(row.sleep_lock) !== 1) return false;
  const until = row.sleep_lock_until ? new Date(String(row.sleep_lock_until).replace(' ', 'T')) : null;
  if (until && Number.isFinite(until.getTime()) && until.getTime() <= getProgramNow().getTime()) {
    try {
      getDb().prepare(
        `UPDATE character_hypnosis SET sleep_lock = 0, sleep_lock_until = NULL, updated_at = datetime('now')
          WHERE character_id = ?`
      ).run(id);
    } catch { /* 清理失败不影响"已过期"这个结论 */ }
    return false;
  }
  return true;
}

/**
 * 锁的完整状态（面板用）。
 * @returns {{locked:boolean, until:string|null, untilText:string, hours:number}}
 */
export function getSleepLockState(characterId) {
  const id = toId(characterId);
  const locked = isSleepLocked(id);
  const row = locked ? readRow(id) : null;
  const until = row?.sleep_lock_until ? String(row.sleep_lock_until) : null;
  return {
    locked,
    until,
    untilText: until ? until.slice(0, 16) : '',
    hours: Math.round(MAX_LOCK_MINUTES / 60),
  };
}

/**
 * 开关睡眠锁。
 *
 * 开：写锁 → 立刻入睡（`forceSleepNow` 写一个到期的睡眠块）。
 * 关：清锁 → 立刻唤醒（`forceWakeNow`）；本来醒着就是幂等空操作。
 *
 * @param {number} characterId
 * @param {boolean} on
 * @param {{minutes?:number}} [options] 仅"开"时有意义，夹在 1~MAX_LOCK_MINUTES
 * @returns {{characterId:number, locked:boolean, until:string|null, sleeping:boolean,
 *            sleepUntil:string|null, reason?:string}}
 */
export function setSleepLock(characterId, on, { minutes } = {}) {
  const id = toId(characterId);
  if (!id) throw new Error('invalid character id');
  const db = getDb();
  const character = db.prepare('SELECT id FROM characters WHERE id = ?').get(id);
  if (!character) {
    const err = new Error('character not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (!on) {
    db.prepare(
      `UPDATE character_hypnosis SET sleep_lock = 0, sleep_lock_until = NULL, updated_at = datetime('now')
        WHERE character_id = ?`
    ).run(id);
    // 关锁 ＝ 放开她：立刻唤醒（本来醒着时 forceWakeNow 幂等，不会动日程）
    forceWakeNow(id);
    const status = getSleepStatus(id);
    return {
      characterId: id,
      locked: false,
      until: null,
      sleeping: Boolean(status.isSleeping),
      sleepUntil: status.sleepUntil || null,
    };
  }

  const raw = Number(minutes);
  const span = Number.isFinite(raw) && raw > 0
    ? Math.min(MAX_LOCK_MINUTES, Math.max(1, Math.round(raw)))
    : DEFAULT_LOCK_MINUTES;
  const untilDate = new Date(getProgramNow().getTime() + span * 60_000);
  db.prepare(
    `INSERT INTO character_hypnosis (character_id, sleep_lock, sleep_lock_until, updated_at)
     VALUES (?, 1, ?, datetime('now'))
     ON CONFLICT(character_id) DO UPDATE SET
       sleep_lock = 1,
       sleep_lock_until = excluded.sleep_lock_until,
       updated_at = datetime('now')`
  ).run(id, toProgramText(untilDate));

  // 立刻入睡：写睡块这一步交给 scheduleEditor（它负责派生链与广播）
  const sleepResult = forceSleepNow(id, { until: toUntilArg(untilDate) });
  const status = getSleepStatus(id);
  return {
    characterId: id,
    locked: true,
    until: toProgramText(untilDate),
    sleeping: Boolean(status.isSleeping),
    sleepUntil: status.sleepUntil || null,
    // 'no_schedule'：她日程被清空过，锁仍然记下了（场景里照样醒不过来），只是没有睡块可写
    reason: sleepResult.ok ? undefined : sleepResult.reason,
  };
}

/** 调试/展示用：当前锁着的角色 id（不做过期清理，调用方需要时自行 isSleepLocked 复核） */
export function listSleepLockedIds() {
  try {
    return getDb().prepare('SELECT character_id FROM character_hypnosis WHERE sleep_lock = 1')
      .all()
      .map((r) => Number(r.character_id))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  } catch {
    return [];
  }
}
