


/**
 * 迁移: emotion_snapshots 改为每 conversation 仅保留最新一条
 * - 清理历史数据（只保留每个 conversation_id 的 max(id)）
 * - 将 conversation_id 改为 UNIQUE 约束（如果尚未）
 */
export function migrateEmotionSnapshotsUnique(db) {
  try {
    const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'emotion_snapshots'`).get();
    if (!tableInfo) return; // 表不存在，CREATE TABLE 会建新的

    // 删除历史数据：每个 conversation_id 只保留最新一条
    const deleted = db.prepare(`
      DELETE FROM emotion_snapshots
      WHERE id NOT IN (SELECT MAX(id) FROM emotion_snapshots GROUP BY conversation_id)
    `).run();
    if (deleted.changes > 0) {
      console.log(`[db] emotion_snapshots cleaned: ${deleted.changes} old snapshots removed`);
    }

    // 如果 conversation_id 还没有 UNIQUE 约束，重建表
    if (!/UNIQUE/.test(tableInfo.sql)) {
      db.exec(`
        CREATE TABLE emotion_snapshots_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL UNIQUE,
          after_msg_id INTEGER REFERENCES messages(id),
          valence REAL NOT NULL DEFAULT 0.5,
          arousal REAL NOT NULL DEFAULT 0.5,
          dominance REAL NOT NULL DEFAULT 0.5,
          mood_valence REAL DEFAULT 0.5,
          mood_arousal REAL DEFAULT 0.5,
          mood_dominance REAL DEFAULT 0.5,
          dominant_emotion TEXT,
          affinity REAL,
          affinity_delta REAL,
          reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO emotion_snapshots_new SELECT * FROM emotion_snapshots;
        DROP TABLE emotion_snapshots;
        ALTER TABLE emotion_snapshots_new RENAME TO emotion_snapshots;
      `);
      console.log('[db] emotion_snapshots rebuilt with UNIQUE constraint');
    }
  } catch (err) {
    console.log('[db] migrateEmotionSnapshotsUnique error:', err.message);
  }
}


export function migrateCharacterNegativePrompt(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'negative_prompt')) {
      db.exec(`ALTER TABLE characters ADD COLUMN negative_prompt TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Added characters.negative_prompt column');
    }
  } catch (err) {
    console.log('[db] migrateCharacterNegativePrompt error:', err.message);
  }
}


export function migrateCharacterOutfitOverride(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'outfit_override_scene')) {
      db.exec(`ALTER TABLE characters ADD COLUMN outfit_override_scene TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Added characters.outfit_override_scene column');
    }
    if (!cols.find(c => c.name === 'outfit_override_until')) {
      db.exec(`ALTER TABLE characters ADD COLUMN outfit_override_until DATETIME`);
      console.log('[db] Added characters.outfit_override_until column');
    }
  } catch (err) {
    console.log('[db] migrateCharacterOutfitOverride error:', err.message);
  }
}


/**
 * 迁移: town_newspapers 重建为无外键版本。
 * 初版把 character_id 设了 REFERENCES characters(id) ON DELETE SET NULL，角色被删除时
 * 报纸的主角链接会被置空——报纸是"已印出的历史"，不应随角色删除失联。
 */
export function migrateNewspaperDropForeignKey(db) {
  try {
    const fks = db.pragma('foreign_key_list(town_newspapers)');
    if (!Array.isArray(fks) || fks.length === 0) return; // 新库或已迁移
    const fkWasOn = db.pragma('foreign_keys', { simple: true });
    if (fkWasOn) db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE town_newspapers_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publish_date TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        edition INTEGER NOT NULL DEFAULT 1,
        items_json TEXT NOT NULL DEFAULT '[]',
        character_id INTEGER,
        character_event_json TEXT,
        world_state_json TEXT,
        moment_done INTEGER NOT NULL DEFAULT 0,
        complaint_after DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO town_newspapers_new (id, publish_date, name, edition, items_json, character_id, character_event_json, world_state_json, moment_done, complaint_after, created_at)
        SELECT id, publish_date, name, edition, items_json, character_id, character_event_json, world_state_json, moment_done, complaint_after, created_at FROM town_newspapers;
      DROP TABLE town_newspapers;
      ALTER TABLE town_newspapers_new RENAME TO town_newspapers;
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_town_newspapers_date ON town_newspapers(publish_date)`);
    if (fkWasOn) db.pragma('foreign_keys = ON');
    console.log('[db] town_newspapers: dropped character_id foreign key (paper survives character deletion)');
  } catch (err) {
    console.log('[db] migrateNewspaperDropForeignKey error:', err.message);
  }
}


