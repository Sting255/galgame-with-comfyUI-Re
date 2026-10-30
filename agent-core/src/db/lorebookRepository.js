import { normalizeBook, normalizeSettings, hash } from '../services/lorebook/engine.js';

export function migrateLorebooks(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS world_lorebooks (
    world_id INTEGER PRIMARY KEY REFERENCES world_settings(id) ON DELETE CASCADE,
    name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    document_json TEXT NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS world_lorebook_runs (
    world_id INTEGER NOT NULL REFERENCES world_settings(id) ON DELETE CASCADE,
    scope TEXT NOT NULL, turn_key TEXT NOT NULL, step INTEGER NOT NULL,
    revision INTEGER NOT NULL, state_json TEXT NOT NULL, result_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(world_id,scope,turn_key)
  );
  CREATE INDEX IF NOT EXISTS world_lorebook_run_scope ON world_lorebook_runs(world_id,scope,step);`);
}

export function createLorebookRepository(db) {
  const get = worldId => {
    const row = db.prepare('SELECT * FROM world_lorebooks WHERE world_id=?').get(worldId);
    return row ? { worldId: row.world_id, name: row.name, enabled: !!row.enabled, revision: row.revision, document: JSON.parse(row.document_json), settings: normalizeSettings(JSON.parse(row.settings_json)), updatedAt: row.updated_at } : null;
  };
  return {
    get,
    save(worldId, { name, document, settings, enabled = true, expectedRevision } = {}) {
      if (!db.prepare('SELECT id FROM world_settings WHERE id=?').get(worldId)) throw new Error('世界观不存在');
      const old = get(worldId);
      if (expectedRevision !== undefined && Number(expectedRevision) !== (old?.revision || 0)) throw new Error('世界书已被其他窗口修改，请重新加载');
      const normalized = normalizeBook(document); const nextSettings = normalizeSettings(settings || old?.settings);
      db.prepare(`INSERT INTO world_lorebooks(world_id,name,enabled,document_json,settings_json) VALUES(?,?,?,?,?)
        ON CONFLICT(world_id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,document_json=excluded.document_json,settings_json=excluded.settings_json,revision=world_lorebooks.revision+1,updated_at=CURRENT_TIMESTAMP`)
        .run(worldId, String(name || old?.name || '世界书'), enabled ? 1 : 0, JSON.stringify(normalized.document), JSON.stringify(nextSettings));
      return { book: get(worldId), warnings: normalized.warnings };
    },
    remove(worldId) { db.transaction(() => { db.prepare('DELETE FROM world_lorebook_runs WHERE world_id=?').run(worldId); db.prepare('DELETE FROM world_lorebooks WHERE world_id=?').run(worldId); })(); },
    previous(worldId, scope, step, revision) {
      const row = db.prepare('SELECT state_json FROM world_lorebook_runs WHERE world_id=? AND scope=? AND step<? AND revision=? ORDER BY step DESC LIMIT 1').get(worldId,scope,step,revision);
      return row ? JSON.parse(row.state_json) : {};
    },
    snapshot(worldId, scope, turnKey, revision) {
      const row = db.prepare('SELECT result_json FROM world_lorebook_runs WHERE world_id=? AND scope=? AND turn_key=? AND revision=?').get(worldId,scope,turnKey,revision);
      return row ? JSON.parse(row.result_json) : null;
    },
    commit(book, scope, turnKey, step, result) {
      // The first committed request owns this logical turn; retries are idempotent.
      db.prepare(`INSERT INTO world_lorebook_runs(world_id,scope,turn_key,step,revision,state_json,result_json) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(world_id,scope,turn_key) DO UPDATE SET step=excluded.step,revision=excluded.revision,state_json=excluded.state_json,result_json=excluded.result_json
        WHERE world_lorebook_runs.revision < excluded.revision`)
        .run(book.worldId,scope,turnKey,step,book.revision,JSON.stringify(result.nextState),JSON.stringify(result));
    },
    rewind(scope, step = -1) { db.prepare('DELETE FROM world_lorebook_runs WHERE scope=? AND step>=?').run(scope,step); },
    fingerprint: hash,
  };
}
