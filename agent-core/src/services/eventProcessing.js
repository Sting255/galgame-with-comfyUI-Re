import { getDb } from '../db/index.js';

// 分支、到期调度与手动结算共用数据库 processing 标记。
export async function withEventProcessing(table, id, action) {
  if (!['character_events', 'town_npc_events'].includes(table)) throw new Error('Invalid event table');
  const db = getDb();
  const acquired = db.prepare(`UPDATE ${table} SET processing = 1 WHERE id = ? AND processing = 0`).run(id);
  if (!acquired.changes) throw new Error('EVENT_ALREADY_PROCESSING');
  try {
    return await action(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
  } finally {
    db.prepare(`UPDATE ${table} SET processing = 0 WHERE id = ?`).run(id);
  }
}