/**
 * 迁移: 防打扰模式 — characters 表新增 dnd_original_state 列
 * 存储被 DND 覆盖前的原始状态 JSON: {"moments_disabled":0,"proactive_disabled":0,"events_disabled":0}
 * NULL 表示该角色当前未被 DND 覆盖
 */
export function migrateDisturbSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'dnd_original_state')) {
      db.exec(`ALTER TABLE characters ADD COLUMN dnd_original_state TEXT`);
      console.log('[db] Added characters.dnd_original_state column');
    }
  } catch (err) {
    console.log('[db] migrateDisturbSchema error:', err.message);
  }
}


/** 只建列（幂等）：initSchema 早期调用，保证城镇/其它迁移能安全引用 is_system */
export function ensureCharacterScopeColumn(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(characters)').all();
    if (!cols.find(c => c.name === 'is_system')) {
      db.exec('ALTER TABLE characters ADD COLUMN is_system INTEGER DEFAULT 0');
      console.log('[db] Added characters.is_system column (default 0)');
    }
  } catch (err) {
    console.log('[db] ensureCharacterScopeColumn skipped:', err.message);
  }
}


/**
 * 迁移: 角色作用域（characters.is_system）
 *
 * 2026-11-08 用户要求「根治」：默认助手（生图助手）同时是一个角色行、
 * 一个内置人格、又是「所有人」集合的成员，任何「遍历所有角色」的链路都会不知不觉
 * 把它带上（批量覆盖设置、日程生成、事件、朋友圈…都要逐个调用点手工排除）。
 *
 * 现在给它一个显式身份：is_system = 1 的行是系统内置角色，**面向用户的角色集合
 * 一律只取 is_system = 0**（见 services/characterScope.js）。
 * 幂等：列已存在不重建，标记每次都按 name 校正一遍。
 */
export function migrateCharacterScope(db) {
  ensureCharacterScopeColumn(db);
  try {
    // 内置角色清单：默认助手（生图助手）。以后再加内置角色，往这里加 name。
    const SYSTEM_CHARACTER_NAMES = ['default'];
    const mark = db.prepare('UPDATE characters SET is_system = 1 WHERE name = ?');
    let marked = 0;
    for (const name of SYSTEM_CHARACTER_NAMES) marked += mark.run(name).changes;
    if (marked > 0) console.log(`[db] characters.is_system: marked ${marked} built-in character(s)`);
  } catch (err) {
    console.log('[db] migrateCharacterScope skipped:', err.message);
  }
}


/**
 * 迁移: 日程系统 — characters 表新增 schedule 相关列
 */
