/**
 * 默认助手（生图助手）的总开关（2026-11-08 用户要求）。
 *
 * 背景：默认助手是 seed 出来的一个生图助手人格（name='default'），用户明确说「完全用不上」。
 * 但它不能简单删掉就完事 —— 真机上他的痛点是：**对所有人下覆盖设置或批量命令时，
 * 它会被一起拉起来**，白占一次执行、还在工作卡里多出一行。删掉也会被 seed 复活（见 seedData）。
 *
 * 所以做成一个开关（system_settings.default_assistant_enabled）：
 *   · 缺省 = 启用（与加这个开关之前的行为逐字节一致）
 *   · 关掉 = 不进角色列表、不被「对所有人」的批量任务带上（日程那边一直按 name 排除，与本开关无关）
 */

export const DEFAULT_ASSISTANT_SETTING_KEY = 'default_assistant_enabled';
export const DEFAULT_ASSISTANT_NAME = 'default';

/** 开关状态；没写过这个设置时按「启用」算，保持历史行为 */
export function isDefaultAssistantEnabled(db) {
  try {
    const row = db.prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').get(DEFAULT_ASSISTANT_SETTING_KEY);
    if (!row) return true;
    return String(row.setting_value) !== '0';
  } catch {
    // system_settings 还没迁移完（极早期启动）→ 按启用处理，绝不因为读不到设置就崩
    return true;
  }
}

export function setDefaultAssistantEnabled(db, enabled) {
  const value = enabled ? '1' : '0';
  db.prepare(
    `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(DEFAULT_ASSISTANT_SETTING_KEY, value);
  console.log(`[characters] 默认助手开关 → ${enabled ? '启用' : '停用'}`);
  return enabled;
}

/**
 * 给「所有角色」这类范围查询拼的 SQL 片段：开关关掉时把默认助手排除在外。
 * 用片段而不是改写每条查询，是为了让每个调用点自己决定拼在哪（有的查 id，有的查整行）。
 * @param {string} column 用来判断角色身份的列，默认 name
 */
export function excludeDefaultAssistantClause(db, column = 'name') {
  return isDefaultAssistantEnabled(db) ? '' : ` AND ${column} != '${DEFAULT_ASSISTANT_NAME}'`;
}
