


export function migrateRollingSummaryCheckpointSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(rolling_summaries)`).all();
    if (!cols.some(c => c.name === 'checkpoint_version')) {
      // 旧算法的 end_msg_id 可能超过实际摘要范围；新增列时将历史记录标为 0。
      db.exec(`ALTER TABLE rolling_summaries ADD COLUMN checkpoint_version INTEGER NOT NULL DEFAULT 0`);
    }
  } catch (err) {
    console.log('[db] migrateRollingSummaryCheckpointSchema error:', err.message);
  }
}


export function rebuildFtsIndex(db) {
  // ── 轻量完整性检查：不每次清空重建，只在确实损坏或计数不一致时才处理 ──
  let ftsOk = false;
  let ftsCount = 0;
  try {
    ftsCount = db.prepare(`SELECT count(*) AS c FROM messages_fts`).get().c;
    ftsOk = true;
  } catch (err) {
    if (err.code === 'SQLITE_CORRUPT_VTAB') {
      console.log('[db] FTS5 table corrupted, recreating...');
      // 先删触发器（它们依赖 messages_fts）
      db.exec(`DROP TRIGGER IF EXISTS messages_ai`);
      db.exec(`DROP TRIGGER IF EXISTS messages_ad`);
      db.exec(`DROP TRIGGER IF EXISTS messages_au`);
      // 删掉损坏的虚拟表
      db.exec(`DROP TABLE IF EXISTS messages_fts`);
      // 重建
      db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content,
          content='messages',
          content_rowid='id'
        );
      `);
      // 重建触发器
      db.exec(`
        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
      db.exec(`
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;
      `);
      db.exec(`
        CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
    } else {
      throw err;
    }
  }

  // 只在 FTS 损坏或计数不一致时才全量重建
  const msgCount = db.prepare(`SELECT count(*) AS c FROM messages`).get().c;
  if (!ftsOk || ftsCount !== msgCount) {
    if (ftsOk) {
      // 表完好但计数不一致 — 清空后重建
      try {
        db.exec(`DELETE FROM messages_fts`);
      } catch (delErr) {
        console.log('[db] DELETE FROM messages_fts failed, dropping and recreating...');
        db.exec(`DROP TABLE IF EXISTS messages_fts`);
        db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id')`);
      }
    }
    const msgs = db.prepare(`SELECT id, content FROM messages`).all();
    if (msgs.length > 0) {
      const insert = db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`);
      for (const m of msgs) {
        insert.run(m.id, m.content);
      }
      console.log(`[db] FTS5 index rebuilt: ${msgs.length} messages indexed`);
    }
  }
}


// ── 世界观收藏 CRUD 已下沉到 db/worldRepository.js ──
// 迁移: PAI 风格聊天记忆 v2。保留旧字段供现有管理界面兼容，新增字段作为权威语义。
// 导出供迁移回归测试使用（test/memoryIndexRetry.test.js 断言存量库的 attempts 补列行为）。
export function migrateChatMemoryV2Schema(db) {
  try {
    const columns = new Set(db.prepare(`PRAGMA table_info(memory_fragments)`).all().map(c => c.name));
    const additions = [
      ['memory_id', 'TEXT'],
      ['memory_type', "TEXT NOT NULL DEFAULT 'knowledge'"],
      ['subject', "TEXT NOT NULL DEFAULT 'user'"],
      ['judgment', "TEXT NOT NULL DEFAULT ''"],
      ['reasoning', "TEXT NOT NULL DEFAULT ''"],
      ['tags', "TEXT NOT NULL DEFAULT '[]'"],
      ['content_hash', 'TEXT'],
      ['status', "TEXT NOT NULL DEFAULT 'active'"],
      ['source_raw_start_id', 'INTEGER'],
      ['source_raw_end_id', 'INTEGER'],
      ['embedding_profile', 'TEXT'],
      ['embedding_state', "TEXT NOT NULL DEFAULT 'disabled'"],
      ['embedding_error', 'TEXT'],
      ['updated_at', 'DATETIME'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) db.exec(`ALTER TABLE memory_fragments ADD COLUMN ${name} ${definition}`);
    }

    db.exec(`
      UPDATE memory_fragments
      SET memory_id = COALESCE(memory_id, 'legacy_' || id),
          memory_type = CASE fragment_type WHEN 'emotion' THEN 'emotion' ELSE 'knowledge' END,
          judgment = CASE WHEN judgment = '' THEN content ELSE judgment END,
          tags = CASE WHEN tags = '[]' THEN COALESCE(entities, '[]') ELSE tags END,
          status = COALESCE(status, 'active'),
          updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
      WHERE memory_id IS NULL OR judgment = '' OR updated_at IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_fragments_memory_id ON memory_fragments(memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_fragments_active_conv ON memory_fragments(conversation_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_fragments_source_raw ON memory_fragments(conversation_id, source_raw_start_id, source_raw_end_id);

      CREATE TABLE IF NOT EXISTS memory_extraction_checkpoints (
        conversation_id TEXT PRIMARY KEY,
        last_raw_msg_id INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memory_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('update','merge','rollback')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memory_index_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        memory_id TEXT,
        profile TEXT,
        priority INTEGER NOT NULL DEFAULT 10,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS memory_retrieval_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        query TEXT NOT NULL,
        mode TEXT NOT NULL,
        candidate_sources TEXT NOT NULL DEFAULT '{}',
        memory_ids TEXT NOT NULL DEFAULT '[]',
        fallback_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fragments_fts USING fts5(
        judgment, reasoning, tags,
        content='memory_fragments', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS memory_fragments_fts_ai AFTER INSERT ON memory_fragments BEGIN
        INSERT INTO memory_fragments_fts(rowid, judgment, reasoning, tags)
        VALUES (new.id, new.judgment, new.reasoning, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_fragments_fts_ad AFTER DELETE ON memory_fragments BEGIN
        INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, judgment, reasoning, tags)
        VALUES ('delete', old.id, old.judgment, old.reasoning, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_fragments_fts_au AFTER UPDATE OF judgment, reasoning, tags ON memory_fragments BEGIN
        INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, judgment, reasoning, tags)
        VALUES ('delete', old.id, old.judgment, old.reasoning, old.tags);
        INSERT INTO memory_fragments_fts(rowid, judgment, reasoning, tags)
        VALUES (new.id, new.judgment, new.reasoning, new.tags);
      END;
    `);
    const indexJobColumns = new Set(db.prepare(`PRAGMA table_info(memory_index_jobs)`).all().map(c => c.name));
    if (!indexJobColumns.has('priority')) {
      db.exec(`ALTER TABLE memory_index_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 10`);
    }
    // 失败自动重试的计数列（上限见 memoryRepository.MAX_INDEX_ATTEMPTS）：
    // 此前索引任务没有 attempts，一次失败就永久停在 failed，只能人工点「重试失败任务」。
    if (!indexJobColumns.has('attempts')) {
      db.exec(`ALTER TABLE memory_index_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_index_jobs_queue ON memory_index_jobs(status, priority, id)`);
    const ftsCount = db.prepare(`SELECT COUNT(*) AS count FROM memory_fragments_fts`).get().count;
    const memoryCount = db.prepare(`SELECT COUNT(*) AS count FROM memory_fragments`).get().count;
    if (ftsCount !== memoryCount) {
      db.prepare(`INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES ('rebuild')`).run();
    }
    db.prepare(`
      INSERT OR IGNORE INTO system_settings(setting_key, setting_value, updated_at)
      VALUES ('memory_settings', ?, CURRENT_TIMESTAMP)
    `).run(JSON.stringify({
      enabled: true,
      topK: 7,
      textCandidates: 24,
      vectorCandidates: 24,
      embedding: { enabled: false, provider: 'custom', baseURL: '', apiKey: '', model: '', dimensions: null, headers: {}, timeoutMs: 8000 },
      reranker: { enabled: false, provider: 'custom', baseURL: '', apiKey: '', model: '', topN: 7, headers: {}, timeoutMs: 8000 },
    }));
  } catch (err) {
    console.error('[db] migrateChatMemoryV2Schema error:', err.message);
    throw err;
  }
}


// 迁移: 记忆 v3 —— MMS 多重表示（keywords/perspectives/episodic_note 为检索单元，semantic_note
// 为注入单元）、双时态演化列（valid_from/valid_to，替换改为"置失效+保留历史"）、实体与三元组
// 索引层（平行表，不上图数据库）。设计依据 docs/memory-upgrade-plan.md。
// 导出供迁移回归测试使用（test/memoryV3Migration.test.js）。
export function migrateChatMemoryV3Schema(db) {
  try {
    const columns = new Set(db.prepare(`PRAGMA table_info(memory_fragments)`).all().map(c => c.name));
    const additions = [
      // 检索单元字段（进 FTS / 向量 / LIKE 通道）
      ['keywords', "TEXT NOT NULL DEFAULT '[]'"],
      ['perspectives', "TEXT NOT NULL DEFAULT '[]'"],
      ['episodic_note', "TEXT NOT NULL DEFAULT ''"],
      // 注入单元字段（只进 <rag_memories>，刻意不进任何检索通道）
      ['semantic_note', "TEXT NOT NULL DEFAULT ''"],
      // 双时态演化
      ['event_time', 'DATETIME'],
      ['valid_from', 'DATETIME'],
      ['valid_to', 'DATETIME'],
      // 强度模型（遗忘曲线，阶段三整理 daemon 消费）
      ['importance', 'INTEGER NOT NULL DEFAULT 3'],
      ['strength', 'REAL NOT NULL DEFAULT 1.0'],
      ['last_reinforced_at', 'DATETIME'],
      ['retrieval_count', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) db.prepare(`ALTER TABLE memory_fragments ADD COLUMN ${name} ${definition}`).run();
    }

    const relationColumns = new Set(db.prepare(`PRAGMA table_info(memory_relations)`).all().map(c => c.name));
    if (!relationColumns.has('relation_meta')) {
      db.prepare(`ALTER TABLE memory_relations ADD COLUMN relation_meta TEXT`).run();
    }

    const ddlStatements = [
      // 存量记忆回填 valid_from（双时态起点）
      `UPDATE memory_fragments SET valid_from = COALESCE(valid_from, updated_at, created_at, CURRENT_TIMESTAMP) WHERE valid_from IS NULL`,

      // 实体索引层（Mem0 平行实体集合思路：不上图数据库，检索时 boost）
      `CREATE TABLE IF NOT EXISTS memory_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        aliases TEXT NOT NULL DEFAULT '[]',
        mention_count INTEGER NOT NULL DEFAULT 0,
        embedding_state TEXT NOT NULL DEFAULT 'disabled',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON memory_entities(name)`,

      `CREATE TABLE IF NOT EXISTS memory_entity_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'mention',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(memory_id, entity_id, role)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_entity_links_entity ON memory_entity_links(entity_id, memory_id)`,

      // 三元组索引层（阶段二主动回想 query-to-triple 匹配用）
      `CREATE TABLE IF NOT EXISTS memory_triples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        subject_entity_id INTEGER,
        subject_text TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_entity_id INTEGER,
        object_text TEXT NOT NULL,
        event_time DATETIME,
        valid_from DATETIME,
        valid_to DATETIME,
        embedding_profile TEXT,
        embedding_state TEXT NOT NULL DEFAULT 'disabled',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_triples_memory ON memory_triples(memory_id)`,

      // 整理任务队列（阶段三 daemon 用；先建表占位，调度器后续接入）
      `CREATE TABLE IF NOT EXISTS memory_consolidation_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // 画像升华建议（阶段三 T4 半自动通道）
      `CREATE TABLE IF NOT EXISTS portrait_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER,
        field TEXT NOT NULL,
        current_value TEXT,
        suggestion TEXT NOT NULL,
        source_memory_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ];
    for (const sql of ddlStatements) db.prepare(sql).run();

    // 三元组语料随嵌入 profile 分流（方案 A）的列：存量库补列，旧行 embedding_profile 为空，
    // 由 memoryRepository 启动时的补嵌任务重新入队（旧向量躺在共享语料 memory_triples_v1 里）。
    const tripleColumns = new Set(db.prepare(`PRAGMA table_info(memory_triples)`).all().map(c => c.name));
    if (!tripleColumns.has('embedding_profile')) {
      db.prepare(`ALTER TABLE memory_triples ADD COLUMN embedding_profile TEXT`).run();
    }

    upgradeMemoryFtsToV3(db);
  } catch (err) {
    console.error('[db] migrateChatMemoryV3Schema error:', err.message);
    throw err;
  }
}


// 迁移: 记忆整理"已处理"记账表 + 维护索引。
//
// 背景：T1/T2/T4/T5 的候选发现只按时间窗/状态筛选，模型判定"无关 / 归纳不出结论 / 补不出字段"
// 时不产生任何内容写入，候选就不会消失——daemon 每轮扫描（默认 5 分钟、空闲时全程为真）
// 会把同一批候选重复送进 LLM。本表按 (job_type, mark_key) 记账并带 TTL
// （TTL 常量见 services/memory/memoryConsolidation.js），过期行由 T3 维护清理删除。
//
// 键约定：conflict=memory_id、generalize=会话|实体|主体、portrait_suggest=会话、backfill=memory_id。
// 导出供迁移回归测试使用（test/memoryConsolidationMarks.test.js）。
export function migrateMemoryConsolidationMarks(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_consolidation_marks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        mark_key TEXT NOT NULL,
        marked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(job_type, mark_key)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_consolidation_jobs_type
        ON memory_consolidation_jobs(job_type, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_retrieval_audits_created
        ON memory_retrieval_audits(created_at);
    `);
  } catch (err) {
    console.error('[db] migrateMemoryConsolidationMarks error:', err.message);
    throw err;
  }
}


// 迁移: 把整理 daemon 的显式配置写进既有 memory_settings 行。
//
// 背景：memory_settings 只在首次运行时 INSERT OR IGNORE，老库里根本没有 consolidation 块，
// 一直靠 normalizeMemorySettings 的默认值兜底——库里看不出实际生效的节奏，旧键
// dailyMaxLlmCalls（语义本就是"每日总量"）也一直残留。这里做一次幂等的显式化：
//   - 只动 consolidation 一个键，其余配置逐字保留；
//   - dailyMaxLlmCalls → dailyLlmCalls（语义归位，避免被读成"每轮预算"）；
//   - 已有值不覆盖（用户手改过就以用户为准），只补缺失键。
// 全新库由 migrateChatMemoryV2Schema 的种子行覆盖，本函数直接跳过。
// 注意：这里的数值不在这里做钳制，读取侧 memoryConfig.normalizeMemorySettings 统一钳制。
// 导出供迁移回归测试使用（test/consolidation.test.js）。
export function migrateMemoryConsolidationSettings(db) {
  try {
    const row = db.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'memory_settings'`).get();
    if (!row) return { skipped: 'no-settings' };

    let stored = {};
    try { stored = JSON.parse(row.setting_value) || {}; } catch { stored = {}; }
    const current = stored.consolidation && typeof stored.consolidation === 'object' && !Array.isArray(stored.consolidation)
      ? stored.consolidation
      : {};

    const fields = ['enabled', 'idleDelayMinutes', 'minIntervalMinutes', 'llmCallsPerRun', 'dailyLlmCalls', 'portraitSuggest'];
    const missing = fields.some(field => current[field] === undefined);
    const hasLegacyKey = current.dailyMaxLlmCalls !== undefined;
    if (!missing && !hasLegacyKey) return { skipped: 'up-to-date' };

    const next = {
      enabled: current.enabled === undefined ? true : Boolean(current.enabled),
      idleDelayMinutes: current.idleDelayMinutes === undefined ? 30 : current.idleDelayMinutes,
      minIntervalMinutes: current.minIntervalMinutes === undefined ? 60 : current.minIntervalMinutes,
      llmCallsPerRun: current.llmCallsPerRun === undefined ? 3 : current.llmCallsPerRun,
      dailyLlmCalls: current.dailyLlmCalls ?? current.dailyMaxLlmCalls ?? 60,
      // 用户显式开启过 T4 就必须保留：白名单漏掉这个键会把「开」悄悄改回「关」
      portraitSuggest: current.portraitSuggest === undefined ? false : Boolean(current.portraitSuggest),
    };
    stored.consolidation = next;
    db.prepare(`
      UPDATE system_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = 'memory_settings'
    `).run(JSON.stringify(stored));
    console.log(`[db] migrateMemoryConsolidationSettings: consolidation 已显式化 ${JSON.stringify(next)}`);
    return { updated: true, consolidation: next };
  } catch (err) {
    // 配置显式化失败不应阻止启动：读取侧仍有默认值兜底
    console.warn('[db] migrateMemoryConsolidationSettings skipped:', err.message);
    return { error: err.message };
  }
}


// 迁移: 把 v3 / activeSearch / contextBudget 三个阶段开关块与 useBuiltin / recordUnengagedEvents
// 显式写进既有 memory_settings 行。
//
// 背景：memory_settings 只在首次运行时 INSERT OR IGNORE，老库里这些键根本不存在，一直靠
// normalizeMemorySettings 的默认值兜底——从库里读不出实际生效值，将来修改代码默认值时老库还会
// 静默跟随新默认（排障时"为什么行为和文档不一样"往往就出在这里）。这里做一次幂等显式化：
//   - 只补缺失键，已有值一律不覆盖（用户手改过就以用户为准）；
//   - 不做范围钳制，钳制统一在读取侧 normalizeMemorySettings（与 migrateMemoryConsolidationSettings 同口径）；
//   - 数值与 memoryConfig.DEFAULT_MEMORY_SETTINGS 保持同步（本文件不能 import 它，会形成循环依赖）。
export function migrateMemorySettingsExplicitBlocks(db) {
  try {
    const row = db.prepare(`SELECT setting_value FROM system_settings WHERE setting_key = 'memory_settings'`).get();
    if (!row) return { skipped: 'no-settings' };

    let stored = {};
    try { stored = JSON.parse(row.setting_value) || {}; } catch { stored = {}; }

    const blockDefaults = {
      v3: { enabled: true },
      activeSearch: { enabled: false, timeoutMs: 4000 },
      contextBudget: { enabled: false, dynamicTokens: 8000 },
    };
    let changed = false;
    for (const [key, defaults] of Object.entries(blockDefaults)) {
      const current = stored[key];
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        for (const [field, fallback] of Object.entries(defaults)) {
          if (current[field] === undefined) { current[field] = fallback; changed = true; }
        }
      } else {
        stored[key] = { ...defaults };
        changed = true;
      }
    }
    if (stored.recordUnengagedEvents === undefined) { stored.recordUnengagedEvents = true; changed = true; }
    for (const key of ['embedding', 'reranker']) {
      const provider = stored[key];
      if (provider && typeof provider === 'object' && !Array.isArray(provider) && provider.useBuiltin === undefined) {
        provider.useBuiltin = true;
        changed = true;
      }
    }
    if (!changed) return { skipped: 'up-to-date' };

    db.prepare(`UPDATE system_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = 'memory_settings'`)
      .run(JSON.stringify(stored));
    console.log('[db] migrateMemorySettingsExplicitBlocks: v3/activeSearch/contextBudget 等开关已显式化');
    return { updated: true, keys: [...Object.keys(blockDefaults), 'recordUnengagedEvents', 'useBuiltin'] };
  } catch (err) {
    // 配置显式化失败不应阻止启动：读取侧仍有默认值兜底
    console.warn('[db] migrateMemorySettingsExplicitBlocks skipped:', err.message);
    return { error: err.message };
  }
}


// FTS 扩列 3 → 6 列：外部内容表无法 ALTER，需删表重建 + 全量 rebuild。
// semantic_note 刻意不进 FTS（高层语义提炼与提问语言形态脱节，混入降低召回，见方案 §2）。
export function upgradeMemoryFtsToV3(db) {
  const ftsSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fragments_fts'`).get();
  if (!ftsSql || /keywords/i.test(ftsSql.sql || '')) return;
  const ddlStatements = [
    `DROP TRIGGER IF EXISTS memory_fragments_fts_ai`,
    `DROP TRIGGER IF EXISTS memory_fragments_fts_ad`,
    `DROP TRIGGER IF EXISTS memory_fragments_fts_au`,
    `DROP TABLE IF EXISTS memory_fragments_fts`,
    `CREATE VIRTUAL TABLE memory_fragments_fts USING fts5(
      judgment, reasoning, tags, keywords, perspectives, episodic_note,
      content='memory_fragments', content_rowid='id'
    )`,
    `CREATE TRIGGER memory_fragments_fts_ai AFTER INSERT ON memory_fragments BEGIN
      INSERT INTO memory_fragments_fts(rowid, judgment, reasoning, tags, keywords, perspectives, episodic_note)
      VALUES (new.id, new.judgment, new.reasoning, new.tags, new.keywords, new.perspectives, new.episodic_note);
    END`,
    `CREATE TRIGGER memory_fragments_fts_ad AFTER DELETE ON memory_fragments BEGIN
      INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, judgment, reasoning, tags, keywords, perspectives, episodic_note)
      VALUES ('delete', old.id, old.judgment, old.reasoning, old.tags, old.keywords, old.perspectives, old.episodic_note);
    END`,
    `CREATE TRIGGER memory_fragments_fts_au AFTER UPDATE OF judgment, reasoning, tags, keywords, perspectives, episodic_note ON memory_fragments BEGIN
      INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, judgment, reasoning, tags, keywords, perspectives, episodic_note)
      VALUES ('delete', old.id, old.judgment, old.reasoning, old.tags, old.keywords, old.perspectives, old.episodic_note);
      INSERT INTO memory_fragments_fts(rowid, judgment, reasoning, tags, keywords, perspectives, episodic_note)
      VALUES (new.id, new.judgment, new.reasoning, new.tags, new.keywords, new.perspectives, new.episodic_note);
    END`,
    `INSERT INTO memory_fragments_fts(memory_fragments_fts) VALUES ('rebuild')`,
  ];
  for (const sql of ddlStatements) db.prepare(sql).run();
  console.log('[db] memory_fragments_fts upgraded to v3 (6-column) and rebuilt');
}
