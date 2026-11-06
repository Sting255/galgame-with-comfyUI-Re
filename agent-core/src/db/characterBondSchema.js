/**
 * characterBondSchema.js —— 角色之间的温度表（2026-11-06）
 *
 * 单独成文件是为了避免循环依赖：业务读写放在 services/groupBonds.js（它 import db/index），
 * 迁移放在这里（零依赖，由 db/index 调用）。
 */
export function migrateCharacterBondSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_bonds (
      from_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      to_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      score REAL NOT NULL DEFAULT 0,
      day TEXT NOT NULL DEFAULT '',
      day_delta REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (from_character_id, to_character_id)
    );
  `);
}
