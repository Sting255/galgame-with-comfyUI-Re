import { getDb } from '../../index.js';


/**
 * 种子：奇遇事件类型库 + 朋友圈话题库
 * 仅插入缺失的系统条目（INSERT OR IGNORE），不覆盖用户对已有条目的编辑；
 * 软删除（is_active=0）的条目行仍存在，因此不会在下次启动时复活。
 */
/** 种子：默认表情类别（仅当 emoji_categories 为空时插入） */
export function seedEmojiCategories(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM emoji_categories').get();
  if (row?.c > 0) return;
  const insert = db.prepare('INSERT INTO emoji_categories (emoji_key, sort_order) VALUES (?, ?)');
  const keys = ['开心', '难过', '哭', '生气', '哈哈大笑', '卖萌', '晕倒', '害羞', '惊讶', '委屈', '得意', '比心', '无语', '嫌弃', '心虚'];
  for (let i = 0; i < keys.length; i++) insert.run(keys[i], i + 1);
}


/** 迁移：给旧默认 12 类追加新增的 3 个默认类别，不打扰已自定义的列表 */
export function migrateEmojiCategoriesV2(db) {
  try {
    const existing = new Set(db.prepare('SELECT emoji_key FROM emoji_categories').all().map(r => r.emoji_key));
    const legacyDefaults = ['开心', '难过', '悲伤', '生气', '哈哈大笑', '卖萌', '晕倒', '害羞', '惊讶', '委屈', '得意', '比心'];
    if (!legacyDefaults.every(k => existing.has(k))) return;
    const newKeys = ['无语', '嫌弃', '心虚'].filter(k => !existing.has(k));
    if (newKeys.length === 0) return;
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM emoji_categories').get().m;
    const insert = db.prepare('INSERT OR IGNORE INTO emoji_categories (emoji_key, sort_order) VALUES (?, ?)');
    newKeys.forEach((k, i) => insert.run(k, maxOrder + i + 1));
    console.log(`[db] migrateEmojiCategoriesV2: appended ${newKeys.join('、')}`);
  } catch (err) {
    console.log('[db] migrateEmojiCategoriesV2 error:', err.message);
  }
}

/** 迁移：表情包多配置单 — character_emojis 加 set_id 列（唯一约束从 character_id+emoji_key
 * 换成 set_id+emoji_key，SQLite 改约束需整表重建），并为已有表情的角色各回填一张启用中的
 * 「默认表情包」配置单；从没生成过表情的角色不建单，首次生成时由服务层自动补建 */
