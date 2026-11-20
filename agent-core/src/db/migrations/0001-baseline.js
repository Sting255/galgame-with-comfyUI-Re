import { migrateGameSchema } from '../gameSchema.js';
import { initSettingsHandle, loadSystemSettings } from '../settings.js';
import { initWorldRepository, migrateWorldLanguageStyle } from '../worldRepository.js';
import { migrateLorebooks } from '../lorebookRepository.js';
import { migratePresets } from '../presetRepository.js';
import { seedAll } from '../seedData.js';
import { migrateTownSchema, createTownActorRegistry, migrateTownEncounterOutcome, migrateTownV2Schema, migrateTownMultiMapSchema, migrateTownGenerationSettings } from './legacy/town.js';
import { migrateTownActionSchema } from '../townActionSchema.js';
import { ensureTownDialogueSchema } from '../townDialogueSchema.js';
import { migrateTownEconomySchema } from '../townEconomySchema.js';
import { migrateTownNpcFunctionsSchema } from '../townNpcFunctionsSchema.js';
import { migrateTownNpcEventSchema } from '../townNpcEventSchema.js';
import { migrateTownResponsibilitySchema } from '../townResponsibilitySchema.js';
import { migrateTownCharacterCapabilitiesSchema } from '../townCharacterCapabilitiesSchema.js';
import { migrateTownCharacterProfileSchema } from '../townCharacterProfileSchema.js';
import { migrateTownExperienceSchema } from '../townExperienceSchema.js';
import { migrateTownServiceOfferSchema } from '../townServiceOfferSchema.js';
import { migrateTownItemSchema } from '../townItemSchema.js';
import { migrateTownItemTemplateSchema } from '../townItemTemplateSchema.js';
import { migrateWeatherHourlySchema } from '../weatherHourlySchema.js';
import { migrateCharacterDiarySchema } from '../diarySchema.js';
import { migrateSoulSchema } from '../soulSchema.js';
import { migrateExpressionStandings } from '../expressionStandingSchema.js';
import { migrateStandingInteractions } from '../standingInteractionSchema.js';
import { migrateCharacterReactionPacksSchema } from '../characterReactionPackSchema.js';
import { createMediaTables, migrateMediaSchema } from '../mediaSchema.js';
import { migrateTownBuildingFeatureSchema } from '../townBuildingFeatureSchema.js';
import { migrateTtsSchema } from '../ttsSchema.js';
import { migrateGodSaysSchema } from '../godSaysSchema.js';
import { migrateCohabitationSchema } from '../cohabitationRepository.js';
import { migrateInterCharacterEventSchema } from '../interCharacterEventSchema.js';
import { migrateWorldTimelineSchema } from '../worldTimelineSchema.js';
import { migrateCharacterBondSchema } from '../characterBondSchema.js';
import { migratePhotoStudioSchema } from '../photoStudioSchema.js';
import { migrateGallerySchema } from '../gallerySchema.js';
import { seedEmojiCategories, migrateEmojiCategoriesV2, migrateEmojiSetsSchema, migrateMomentsSchema, migrateMomentAutoTrigger, migrateMomentCommentQueueUnique, migrateMomentUnreadToTimestamp, migrateMomentTopicsSchema, migratePrivateMomentSchema } from './legacy/moments.js';
import { seedEventLibraries, migrateEventsSchema, migrateEventEmphasisSchema, migrateEventCrossRef } from './legacy/events.js';
import { seedImagePromptKnowledge, migrateImagePromptKnowledgeSchema, dropImagePromptPreparations } from './legacy/knowledge.js';
import { migrateEmotionSnapshotsUnique, migrateCharacterNegativePrompt, migrateCharacterOutfitOverride, migrateNewspaperDropForeignKey, migrateDisturbSchema, ensureCharacterScopeColumn, migrateCharacterScope, migrateScheduleSchema, migrateWakeSchema, migrateAffinitySchema, migrateProactiveSchema, migrateDeepThinkSchema, migrateIdentityAnchorSchema, migrateStandingSchema, migrateAffinityRegressionSchema, migrateArtistFavoritesUnique, migrateLoraSchema, migrateLorasArraySchema, migrateArtistOverrideSchema, migrateMailboxSchema, migrateHandwritingFont, migrateOathSchema, migratePinSchema, migrateCharacterOutfitScene, migrateCharacterFolderSchema } from './legacy/characters.js';
import { migrateRollingSummaryCheckpointSchema, rebuildFtsIndex, migrateChatMemoryV2Schema, migrateChatMemoryV3Schema, migrateMemoryConsolidationMarks, migrateMemoryConsolidationSettings, migrateMemorySettingsExplicitBlocks } from './legacy/memory.js';
import { migrateNewspaperWorldDismissed, migrateLlmProfiles, migrateWorldSettings, seedDefaultWorldSetting, migrateSystemSettings } from './legacy/settings.js';
import { migrateChatBgSchema, migrateGroupAvatarSchema, migrateGroupChatSchema } from './legacy/chat.js';
import { migrateIntimateSchema, migrateIntimateSceneSchema, migrateTouchSchema, migrateWornToysSchema, migrateToyPlaySchema, migrateHypnosisSchema } from './legacy/intimate.js';


