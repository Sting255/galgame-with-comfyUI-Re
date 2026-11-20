import fs from 'fs';
import path from 'path';
export { migrateTownSchema } from '../../townSchema.js';
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('../../', import.meta.url));
export { createTownActorRegistry, cleanupTownDialogueRequests };
import { createTownActorRegistry } from '../../../services/town/townActorRegistry.js';
import { cleanupTownDialogueRequests } from '../../../services/town/townDialogueRequests.js';


export function migrateTownEncounterOutcome(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(town_encounters)`).all();
    if (!cols.length) return; // 表还没建（新库走 CREATE TABLE 分支）
    if (!cols.find(c => c.name === 'outcome_json')) {
      db.exec(`ALTER TABLE town_encounters ADD COLUMN outcome_json TEXT DEFAULT NULL`);
      console.log('[db] Added town_encounters.outcome_json column (default NULL)');
    }
    if (!cols.find(c => c.name === 'polished_summary')) {
      db.exec(`ALTER TABLE town_encounters ADD COLUMN polished_summary TEXT DEFAULT ''`);
      console.log('[db] Added town_encounters.polished_summary column (default \'\')');
    }
  } catch (err) {
    console.log('[db] migrateTownEncounterOutcome error:', err.message);
  }
}


/**
 * 迁移: AI 小镇 v2（瓦片地图 + 素材库 + 轻量 NPC）
 * - town_maps 加 layers_json / tile_size / world_setting_id / version
 * - town_locations 加 object_id
 * - town_players 加 sprite_asset_id / appearance_desc
 * 新表（town_assets / town_npcs / town_npc_chat_messages）由 CREATE TABLE IF NOT EXISTS 建出
 */
export function migrateTownV2Schema(db) {
  try {
    const mapCols = db.prepare(`PRAGMA table_info(town_maps)`).all();
    if (mapCols.length > 0 && !mapCols.find(c => c.name === 'layers_json')) {
      db.exec(`ALTER TABLE town_maps ADD COLUMN layers_json TEXT`);
      db.exec(`ALTER TABLE town_maps ADD COLUMN tile_size INTEGER DEFAULT 32`);
      db.exec(`ALTER TABLE town_maps ADD COLUMN world_setting_id INTEGER`);
      db.exec(`ALTER TABLE town_maps ADD COLUMN version INTEGER DEFAULT 1`);
      console.log('[db] Added town_maps v2 columns (layers_json/tile_size/world_setting_id/version)');
    }
    // v1→v2 行为切换（once 标记）：v1 默认全员进镇；v2 角色默认不进镇（管理面板里手动入住）
    const marker = db.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'town_v2_optin_reset'`).get();
    if (!marker && db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='town_characters'`).get()) {
      try {
        db.exec(`UPDATE town_characters SET town_enabled = 0`);
        db.prepare(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('town_v2_optin_reset', '1')`).run();
        console.log('[db] town_characters reset to opt-in (v2 behavior, one-time)');
      } catch { /* 表可能不存在 */ }
    }
    const locCols = db.prepare(`PRAGMA table_info(town_locations)`).all();
    if (locCols.length > 0 && !locCols.find(c => c.name === 'object_id')) {
      db.exec(`ALTER TABLE town_locations ADD COLUMN object_id INTEGER`);
      console.log('[db] Added town_locations.object_id column');
    }
    // 邀请入邻舍：NPC 对应的 characters.id（未邀请为 NULL）
    const npcCols = db.prepare(`PRAGMA table_info(town_npcs)`).all();
    if (npcCols.length > 0 && !npcCols.find(c => c.name === 'character_id')) {
      db.exec(`ALTER TABLE town_npcs ADD COLUMN character_id INTEGER`);
      console.log('[db] Added town_npcs.character_id column');
    }
    // 向导「一句话人设」：人格卡生成种子，重掷人格卡时复用（旧库无此列）
    if (npcCols.length > 0 && !npcCols.find(c => c.name === 'brief')) {
      db.exec(`ALTER TABLE town_npcs ADD COLUMN brief TEXT DEFAULT ''`);
      console.log('[db] Added town_npcs.brief column');
    }
    // 向导提前建档：map_id 需可空（建档时地图尚未生成）
    const mapIdCol = npcCols.find(c => c.name === 'map_id');
    if (mapIdCol && mapIdCol.notnull) {
      const chatExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='town_npc_chat_messages'`).get();
      if (chatExists) db.exec('DELETE FROM town_npc_chat_messages');
      db.exec(`
        CREATE TABLE town_npcs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          map_id INTEGER,
          display_name TEXT NOT NULL,
          persona TEXT DEFAULT '',
          brief TEXT DEFAULT '',
          appearance_desc TEXT DEFAULT '',
          job TEXT DEFAULT '', home_location_id INTEGER,
          routine_json TEXT DEFAULT '[]',
          traits_json TEXT DEFAULT '{}',
          sprite_ready INTEGER DEFAULT 0,
          town_enabled INTEGER DEFAULT 1,
          character_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO town_npcs_new (id, map_id, display_name, persona, brief, appearance_desc, job, home_location_id, routine_json, traits_json, sprite_ready, town_enabled, character_id, created_at)
          SELECT id, map_id, display_name, persona, brief, appearance_desc, job, home_location_id, routine_json, traits_json, sprite_ready, town_enabled, character_id, created_at FROM town_npcs;
        DROP TABLE town_npcs;
        ALTER TABLE town_npcs_new RENAME TO town_npcs;
      `);
      console.log('[db] town_npcs.map_id made nullable (wizard early-create)');
    }
    const playerCols = db.prepare(`PRAGMA table_info(town_players)`).all();
    if (playerCols.length > 0 && !playerCols.find(c => c.name === 'sprite_asset_id')) {
      db.exec(`ALTER TABLE town_players ADD COLUMN sprite_asset_id INTEGER`);
      db.exec(`ALTER TABLE town_players ADD COLUMN appearance_desc TEXT DEFAULT ''`);
      console.log('[db] Added town_players v2 columns (sprite_asset_id/appearance_desc)');
    }
    // town_agent_state：v1 主键是 character_id（带 characters 外键），NPC 无法落库 → 整表重建
    // （v1 快照绑定已作废的种子地图，无保留价值）
    const agentCols = db.prepare(`PRAGMA table_info(town_agent_state)`).all();
    if (agentCols.length > 0 && agentCols.find(c => c.name === 'character_id')) {
      db.exec(`DROP TABLE town_agent_state`);
      db.exec(`
        CREATE TABLE town_agent_state (
          agent_key TEXT PRIMARY KEY,
          grid_x INTEGER,
          grid_y INTEGER,
          path_json TEXT DEFAULT '[]',
          current_location_id INTEGER,
          activity_text TEXT DEFAULT '',
          updated_at DATETIME
        )
      `);
      console.log('[db] town_agent_state rebuilt with agent_key primary key (v2)');
    }
  } catch (err) {
    console.log('[db] migrateTownV2Schema error:', err.message);
  }
}


/**
 * 迁移: AI 小镇多地图
 * - town_maps 加 status（出行目录只列 ready）
 * - town_players 加 map_id（玩家所在地图 = 聚焦口径的权威来源）
 * - town_characters 加 map_id（入住镇），旧数据按住宅所在图回填，缺住宅落到默认图
 * - town_npcs.map_id 为空的历史行（向导提前建档）落到默认图
 * - town_locations 的 key 唯一约束从「全库唯一」改为「图内唯一」（重建表，行 id 原样保留）
 * - town_agent_state 主键从 agent_key 改为 (agent_key, map_id)（重建表，旧快照归入默认图）
 * 幂等：已迁移的库不会重复重建。
 */
export function migrateTownMultiMapSchema(db) {
  try {
    const tableSql = name => db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name)?.sql || '';
    const columns = name => db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
    const defaultMapId = db.prepare('SELECT id FROM town_maps ORDER BY id LIMIT 1').get()?.id ?? null;

    const mapCols = columns('town_maps');
    if (mapCols.length > 0 && !mapCols.includes('status')) {
      db.exec(`ALTER TABLE town_maps ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'`);
      console.log('[db] Added town_maps.status column (multi-map)');
    }

    const playerCols = columns('town_players');
    if (playerCols.length > 0 && !playerCols.includes('map_id')) {
      db.exec('ALTER TABLE town_players ADD COLUMN map_id INTEGER');
      console.log('[db] Added town_players.map_id column (multi-map)');
    }

    const charCols = columns('town_characters');
    if (charCols.length > 0 && !charCols.includes('map_id')) {
      db.exec('ALTER TABLE town_characters ADD COLUMN map_id INTEGER');
      console.log('[db] Added town_characters.map_id column (multi-map)');
    }

    // 旧库单图：地点归属天然就是默认图；居民、角色、玩家与快照按默认图补齐
    if (defaultMapId != null) {
      db.prepare('UPDATE town_npcs SET map_id = ? WHERE map_id IS NULL').run(defaultMapId);
      db.prepare(`UPDATE town_characters SET map_id = (SELECT map_id FROM town_locations WHERE id = town_characters.home_location_id)
        WHERE home_location_id IS NOT NULL AND map_id IS NULL`).run();
      db.prepare('UPDATE town_characters SET map_id = ? WHERE map_id IS NULL').run(defaultMapId);
      db.prepare('UPDATE town_players SET map_id = ? WHERE map_id IS NULL').run(defaultMapId);
    }

    const fkWasOn = db.pragma('foreign_keys', { simple: true });
    // 重建表：先建新表并逐列搬运（保留行 id），再换名。外键约束临时关闭。
    const rebuild = (name, { create, columns: nextColumns, select }) => {
      if (fkWasOn) db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`DROP TABLE IF EXISTS ${name}_multimap_mig`);
          db.exec(create);
          db.exec(`INSERT INTO ${name}_multimap_mig (${nextColumns.join(', ')}) SELECT ${select} FROM ${name}`);
          db.exec(`DROP TABLE ${name}`);
          db.exec(`ALTER TABLE ${name}_multimap_mig RENAME TO ${name}`);
        })();
      } finally {
        if (fkWasOn) db.pragma('foreign_keys = ON');
      }
    };

    const locSql = tableSql('town_locations');
    if (locSql && !locSql.includes('UNIQUE(map_id, key)')) {
      const cols = columns('town_locations');
      rebuild('town_locations', {
        create: `CREATE TABLE town_locations_multimap_mig (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          map_id INTEGER NOT NULL REFERENCES town_maps(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          name TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          kind TEXT NOT NULL DEFAULT 'place' CHECK(kind IN ('home','place','outdoor')),
          grid_x INTEGER NOT NULL,
          grid_y INTEGER NOT NULL,
          radius INTEGER NOT NULL DEFAULT 2,
          ambient TEXT DEFAULT '',
          object_id INTEGER,
          business_kind TEXT,
          capabilities_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(map_id, key)
        )`,
        columns: cols,
        select: cols.join(', '),
      });
      db.exec('CREATE INDEX IF NOT EXISTS idx_town_locations_map ON town_locations(map_id)');
      console.log('[db] Rebuilt town_locations with UNIQUE(map_id, key) (multi-map)');
    }

    const agentSql = tableSql('town_agent_state');
    if (agentSql && !agentSql.includes('PRIMARY KEY (agent_key, map_id)')) {
      const cols = columns('town_agent_state');
      if (defaultMapId == null) {
        // 没有地图可归属的库（升级后还没开镇）：旧快照本就无意义，清空后照样重建表结构，
        // 否则后续 persistAgent 的 ON CONFLICT(agent_key, map_id) 会因为旧主键直接报错。
        db.exec('DELETE FROM town_agent_state');
      }
      const carried = cols.filter(c => c !== 'agent_key');
      rebuild('town_agent_state', {
        create: `CREATE TABLE town_agent_state_multimap_mig (
          agent_key TEXT NOT NULL,
          map_id INTEGER NOT NULL,
          grid_x INTEGER,
          grid_y INTEGER,
          path_json TEXT DEFAULT '[]',
          current_location_id INTEGER,
          activity_text TEXT DEFAULT '',
          updated_at DATETIME,
          PRIMARY KEY (agent_key, map_id)
        )`,
        columns: ['agent_key', 'map_id', ...carried],
        // 表已清空时这里没有行，取值只为满足 NOT NULL 的列定义
        select: `agent_key, ${defaultMapId ?? 0}, ${carried.join(', ')}`,
      });
      console.log('[db] Rebuilt town_agent_state keyed by (agent_key, map_id) (multi-map)');
    }
  } catch (err) {
    console.log('[db] migrateTownMultiMapSchema error:', err.message);
  }
}



