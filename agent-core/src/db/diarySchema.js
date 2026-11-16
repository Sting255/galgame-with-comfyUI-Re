/**
 * 角色日记表结构。
 *
 * 一个角色每个自然日最多一篇日记（UNIQUE(character_id, diary_date)）：
 * 同一天多次生成走 INSERT ... ON CONFLICT DO UPDATE 覆盖，历史日期行原样保留，
 * 供日记本里往前翻阅。
 *
 * 图片：images 是 URL 数组（口径同 moments/mailbox），resolutions 同步保存每张图的
 * "WxH"（朋友圈参数下横竖随机，逐图不同，重绘时要能还原）。
 */

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS character_diaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    diary_date TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    mood TEXT NOT NULL DEFAULT '',
    weather TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    image_prompts TEXT NOT NULL DEFAULT '[]',
    resolutions TEXT NOT NULL DEFAULT '[]',
    handwriting_font TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','generating','completed','failed')),
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(character_id, diary_date)
  )
`;

const CREATE_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_character_diaries_char ON character_diaries(character_id, diary_date DESC)';
const ADD_RETRY_COLUMN_SQL = 'ALTER TABLE character_diaries ADD COLUMN retry_at DATETIME DEFAULT NULL';
const CREATE_RETRY_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_character_diaries_retry ON character_diaries(status, retry_at)';

export function migrateCharacterDiarySchema(db) {
  db.prepare(CREATE_TABLE_SQL).run();
  db.prepare(CREATE_INDEX_SQL).run();

  // P1-11：延期重试时刻。
  //
  // 不在 status 里加 'deferred' —— 那要重建带 CHECK 约束的表，代价与风险都不值得。
  // 语义上「延期」就是「还没做、但不是失败」：
  //   status='pending' + retry_at 非空 + error_message 写原因。
  // 调度器只看 `status='pending' AND retry_at <= now`，与首次生成共用同一条路径。
  try {
    const cols = db.prepare('PRAGMA table_info(character_diaries)').all();
    if (!cols.find(c => c.name === 'retry_at')) {
      db.prepare(ADD_RETRY_COLUMN_SQL).run();
      console.log('[db] Added character_diaries.retry_at column');
    }
    db.prepare(CREATE_RETRY_INDEX_SQL).run();
  } catch (err) {
    console.log('[db] migrateCharacterDiarySchema retry_at error:', err.message);
  }
  console.log('[db] character_diaries schema ensured');
}

/** 仅由数据库启动恢复调用，不能在轮询中改写仍在运行的任务。 */
export function recoverInterruptedDiaries(db) {
  return db.prepare(`UPDATE character_diaries SET status='failed',
    error_message='服务重启导致日记生成中断，请重试', updated_at=datetime('now')
    WHERE status='generating'`).run();
}
