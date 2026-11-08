/**
 * 角色作用域（2026-11-08 用户要求根治）
 *
 * 问题：默认助手（生图助手，name='default'）同时是「一个角色行」+「一个内置人格」+
 * 「所有人集合的成员」。于是任何「遍历所有角色」的链路都会不知不觉把它带上 ——
 * 批量覆盖设置、日程生成、事件、朋友圈、回复队列……以前是在每个调用点手工写
 * `name != 'default'`，加一条新链路就会漏一次。
 *
 * 口径：characters.is_system = 1 表示**系统内置角色**，不属于用户的角色集合。
 *   · 面向用户的角色集合（列表、批量、后台生成、遍历）→ 一律带 is_system 过滤
 *   · 按 id 取单个角色（`WHERE id = ?`）→ 不过滤：用户点到它时仍可查看/编辑/聊天
 *   · 默认助手开关（system_settings.default_assistant_enabled）只决定它**是否出现在列表里**，
 *     不改变「后台自动化永远跳过系统角色」这条底线
 *
 * 用法：
 *   const rows = db.prepare(`SELECT * FROM characters WHERE ${USER_SCOPE} ORDER BY id`).all();
 *   const rows = db.prepare(`SELECT c.* FROM characters c WHERE ${USER_SCOPE_ALIASED} AND ...`).all();
 *   // 已经在 WHERE 里的，用 AND 追加：
 *   `SELECT ... FROM characters WHERE schedule_enabled=1 AND ${USER_SCOPE}`
 */

import { isDefaultAssistantEnabled } from './defaultAssistant.js';

/** 没有表别名时的过滤条件（COALESCE 兼容老库未迁移/写空的情形） */
export const USER_SCOPE = 'COALESCE(is_system, 0) = 0';

/** 表别名 c 时的过滤条件 */
export const USER_SCOPE_ALIASED = 'COALESCE(c.is_system, 0) = 0';

/** 判断某一角色行是不是系统内置角色（老库可能为 NULL/0） */
export function isSystemCharacter(character) {
  return Number(character?.is_system || 0) === 1;
}

/** 用户的角色集合里是否需要它：系统角色默认不进集合（供需要在内存里过滤的调用点用） */
export function isUserCharacter(character) {
  return !isSystemCharacter(character);
}

/**
 * 「角色列表」用的作用域：跟随默认助手开关。
 * 启用时把系统角色也列出来（用户可以点进去聊天），停用时列表里只剩用户角色。
 * 注意这只影响**显示**：后台自动化永远用 USER_SCOPE，不受开关影响。
 */
export function userVisibleScope(db) {
  return isDefaultAssistantEnabled(db) ? '1=1' : USER_SCOPE;
}