// 迁移: 世界生成配置改为 system_settings 存储；首次启动写入与前端一致的默认值。
export function migrateTownGenerationSettings(db) {
  try {
    const existing = db.prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'town_generation_settings'").get();
    if (existing) return;

    // Upgrade compatibility: carry over a style preference that is still in the wizard state file.
    let styleTags = '';
    try {
      const statePath = path.resolve(__dirname, '..', '..', 'data', 'town', 'init-state.json');
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        styleTags = String(state?.blueprint?.styleTags || '').slice(0, 200);
      }
    } catch { /* init state is optional */ }
    db.prepare("INSERT INTO system_settings (setting_key, setting_value) VALUES ('town_generation_settings', ?)").run(JSON.stringify({
      styleTags,
      steps: {
        tiles: { prefix: 'pixel art, game sprite, white background', artist: '@ebora', loras: [] },
        buildings: { prefix: 'pixel art, game sprite, white background', artist: '@ebora', loras: [] },
        npcs: { prefix: 'pixel art, game sprite, mini human sized, full body', artist: '@ebora', loras: [], portraitLoras: false },
        player: { prefix: 'pixel art, game sprite, mini human sized, full body', artist: '@ebora', loras: [], portraitLoras: false },
      },
    }));
    console.log('[db] system_settings: seeded town_generation_settings');
  } catch (err) {
    console.log('[db] migrateTownGenerationSettings error:', err.message);
  }
}
