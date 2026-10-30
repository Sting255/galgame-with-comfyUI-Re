/**
 * 灵魂引擎 schema 迁移（从上游 v3.9.0 agent-core/src/db/index.js 的 migrateSoulSchema 抽取成独立文件）。
 *
 *   - soul_states：四维能量槽按 character_id 键控落库，跨会话/跨重启延续
 *   - memory_fragments.soul_snapshot：记忆落库那一刻的四维 energy 快照，供召回时反向共鸣
 * 默认开启（config.features.soul）；移除设置页开关后，一次性将旧安装的关闭值迁移为开启。
 * 设计依据 .pai/plan/memory/20261010_灵魂系统最小迁移到邻舍.md。
 */

export function migrateSoulSchema(db) {
  try {
    db.transaction(() => {
      const migrated = db.prepare("SELECT 1 FROM system_settings WHERE setting_key = 'soul_default_enabled_migrated'").get();
      if (migrated) return;
      db.prepare("INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES ('feature_soul', 'true', CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO system_settings (setting_key, setting_value) VALUES ('soul_default_enabled_migrated', '1')").run();
    })();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS soul_states (
        character_id TEXT PRIMARY KEY,
        recall_depth REAL NOT NULL DEFAULT 0,
        impression_depth REAL NOT NULL DEFAULT 0,
        expression_desire REAL NOT NULL DEFAULT 0,
        creativity REAL NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    const columns = new Set(db.prepare(`PRAGMA table_info(memory_fragments)`).all().map(c => c.name));
    if (!columns.has('soul_snapshot')) {
      db.prepare(`ALTER TABLE memory_fragments ADD COLUMN soul_snapshot TEXT NOT NULL DEFAULT ''`).run();
    }
  } catch (err) {
    console.error('[db] migrateSoulSchema error:', err.message);
    throw err;
  }
}
