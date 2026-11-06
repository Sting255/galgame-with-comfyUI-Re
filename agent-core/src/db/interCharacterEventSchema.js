/**
 * interCharacterEventSchema.js —— 角色之间的互动记录（2026-11-06）
 *
 * 为什么需要：现在角色对彼此的了解只有两样东西 —— 静态的 `character_relationships`（"她是姐姐"）
 * 和静态的群聊历史。少了中间那层"她们俩之间最近发生过什么"，群聊里的互动就会退回成
 * "每个人轮流对玩家说话"：因为模型手里没有"A 昨天怼过 B"这种可接的话头。
 *
 * 与既有数据的分工：
 *   · `character_relationships` = 长期关系定义（谁是谁的谁），改得少；
 *   · 本表 = **瞬时互动**（A 对 B 说了什么、什么场合），只读最近若干条注入 prompt；
 *   · 记忆系统（memoryRepository）管的是角色自己的经历与感受，不是"两人之间"。
 *
 * 数据来源刻意是**确定性抽取**（群聊轮次里"谁的台词点了谁的名"），不额外调模型 ——
 * 加一次 LLM 调用去总结"他们关系变了没"成本高且质量不可控。
 */
export function migrateInterCharacterEventSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inter_character_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      from_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      to_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'said_to',
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ice_pair ON inter_character_events(from_character_id, to_character_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_ice_group ON inter_character_events(group_id, id DESC);
  `);
}
