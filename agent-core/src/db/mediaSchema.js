/**
 * mediaSchema.js — 媒体内容页（传媒 / 数字媒体）的建表与迁移。
 *
 * 2026-10-13 合并上游 v3.9.0。上游把媒体建表写在 db/index.js 的启动建表块里、
 * 迁移写成 migrateMediaSchema；本地抽成独立文件，index.js 只留一行调用。
 *
 * 表：
 *   media_outlets      媒体（内容源：论坛/报纸/匿名职场社区/暗网…），自带生成提示词
 *   media_boards       板块（媒体下的分区）
 *   media_posts        帖子（作者可为活跃角色或匿名 NPC；配图文字先落库、后台补）
 *   media_avatars      匿名 NPC 头像库
 *   media_npc_avatars  NPC 作者 → 头像的固定指派（同一作者每次出现用同一张）
 */

import { DEFAULT_MEDIA_OUTLETS } from './seedMedia.js';
import { migrateMediaAvatarLibrary } from './mediaAvatarSchema.js';
import { migrateMediaFavorites } from './mediaFavorites.js';

/** 建表（幂等）。启动建表流程调用。 */
export function createMediaTables(db) {
  db.exec(`
    -- 传媒 / 数字媒体（媒体内容页）
    -- 一个「媒体」= 一个内容源（论坛 / 报纸 / 匿名职场社区 / 暗网 …），自带一份生成提示词。
    -- 用户可自行增删改；默认种入二相乐园的 5 个媒体。
    -- prompt 存的是该媒体的「角色设定 + 规则 + 写作要求」，生成帖子时原样作为 system 注入。
    CREATE TABLE IF NOT EXISTS media_outlets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      tagline TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      -- 形态：feed=帖子流 / portal=数字报刊（决定前端用哪套渲染）
      layout TEXT NOT NULL DEFAULT 'feed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 板块（媒体下的分区，如「攻略 / 八卦 / 招募」）。每个媒体可自定义自己的板块。
    CREATE TABLE IF NOT EXISTS media_boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outlet_id INTEGER NOT NULL REFERENCES media_outlets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      desc TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(outlet_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_media_boards_outlet ON media_boards(outlet_id);

    -- 帖子。作者可能是**活跃角色**（author_type='character'，带角色 id 与头像）或匿名 NPC。
    -- 配图沿用《邻舍日报》的做法：文字先落库，image_status='pending' 由后台逐张补。
    CREATE TABLE IF NOT EXISTS media_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outlet_id INTEGER NOT NULL REFERENCES media_outlets(id) ON DELETE CASCADE,
      board_id INTEGER REFERENCES media_boards(id) ON DELETE SET NULL,
      batch_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT,
      author_type TEXT NOT NULL DEFAULT 'anonymous',
      character_id INTEGER,
      author_name TEXT NOT NULL DEFAULT '',
      author_avatar TEXT,
      likes INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      comments_json TEXT,
      image_prompt TEXT,
      image TEXT,
      image_status TEXT NOT NULL DEFAULT 'pending',
      image_error TEXT,
      -- 数字报刊的结构化正文（feed 形态不用，正文仍在 content）
      payload_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_media_posts_outlet ON media_posts(outlet_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_media_posts_board ON media_posts(board_id);
    CREATE INDEX IF NOT EXISTS idx_media_posts_img ON media_posts(image_status);

    CREATE TABLE IF NOT EXISTS media_avatars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS media_npc_avatars (
      outlet_id INTEGER NOT NULL REFERENCES media_outlets(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      avatar_id INTEGER NOT NULL REFERENCES media_avatars(id),
      PRIMARY KEY (outlet_id, author_name)
    );
  `);
}

/** 一次性升级旧报刊；后续启动尊重用户选择的媒体类型。 */
export function migrateMediaOutletLayouts(db) {
  const migrated = db.prepare(`SELECT 1 FROM system_settings WHERE setting_key = 'media_layout_editable_migrated'`).get();
  if (migrated) return;
  db.transaction(() => {
    db.prepare(`UPDATE media_outlets SET layout = 'portal' WHERE name IN ('狸狸通讯社','狸狸八卦') AND layout != 'portal'`).run();
    db.prepare(`INSERT INTO system_settings (setting_key, setting_value) VALUES ('media_layout_editable_migrated', '1')`).run();
  })();
}

/**
 * 迁移: 媒体内容页 —— 结构升级 + 默认媒体种子
 *
 * 表本身由 createMediaTables 建（幂等）；这里只负责**补列与种入默认媒体/板块**。
 * 用 INSERT OR IGNORE：用户改过的媒体/板块不会被后续启动覆盖。
 * 用户删掉的默认媒体会被"复活"（按 name 判重）⇒ 额外记一个 system_settings 标记，播过一次就不再播。
 */