export function migrateEmojiSetsSchema(db) {
  try {
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_emojis'`).get();
    if (!tableExists) return; // 全新库：initSchema 已按新结构建表，只需确保索引
    const cols = db.prepare('PRAGMA table_info(character_emojis)').all();
    if (cols.some(c => c.name === 'set_id')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_character_emojis_set ON character_emojis(set_id, status)`);
      return;
    }

    // 1) 为已有表情的角色各回填一张启用中的默认配置单。
    //    先清掉孤儿表情行（角色已删但行残留）：否则回填默认组会因 FK 校验失败中断整个迁移，
    //    新代码就会对着旧表结构跑（查 set_id 直接报错）
    const orphanRemoved = db.prepare(`
      DELETE FROM character_emojis WHERE character_id NOT IN (SELECT id FROM characters)
    `).run();
    if (orphanRemoved.changes > 0) {
      console.log(`[db] migrateEmojiSetsSchema: removed ${orphanRemoved.changes} orphaned character_emojis row(s)`);
    }
    const charIds = db.prepare('SELECT DISTINCT character_id FROM character_emojis ORDER BY character_id').all().map(r => r.character_id);
    const insertSet = db.prepare(`INSERT INTO emoji_sets (character_id, name, is_active) VALUES (?, '默认表情包', 1)`);
    db.transaction(() => { for (const cid of charIds) insertSet.run(cid); })();

    // 2) 重建 character_emojis，把存量行挂到各自角色的默认配置单上
    db.exec(`DROP TABLE IF EXISTS character_emojis_new`);
    db.exec(`
      CREATE TABLE character_emojis_new (
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
      INSERT INTO character_emojis_new (id, character_id, set_id, emoji_key, prompt, image_path, style, status, error_message, created_at, updated_at)
        SELECT ce.id, ce.character_id, es.id, ce.emoji_key, ce.prompt, ce.image_path, ce.style, ce.status, ce.error_message, ce.created_at, ce.updated_at
        FROM character_emojis ce
        JOIN emoji_sets es ON es.character_id = ce.character_id AND es.is_active = 1;
      DROP TABLE character_emojis;
      ALTER TABLE character_emojis_new RENAME TO character_emojis;
      CREATE INDEX IF NOT EXISTS idx_character_emojis_character ON character_emojis(character_id, status);
      CREATE INDEX IF NOT EXISTS idx_character_emojis_set ON character_emojis(set_id, status);
    `);
    console.log(`[db] migrateEmojiSetsSchema: character_emojis rebuilt with set_id, ${charIds.length} default emoji set(s) backfilled`);
  } catch (err) {
    console.log('[db] migrateEmojiSetsSchema error:', err.message);
  }
}


/** 镇民朋友圈：moment_posts 作者扩展为「角色或镇民二选一」。
 * 老库的 character_id 带 NOT NULL，只能整体重建才能挂 npc_id；
 * FK 子表（评论/点赞）按表名解析，重建后自动指向新表。 */
export function migrateMomentPostNpcAuthors(db) {
  const cols = db.prepare('PRAGMA table_info(moment_posts)').all();
  const charCol = cols.find(c => c.name === 'character_id');
  if (!charCol) return;
  if (!charCol.notnull) {
    if (!cols.find(c => c.name === 'npc_id')) {
      db.exec(`ALTER TABLE moment_posts ADD COLUMN npc_id INTEGER REFERENCES town_npcs(id) ON DELETE CASCADE`);
      console.log('[db] Added moment_posts.npc_id column');
    }
    return;
  }
  const rebuild = () => {
    db.exec(`
      CREATE TABLE moment_posts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
        npc_id INTEGER REFERENCES town_npcs(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        images TEXT DEFAULT '[]',
        prompt TEXT,
        style TEXT,
        resolution TEXT DEFAULT '1600x1200',
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','generating','done','failed')),
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        CHECK ((character_id IS NULL) != (npc_id IS NULL))
      );
      INSERT INTO moment_posts_new (id, character_id, npc_id, content, images, prompt, style, resolution, status, error_message, created_at)
        SELECT id, character_id, NULL, content, images, prompt, style, resolution, status, error_message, created_at FROM moment_posts;
      DROP TABLE moment_posts;
      ALTER TABLE moment_posts_new RENAME TO moment_posts;
      CREATE INDEX IF NOT EXISTS idx_moment_posts_character ON moment_posts(character_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_moment_posts_created ON moment_posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_moment_posts_filter ON moment_posts(status);
      CREATE INDEX IF NOT EXISTS idx_moment_posts_npc ON moment_posts(npc_id, created_at DESC);
    `);
  };
  const fkWasOn = db.pragma('foreign_keys', { simple: true });
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(rebuild)();
    console.log('[db] Rebuilt moment_posts to support town npc authors');
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}


/** 用户朋友圈：moment_posts 允许「用户作者」（character_id 与 npc_id 同时为 NULL）。
 * 老库/上一版建表带严格 CHECK（恰一作者），需整体重建为「至多一作者」。 */
export function migrateMomentPostUserAuthors(db) {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'moment_posts'`
  ).get();
  if (!row?.sql) return;
  if (!row.sql.includes('(character_id IS NULL) != (npc_id IS NULL)')) return;

  const rebuild = () => {
    db.exec(`
      CREATE TABLE moment_posts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
        npc_id INTEGER REFERENCES town_npcs(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        images TEXT DEFAULT '[]',
        prompt TEXT,
        style TEXT,
        resolution TEXT DEFAULT '1600x1200',
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','generating','done','failed')),
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        CHECK (character_id IS NULL OR npc_id IS NULL)
      );
      INSERT INTO moment_posts_new (id, character_id, npc_id, content, images, prompt, style, resolution, status, error_message, created_at)
        SELECT id, character_id, npc_id, content, images, prompt, style, resolution, status, error_message, created_at FROM moment_posts;
      DROP TABLE moment_posts;
      ALTER TABLE moment_posts_new RENAME TO moment_posts;
      CREATE INDEX IF NOT EXISTS idx_moment_posts_character ON moment_posts(character_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_moment_posts_created ON moment_posts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_moment_posts_filter ON moment_posts(status);
      CREATE INDEX IF NOT EXISTS idx_moment_posts_npc ON moment_posts(npc_id, created_at DESC);
    `);
  };
  const fkWasOn = db.pragma('foreign_keys', { simple: true });
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(rebuild)();
    console.log('[db] Rebuilt moment_posts to support user authors');
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}


export function migrateMomentsSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'next_moment_at')) {
      db.exec(`ALTER TABLE characters ADD COLUMN next_moment_at DATETIME`);
      console.log('[db] Added characters.next_moment_at column');
    }
    if (!cols.find(c => c.name === 'moments_disabled')) {
      db.exec(`ALTER TABLE characters ADD COLUMN moments_disabled INTEGER DEFAULT 0`);
      console.log('[db] Added characters.moments_disabled column (default 0)');
    }
    migrateMomentPostNpcAuthors(db);
    migrateMomentPostUserAuthors(db);
  } catch (err) {
    console.log('[db] migrateMomentsSchema error:', err.message);
  }
}


