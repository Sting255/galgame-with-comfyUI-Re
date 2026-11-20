import { getDb } from '../db/index.js';
import { getProgramDateKey, getProgramNow } from './programTime.js';
import { refreshResidenceDailySleep } from './cohabitationPersistence.js';
import { reapplyActiveEventSchedule } from './eventSchedule.js';

let onSnapshotDerived = () => {};

export function registerScheduleSnapshotDerivedHandler(handler) {
  onSnapshotDerived = typeof handler === 'function' ? handler : () => {};
}

/** Read the program-date schedule snapshot, deriving it from the template once when absent. */
export function getScheduleSnapshot(characterId, programNow = getProgramNow()) {
  const db = getDb();
  const id = Number(characterId);
  const date = getProgramDateKey(programNow);
  let row = db.prepare(
    'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
  ).get(id, date);

  if (!row) {
    const template = db.prepare(
      'SELECT schedule_json FROM schedule_templates WHERE character_id = ?'
    ).get(id);
    if (!template) return null;

    let templateActivities;
    try {
      const parsed = JSON.parse(template.schedule_json);
      templateActivities = Array.isArray(parsed) ? parsed : parsed?.activities;
    } catch { return null; }
    if (!Array.isArray(templateActivities)) return null;

    const snapshotJson = JSON.stringify(templateActivities);
    const inserted = db.prepare(`
      INSERT INTO daily_schedules (character_id, schedule_date, schedule_json)
      VALUES (?, ?, ?)
      ON CONFLICT(character_id, schedule_date) DO NOTHING
    `).run(id, date, snapshotJson).changes > 0;

    if (inserted) {
      reapplyActiveEventSchedule(id, db);
      for (const affectedId of refreshResidenceDailySleep(db, id, programNow)) {
        onSnapshotDerived(affectedId);
      }
      if (date === getProgramDateKey()) {
        db.prepare(
          `DELETE FROM daily_schedules WHERE character_id = ? AND schedule_date < date(?, '-2 days')`
        ).run(id, date);
      }
    }

    row = db.prepare(
      'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
    ).get(id, date) || { schedule_json: snapshotJson };
  }

  try {
    const parsed = JSON.parse(row.schedule_json);
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.activities) ? parsed.activities : null;
  } catch {
    return null;
  }
}