export function initSchema(db) {
  migrateGallerySchema(db);
  db.exec(`
    -- 原始完整消息表（LLM 上下文用，不拆分）
    CREATE TABLE IF NOT EXISTS raw_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      prompt TEXT,
      client_msg_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 分句展示消息表（前端用，每个气泡一条）
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      raw_id INTEGER REFERENCES raw_messages(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      images TEXT,
      seq INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );


    -- MaiBot 桥接：最新一份记忆整理（覆盖式，供 MaiBot 主聊天流注入）
    CREATE TABLE IF NOT EXISTS maibot_latest_memory (
      session_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 记忆碎片表（事实/偏好/情绪）
    CREATE TABLE IF NOT EXISTS memory_fragments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      source_msg_id INTEGER REFERENCES messages(id),
      source_raw_start_id INTEGER,
      source_raw_end_id INTEGER,
      fragment_type TEXT NOT NULL CHECK(fragment_type IN ('fact','preference','emotion')),
      content TEXT NOT NULL,
      entities TEXT DEFAULT '[]',
      chroma_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 滚动摘要表
    CREATE TABLE IF NOT EXISTS rolling_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      start_msg_id INTEGER NOT NULL,
      end_msg_id INTEGER NOT NULL,
      summary TEXT NOT NULL,
      checkpoint_version INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );


    -- 情绪快照表（每 conversation 仅保留最新一条）
    CREATE TABLE IF NOT EXISTS emotion_snapshots (
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 生图任务表
    CREATE TABLE IF NOT EXISTS private_chat_image_turns (
      user_raw_id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, scene TEXT NOT NULL,
      task_id INTEGER NOT NULL, raw_id INTEGER NOT NULL, message_id INTEGER NOT NULL, snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_chat_replies (
      user_raw_id INTEGER PRIMARY KEY REFERENCES raw_messages(id) ON DELETE CASCADE,
      raw_id INTEGER NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS private_chat_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_raw_id INTEGER NOT NULL, call_id TEXT NOT NULL,
      assistant_json TEXT NOT NULL, arguments_json TEXT NOT NULL, result_json TEXT NOT NULL, task_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS image_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      source_msg_id INTEGER REFERENCES messages(id),
      prompt_original TEXT NOT NULL,
      prompt_refined TEXT,
      style TEXT,
      resolution TEXT DEFAULT '1024x1024',
      workflow_template TEXT,
      -- ⚠️ 死列（2026-10-15 标注，**只标注不删**）：全仓只有这一处定义，服务层与测试零引用。
      -- 原意是存 ComfyUI 的 prompt_id（便于按 id 查队列/中断任务），但出图走的是"提交后等结果"，
      -- 没用到这个 id ⇒ 从没写入过。保留原因：改 schema 要走迁移，而 ALTER TABLE DROP COLUMN 在
      -- 老 SQLite 上不可用；真要清就**连同另外 7 个死列一起**在一次性迁移里做（见下方各列的标注）。
      comfyui_prompt_id TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
      output_paths TEXT DEFAULT '[]',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );


    -- 生图提示词知识库（独立于聊天记忆，仅供生图 prompt 生产链检索）
    CREATE TABLE IF NOT EXISTS image_prompt_knowledge (
      knowledge_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      search_terms TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      executable_tags TEXT NOT NULL DEFAULT '[]',
      scenes TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      version TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 全局规则表（追加到每个角色的 system prompt 末尾）
    CREATE TABLE IF NOT EXISTS global_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_key TEXT NOT NULL UNIQUE,
      rule_content TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 系统设置表（画师串/分辨率/功能开关，替代 .env 中的对应字段）
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 朋友圈帖子表
    CREATE TABLE IF NOT EXISTS moment_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,  -- 入住角色作者；镇民作者时为 NULL（二选一，见下方 CHECK）
      npc_id INTEGER REFERENCES town_npcs(id) ON DELETE CASCADE,         -- 镇民作者；角色作者时为 NULL
      content TEXT NOT NULL,
      images TEXT DEFAULT '[]',
      prompt TEXT,
      style TEXT,
      resolution TEXT DEFAULT '1600x1200',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','generating','done','failed')),
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- 作者三选一：角色 / 镇民 / 用户（用户发帖时两者均为 NULL，见 migrateMomentPostUserAuthors）
      CHECK (character_id IS NULL OR npc_id IS NULL)
    );

    -- 朋友圈评论表
    CREATE TABLE IF NOT EXISTS moment_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES moment_posts(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK(author_type IN ('user','character')),
      author_id INTEGER,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 朋友圈评论「等角色睡醒再回」队列（2026-11-08 用户定）
    -- 你在她睡觉时评论了她的帖子：那一刻她不回（睡着的人不会回消息），
    -- 到点（醒来后 1~10 分钟）由 replyQueueScheduler 生成回复并落库 + 广播 new_comment。
    CREATE TABLE IF NOT EXISTS moment_comment_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL,
      user_comment_id INTEGER NOT NULL,
      scheduled_reply_at DATETIME NOT NULL,
      status TEXT DEFAULT 'waiting' CHECK(status IN ('waiting','processing','done','cancelled')),
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_moment_comment_queue_due
      ON moment_comment_queue(status, scheduled_reply_at);

    -- 朋友圈点赞表（单用户：每个帖子最多一个赞，UNIQUE 约束 + toggle）
    CREATE TABLE IF NOT EXISTS moment_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES moment_posts(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id)
    );

    -- 朋友圈未读计数已迁移为时序方案（last_moments_seen_at）
    -- moment_unread 表如有残留，由下方 migrateMomentUnreadToTimestamp() 清理

    -- 用户关系表（用户 → 角色，用户为单例无 user_id，每个角色唯一一条）
    CREATE TABLE IF NOT EXISTS user_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      relationship_text TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(character_id)
    );

    -- 用户画像表（角色视角下的用户特征，AI 自动从对话中提取）
    -- trait_type: appearance(外貌) / personality(性格) / preference(偏好)
    CREATE TABLE IF NOT EXISTS user_portraits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      trait_type TEXT NOT NULL CHECK(trait_type IN ('appearance','personality','preference')),
      content TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      source_msg_id INTEGER REFERENCES messages(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(character_id, trait_type, content)
    );

    -- 世界观收藏表（多套设定，可切换激活）
    CREATE TABLE IF NOT EXISTS world_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_active INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 角色关系表（有向：from → to，关系文本存储在 relationship_text 中）
    CREATE TABLE IF NOT EXISTS character_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      to_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      relationship_text TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_character_id, to_character_id)
    );

    -- 角色配置表
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      base_prompt TEXT NOT NULL,
      avatar_path TEXT,
      standing_url TEXT,
      emotion_baseline TEXT NOT NULL DEFAULT '{"valence":0.5,"arousal":0.5,"dominance":0.5}',
      moments_disabled INTEGER DEFAULT 0,
      short_prompt TEXT,
      artist_override TEXT,
      handwriting_font TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

      -- 表情包配置单（一个角色可建多张，聊天只使用启用中的那张；启用互斥由服务层在事务里保证。
      -- 删除配置单仅删数据库行，不清理磁盘图片文件，历史消息贴图不受影响）
      CREATE TABLE IF NOT EXISTS emoji_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_emoji_sets_char ON emoji_sets(character_id);

      -- 角色表情包表（每张配置单每种表情一条，prompt 生成与图片生成分离）
      CREATE TABLE IF NOT EXISTS character_emojis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        set_id INTEGER NOT NULL REFERENCES emoji_sets(id) ON DELETE CASCADE,
        emoji_key TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        image_path TEXT,
        style TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','prompt_ready','generating','done','failed')),
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(set_id, emoji_key)
      );

      -- 表情类别表（可编辑的 15 个默认类别，按 sort_order 排序）
      CREATE TABLE IF NOT EXISTS emoji_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        emoji_key TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

    -- 角色专属外观/形态/装甲/衣服（每个角色可定义多套，同时只启用一套，启用互斥由服务层保证）。
    -- expires_at：道具变身卡写入的临时形态到期时间（空 = 永久），由 getActiveOutfits 惰性过滤
    -- scene：场景服装标记（NULL = 普通换装行；'nude'/'work'/'casual'/'home'/'sleep' = 场景服装那一族）
    -- body：**身体描述**（英文 tag 风格：发色/发型/瞳色/肤色/体型/显著特征）。该角色 5 套场景服装**共用同一份**，
    --   description 只存"这一套的衣服"，注入时由 outfitScene.composeOutfitText() 拼成自包含文本。
    --   单一真源：写 body 时同步到该角色全部服装行（outfitScene.setCharacterBody）。
    CREATE TABLE IF NOT EXISTS character_outfits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      expires_at DATETIME,
      scene TEXT,
      body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_character_outfits_char ON character_outfits(character_id);

    -- 场景立绘（工装/常服/私服/居家/睡衣/裸体六套形象，供角色详情页左右切换查看）。
    -- 与 character_outfits 的「场景服装」是两回事：服装是**文字描述**（驱动生图），立绘是**已画好的图**。
    -- 刻意分表 —— 角色可以还没配服装就先有立绘，也可以配了服装但某套还没出图，两者解耦。
    -- scene 取值同 services/outfitScene.js 的 OUTFIT_SCENES。
    -- 注意：characters.standing_url 仍是「角色默认形象」，被聊天/朋友圈/群聊等各处引用，本表不动它；
    -- work 槽在读取时以 standing_url 兜底（见 services/characterStanding.js），
    -- 这样「已有的那张立绘」天然就是常服形象，用户不会觉得立绘凭空消失。
    CREATE TABLE IF NOT EXISTS character_standings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      scene TEXT NOT NULL,
      image_url TEXT,
      prompt_text TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(character_id, scene)
    );
    CREATE INDEX IF NOT EXISTS idx_character_standings_char ON character_standings(character_id);

    -- 全角色统一服装类型（2026-11-07）：在设置里定义一次，对所有角色生效。
    -- scene_key 固定为 custom_g<id>，同一类型在所有角色上是同一个 key，批量生成与页签文案都靠它对齐；
    -- 各角色的实际服装仍写 character_outfits（scene=scene_key, name=类型名, description=各自生成）。
    CREATE TABLE IF NOT EXISTS global_outfit_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 通用限时服饰（如一套女仆装的 tag 组合）。character_id 为空 = 全员可见的全局服饰；
    -- 指定角色 = 道具系统写入的该角色专属限时服饰。expires_at 为过期时间（空 = 永久生效），
    -- 两者均由 outfitService.getActiveOutfits 惰性过滤。condition_json 预留未来更复杂的注入条件，当前不解析
    CREATE TABLE IF NOT EXISTS global_outfits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      expires_at DATETIME,
      condition_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 背包道具（宝箱开出的道具；status: generating → ready → used；
    -- collected_at 为空 = 待收下，未收下的道具不进背包列表、不可使用）
    CREATE TABLE IF NOT EXISTS backpack_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      effect_key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      rarity TEXT NOT NULL DEFAULT 'common',
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'generating',
      payload_json TEXT,
      collected_at DATETIME,
      acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_backpack_items_status ON backpack_items(status);

    -- 道具生效中的效果（buff 到期失效；变身卡靠 payload 恢复原专属形态）
    CREATE TABLE IF NOT EXISTS item_effects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES backpack_items(id) ON DELETE CASCADE,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      effect_key TEXT NOT NULL,
      payload_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_item_effects_char ON item_effects(character_id);

    -- 画师串收藏夹
    CREATE TABLE IF NOT EXISTS artist_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      artist TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 奇遇事件表（每角色同时最多一个活跃事件）
    CREATE TABLE IF NOT EXISTS character_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      event_type_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','open','engaged','completed','expired','cancelled')),
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image TEXT,
      prompt TEXT,
      style TEXT,
      resolution TEXT DEFAULT '1600x1200',
      choice_a TEXT NOT NULL DEFAULT '',
      choice_b TEXT NOT NULL DEFAULT '',
      choice_c_label TEXT NOT NULL DEFAULT '自由行动',
      current_branch INTEGER DEFAULT 0,
      max_branches INTEGER DEFAULT 3,
      choice_history TEXT DEFAULT '[]',
      summary TEXT DEFAULT '',
      engaged INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      last_interaction_at DATETIME,
      half_time_notified INTEGER DEFAULT 0,
      error_message TEXT
    );

    -- 日程模板表（每个角色一条，LLM 生成后缓存）
    CREATE TABLE IF NOT EXISTS schedule_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
      schedule_json TEXT NOT NULL DEFAULT '[]',
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      version INTEGER DEFAULT 1
    );

    -- 每日日程实例表（从 template 快照，独立于模板可微调）
    CREATE TABLE IF NOT EXISTS daily_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      schedule_date TEXT NOT NULL,
      schedule_json TEXT NOT NULL DEFAULT '[]',
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(character_id, schedule_date)
    );

    -- 待应用日程变更队列（聊天约定的是未来某天时先入队，到那天再合并进当日日程）
    CREATE TABLE IF NOT EXISTS pending_schedule_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      target_date TEXT NOT NULL,
      activity_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'chat',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 消息回复队列表（延迟回复 + 睡眠合并）
    CREATE TABLE IF NOT EXISTS reply_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      user_raw_msg_id INTEGER NOT NULL,
      user_msg_id INTEGER NOT NULL,
      user_content TEXT NOT NULL,
      client_msg_id TEXT,
      scheduled_reply_at DATETIME NOT NULL,
      status TEXT DEFAULT 'waiting' CHECK(status IN ('waiting','processing','done','cancelled')),
      -- ⚠️ 死列 ×3（2026-10-15 标注，只标注不删）：reply_raw_msg_id / reply_msg_ids / processed_at
      -- 全仓只有这三行定义、服务层与测试零引用。原意是"回复生成后把落库的消息 id 回填到队列行"，
      -- 但实际流程是回复直接写 raw_messages、队列行用完就按 status 标记，从没回填过 ⇒ 三列恒为 NULL/默认。
      -- 保留原因同 image_tasks.comfyui_prompt_id：改 schema 要迁移，真要清就**同批处理**全部死列。
      reply_raw_msg_id INTEGER,
      reply_msg_ids TEXT DEFAULT '[]',
      current_activity TEXT,
      delay_minutes INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    );

    -- 奇遇事件历史表
    CREATE TABLE IF NOT EXISTS event_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      event_type_key TEXT,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      final_image TEXT,
      summary TEXT NOT NULL DEFAULT '',
      conclusion TEXT,
      choice_history TEXT DEFAULT '[]',
      total_branches INTEGER DEFAULT 0,
      engaged INTEGER DEFAULT 0,
      outcome TEXT DEFAULT 'expired' CHECK(outcome IN ('completed','expired','cancelled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 梦境表（睡眠会话内共享；talk_schedule 为本次睡眠已排定的梦话时刻 ISO 数组）
    CREATE TABLE IF NOT EXISTS character_dreams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      dream_type TEXT,
      content TEXT NOT NULL,
      image_prompt TEXT,
      image_path TEXT,
      -- ⚠️ 死列 ×2（2026-10-15 标注，只标注不删）：dream_talks / talks_emitted
      -- 梦话最终走的是**下面那对** talk_schedule（排定时刻）+ 直接按时刻发，不在这里记"已说了几条"。
      -- 全仓只有这两行定义、服务层与测试零引用 ⇒ 恒为 '[]' / 0。保留原因同其它死列（改 schema 要迁移）。
      dream_talks TEXT DEFAULT '[]',
      talk_schedule TEXT DEFAULT '[]',
      talks_emitted INTEGER DEFAULT 0,
      status TEXT DEFAULT 'generating' CHECK(status IN ('generating','ready','failed')),
      sleep_until DATETIME,
      shared_at DATETIME,
      shared_via TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dreams_char_created ON character_dreams(character_id, created_at DESC);

    -- 信箱信件表
    CREATE TABLE IF NOT EXISTS mailbox_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('user_to_char','char_to_user')),
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      reply_content TEXT DEFAULT '',
      content_short TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      reply_at DATETIME,
      paper_path TEXT DEFAULT '',
      portrait_path TEXT DEFAULT '',
      illustration_path TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      replied_at DATETIME,
      is_read INTEGER NOT NULL DEFAULT 0,
      auto_read INTEGER NOT NULL DEFAULT 0,
      speech_job_id TEXT DEFAULT ''
    );

    -- 逐小时天气缓存表（仅保留 24 条，weather_time 为 HH:00）
    CREATE TABLE IF NOT EXISTS weather_hourly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      weather_time TEXT NOT NULL UNIQUE,
      weather_text TEXT NOT NULL,
      temperature TEXT NOT NULL,
      wind_speed TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 群聊表（conversation_id = 'group_' || id，消息复用 raw_messages/messages 双表）
    CREATE TABLE IF NOT EXISTS group_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      topic TEXT DEFAULT '',
      avatar_path TEXT,
      created_by TEXT NOT NULL DEFAULT 'user' CHECK(created_by IN ('user','character')),
      creator_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
      idle_enabled INTEGER DEFAULT 1,
      next_idle_at DATETIME,
      idle_budget INTEGER DEFAULT 2,
      idle_budget_date TEXT,
      idle_budget_used INTEGER DEFAULT 0,
      last_message_at DATETIME,
      last_seen_at DATETIME,
      rag_last_extracted_raw_id INTEGER DEFAULT 0,
      rag_user_rounds_pending INTEGER DEFAULT 0,
      -- 《邻舍日报》群聊注入记账：newspaper_paper_id 是已计数的报纸 id（换期即重置），
      -- newspaper_rounds_used 是该群对本期报纸已注入的轮数（限额见 newspaperService.GROUP_INJECT_ROUNDS）
      newspaper_paper_id INTEGER,
      newspaper_rounds_used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 群成员表
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, character_id)
    );

    -- 奇遇事件类型库（系统 default + 用户自定义 custom）
    CREATE TABLE IF NOT EXISTS event_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      duration_min INTEGER NOT NULL DEFAULT 20,
      urgency INTEGER NOT NULL DEFAULT 1,
      fun_from TEXT NOT NULL DEFAULT '[]',
      desc TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'default' CHECK(source IN ('default','custom')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 朋友圈话题库（系统 default + 用户自定义 custom）
    -- 判重口径（2026-10-14）：**同来源内 name 唯一**，不再全库唯一 ——
    -- 自定义话题允许与系统话题同名（用户想「用系统那套名字写自己的描述」是合理需求），
    -- 故选 id 时靠 (id) 而不是 (name) 定位；唯一性由 idx_moment_topics_name_source 保证。
    -- checked：是否参与「自动抽取」（手动点题不受它限制）。注意存 0/1 整数，不存布尔。
    CREATE TABLE IF NOT EXISTS moment_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      desc TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'default' CHECK(source IN ('default','custom')),
      is_active INTEGER NOT NULL DEFAULT 1,
      checked INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- 同来源判重：老库（真库）当年建的是 name 单列 UNIQUE，
    -- 由 migrateMomentTopicsSchema 做幂等重建搬到这条复合唯一索引上。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_topics_name_source ON moment_topics(name, source);

    -- ── AI 小镇（世界页 v2）：瓦片地图 / 素材库 / 轻量 NPC / POI / 相遇对话 ──
    CREATE TABLE IF NOT EXISTS town_maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      image_path TEXT,                   -- v1 遗留：整图插画（v2 弃用，保留列兼容旧库）
      grid_cols INTEGER NOT NULL,
      grid_rows INTEGER NOT NULL,
      -- ⚠️ 死列（2026-10-15 标注，**只标注不删**）：v1 遗留，可走性已改为按 layers_json 运行时计算
      -- （见 services/town/townPathfinding.js 的说明）。列本身仍 NOT NULL 有默认值，所以旧库无需迁移。
      -- 与另外 8 个死列同批（清单跑 scripts/scan-dead-code.mjs），要清就一起清。
      -- ⚠️ 在这段 SQL 里写注释**不要用反引号** —— 整段是 JS 模板字符串，一个反引号就把它截断（踩过两次）。
      walk_grid TEXT NOT NULL DEFAULT '[]',
      layers_json TEXT,                  -- v2：{ground,road,objects,blockOverride} 图层数据
      tile_size INTEGER DEFAULT 32,      -- 世界像素/格（1x 缩放下）
      world_setting_id INTEGER,          -- 初始化用的世界观
      version INTEGER DEFAULT 1,         -- 编辑保存版本号（SSE 通知其他端重载）
      status TEXT NOT NULL DEFAULT 'ready',  -- ready | archived（多地图：出行目录只列 ready）
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 像素素材库（ComfyUI 生成 → 抠白/像素化 → data/town/assets/）
    CREATE TABLE IF NOT EXISTS town_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,          -- ground | road | building | prop | npc | player
      key TEXT,                    -- grass_01 / residential / npc_3_down / char_12_right / player_down
      name TEXT NOT NULL,          -- 显示名（青草地 / 普通居民楼）
      image_path TEXT NOT NULL,    -- /town-assets/xxx.png
      meta_json TEXT DEFAULT '{}', -- footprint{w,h}/blocking/doorOffset/cellW,cellH/direction/reusable/maxInstances/styleTags/pixelSize
      source_prompt TEXT DEFAULT '',
      world_setting_id INTEGER,
      status TEXT DEFAULT 'pending',  -- pending | ready | failed
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_town_assets_kind ON town_assets(kind, status);

    CREATE TABLE IF NOT EXISTS town_map_assets (
      map_id INTEGER NOT NULL REFERENCES town_maps(id) ON DELETE CASCADE,
      asset_id INTEGER NOT NULL REFERENCES town_assets(id) ON DELETE CASCADE,
      PRIMARY KEY (map_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS town_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id INTEGER NOT NULL REFERENCES town_maps(id) ON DELETE CASCADE,
      key TEXT NOT NULL,                 -- 'cafe'（图内唯一，两张镇可以各有自己的咖啡馆）
      name TEXT NOT NULL,                -- '兽人咖啡厅'
      aliases_json TEXT NOT NULL DEFAULT '[]',
      kind TEXT NOT NULL DEFAULT 'place' CHECK(kind IN ('home','place','outdoor')),
      grid_x INTEGER NOT NULL,
      grid_y INTEGER NOT NULL,
      radius INTEGER NOT NULL DEFAULT 2, -- 锚点周围可站立半径
      ambient TEXT DEFAULT '',           -- 环境氛围描述（注入对话 prompt）
      object_id INTEGER,                 -- v2：绑定的地图对象 id（建筑 POI）
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(map_id, key)
    );

    -- 轻量小镇居民（世界观生成，不进 characters 表）
    CREATE TABLE IF NOT EXISTS town_npcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      persona TEXT DEFAULT '',           -- 完整人格卡（建档时按 brief 生成）
      brief TEXT DEFAULT '',             -- 一句话人设（名单生成/用户手填，人格卡生成种子）
      appearance_desc TEXT DEFAULT '',   -- spirit生成用外观描述
      job TEXT DEFAULT '', home_location_id INTEGER,
      routine_json TEXT DEFAULT '[]',    -- [{start:"08:00",end:"12:00",activity,locationKey}]
      traits_json TEXT DEFAULT '{}',     -- {social, outdoor, nightOwl, 作息偏移}
      sprite_ready INTEGER DEFAULT 0,    -- 4 方向素材齐备标记
      town_enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 玩家与 NPC 就地对话历史（注入后续对话）
    CREATE TABLE IF NOT EXISTS town_npc_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      npc_id INTEGER NOT NULL REFERENCES town_npcs(id) ON DELETE CASCADE,
      role TEXT NOT NULL,                -- user | npc
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_town_npc_chat ON town_npc_chat_messages(npc_id, id DESC);

    CREATE TABLE IF NOT EXISTS town_characters (
      character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      map_id INTEGER,                    -- 入住镇（多地图）；NULL = 尚未指定，按住宅推断
      home_location_id INTEGER REFERENCES town_locations(id),
      town_enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 运行时状态快照（v2：agent_key = 'npc:3' / 'char:12' / 'me'，进程重启后由作息/日程重建）
    CREATE TABLE IF NOT EXISTS town_agent_state (
      agent_key TEXT NOT NULL,
      map_id INTEGER NOT NULL,           -- 运行时快照按图保存：玩家每图一份最近坐标
      grid_x INTEGER,
      grid_y INTEGER,
      path_json TEXT DEFAULT '[]',
      current_location_id INTEGER,
      activity_text TEXT DEFAULT '',
      updated_at DATETIME,
      PRIMARY KEY (agent_key, map_id)
    );

    CREATE TABLE IF NOT EXISTS town_encounters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id INTEGER NOT NULL,
      char_a INTEGER NOT NULL,
      char_b INTEGER NOT NULL,
      location_id INTEGER,
      status TEXT NOT NULL DEFAULT 'chatting' CHECK(status IN ('chatting','done','cancelled')),
      summary TEXT DEFAULT '',              -- 规则结算的模板摘要（M0：唯一权威事实文本）
      outcome_json TEXT,                    -- 规则结算的结构化结果 {interactionType,resultCode,ruleVersion,settledAtUtcMs}
      polished_summary TEXT DEFAULT '',     -- LLM 润色摘要（仅附加表现，不参与结算校验）
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS town_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      encounter_id INTEGER NOT NULL REFERENCES town_encounters(id) ON DELETE CASCADE,
      speaker_char_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS town_players (
      id TEXT PRIMARY KEY,               -- 'me'（单用户）
      display_name TEXT NOT NULL,
      map_id INTEGER,                    -- 玩家当前所在地图（聚焦口径的权威来源）
      grid_x INTEGER,
      grid_y INTEGER,
      sprite_asset_id INTEGER,           -- v2：玩家spirit素材（player_down 等 4 方向共用一套 meta）
      appearance_desc TEXT DEFAULT '',   -- v2：spirit生成用外观描述（用户配置外观）
      updated_at DATETIME
    );

    -- 小镇预告报纸《邻舍日报》：每日一份，每天零点后由 replyQueueScheduler 补当天份
    -- items_json：普通新闻 [{category,title,content,image}]；character_event_json：绑定角色的特稿
    -- {title,content,image,note,character_name,character_avatar}；world_state_json：15% 概率出现的当日全员状态
    -- {name,description,news,image,effect_prompt}（注入口与道具 buff 同位，见 chat.js 稳定块[1]）
    -- moment_done/complaint_after：绑定角色当日吐槽朋友圈的排期与完成标记（momentScheduler 消费）
    -- world_dismissed：读者在日报里手动「消除影响」的标记；置 1 后当天世界状态不再注入任何提示词
    -- character_id 不设外键：报纸是"已印出的历史"，角色之后被删除也不得抹掉主角链接
    -- （旧库带 ON DELETE SET NULL 的版本由 migrateNewspaperDropForeignKey 重建）
    CREATE TABLE IF NOT EXISTS town_newspapers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publish_date TEXT NOT NULL UNIQUE,             -- 本地日期 YYYY-MM-DD（getLocalDateKey 口径）
      name TEXT NOT NULL DEFAULT '',                 -- 报头名
      edition INTEGER NOT NULL DEFAULT 1,            -- 期号（历史最大期号 + 1）
      items_json TEXT NOT NULL DEFAULT '[]',
      character_id INTEGER,
      character_event_json TEXT,
      world_state_json TEXT,
      world_dismissed INTEGER NOT NULL DEFAULT 0,
      moment_done INTEGER NOT NULL DEFAULT 0,
      complaint_after DATETIME,                      -- UTC（与 datetime('now') 同口径比较）
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_town_newspapers_date ON town_newspapers(publish_date);
  `);

  // 只补齐历史 NULL；保留用户显式关闭后台闲聊的 idle_enabled=0。
  db.prepare(`UPDATE group_chats SET idle_enabled = 1 WHERE idle_enabled IS NULL`).run();

  // FTS5 external content table — drop & recreate to handle schema changes
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id'
    );
  `);

  // Triggers to keep FTS5 index in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_raw ON messages(raw_id);
    CREATE INDEX IF NOT EXISTS idx_raw_messages_conv ON raw_messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_fragments_conv ON memory_fragments(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_fragments_type ON memory_fragments(fragment_type);
    CREATE INDEX IF NOT EXISTS idx_summaries_conv ON rolling_summaries(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_checkpoint ON rolling_summaries(conversation_id, end_msg_id);

    CREATE INDEX IF NOT EXISTS idx_image_tasks_conv ON image_tasks(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_image_tasks_status ON image_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_image_prompt_knowledge_category ON image_prompt_knowledge(category, is_active);
    CREATE INDEX IF NOT EXISTS idx_image_prompt_knowledge_priority ON image_prompt_knowledge(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_moment_posts_character ON moment_posts(character_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_moment_posts_created ON moment_posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_moment_posts_filter ON moment_posts(status);
    CREATE INDEX IF NOT EXISTS idx_moment_comments_post ON moment_comments(post_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_user_rels_char ON user_relationships(character_id);
    CREATE INDEX IF NOT EXISTS idx_portraits_char ON user_portraits(character_id);
    CREATE INDEX IF NOT EXISTS idx_portraits_type ON user_portraits(trait_type);
    CREATE INDEX IF NOT EXISTS idx_char_rels_from ON character_relationships(from_character_id);
    CREATE INDEX IF NOT EXISTS idx_char_rels_to ON character_relationships(to_character_id);
      CREATE INDEX IF NOT EXISTS idx_character_emojis_character ON character_emojis(character_id, status);
      CREATE INDEX IF NOT EXISTS idx_emoji_categories_sort ON emoji_categories(sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_ce_char_status ON character_events(character_id, status);
    CREATE INDEX IF NOT EXISTS idx_ce_expires ON character_events(expires_at);
    CREATE INDEX IF NOT EXISTS idx_eh_char ON event_history(character_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ds_char_date ON daily_schedules(character_id, schedule_date);
    CREATE INDEX IF NOT EXISTS idx_psc_status_date ON pending_schedule_changes(status, target_date);
    CREATE INDEX IF NOT EXISTS idx_rq_scheduled ON reply_queue(scheduled_reply_at, status);
    CREATE INDEX IF NOT EXISTS idx_rq_character ON reply_queue(character_id, status);
    CREATE INDEX IF NOT EXISTS idx_weather_lookup ON weather_hourly(weather_time);
    CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_char ON group_members(character_id);
    CREATE INDEX IF NOT EXISTS idx_group_chats_idle ON group_chats(next_idle_at, idle_enabled);
    CREATE INDEX IF NOT EXISTS idx_town_locations_map ON town_locations(map_id);
    CREATE INDEX IF NOT EXISTS idx_town_encounters_status ON town_encounters(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_town_chat_enc ON town_chat_messages(encounter_id, created_at);
  `);

  // Partial unique index for raw_messages client_msg_id (SQLite 3.8+)
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_client_msg ON raw_messages(client_msg_id) WHERE client_msg_id IS NOT NULL`);
  } catch (err) {
    console.log('[db] idx_raw_client_msg skipped:', err.message);
  }

  // Partial unique index: 每角色最多一个活跃事件
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_event ON character_events(character_id) WHERE status IN ('pending','open','engaged')`);
  } catch (err) {
    console.log('[db] idx_one_active_event skipped:', err.message);
  }

  // 保留完整预报时间；历史天气缓存不推断日期或回填。
  migrateWeatherHourlySchema(db);
  migrateExpressionStandings(db);
  // 上游 v3.9.0 合并：立绘互动（空手触摸台词 + 触碰配置/区域，见 services/standingTouchLines.js
  // 与 services/standingInteractionService.js）。必须排在 migrateExpressionStandings 之后：
  // standing_interaction_regions 外键引用 expression_standings。
  migrateStandingInteractions(db);

  // 上游 v3.9.0 合并：媒体内容页建表（传媒 / 数字媒体，见 services/mediaService.js）
  createMediaTables(db);

  // 迁移: characters 表新增 next_moment_at 列
  migrateMomentsSchema(db);

  // 迁移: characters 表新增 negative_prompt 列（角色级负面提示词，2026-11-06）
  migrateCharacterNegativePrompt(db);

  // 迁移: characters 表新增 outfit_override_scene / outfit_override_until（手动指定当前服装）
  migrateCharacterOutfitOverride(db);

  // 迁移: town_newspapers 去掉 character_id 外键（报纸主角链接不随角色删除被置空）
  migrateNewspaperDropForeignKey(db);

  // 迁移: town_newspapers 加 world_dismissed 列（日报手动消除世界影响）；
  // 必须在外键重建之后执行——重建出的表不带该列
  migrateNewspaperWorldDismissed(db);

  // 迁移: town_encounters 加 outcome_json / polished_summary（M0 相遇规则结算）
  migrateTownEncounterOutcome(db);

  // 迁移: 删除 image_prompt_preparations（生图提示词诊断留档，全项目无读者，
  // 曾是全库最大表：113MB/1.7 万行；写入路径已一并移除）
  dropImagePromptPreparations(db);

  // 迁移: moment_unread 计数 → 时序方案 (last_moments_seen_at)
  migrateMomentUnreadToTimestamp(db);

  // 迁移: 好感度系统 — user_relationships 和 emotion_snapshots 新增 affinity 列
  migrateAffinitySchema(db);

  // 迁移: characters 表新增 next_proactive_at 和 proactive_disabled 列（主动聊天）
  migrateProactiveSchema(db);

  // 迁移: emotion_snapshots 改为每 conversation 仅保留最新一条（UNIQUE 约束 + 清理历史）
  migrateEmotionSnapshotsUnique(db);

  // 迁移: 好感度回归系统 — user_relationships 加 last_interaction_at + gift_history 表
  migrateTownItemSchema(db);
  migrateTownItemTemplateSchema(db);
  migrateAffinityRegressionSchema(db);

  // 迁移: artist_favorites.artist 加 UNIQUE 约束（防止重复收藏）
  migrateArtistFavoritesUnique(db);

  // 迁移: characters 表新增 events_disabled 列（奇遇系统）
  migrateEventsSchema(db);

  // 迁移: 防打扰模式 — characters 表新增 dnd_original_state 列
  migrateDisturbSchema(db);

  // 迁移: 日程系统 — characters 表新增 schedule 相关列
  migrateScheduleSchema(db);
  migrateCohabitationSchema(db);
  migrateInterCharacterEventSchema(db);
  migrateWorldTimelineSchema(db);
  migrateCharacterBondSchema(db);
  migratePhotoStudioSchema(db);
  migrateGameSchema(db);

  // 迁移: moment_comments 新增 auto_trigger + thread_root_id（朋友圈关系网互动）
  migrateMomentAutoTrigger(db);
  // 迁移: 延迟评论队列的持久唯一键（P1-04）—— 必须在建表之后、调度器启动之前
  migrateMomentCommentQueueUnique(db);

  // 系统设置迁移: 清理历史遗留键（idempotent，需在种子注入前执行）
  migrateSystemSettings(db);
  migrateTownGenerationSettings(db);

  // 迁移: 绘图知识词库保留可直接注入的结构化 tag。
  migrateImagePromptKnowledgeSchema(db);

  // 迁移: PAI 风格聊天记忆单元、全文索引、提取 checkpoint 与索引任务
  migrateChatMemoryV2Schema(db);

  // 迁移: 记忆 v3 —— 多重表示 + 双时态演化 + 实体/三元组索引层（见 docs/memory-upgrade-plan.md）
  migrateChatMemoryV3Schema(db);

  // 迁移: 记忆整理记账表（防同一批候选被反复送进 LLM）+ 整理/审计表维护索引
  migrateMemoryConsolidationMarks(db);

  // 迁移: 把整理 daemon 的显式配置写进既有 memory_settings 行（缺失才补，不覆盖用户值）
  migrateMemoryConsolidationSettings(db);

  // 迁移: 把 v3 / activeSearch / contextBudget 等阶段开关也显式化，让库里能读出实际生效值
  migrateMemorySettingsExplicitBlocks(db);

  // 迁移: 叫醒系统 — characters 表新增 wake 相关列
  migrateWakeSchema(db);

  // 迁移: characters 表新增 lora 列
  migrateLoraSchema(db);

  // characters 表新增 loras JSON 列
  migrateLorasArraySchema(db);

  // characters 表新增角色单独画师串列
  migrateArtistOverrideSchema(db);

  // 迁移: 将 global_rules.world_setting 移至 world_settings 表（多套世界观）
  migrateWorldSettings(db);
  migrateWorldLanguageStyle(db);

  // 空表补默认激活世界观：前端世界观弹窗的保存依赖选中项，空表时写入无法落库
  seedDefaultWorldSetting(db);

  // 迁移: LLM 多配置切换（需在 seed 之后，确保 DB 已初始化）
  migrateLlmProfiles(db);

  // 迁移: 信箱系统
  migrateMailboxSchema(db);

  // 迁移: 手写字体 — characters 表新增 handwriting_font 列
  migrateHandwritingFont(db);

  // 迁移: 角色聊天背景 — characters 表新增 chat_bg_path 列
  migrateChatBgSchema(db);

  // 迁移: 群头像 — group_chats 表新增 avatar_path 列
  migrateGroupAvatarSchema(db);

  // 迁移: 朋友圈话题库 — 判重从「全库 name 唯一」改成「同来源内唯一」+ 新增 checked 列
  // （老库建的是 name 单列 UNIQUE，不重建真机一升级就插不进同名话题；幂等）
  migrateMomentTopicsSchema(db);

  // 迁移: 角色置顶 — characters 表新增 pinned 列
  migratePinSchema(db);

  // 迁移: 奇遇强调降格 — character_events 表新增 emphasis_delivered 列
  migrateEventEmphasisSchema(db);

  // 迁移: 摘要 checkpoint 版本标记；旧摘要边界不可信，不能直接用于历史截断
  migrateRollingSummaryCheckpointSchema(db);

  // 迁移: 誓约系统 — user_relationships 表新增 is_oath 列
  migrateOathSchema(db);

  // 迁移: 交叉角色引用 — character_events 表新增 referenced_character_ids 列
  migrateEventCrossRef(db);

  // 迁移: 群聊系统 — raw_messages/messages 新增 speaker_character_id 列
  migrateGroupChatSchema(db);

  // 迁移: 深度思考 — raw_messages 新增 thinking 列（存 planner 思考+计划原文，历史回看用）
  migrateDeepThinkSchema(db);

  // 迁移: 角色立绘 — characters 表新增 standing_url 列
  migrateStandingSchema(db);

  // 迁移: 角色身份锚点 — characters 表新增 identity_anchor / identity_anchor_source 列
  migrateIdentityAnchorSchema(db);

  // 迁移: 角色作用域列（characters.is_system）必须在城镇注册表之前建好 ——
  // 城镇的 synchronize 会按作用域筛选角色，列不存在就会 no such column 直接崩启动。
  // 这里只建列；把内置角色标成 is_system=1 的那步在 seedAll 之后（见 migrateCharacterScope）。
  ensureCharacterScopeColumn(db);

  // 迁移: AI 小镇 v2 — town_maps/locations/players 加列（新表由上方 CREATE IF NOT EXISTS 覆盖）
  migrateTownV2Schema(db);
  migrateTownSchema(db);
  migrateTownActionSchema(db);
  ensureTownDialogueSchema(db);
  // 迁移: 世界地图骨架（叙事地理，「地图」页）—— 与 town_maps 网格图刻意分开
  migrateTownEconomySchema(db);
  migrateTownNpcFunctionsSchema(db);
  migrateTownNpcEventSchema(db);
  migrateTownResponsibilitySchema(db);
  migrateTownCharacterCapabilitiesSchema(db);
  migrateTownCharacterProfileSchema(db);
  migrateTownExperienceSchema(db);
  migrateTownServiceOfferSchema(db);
  migrateTownMultiMapSchema(db);
  // 迁移: 小镇特殊建筑功能（配置/操作/配额/模板事件 + 地点用途描述列）；依赖 town_locations
  //       （上游 v3.9.0 合并，见 services/town/townBuildingFeature*）
  migrateTownBuildingFeatureSchema(db);

  // 迁移: 建筑地点不再携带 trade 能力位（一次性，幂等）。店内买卖全部走功能模板货架
  // （店铺舞台），地点上的 trade 只会喂出打不开东西的「交易」入口与旧层货架数据。
  try {
    const rows = db.prepare("SELECT id, capabilities_json FROM town_locations WHERE capabilities_json LIKE '%trade%'").all();
    let cleaned = 0;
    for (const row of rows) {
      try {
        const caps = JSON.parse(row.capabilities_json);
        if (!Array.isArray(caps) || !caps.includes('trade')) continue;
        db.prepare('UPDATE town_locations SET capabilities_json = ? WHERE id = ?')
          .run(JSON.stringify(caps.filter(c => c !== 'trade')), row.id);
        cleaned += 1;
      } catch { /* 单行坏数据跳过，不影响其余清理 */ }
    }
    if (cleaned > 0) console.log(`[db] migration: removed trade capability from ${cleaned} town location(s)`);
  } catch (err) {
    console.log('[db] trade capability cleanup skipped:', err.message);
  }

  // 迁移: 亲密档案与统计看板 — character_body_profile / character_intimate_log /
  //       character_intimate_firsts / character_intimate_stats / character_intimate_backfill /
  //       character_intimate_suggestions（AI 待确认提议）
  //       （见 services/intimateService.js 与 services/intimateAiEdit.js）
  migrateIntimateSchema(db);

  // 迁移: 性爱交互「可点击推进」进行中状态 — character_intimate_scene（每角色一行，
  //       体位 / 是否插入中 / 节奏档 / 累积度；见 services/intimateActionService.js）
  migrateIntimateSceneSchema(db);

  // 迁移: 催眠手机 — character_hypnosis / hypnosis_forgotten_windows（见 services/hypnosisService.js）
  migrateHypnosisSchema(db);

  // 迁移: SLG 动作系统 — character_touch_state（腻烦 / 偏好）/ touch_events（动作待反应，见 routes/touch.js）
  migrateTouchSchema(db);

  // 迁移: 成人玩具系统 — character_worn_toys（佩戴状态，专题-玩具系统 §2.2，见 services/toyService.js）
  migrateWornToysSchema(db);

  // 玩具玩法状态 — toy_play_state / toy_self_play_log（2026-10-02 玩法扩充；
  // 与佩戴表紧邻，因为两者是同一套玩法的状态与流水）
  migrateToyPlaySchema(db);

  // 迁移: 私密时刻 — character_private_moments（2026-10-02「自慰事件 / 闯入」，
  // 见 services/privateMomentService.js：一天一条，落在她**日程里的独处时段**上）
  migratePrivateMomentSchema(db);

  // 迁移: 灵魂系统 — soul_states 表 + memory_fragments.soul_snapshot 列（上游 v3.9.0 合并，
  // 见 services/soulEngine.js）。排在这附近与上游 index.js 的调用顺序一致（都在记忆整理之前）
  migrateSoulSchema(db);

  // 迁移: 角色日记（每角色每日一篇，同日覆盖、历史保留；上游 v3.9.0 合并，
  // 见 services/diaryGenerator.js）
  migrateCharacterDiarySchema(db);

  // 迁移: 场景服装系统 — character_outfits.scene / body + character_standings（2026-10-13，
  // 上游 v3.9.0 的 4 态场景服装 + PR #24 的五态与身体分层，见 services/outfitScene.js）
  migrateCharacterOutfitScene(db);

  // 迁移: 角色操作反馈短句包 — character_reaction_packs（每角色一份有效包，
  // 保存完整 JSON + 协议版本 + 人格指纹；见 services/characterReactionPackService.js）
  migrateCharacterReactionPacksSchema(db);

  // 迁移: 角色文件夹 — character_folders 表 + characters.folder_id 列（上游 v3.9.0 合并，
  //       单层分类：一个角色只属于一个文件夹，folder_id 为 NULL 表示「未分类」；
  //       删除文件夹只把成员置回未分类，不动角色本体）
  migrateCharacterFolderSchema(db);

  // 迁移: 媒体内容页 — media_outlets / media_boards / media_posts 结构升级 + 默认媒体种子
  //       （上游 v3.9.0 合并，见 db/mediaSchema.js 与 services/mediaService.js）
  migrateMediaSchema(db);

  // 迁移: 移除 user_portraits 的 appearance 维度（用户外观由 config.user.appearance 自述，
  // 不再需要角色视角提取；幂等清理，每次启动执行。表的 CHECK 枚举保留 'appearance' 不重建表，无害）
  try {
    const r = db.prepare(`DELETE FROM user_portraits WHERE trait_type = 'appearance'`).run();
    if (r.changes > 0) console.log(`[db] migration: removed ${r.changes} appearance portrait row(s)`);
  } catch (err) {
    console.log('[db] appearance portrait cleanup skipped:', err.message);
  }

  // 迁移: 梦境系统已改为常驻逻辑（无开关），清理残留的 flag 设置行
  try {
    db.prepare(`DELETE FROM system_settings WHERE setting_key = 'feature_dreams'`).run();
  } catch (err) {
    console.log('[db] feature_dreams cleanup skipped:', err.message);
  }

  // 种子: 注入全部初始数据（仅首次运行生效）
  seedAll(db);
  // 迁移: 角色作用域（characters.is_system）—— 必须在 seedAll 之后，
  // 因为要让刚种出来的默认助手被标成系统角色（2026-11-08）
  migrateCharacterScope(db);
  // 新存档 seed 会创建默认角色；首启就完成 actor 回填，避免第二次启动才补身份。
  createTownActorRegistry(db).synchronize();
  // 种子: 表情类别（仅首次运行插入默认 15 类）
  seedEmojiCategories(db);
  migrateEmojiCategoriesV2(db);
  // 迁移: 表情包多配置单（emoji_sets + character_emojis.set_id，旧数据回填默认配置单）
  migrateEmojiSetsSchema(db);
  // 迁移: 语音合成任务表（tts_speech_jobs / character_api_voices 等，幂等）
  migrateTtsSchema(db);
  migrateGodSaysSchema(db);

  // 种子: 奇遇事件类型库 + 朋友圈话题库（INSERT OR IGNORE，仅插入缺失的系统条目，不覆盖用户编辑）
  seedEventLibraries(db);

  // 图片提示词知识使用独立版本化种子；版本升级时只覆盖内置同 ID 条目，保留用户自建条目。
  seedImagePromptKnowledge(db);

  // 系统设置: 注入句柄并从 DB 加载覆盖 config 内存（DB 优先于代码默认值）
  initSettingsHandle(db);
  loadSystemSettings(db);
  initWorldRepository(db);
  migrateLorebooks(db);
  migratePresets(db);

  // 重建 FTS5 索引
  rebuildFtsIndex(db);

  // 启动时 FTS 写入测试：部分损坏场景下 SELECT 能过但 INSERT 会炸，提前修复
  try {
    db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', -1, 'fts_write_test')`).run();
  } catch (writeErr) {
    if (writeErr.code === 'SQLITE_CORRUPT_VTAB') {
      console.log('[db] FTS5 write-test failed at startup, force rebuilding...');
      // 用导出的 repairFtsIndex 不行（circular），直接内联重建
      db.exec(`DROP TRIGGER IF EXISTS messages_ai`);
      db.exec(`DROP TRIGGER IF EXISTS messages_ad`);
      db.exec(`DROP TRIGGER IF EXISTS messages_au`);
      db.exec(`DROP TABLE IF EXISTS messages_fts`);
      db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id')`);
      db.exec(`CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END;`);
      db.exec(`CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content); END;`);
      db.exec(`CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content); INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END;`);
      // 全量重建索引
      const msgs = db.prepare(`SELECT id, content FROM messages`).all();
      const insert = db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`);
      for (const m of msgs) insert.run(m.id, m.content);
      console.log(`[db] FTS5 startup force-rebuild: ${msgs.length} messages indexed`);
    } else {
      throw writeErr;
    }
  }
}

export const version = 1;
export const description = "旧库兼容基线（保留原顺序，每次启动幂等修复）";
export const transactional = false;
export const up = initSchema;