export function migrateScheduleSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'schedule_enabled')) {
      db.exec(`ALTER TABLE characters ADD COLUMN schedule_enabled INTEGER DEFAULT 1`);
      console.log('[db] Added characters.schedule_enabled column (default 1)');
    }
    if (!cols.find(c => c.name === 'is_sleeping')) {
      db.exec(`ALTER TABLE characters ADD COLUMN is_sleeping INTEGER DEFAULT 0`);
      console.log('[db] Added characters.is_sleeping column (default 0)');
    }
    if (!cols.find(c => c.name === 'sleep_until')) {
      db.exec(`ALTER TABLE characters ADD COLUMN sleep_until DATETIME`);
      console.log('[db] Added characters.sleep_until column');
    }
    if (!cols.find(c => c.name === 'next_schedule_refresh_at')) {
      db.exec(`ALTER TABLE characters ADD COLUMN next_schedule_refresh_at DATETIME`);
      console.log('[db] Added characters.next_schedule_refresh_at column');
    }
    // 2026-10-02 敏感度（用户提的新数值系统，见 src/services/sensitivityService.js）：
    //   sensitivity           0~100，所有性爱相关内容都读它（增益 / 高潮强度与频率 / 自慰概率 / prompt 表现）
    //   sensitivity_updated_at 上一次变化的时间 —— 用来做"很久没碰会缓慢回落"
    //   heat_mode / heat_until 催眠手机里的「发情模式」：直接拉满，到点自然回落
    //
    // ⚠️⚠️ 这一段**绝不能**放进上面那个 `if (!next_schedule_refresh_at)` 里（我第一版就是：
    //   写代码时手滑嵌进去了）。后果非常隐蔽：`characters` 建表语句里**已经**有
    //   `next_schedule_refresh_at` ⇒ 真空库（测试用 `:memory:`）永远跳过整段、列建不出来，
    //   而"列不存在"会被 `getSensitivity` 的 try/catch 兜成 0/冷淡、`addSensitivity` 兜成 null ⇒
    //   **所有单测与前端守卫全绿，只有真机的 POST /heat 500**（第五十一轮 E2E 的 H1 抓到的就是这个：
    //   `500 POST /api/characters/6/heat`）。凡是"补列"的迁移，判断条件只能是"这一列在不在"。
    for (const [col, ddl] of [
      ['sensitivity', 'REAL DEFAULT 0'],
      ['sensitivity_updated_at', 'DATETIME'],
      ['heat_mode', 'INTEGER DEFAULT 0'],
      ['heat_until', 'DATETIME'],
      // 2026-10-03 复查补的三列（各自的"为什么"见 sensitivityService 里的长注释）：
      //   · sensitivity_before_heat   发情模式**开之前**的值 —— 到点/关掉时还给她
      //     （不加这一列的话：到点后 100 没人写回、要 15 天才掉到 55；关掉时又一律砍成 55，
      //      把她本来 80 的真实值也砍掉）
      //   · sensitivity_sex_day / _gain / _last_at
      //       「缓慢累加」的两道闸门：性相关来源 15 秒内只记一次 + 每天最多 +20（跨日归零）。
      //       没有它，"自动插入"冲刺档 = 每分钟 +20 ⇒ 五分钟顶满，等于发情模式白给。
      ['sensitivity_before_heat', 'REAL'],
      ['sensitivity_sex_day', 'TEXT'],
      ['sensitivity_sex_day_gain', 'REAL DEFAULT 0'],
      ['sensitivity_sex_last_at', 'DATETIME'],
    ]) {
      const has = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('characters') WHERE name = ?").get(col).n;
      if (!has) {
        db.exec(`ALTER TABLE characters ADD COLUMN ${col} ${ddl}`);
        console.log(`[db] Added characters.${col} column (sensitivity 系统)`);
      }
    }
  } catch (err) {
    console.log('[db] migrateScheduleSchema error:', err.message);
  }
}


/**
 * 迁移: 叫醒系统 — characters 表新增 wake 相关列
 */
export function migrateWakeSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'wake_attempts')) {
      db.exec(`ALTER TABLE characters ADD COLUMN wake_attempts INTEGER DEFAULT 0`);
      console.log('[db] Added characters.wake_attempts column (default 0)');
    }
    if (!cols.find(c => c.name === 'was_door_woken')) {
      db.exec(`ALTER TABLE characters ADD COLUMN was_door_woken INTEGER DEFAULT 0`);
      console.log('[db] Added characters.was_door_woken column (default 0)');
    }
    if (!cols.find(c => c.name === 'temporary_wake_until')) {
      db.exec(`ALTER TABLE characters ADD COLUMN temporary_wake_until DATETIME`);
      console.log('[db] Added characters.temporary_wake_until column');
    }
    if (!cols.find(c => c.name === 'wake_mode')) {
      db.exec(`ALTER TABLE characters ADD COLUMN wake_mode TEXT`);
      console.log('[db] Added characters.wake_mode column');
    }
  } catch (err) {
    console.log('[db] migrateWakeSchema error:', err.message);
  }
}


