/**
 * worldTimelineSchema.js —— 世界时间轴（2026-11-06）
 *
 * 要做的事：让"世界在这段时间里发生过什么"有唯一一份账本。
 *
 * 现在的问题（用户口径："我要的是一个完全拟真的架空世界"）：
 *   朋友圈、群聊、奇遇、神说的世界事实各自记账，谁也不知道彼此；
 *   新事件生成时最多参考"她一小时前的朋友圈"，接不上更早的事。
 *   于是离线几小时回来，世界像被重新洗牌：事件之间没有因果，也没有"这段时间发生了什么"。
 *
 * 本表只存**世界级**的发生（不是每条聊天）：
 *   · event        —— 奇遇/事件开场
 *   · god_fact     —— 神说降下的世界事实
 * 写入用 source_id 做幂等（`event:12` / `god:3`），重复调用不会写两条。
 */
export function migrateWorldTimelineSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'event',
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      character_ids TEXT,
      source_id TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_world_timeline_at ON world_timeline(at DESC, id DESC);
  `);
}
