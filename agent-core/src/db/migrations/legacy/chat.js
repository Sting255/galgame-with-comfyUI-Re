


/**
 * 迁移: 角色聊天背景 — characters 表新增 chat_bg_path 列
 * （上游 v3.9.0 合并：同一迁移里补 galgame_bg_path，沉浸对话的独立背景槽位）
 *
 * 2026-10-14 补漏合并：上游此处是 `export function`，本地漏了 export。
 * 上游测试按 `import { migrateChatBgSchema } from '../src/db/index.js'` 取，故补回 export。
 */
export function migrateChatBgSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'chat_bg_path')) {
      db.exec(`ALTER TABLE characters ADD COLUMN chat_bg_path TEXT`);
      console.log('[db] Added characters.chat_bg_path column');
    }
    if (!cols.find(c => c.name === 'galgame_bg_path')) {
      db.exec('ALTER TABLE characters ADD COLUMN galgame_bg_path TEXT');
      console.log('[db] Added characters.galgame_bg_path column');
    }
  } catch (err) {
    console.log('[db] migrateChatBgSchema error:', err.message);
  }
}


/**
 * 迁移: 群头像 — group_chats 表新增 avatar_path 列
 */
export function migrateGroupAvatarSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(group_chats)`).all();
    if (!cols.find(c => c.name === 'avatar_path')) {
      db.exec(`ALTER TABLE group_chats ADD COLUMN avatar_path TEXT`);
      console.log('[db] Added group_chats.avatar_path column');
    }
  } catch (err) {
    console.log('[db] migrateGroupAvatarSchema error:', err.message);
  }
}


/**
 * 迁移: 群聊系统 — raw_messages/messages 新增 speaker_character_id 列
 * NULL = 用户消息或 1 对 1 旧数据；群聊中角色消息填角色 id
 */
export function migrateGroupChatSchema(db) {
  try {
    const rawCols = db.prepare(`PRAGMA table_info(raw_messages)`).all();
    if (!rawCols.find(c => c.name === 'speaker_character_id')) {
      db.exec(`ALTER TABLE raw_messages ADD COLUMN speaker_character_id INTEGER DEFAULT NULL`);
      console.log('[db] Added raw_messages.speaker_character_id column');
    }
    const msgCols = db.prepare(`PRAGMA table_info(messages)`).all();
    if (!msgCols.find(c => c.name === 'speaker_character_id')) {
      db.exec(`ALTER TABLE messages ADD COLUMN speaker_character_id INTEGER DEFAULT NULL`);
      console.log('[db] Added messages.speaker_character_id column');
    }
    // 迁移: D4（2026-09-30）群聊围观落库 —— messages.onlooker_char_id
    // 群聊轮里"围观/起哄的那位"由程序选定（planTouchBystander），本列把选择落库，
    // 使「谁围观」可查询、可统计。NULL = 本轮无人围观 / 私聊消息。
    if (!msgCols.find(c => c.name === 'onlooker_char_id')) {
      db.exec(`ALTER TABLE messages ADD COLUMN onlooker_char_id INTEGER DEFAULT NULL`);
      console.log('[db] Added messages.onlooker_char_id column');
    }

    const fragmentCols = db.prepare(`PRAGMA table_info(memory_fragments)`).all();
    if (!fragmentCols.find(c => c.name === 'source_raw_start_id')) {
      db.exec(`ALTER TABLE memory_fragments ADD COLUMN source_raw_start_id INTEGER DEFAULT NULL`);
      console.log('[db] Added memory_fragments.source_raw_start_id column');
    }
    if (!fragmentCols.find(c => c.name === 'source_raw_end_id')) {
      db.exec(`ALTER TABLE memory_fragments ADD COLUMN source_raw_end_id INTEGER DEFAULT NULL`);
      console.log('[db] Added memory_fragments.source_raw_end_id column');
    }

    const imageTaskCols = db.prepare(`PRAGMA table_info(image_tasks)`).all();
    if (!imageTaskCols.find(c => c.name === 'source_msg_id')) {
      db.exec(`ALTER TABLE image_tasks ADD COLUMN source_msg_id INTEGER DEFAULT NULL`);
      console.log('[db] Added image_tasks.source_msg_id column');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_image_tasks_source_msg ON image_tasks(source_msg_id)`);

    const groupCols = db.prepare(`PRAGMA table_info(group_chats)`).all();
    if (!groupCols.find(c => c.name === 'rag_last_extracted_raw_id')) {
      db.exec(`ALTER TABLE group_chats ADD COLUMN rag_last_extracted_raw_id INTEGER DEFAULT 0`);
      console.log('[db] Added group_chats.rag_last_extracted_raw_id column');
    }
    if (!groupCols.find(c => c.name === 'rag_user_rounds_pending')) {
      db.exec(`ALTER TABLE group_chats ADD COLUMN rag_user_rounds_pending INTEGER DEFAULT 0`);
      console.log('[db] Added group_chats.rag_user_rounds_pending column');
    }
    // 每群每日后台闲聊预算（默认 2），独立计数；用户发言或跨天重置
    if (!groupCols.find(c => c.name === 'idle_budget')) {
      db.exec(`ALTER TABLE group_chats ADD COLUMN idle_budget INTEGER DEFAULT 2`);
      console.log('[db] Added group_chats.idle_budget column (default 2)');
    }
    db.exec(`UPDATE group_chats SET idle_budget = 2 WHERE idle_budget IS NULL OR idle_budget <= 0`);

    // 《邻舍日报》群聊注入轮数记账（报纸块只在主角所在群的前 4 轮注入，见 newspaperService）
    if (!groupCols.find(c => c.name === 'newspaper_paper_id')) {
      db.exec(`ALTER TABLE group_chats ADD COLUMN newspaper_paper_id INTEGER`);
      console.log('[db] Added group_chats.newspaper_paper_id column');
    }
    if (!groupCols.find(c => c.name === 'newspaper_rounds_used')) {
      db.exec(`ALTER TABLE group_chats ADD COLUMN newspaper_rounds_used INTEGER DEFAULT 0`);
      console.log('[db] Added group_chats.newspaper_rounds_used column');
    }

    // main v2.4 beta 曾将群聊提取边界保存在 group_chats；升级后只回填到 v2 checkpoint。
    // 同时兼容更早仅通过 source_msg_id 关联 raw 的记忆，且绝不回退已有 checkpoint。
    db.exec(`
      INSERT INTO memory_extraction_checkpoints(conversation_id, last_raw_msg_id, status, last_error, updated_at)
      SELECT
        'group_' || gc.id,
        MAX(
          COALESCE(gc.rag_last_extracted_raw_id, 0),
          COALESCE((
            SELECT MAX(COALESCE(mf.source_raw_end_id, msg.raw_id, 0))
            FROM memory_fragments mf
            LEFT JOIN messages msg ON msg.id = mf.source_msg_id
            WHERE mf.conversation_id = 'group_' || gc.id
          ), 0)
        ),
        'idle',
        NULL,
        CURRENT_TIMESTAMP
      FROM group_chats gc
      WHERE 1 = 1
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_raw_msg_id = MAX(memory_extraction_checkpoints.last_raw_msg_id, excluded.last_raw_msg_id),
        updated_at = CASE
          WHEN excluded.last_raw_msg_id > memory_extraction_checkpoints.last_raw_msg_id THEN CURRENT_TIMESTAMP
          ELSE memory_extraction_checkpoints.updated_at
        END
    `);
  } catch (err) {
    console.log('[db] migrateGroupChatSchema error:', err.message);
  }
}