/**
 * 迁移: 好感度系统 — user_relationships 和 emotion_snapshots 新增 affinity 列
 */
export function migrateAffinitySchema(db) {
  try {
    // user_relationships 表
    const urCols = db.prepare(`PRAGMA table_info(user_relationships)`).all();
    if (!urCols.find(c => c.name === 'affinity')) {
      db.exec(`ALTER TABLE user_relationships ADD COLUMN affinity REAL DEFAULT 50`);
      console.log('[db] Added user_relationships.affinity column (default 50)');
      // 已有关系的行设置为默认值 50
      db.prepare(`UPDATE user_relationships SET affinity = 50 WHERE affinity IS NULL`).run();
    }

    // emotion_snapshots 表
    const esCols = db.prepare(`PRAGMA table_info(emotion_snapshots)`).all();
    if (!esCols.find(c => c.name === 'affinity')) {
      db.exec(`ALTER TABLE emotion_snapshots ADD COLUMN affinity REAL`);
      console.log('[db] Added emotion_snapshots.affinity column');
    }
    if (!esCols.find(c => c.name === 'affinity_delta')) {
      db.exec(`ALTER TABLE emotion_snapshots ADD COLUMN affinity_delta REAL`);
      console.log('[db] Added emotion_snapshots.affinity_delta column');
    }
    if (!esCols.find(c => c.name === 'reason')) {
      db.exec(`ALTER TABLE emotion_snapshots ADD COLUMN reason TEXT`);
      console.log('[db] Added emotion_snapshots.reason column');
    }
  } catch (err) {
    console.log('[db] migrateAffinitySchema error:', err.message);
  }
}


/**
 * 迁移: characters 表新增 proactive 相关列
 * - next_proactive_at: 下次主动聊天时间
 * - proactive_disabled: 是否禁用主动聊天
 * - proactive_last_read_at: 用户最后一次查看该角色主动消息的时间（用于未读红点判断）
 */
export function migrateProactiveSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'next_proactive_at')) {
      db.exec(`ALTER TABLE characters ADD COLUMN next_proactive_at DATETIME`);
      console.log('[db] Added characters.next_proactive_at column');
    }
    if (!cols.find(c => c.name === 'proactive_disabled')) {
      db.exec(`ALTER TABLE characters ADD COLUMN proactive_disabled INTEGER DEFAULT 0`);
      console.log('[db] Added characters.proactive_disabled column (default 0)');
    }
    if (!cols.find(c => c.name === 'proactive_last_read_at')) {
      db.exec(`ALTER TABLE characters ADD COLUMN proactive_last_read_at DATETIME`);
      console.log('[db] Added characters.proactive_last_read_at column');
    }
    if (!cols.find(c => c.name === 'proactive_streak')) {
      db.exec(`ALTER TABLE characters ADD COLUMN proactive_streak INTEGER DEFAULT 0`);
      console.log('[db] Added characters.proactive_streak column (default 0)');
    }

    // messages 表：is_proactive 标记主动聊天消息
    const msgCols = db.prepare(`PRAGMA table_info(messages)`).all();
    if (!msgCols.find(c => c.name === 'is_proactive')) {
      db.exec(`ALTER TABLE messages ADD COLUMN is_proactive INTEGER DEFAULT 0`);
      console.log('[db] Added messages.is_proactive column (default 0)');
    }
    // messages 表：event_id 关联奇遇事件（仅分句展示表，不污染 raw_messages）
    if (!msgCols.find(c => c.name === 'event_id')) {
      db.exec(`ALTER TABLE messages ADD COLUMN event_id INTEGER DEFAULT NULL`);
      console.log('[db] Added messages.event_id column (nullable, no FK)');
    }
  } catch (err) {
    console.log('[db] migrateProactiveSchema error:', err.message);
  }
}