/**
 * 迁移: moment_comments 新增 auto_trigger + thread_root_id + reply_to_comment_id
 * （朋友圈关系网互动 / 用户楼中楼回复与 @ 点名）
 */
export function migrateMomentAutoTrigger(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(moment_comments)`).all();
    if (!cols.find(c => c.name === 'auto_trigger')) {
      db.exec(`ALTER TABLE moment_comments ADD COLUMN auto_trigger INTEGER DEFAULT 0`);
      console.log('[db] Added moment_comments.auto_trigger column (default 0)');
    }
    if (!cols.find(c => c.name === 'thread_root_id')) {
      db.exec(`ALTER TABLE moment_comments ADD COLUMN thread_root_id INTEGER DEFAULT NULL`);
      console.log('[db] Added moment_comments.thread_root_id column (nullable)');
    }
    if (!cols.find(c => c.name === 'reply_to_comment_id')) {
      db.exec(`ALTER TABLE moment_comments ADD COLUMN reply_to_comment_id INTEGER DEFAULT NULL`);
      console.log('[db] Added moment_comments.reply_to_comment_id column (nullable)');
    }
  } catch (err) {
    console.log('[db] migrateMomentAutoTrigger error:', err.message);
  }
}


/**
 * 迁移: 延迟评论队列的持久唯一键（P1-04）。
 *
 * 背景：`enqueueDeferredCommentReply` 原来靠「先查再插」做去重，那不是原子幂等——
 * 两个并发请求（或进程重启后重放）都能通过查询再各插一行，同一条用户评论会被回两次。
 *
 * 现在：
 *   1. 给 `moment_comment_queue` 加 `reply_comment_id`（回填落库后的评论 id，供安全重放判断）；
 *   2. 建**部分唯一索引** `(character_id, user_comment_id) WHERE status IN ('waiting','processing')`
 *      —— 只约束「还在排队的」，done/cancelled 的历史行可以重复（同一个人以后还能再被评论）；
 *   3. 建索引前先清理历史重复：保留每组最早的一行，其余标 cancelled。
 *
 * 幂等：重复启动不报错（IF NOT EXISTS / 先查后建）。
 */
export function migrateMomentCommentQueueUnique(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(moment_comment_queue)`).all();
    if (!cols.length) return;   // 表还没建（旧库首次初始化顺序不同）
    if (!cols.find(c => c.name === 'reply_comment_id')) {
      db.exec(`ALTER TABLE moment_comment_queue ADD COLUMN reply_comment_id INTEGER DEFAULT NULL`);
      console.log('[db] Added moment_comment_queue.reply_comment_id column');
    }

    // 历史重复清理：同 (character_id, user_comment_id) 的活跃行只留最早那条
    const dupes = db.prepare(`
      SELECT character_id, user_comment_id, MIN(id) AS keep_id, COUNT(*) AS n
      FROM moment_comment_queue
      WHERE status IN ('waiting','processing')
      GROUP BY character_id, user_comment_id
      HAVING n > 1
    `).all();
    let cancelled = 0;
    const cancel = db.prepare(`
      UPDATE moment_comment_queue SET status = 'cancelled'
      WHERE character_id = ? AND user_comment_id = ? AND status IN ('waiting','processing') AND id != ?
    `);
    for (const row of dupes) {
      const r = cancel.run(row.character_id, row.user_comment_id, row.keep_id);
      cancelled += r.changes;
    }
    if (cancelled > 0) console.log(`[db] moment_comment_queue: 清理 ${cancelled} 条重复排队行`);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_comment_queue_active_unique
      ON moment_comment_queue(character_id, user_comment_id)
      WHERE status IN ('waiting','processing')
    `);
  } catch (err) {
    console.log('[db] migrateMomentCommentQueueUnique error:', err.message);
  }
}


/**
 * 迁移: moment_unread 计数 → 时序方案 (last_moments_seen_at)
 *
 * 旧方案：moment_unread 表中维护一个 count 整数，broadcastNewPost +1，markRead 清零。
 * 新方案：system_settings 中存 last_moments_seen_at 时间戳，
 *         未读数 = COUNT(*) FROM moment_posts WHERE created_at > last_moments_seen_at。
 *
 * 迁移时尽可能保留旧计数的语义：如果旧 count = N，则 last_moments_seen_at
 * 设为第 N 篇最旧未读帖子的 created_at（即从该帖之后开始算未读）。
 */
export function migrateMomentUnreadToTimestamp(db) {
  try {
    // 检查旧表是否存在
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'moment_unread'`
    ).get();

    if (!tableExists) {
      // 全新安装：直接种子默认值（epoch，所有帖子都视为已读）
      seedLastMomentsSeenAt(db, new Date(0).toISOString());
      return;
    }

    // 读旧计数
    const oldRow = db.prepare(`SELECT count FROM moment_unread WHERE id = 1`).get();
    const oldCount = oldRow ? oldRow.count : 0;

    let lastSeenAt;
    if (oldCount > 0) {
      // 第 N 篇最旧未读帖子 = 按时间升序的第 oldCount 篇（跳过已读的）
      // OFFSET oldCount - 1：第 1 篇未读是最旧的未读帖
      const boundary = db.prepare(
        `SELECT created_at FROM moment_posts WHERE status = 'done' ORDER BY created_at DESC LIMIT 1 OFFSET ?`
      ).get(oldCount);

      if (boundary && boundary.created_at) {
        // last_moments_seen_at = 边界帖的 created_at（created_at > last_seen 会包含该帖及更新的）
        // 为了让 COUNT(*) WHERE created_at > last_seen 刚好 = oldCount，
        // 设 last_seen = 边界帖 created_at 的前一秒
        const boundaryDate = new Date(boundary.created_at.replace(' ', 'T') + 'Z');
        boundaryDate.setSeconds(boundaryDate.getSeconds() - 1);
        lastSeenAt = boundaryDate.toISOString();
      } else {
        // 没有帖子，置为当前时间
        lastSeenAt = new Date().toISOString();
      }
    } else {
      // count = 0：全部已读，设为当前时间
      lastSeenAt = new Date().toISOString();
    }

    seedLastMomentsSeenAt(db, lastSeenAt);
    console.log(`[db] migrateMomentUnreadToTimestamp: old count=${oldCount} → last_seen=${lastSeenAt}`);

    // 删除旧表
    db.exec(`DROP TABLE IF EXISTS moment_unread`);
    console.log('[db] Dropped legacy moment_unread table');
  } catch (err) {
    console.log('[db] migrateMomentUnreadToTimestamp error:', err.message);
  }
}


