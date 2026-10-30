/**
 * 世界地图骨架（叙事地理）—— 建表与属性迁移（2026-10-29 移植自 PR#24）
 *
 * ⚠ 与小镇的 `town_maps` 是**两回事**，别混：
 *   · `town_maps`  —— 可行走的**网格图**（tile 图层 + 寻路 + 资产），供世界页用；
 *   · `world_maps` —— 叙事**地理骨架**（大地区 → 子地区 → 场景 → POI），供「地图」页规划用。
 * 两者将来可通过「导入小镇」打通，但数据模型刻意分开：骨架是纯文本、秒级生成、不烧生图额度。
 *
 * 与 PR#24 的差异（一处）：
 * PR 的 `migrateWorldMapTransit` 会往 `world_map_transit` 里种入**二象城**的 A/B/W 三条通勤线
 * （珠星站、泊地站、海原站…都是那张具体地图的站名）。那是作者世界观的数据，不是通用结构，
 * 所以这里只建表、不种数据 —— 换一张地图时由使用方自行填。
 */

/** 建表 + 索引。幂等：全部 CREATE ... IF NOT EXISTS。 */
export function ensureWorldMapSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS world_maps (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL,
        world_setting_id INTEGER,
        note             TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS world_map_places (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        map_id     INTEGER NOT NULL REFERENCES world_maps(id) ON DELETE CASCADE,
        parent_id  INTEGER REFERENCES world_map_places(id) ON DELETE CASCADE,
        level      INTEGER NOT NULL,
        key        TEXT NOT NULL,
        name       TEXT NOT NULL,
        name_en    TEXT,
        kind       TEXT NOT NULL DEFAULT '',
        summary    TEXT NOT NULL DEFAULT '',
        pois_json  TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wmp_map    ON world_map_places(map_id, level, sort_order);
      CREATE INDEX IF NOT EXISTS idx_wmp_parent ON world_map_places(parent_id, sort_order);

      -- 区域间通勤边：日程生成时由后端算好注入，不让 LLM 猜距离。
      -- 两翼（喜笑区/悲泣区）在图上不共享坐标系 → 跨翼只能查这张表，不能从坐标推。
      CREATE TABLE IF NOT EXISTS world_map_transit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        map_id     INTEGER NOT NULL REFERENCES world_maps(id) ON DELETE CASCADE,
        line_id    TEXT NOT NULL,              -- A / B / W
        line_name  TEXT NOT NULL DEFAULT '',
        from_stop  TEXT NOT NULL,
        to_stop    TEXT NOT NULL,
        mode       TEXT NOT NULL,              -- rail | water
        km         REAL,                       -- 可为 NULL：跨翼段无法从图上算
        minutes    INTEGER NOT NULL,
        seq        INTEGER NOT NULL DEFAULT 0, -- 在线路里的段序号
        note       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wmt_map  ON world_map_transit(map_id, line_id, seq);
      CREATE INDEX IF NOT EXISTS idx_wmt_from ON world_map_transit(from_stop);
    `);
  } catch (err) {
    console.error('[db] ensureWorldMapSchema 失败:', err.message);
  }
  migrateWorldMapPlaceAttrs(db);
}

/**
 * 迁移: 地图地点的**结构化属性**（准入 / 分区 / 场景提示词 / 功能分类 / 点位坐标）。
 *
 * 为什么需要：日程生成的老问题都出在「地点只有名字，没有属性」——
 *  ① 「谢绝外人」这类准入信息只写在提示词的散文常量里，改地图不会改它；
 *  ② 角色在不在自己家靠 LLM 推断，导致该穿居家服时穿外出服。
 * 解法是把这两件事变成**可查询的数据**，注入时由后端过滤/标注。
 *
 * 加列一律 ALTER TABLE + PRAGMA 存在性检测（本表是 CREATE IF NOT EXISTS 建的，老库没有这几列）。
 * 不给默认值以外的回填 —— access 留空串表示「未标注」，注入侧按「未标注 = 允许」处理，
 * 否则一次迁移会把所有地点关掉。
 */
function migrateWorldMapPlaceAttrs(db) {
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(world_map_places)').all().map(c => c.name));
    const add = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE world_map_places ADD COLUMN ${ddl}`); };
    // access: public | restricted | private | time_window（空串 = 未标注，按 public 处理）
    add('access', `access TEXT NOT NULL DEFAULT ''`);
    // zone: residence | activity | private_transit（空串 = 未标注）
    add('zone', `zone TEXT NOT NULL DEFAULT ''`);
    // category: 功能分类（商店街/商业设施/公园/文化/餐饮/居住/地标…），用于分组呈现
    add('category', `category TEXT NOT NULL DEFAULT ''`);
    // scene_prompt: 生图场景提示词（英文）—— 与 imagePromptTags 的检索面打通
    add('scene_prompt', `scene_prompt TEXT NOT NULL DEFAULT ''`);
    // open/close: 仅 access=time_window 有意义（'18:00' / '02:00'）
    add('open_at', `open_at TEXT NOT NULL DEFAULT ''`);
    add('close_at', `close_at TEXT NOT NULL DEFAULT ''`);
    // 用户在点位图上手动摆过的坐标（归一化 0~1，-1 = 未摆过）。
    // 用 -1 而不是 NULL/0：0 是合法的左上角坐标，用 0 当哨兵会让「摆在最左」和「没摆」混为一谈。
    add('pos_x', `pos_x REAL NOT NULL DEFAULT -1`);
    add('pos_y', `pos_y REAL NOT NULL DEFAULT -1`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wmp_access ON world_map_places(map_id, access)`);
  } catch (err) {
    console.error('[db] migrateWorldMapPlaceAttrs 失败:', err.message);
  }
}