/**
 * 迁移: 深度思考 — raw_messages 新增 thinking 列（nullable）
 * 存 planner 的思考+计划原文 JSON（{think, plan}），GET messages 带出供前端历史回看折叠块
 */
export function migrateDeepThinkSchema(db) {
  try {
    const rawCols = db.prepare(`PRAGMA table_info(raw_messages)`).all();
    if (!rawCols.find(c => c.name === 'thinking')) {
      db.exec(`ALTER TABLE raw_messages ADD COLUMN thinking TEXT DEFAULT NULL`);
      console.log('[db] Added raw_messages.thinking column');
    }
  } catch (err) {
    console.log('[db] migrateDeepThinkSchema error:', err.message);
  }
}


/**
 * 迁移: 角色身份锚点（2026-11-08 用户定）—— characters 表新增两列
 *
 * 背景：角色身份（`Name (Series)` + 身体特征）原先只存在于 `base_prompt` 的「## 你的外观」段，
 * 而这段同时被当成 work（默认）那套衣服的描述 ⇒ 任何对 work 的生成都会换掉角色，
 * 冷门/LoRA 角色直接飘成别人。现在身份有独立存储位，生图时前置，服装生成永远不碰。
 *
 *   identity_anchor        锚点正文（英文 tag 串），空 = 未建立
 *   identity_anchor_source auto = 自动维护（卡变了会被重算）；manual = 用户手改过（自动流程不动）
 */
export function migrateIdentityAnchorSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'identity_anchor')) {
      db.exec(`ALTER TABLE characters ADD COLUMN identity_anchor TEXT`);
      console.log('[db] Added characters.identity_anchor column');
    }
    if (!cols.find(c => c.name === 'identity_anchor_source')) {
      db.exec(`ALTER TABLE characters ADD COLUMN identity_anchor_source TEXT`);
      console.log('[db] Added characters.identity_anchor_source column');
    }
  } catch (err) {
    console.log('[db] migrateIdentityAnchorSchema error:', err.message);
  }
}


/**
 * 迁移: 角色立绘 — characters 表新增 standing_url 列
 * 存放角色立绘图片 URL（/images/standing/...），NULL 表示尚未生成
 */
export function migrateStandingSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'standing_url')) {
      db.exec(`ALTER TABLE characters ADD COLUMN standing_url TEXT`);
      console.log('[db] Added characters.standing_url column');
    }
    // 2026-10-01（用户：「同步形象展示那边的立绘，需要根据现在的世界观去生成」）：
    // 记录这张立绘是在**哪个世界观**下生成的（签名 = 世界观 id + 内容哈希，见 services/worldSignature.js）。
    // 没有这一列时：世界观改了/换了，立绘静默过期——用户点开形象展示看到的还是旧世界的图，
    // 而系统一无所知。有了它才能提示"待同步"并一键按当前世界观重生成。
    // 老数据为 NULL（生成于本列存在之前）⇒ 判为"未知来源"，见 isStandingStale 的口径。
    if (!cols.find(c => c.name === 'standing_world_sig')) {
      db.exec(`ALTER TABLE characters ADD COLUMN standing_world_sig TEXT`);
      console.log('[db] Added characters.standing_world_sig column');
    }
  } catch (err) {
    console.log('[db] migrateStandingSchema error:', err.message);
  }
}


/**
 * 迁移: 好感度回归系统
 * - user_relationships 表新增 last_interaction_at（记录最近一次互动时间）
 * - 新建 gift_history 表（全局冷却记录，含送礼与宝箱开箱的冷却检查）
 */
