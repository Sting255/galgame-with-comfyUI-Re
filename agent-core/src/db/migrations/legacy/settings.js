import { config } from '../../../config.js';


/**
 * 迁移: town_newspapers 加 world_dismissed 列（默认 0）。
 * 读者可在日报里手动「消除影响」当天世界状态；旧库缺列时补齐。
 */
export function migrateNewspaperWorldDismissed(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(town_newspapers)`).all();
    if (!cols.length) return; // 表还没建（新库走 CREATE TABLE 分支）
    if (!cols.find(c => c.name === 'world_dismissed')) {
      db.exec(`ALTER TABLE town_newspapers ADD COLUMN world_dismissed INTEGER NOT NULL DEFAULT 0`);
      console.log('[db] Added town_newspapers.world_dismissed column (default 0)');
    }
  } catch (err) {
    console.log('[db] migrateNewspaperWorldDismissed error:', err.message);
  }
}


// 迁移: LLM 多套配置切换 — 从当前 .env 生成默认 profile
export function migrateLlmProfiles(db) {
  try {
    const existing = db.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'llm_profiles'`).get();
    if (existing) return;

    const now = new Date().toISOString();
    const defaultProfile = {
      id: 'p_' + Date.now(),
      name: '默认配置',
      connectionType: config.llm.connectionType,
      vertexRegion: config.llm.vertexRegion,
      vertexServiceAccount: config.llm.vertexServiceAccount,
      apiKey: config.llm.apiKey || '',
      baseURL: config.llm.baseURL || 'https://api.deepseek.com',
      model: config.llm.model || 'deepseek-flash',
      headers: config.llm.headers || {},
      extraBody: config.llm.extraBody || {},
      serializeBackgroundLLM: config.features.serializeBackgroundLLM || false,
      mergeMessages: config.features.mergeMessages || false,
      backgroundConcurrency: config.features.backgroundLLMMaxConcurrency || 3,
      createdAt: now,
    };

    const profiles = [defaultProfile];
    db.prepare(`INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
      .run('llm_profiles', JSON.stringify(profiles));
    db.prepare(`INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
      .run('active_llm_profile_id', defaultProfile.id);
    console.log('[db] migrateLlmProfiles: created default profile from current config');
  } catch (err) {
    console.log('[db] migrateLlmProfiles error:', err.message);
  }
}


// 迁移: 将 global_rules.world_setting 移至 world_settings 表（idempotent）
export function migrateWorldSettings(db) {
  try {
    const existing = db.prepare(`SELECT rule_content FROM global_rules WHERE rule_key = 'world_setting'`).get();
    if (!existing) return;

    const raw = existing.rule_content || '';
    const match = raw.match(/^<world_setting>\s*([\s\S]*?)\s*<\/world_setting>$/);
    const content = match ? match[1] : raw;

    const already = db.prepare(`SELECT id FROM world_settings`).get();
    if (content.trim() && !already) {
      db.prepare(
        `INSERT INTO world_settings (name, content, is_active, sort_order) VALUES (?, ?, 1, 0)`
      ).run('默认世界观', content);
      console.log('[db] migrateWorldSettings: moved existing world_setting to world_settings table');
    }

    // 迁移后删除旧行：残留会导致 getWorldSetting 回退时读到过期世界观
    db.prepare(`DELETE FROM global_rules WHERE rule_key = 'world_setting'`).run();
    console.log('[db] migrateWorldSettings: removed legacy global_rules.world_setting row');
  } catch (err) {
    console.log('[db] migrateWorldSettings error:', err.message);
  }
}


// 空表补一套默认激活世界观（idempotent：仅在 world_settings 无任何行时插入）
export function seedDefaultWorldSetting(db) {
  try {
    const already = db.prepare(`SELECT id FROM world_settings LIMIT 1`).get();
    if (already) return;
    db.prepare(
      `INSERT INTO world_settings (name, content, is_active, sort_order) VALUES (?, '', 1, 0)`
    ).run('默认世界观');
    console.log('[db] seedDefaultWorldSetting: created default active world setting');
  } catch (err) {
    console.log('[db] seedDefaultWorldSetting error:', err.message);
  }
}


// 清理历史遗留的 system_settings 键（idempotent）
export function migrateSystemSettings(db) {
  // 合并 feature_memoryExtract → feature_memory（v2 迁移）
  const oldExtract = db.prepare(
    `SELECT setting_value FROM system_settings WHERE setting_key = 'feature_memoryExtract'`
  ).get();
  if (oldExtract) {
    if (oldExtract.setting_value === 'true') {
      db.prepare(
        `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES ('feature_memory', 'true', CURRENT_TIMESTAMP)`
      ).run();
      console.log('[db] migration: merged feature_memoryExtract=true → feature_memory=true');
    }
    db.prepare(`DELETE FROM system_settings WHERE setting_key = 'feature_memoryExtract'`).run();
    console.log('[db] migration: removed orphaned feature_memoryExtract row');
  }

  // 清理旧的 snake_case 键（v1 迁移）
  const OLD_SNAKE_CASE_KEYS = [
    'feature_memory_extract', 'feature_auto_image_judge', 'feature_prompt_optimize',
    'feature_reply_guesses', 'feature_force_image_gen',
  ];
  const cleaned = db.prepare(
    `DELETE FROM system_settings WHERE setting_key IN (${OLD_SNAKE_CASE_KEYS.map(() => '?').join(',')})`
  ).run(...OLD_SNAKE_CASE_KEYS);
  if (cleaned.changes > 0) {
    console.log(`[db] system_settings: cleaned ${cleaned.changes} legacy snake_case key(s)`);
  }
}