/** 种子 last_moments_seen_at（如已存在则保留现有值） */
export function seedLastMomentsSeenAt(db, defaultValue) {
  db.prepare(
    `INSERT OR IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, ?)`
  ).run('last_moments_seen_at', defaultValue);
}


/**
 * 迁移: 朋友圈话题库 —— 判重口径 + checked 列（2026-10-14）
 *
 * 老库（真库）的 moment_topics 是 `name TEXT NOT NULL UNIQUE` 且没有 checked 列；
 * 新口径是**同来源内 name 唯一**（自定义话题允许与系统话题同名）+ `checked`（是否参与自动抽取）。
 * SQLite 改不了列上的 UNIQUE 约束，只能重建表。
 *
 * 幂等判定：已有 checked 列 **且** 没有「只针对 name 单列」的唯一索引 ⇒ 已迁过，直接返回。
 * 有跨来源重名时用 INSERT OR IGNORE 保留先插入的那条、丢掉后面的，不让迁移炸掉。
 */
export function migrateMomentTopicsSchema(db = getDb()) {
  try {
    const cols = db.prepare(`PRAGMA table_info(moment_topics)`).all();
    if (!cols.length) return;   // 表还没建（正常流程下 CREATE 块先跑，这里只兜底）
    const hasChecked = cols.some(c => c.name === 'checked');
    // 老库的 name 单列 UNIQUE 会以 sqlite_autoindex_* 形式出现在 index_list 里；
    // 我们自己建的复合唯一索引是 (name, source)，两列，不会被误判。
    const nameOnlyUnique = db.prepare(`PRAGMA index_list(moment_topics)`).all().some(index => {
      if (!index.unique) return false;
      const info = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all();
      return info.length === 1 && info[0].name === 'name';
    });
    if (hasChecked && !nameOnlyUnique) return;

    let kept = 0, dropped = 0;
    db.transaction(() => {
      // 索引名在库内全局唯一：先丢掉旧的同名索引，否则重建表后 CREATE INDEX 会静默变成 no-op
      db.exec('DROP INDEX IF EXISTS idx_moment_topics_name_source');
      db.exec('ALTER TABLE moment_topics RENAME TO moment_topics_legacy');
      db.exec(`
        CREATE TABLE moment_topics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          desc TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'default' CHECK(source IN ('default','custom')),
          is_active INTEGER NOT NULL DEFAULT 1,
          checked INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_topics_name_source ON moment_topics(name, source);
      `);
      // checked 老行统一按 1（照旧参与自动抽取，行为不变）
      const res = db.prepare(`
        INSERT OR IGNORE INTO moment_topics (id, name, desc, source, is_active, checked, created_at, updated_at)
        SELECT id, name, desc, source, is_active, 1, created_at, updated_at FROM moment_topics_legacy
      `).run();
      kept = res.changes;
      dropped = db.prepare('SELECT COUNT(*) AS n FROM moment_topics_legacy').get().n - kept;
      db.exec('DROP TABLE moment_topics_legacy');
    })();

    console.log(`[db] migrateMomentTopicsSchema: moment_topics rebuilt (kept ${kept}${dropped > 0 ? `, dropped ${dropped}` : ''})`);
    if (dropped > 0) console.warn(`[db] migrateMomentTopicsSchema: ${dropped} 条跨来源重名话题未能迁移（(name, source) 唯一，保留先插入的那条）`);
  } catch (err) {
    console.warn('[db] migrateMomentTopicsSchema error:', err.message);
  }
}