export function migrateAffinityRegressionSchema(db) {
  try {
    // user_relationships 表
    const urCols = db.prepare(`PRAGMA table_info(user_relationships)`).all();
    if (!urCols.find(c => c.name === 'last_interaction_at')) {
      db.exec(`ALTER TABLE user_relationships ADD COLUMN last_interaction_at DATETIME`);
      console.log('[db] Added user_relationships.last_interaction_at column');
    }

    // gift_history 表：全局冷却（跟系统不跟角色），仅需 gift_type + created_at。
    // chest = 每日宝箱开箱冷却（与送礼同构的惰性冷却记录，见 itemService.getChestState）
    const ghCols = db.prepare(`PRAGMA table_info(gift_history)`).all();
    const hasCharId = ghCols.some(c => c.name === 'character_id');
    if (ghCols.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gift_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          gift_type TEXT NOT NULL CHECK(gift_type IN ('small','large','chest')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('[db] Created gift_history table (global cooldown)');
    } else if (hasCharId) {
      // 迁移：去掉 character_id，改为全局冷却，每种礼物只保留最新一条
      db.exec(`DROP TABLE IF EXISTS gift_history_new`);
      db.exec(`CREATE TABLE gift_history_new (id INTEGER PRIMARY KEY AUTOINCREMENT, gift_type TEXT NOT NULL CHECK(gift_type IN ('small','large','chest')), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.exec(`INSERT INTO gift_history_new (gift_type, created_at) SELECT gift_type, MAX(created_at) FROM gift_history GROUP BY gift_type`);
      db.exec(`DROP TABLE gift_history`);
      db.exec(`ALTER TABLE gift_history_new RENAME TO gift_history`);
      console.log('[db] gift_history migrated to global cooldown (removed character_id, deduplicated)');
    } else {
      // 兜底：v3.2.0 前建的全局表 CHECK 不含 chest 且无 character_id，走不到上面两个分支——
      // 开箱冷却 INSERT 会 CHECK 失败并被 recordChestOpen 静默吞掉 → 可无限开箱，按建表 SQL 检测后重建
      const tableSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gift_history'`).get()?.sql || '';
      if (!tableSql.includes(`'chest'`)) {
        db.exec(`DROP TABLE IF EXISTS gift_history_new`);
        db.exec(`CREATE TABLE gift_history_new (id INTEGER PRIMARY KEY AUTOINCREMENT, gift_type TEXT NOT NULL CHECK(gift_type IN ('small','large','chest')), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.exec(`INSERT INTO gift_history_new (gift_type, created_at) SELECT gift_type, MAX(created_at) FROM gift_history WHERE gift_type IN ('small','large','chest') GROUP BY gift_type`);
        db.exec(`DROP TABLE gift_history`);
        db.exec(`ALTER TABLE gift_history_new RENAME TO gift_history`);
        // backpack_items 只由开箱写入，用最近一次开箱时间回填冷却（无开箱记录则不回填）
        const lastItem = db.prepare(`SELECT MAX(acquired_at) AS acquired_at FROM backpack_items
          WHERE owner_key = 'me' AND source_type IN ('legacy_chest', 'chest')`).get();
        if (lastItem?.acquired_at) {
          db.prepare(`INSERT INTO gift_history (gift_type, created_at) VALUES ('chest', ?)`).run(lastItem.acquired_at);
        }
        console.log(`[db] gift_history CHECK 缺 chest，已重建补齐${lastItem?.acquired_at ? `（开箱冷却回填至 ${lastItem.acquired_at}）` : ''}`);
      }
    }

    // 启动时去重：每种类型只保留最新一条（冷却只看最近一次）
    for (const type of ['small', 'large', 'chest']) {
      const rows = db.prepare(`SELECT id FROM gift_history WHERE gift_type = ? ORDER BY id DESC`).all(type);
      if (rows.length > 1) {
        const keepId = rows[0].id;
        db.prepare(`DELETE FROM gift_history WHERE gift_type = ? AND id != ?`).run(type, keepId);
        console.log(`[db] gift_history pruned ${rows.length - 1} old ${type} row(s), kept #${keepId}`);
      }
    }

    // chest_opens 已并入本表（gift_type='chest'）：搬最后一次开箱时间（保住进行中的冷却）后删表
    const hasChestOpens = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chest_opens'`).get();
    if (hasChestOpens) {
      const lastOpen = db.prepare(`SELECT opened_at FROM chest_opens ORDER BY id DESC LIMIT 1`).get();
      const lastChest = db.prepare(`SELECT created_at FROM gift_history WHERE gift_type = 'chest' ORDER BY id DESC LIMIT 1`).get();
      if (lastOpen && (!lastChest || String(lastOpen.opened_at) > String(lastChest.created_at))) {
        db.prepare(`DELETE FROM gift_history WHERE gift_type = 'chest'`).run();
        db.prepare(`INSERT INTO gift_history (gift_type, created_at) VALUES ('chest', ?)`).run(lastOpen.opened_at);
      }
      db.exec(`DROP TABLE chest_opens`);
      console.log('[db] chest_opens merged into gift_history (gift_type=chest) and dropped');
    }
  } catch (err) {
    console.log('[db] migrateAffinityRegressionSchema error:', err.message);
  }
}


/**
 * 迁移: artist_favorites.artist 加 UNIQUE 约束（防止重复收藏）
 */
export function migrateArtistFavoritesUnique(db) {
  try {
    db.exec(`CREATE UNIQUE INDEX idx_artist_fav_artist ON artist_favorites(artist)`);
    console.log('[db] Added UNIQUE index on artist_favorites.artist');
  } catch (err) {
    // 索引已存在则忽略
    if (!err.message.includes('already exists')) {
      console.log('[db] migrateArtistFavoritesUnique error:', err.message);
    }
  }
}


/**
 * 迁移: characters 表新增 lora 列（仅保留 custom_workflow 和 loras）
 */
export function migrateLoraSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'custom_workflow')) {
      db.exec(`ALTER TABLE characters ADD COLUMN custom_workflow TEXT`);
      console.log('[db] Added characters.custom_workflow column');
    }
  } catch (err) {
    console.log('[db] migrateLoraSchema error:', err.message);
  }
}


