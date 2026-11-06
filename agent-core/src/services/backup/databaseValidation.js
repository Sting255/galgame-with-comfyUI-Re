import Database from 'better-sqlite3';

/** 只读检查 staging，不运行迁移、不接触当前数据库。旧版附加表可由正常迁移补齐。 */
export function validateBackupDatabase(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const result = db.pragma('integrity_check');
    if (result.length !== 1 || result[0].integrity_check !== 'ok') {
      throw new Error('SQLite 完整性检查未通过');
    }
    for (const [table, required] of Object.entries({
      characters: ['id', 'name', 'display_name', 'base_prompt'],
      messages: ['id', 'conversation_id', 'role', 'content'],
      system_settings: ['setting_key', 'setting_value'],
    })) {
      const columns = new Set(db.pragma(`table_info(${table})`).map(row => row.name));
      if (required.some(column => !columns.has(column))) throw new Error(`缺少邻舍数据表或字段：${table}`);
    }
  } finally {
    db?.close();
  }
}