/**
 * 私密时刻（2026-10-02 用户：「再增加一个事件 叫自慰 和角色敏感度也相关 越高发生概率也就越高
 * 这个可以算到日程里」「这个时候再去找角色私聊就会触发事件 玩家闯入角色正在自慰的情况」）。
 *
 * 一天（一个日程槽）**最多一行** ⇒ `UNIQUE(character_id, slot_date, slot_key)`：
 * 判定是**确定性**的（种子 + 槽位哈希），所以"这一天她做不做"不会因为刷新而变来变去；
 * 行本身也是"她做过这件事"的流水（`caught_at` = 第一次被撞见的时间）。
 *
 * ⚠️ 时间口径：**程序时间的分钟数**（`start_minute`/`end_minute` = 当天 0 点起的分钟），
 * 不存绝对时间戳 —— 日程本身就是程序时间（HH:MM），存绝对时间会在"程序时间跳天/加速"后对不上。
 * 只有 `caught_at` / `created_at` 是真实时间戳（历史排序用，与别的表同口径）。
 */
export function migratePrivateMomentSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_private_moments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'self_play',
        slot_date TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        slot_activity TEXT NOT NULL DEFAULT '',
        slot_location TEXT NOT NULL DEFAULT '',
        start_minute INTEGER NOT NULL DEFAULT 0,
        end_minute INTEGER NOT NULL DEFAULT 0,
        probability REAL NOT NULL DEFAULT 0,
        roll REAL NOT NULL DEFAULT 0,
        sensitivity REAL NOT NULL DEFAULT 0,
        caught_at DATETIME,
        caught_times INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(character_id, slot_date, slot_key)
      );

      CREATE INDEX IF NOT EXISTS idx_private_moments_char ON character_private_moments (character_id, slot_date DESC);
    `);
  } catch (err) {
    console.log('[db] migratePrivateMomentSchema error:', err.message);
  }
}