/**
 * characters 表 loras JSON 列
 * 格式: [{"path":"xxx.safetensors","weight":1,"triggerWord":"xxx"}]
 */
export function migrateLorasArraySchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'loras')) {
      db.exec(`ALTER TABLE characters ADD COLUMN loras TEXT DEFAULT '[]'`);
      console.log('[db] Added characters.loras column (JSON array, default [])');
    }
  } catch (err) {
    console.log('[db] migrateLorasArraySchema error:', err.message);
  }
}


/**
 * characters 表 artist_override 列（角色单独画师串，非空时覆盖系统画师串）
 */
export function migrateArtistOverrideSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'artist_override')) {
      db.exec(`ALTER TABLE characters ADD COLUMN artist_override TEXT`);
      console.log('[db] Added characters.artist_override column');
    }
  } catch (err) {
    console.log('[db] migrateArtistOverrideSchema error:', err.message);
  }
}


// 迁移: 信箱系统 — mailbox_letters 表（由 CREATE TABLE IF NOT EXISTS 保证，仅新增索引）
export function migrateMailboxSchema(db) {
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mailbox_character_id ON mailbox_letters(character_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mailbox_status ON mailbox_letters(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mailbox_reply_at ON mailbox_letters(reply_at)`);
    const cols = db.prepare(`PRAGMA table_info(mailbox_letters)`).all();
    if (!cols.find(c => c.name === 'auto_read')) {
      db.exec(`ALTER TABLE mailbox_letters ADD COLUMN auto_read INTEGER NOT NULL DEFAULT 0`);
      console.log('[db] Added mailbox_letters.auto_read column');
    }
    if (!cols.find(c => c.name === 'speech_job_id')) {
      db.exec(`ALTER TABLE mailbox_letters ADD COLUMN speech_job_id TEXT DEFAULT ''`);
      console.log('[db] Added mailbox_letters.speech_job_id column');
    }
    console.log('[db] mailbox indexes ensured');
  } catch (err) {
    console.log('[db] migrateMailboxSchema error:', err.message);
  }
}


/**
 * 迁移: 手写字体 — characters 表新增 handwriting_font 列
 */
export function migrateHandwritingFont(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'handwriting_font')) {
      db.exec(`ALTER TABLE characters ADD COLUMN handwriting_font TEXT DEFAULT ''`);
      console.log('[db] Added characters.handwriting_font column');
    }
  } catch (err) {
    console.log('[db] migrateHandwritingFont error:', err.message);
  }
}



export function migrateOathSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(user_relationships)`).all();
    if (!cols.find(c => c.name === 'is_oath')) {
      db.exec(`ALTER TABLE user_relationships ADD COLUMN is_oath INTEGER DEFAULT 0`);
      console.log('[db] Added user_relationships.is_oath column (default 0)');
    }
  } catch (err) {
    console.log('[db] migrateOathSchema error:', err.message);
  }
}


