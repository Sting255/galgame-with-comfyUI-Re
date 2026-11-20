import { DEFAULT_EVENT_TYPES } from '../../seedEventTypes.js';
import { DEFAULT_MOMENT_TOPICS } from '../../seedTopics.js';


export function seedEventLibraries(db) {
  // 事件类型库
  const seedEventType = db.prepare(`
    INSERT OR IGNORE INTO event_types (key, name, duration_min, urgency, fun_from, desc, source, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 'default', 1)
  `);
  let eventCount = 0;
  for (const e of DEFAULT_EVENT_TYPES) {
    const result = seedEventType.run(
      e.key, e.name, e.durationMin ?? 20, e.urgency ?? 1,
      JSON.stringify(e.funFrom ?? []), e.desc ?? ''
    );
    if (result.changes > 0) eventCount++;
  }
  if (eventCount > 0) console.log(`[seed] event_types: ${eventCount} seeded`);

  // 朋友圈话题库
  const seedTopic = db.prepare(`
    INSERT OR IGNORE INTO moment_topics (name, desc, source, is_active)
    VALUES (?, ?, 'default', 1)
  `);
  let topicCount = 0;
  for (const t of DEFAULT_MOMENT_TOPICS) {
    const result = seedTopic.run(t.name, t.desc ?? '');
    if (result.changes > 0) topicCount++;
  }
  if (topicCount > 0) console.log(`[seed] moment_topics: ${topicCount} seeded`);
}


export function migrateEventsSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(characters)`).all();
    if (!cols.find(c => c.name === 'events_disabled')) {
      db.exec(`ALTER TABLE characters ADD COLUMN events_disabled INTEGER DEFAULT 0`);
      console.log('[db] Added characters.events_disabled column (default 0)');
    }

    // character_events 加 processing 列：标记分支生成进行中，防止切页后重复提交
    const ceCols = db.prepare(`PRAGMA table_info(character_events)`).all();
    if (!ceCols.find(c => c.name === 'processing')) {
      db.exec(`ALTER TABLE character_events ADD COLUMN processing INTEGER DEFAULT 0`);
      console.log('[db] Added character_events.processing column (default 0)');
    }
  } catch (err) {
    console.log('[db] migrateEventsSchema error:', err.message);
  }
}


/**
 * 迁移: 奇遇强调降格 — character_events 表新增 emphasis_delivered 列
 * 0 = 首轮强调尚未触发，1 = 已触发过首轮强调（后续降格为日程同级）
 */
export function migrateEventEmphasisSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(character_events)`).all();
    if (!cols.find(c => c.name === 'emphasis_delivered')) {
      db.exec(`ALTER TABLE character_events ADD COLUMN emphasis_delivered INTEGER DEFAULT 0`);
      console.log('[db] Added character_events.emphasis_delivered column (default 0)');
    }
  } catch (err) {
    console.log('[db] migrateEventEmphasisSchema error:', err.message);
  }
}


export function migrateEventCrossRef(db) {
  try {
    let ceCols = db.prepare(`PRAGMA table_info(character_events)`).all();
    if (!ceCols.find(c => c.name === 'referenced_character_ids')) {
      db.exec(`ALTER TABLE character_events ADD COLUMN referenced_character_ids TEXT DEFAULT '[]'`);
      console.log('[db] Added character_events.referenced_character_ids column');
    }
    let ehCols = db.prepare(`PRAGMA table_info(event_history)`).all();
    if (!ehCols.find(c => c.name === 'referenced_character_ids')) {
      db.exec(`ALTER TABLE event_history ADD COLUMN referenced_character_ids TEXT DEFAULT '[]'`);
      console.log('[db] Added event_history.referenced_character_ids column');
    }
    if (!ehCols.find(c => c.name === 'conclusion')) {
      db.exec(`ALTER TABLE event_history ADD COLUMN conclusion TEXT`);
      console.log('[db] Added event_history.conclusion column');
    }
  } catch (err) {
    console.log('[db] migrateEventCrossRef error:', err.message);
  }
}