export function migrateMediaSchema(db) {
  try {
    migrateMediaAvatarLibrary(db);
    // ── 结构升级（独立于种子开关，老库也要加上）──
    // layout：媒体形态，决定前端用哪套版式渲染
    //   'feed'   = 帖子瀑布流
    //   'portal' = 门户（数字报刊·两层生成）：横版卡片网格 + 点开板块才生成正文。
    const oCols = db.prepare(`PRAGMA table_info(media_outlets)`).all();
    if (!oCols.find(c => c.name === 'layout')) {
      db.exec(`ALTER TABLE media_outlets ADD COLUMN layout TEXT NOT NULL DEFAULT 'feed'`);
      console.log('[db] Added media_outlets.layout column');
    }
    // payload_json：数字报刊的结构化正文（feed 形态不用，内容仍在 content）
    const pCols = db.prepare(`PRAGMA table_info(media_posts)`).all();
    migrateMediaFavorites(db);
    if (!pCols.find(c => c.name === 'published_seq')) {
      // 0 保留旧帖可见性及原 id 已读游标；新生成的草稿显式写 NULL，图齐后再发布。
      db.exec(`ALTER TABLE media_posts ADD COLUMN published_seq INTEGER DEFAULT 0`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_media_posts_publication
      ON media_posts(COALESCE(NULLIF(published_seq, 0), id) DESC)
      WHERE published_seq IS NOT NULL`);
    if (!pCols.find(c => c.name === 'payload_json')) {
      db.exec(`ALTER TABLE media_posts ADD COLUMN payload_json TEXT`);
      console.log('[db] Added media_posts.payload_json column');
    }

    // ── 一次性形态回填（后续保留用户选择）──
    try {
      // 两个报刊升级为「门户」：原来的形态是「一次长 LLM + N 张图」全量产出，
      // 在电脑宽屏上还只是 880px 居中单列、两侧各空 520px。门户把它拆成两层
      //（出刊只出骨架 → 立即可读；图后台串行补；正文点开才生成）。
      // 老帖仍按 payload 形态渲染，不会白丢内容。
      migrateMediaOutletLayouts(db);
    } catch { /* ignore */ }

    const seeded = db.prepare(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'media_outlets_seeded'`
    ).get();
    if (seeded?.setting_value === '1') {
      // 种子已播过，但可能还没有「狸狸八卦」（本次新增）—— 单独补种
      try {
        const has = db.prepare(`SELECT id FROM media_outlets WHERE name = '狸狸八卦'`).get();
        if (!has) {
          const ins = db.prepare(`INSERT INTO media_outlets (name, tagline, prompt, icon, sort_order, enabled, layout)
            VALUES (?, ?, ?, ?, ?, 1, ?)`);
          const ghost = DEFAULT_MEDIA_OUTLETS.find(o => o.name === '狸狸八卦');
          if (ghost) {
            const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM media_outlets').get().m;
            ins.run(ghost.name, ghost.tagline || '', ghost.prompt || '', ghost.icon || '', maxOrder + 1, 'poster');
            console.log('[db] media seed: 补种「狸狸八卦」');
          }
        }
      } catch { /* ignore */ }
      return;
    }

    const insOutlet = db.prepare(`
      INSERT OR IGNORE INTO media_outlets (name, tagline, prompt, icon, sort_order, enabled, layout)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);
    const insBoard = db.prepare(`
      INSERT OR IGNORE INTO media_boards (outlet_id, name, desc, sort_order) VALUES (?, ?, '', ?)
    `);
    let outlets = 0, boards = 0;
    const tx = db.transaction(() => {
      DEFAULT_MEDIA_OUTLETS.forEach((o, i) => {
        const r = insOutlet.run(o.name, o.tagline || '', o.prompt || '', o.icon || '', i, o.layout || 'feed');
        if (r.changes > 0) outlets++;
        const row = db.prepare('SELECT id FROM media_outlets WHERE name = ?').get(o.name);
        if (!row) return;
        (o.boards || []).forEach((b, bi) => {
          if (insBoard.run(row.id, b, bi).changes > 0) boards++;
        });
      });
    });
    tx();

    db.prepare(`INSERT OR REPLACE INTO system_settings (setting_key, setting_value)
      VALUES ('media_outlets_seeded', '1')`).run();
    if (outlets || boards) console.log(`[db] media seed: ${outlets} outlets / ${boards} boards`);
  } catch (err) {
    console.log('[db] migrateMediaSchema error:', err.message);
  }
}