/**
 * 迁移: 角色置顶 — characters 表新增 pinned 列（默认 0，未置顶）
 */
export function migratePinSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'pinned')) {
      db.exec(`ALTER TABLE characters ADD COLUMN pinned INTEGER DEFAULT 0`);
      console.log('[db] Added characters.pinned column');
    }
  } catch (err) {
    console.log('[db] migratePinSchema error:', err.message);
  }
}


/**
 * 迁移: 场景服装系统（2026-10-13，上游 v3.9.0 4 态 + PR #24 五态与身体分层）。
 *
 * character_outfits 加两列：
 *   scene TEXT  —— 场景标记。NULL = 普通换装行（老功能，getActiveOutfits 那条通道）；
 *                  'nude'/'work'/'casual'/'home'/'sleep' = 场景服装那一族（outfitScene.js）。
 *   body  TEXT  —— 身体描述，**该角色 5 套场景服装共用同一份**（单一真源）；
 *                  description 从此只存"这一套的衣服"。
 *
 * character_standings：场景立绘表（文字描述驱动生图之外，画好的图单独存）。
 *
 * ⚠️ 迁移只加列建表，**不动已有行** —— 老换装行的 scene 仍是 NULL，行为与改动前逐字节一致。
 *    「从 4 态老数据反推 body」由 outfitScene.backfillBodyFromExisting() 显式执行（一次性，
 *    且只在角色详情页保存时触发），不在启动迁移里跑 —— 那会每次启动都读一遍全部角色。
 */
export function migrateCharacterOutfitScene(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(character_outfits)`).all();
    if (!cols.find(c => c.name === 'scene')) {
      db.exec(`ALTER TABLE character_outfits ADD COLUMN scene TEXT`);
      console.log('[db] Added character_outfits.scene column');
    }
    if (!cols.find(c => c.name === 'body')) {
      db.exec(`ALTER TABLE character_outfits ADD COLUMN body TEXT`);
      console.log('[db] Added character_outfits.body column');
    }
  } catch (err) {
    console.log('[db] migrateCharacterOutfitScene error:', err.message);
  }
}


/**
 * 迁移: 角色文件夹 — 新建 character_folders 表，characters 表新增 folder_id 列
 * 单层分类：一个角色只属于一个文件夹，folder_id 为 NULL 表示「未分类」。
 * 删除文件夹只把成员置回未分类（folder_id = NULL），不动角色本体。
 */
export function migrateCharacterFolderSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'folder_id')) {
      db.exec(`ALTER TABLE characters ADD COLUMN folder_id INTEGER DEFAULT NULL`);
      console.log('[db] Added characters.folder_id column');
    }
  } catch (err) {
    console.log('[db] migrateCharacterFolderSchema error:', err.message);
  }
}
