import { migrateStandingInteractionRegionReferences } from './standingInteractionSchema.js';

const slotColumns = ['slot_id', 'prompt', 'requirement', 'config_json', 'image_url', 'source_url', 'bounds_json', 'world_sig', 'status', 'error', 'version'];

export function migrateExpressionStandings(db) {
  db.transaction(() => {
    if (db.pragma('table_info(expression_standings)').some(column => column.name === 'owner_type')) {
      db.exec('ALTER TABLE expression_standings RENAME TO expression_standings_legacy');
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS expression_standings (
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      slot_id TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      requirement TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      image_url TEXT,
      source_url TEXT,
      bounds_json TEXT,
      world_sig TEXT,
      status TEXT NOT NULL DEFAULT 'empty',
      error TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      UNIQUE(character_id, slot_id)
    );
    CREATE TABLE IF NOT EXISTS expression_standing_jobs (
      id TEXT PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      slots_json TEXT NOT NULL,
      status TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS player_expression_standing_jobs (
      id TEXT PRIMARY KEY,
      slots_json TEXT NOT NULL,
      status TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      request_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS standing_display_selection (
      id INTEGER PRIMARY KEY CHECK(id=1),
      character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL
    );
    `);
    if (!db.pragma('table_info(expression_standing_jobs)').some(c => c.name === 'request_json')) {
      db.exec("ALTER TABLE expression_standing_jobs ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!db.pragma('table_info(expression_standings)').some(c => c.name === 'world_sig')) {
      db.exec('ALTER TABLE expression_standings ADD COLUMN world_sig TEXT');
    }
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
    const columns = ['character_id', ...slotColumns].join(', ');
    for (const legacyTable of ['expression_standings_legacy', 'character_expression_standings']) {
      if (!exists.get(legacyTable)) continue;
      // Local character slots already carry this signature; upstream legacy tables may not.
      const oldColumns = new Set(db.pragma(`table_info(${legacyTable})`).map(column => column.name));
      const values = ['character_id', ...slotColumns].map(column => column === 'world_sig' && !oldColumns.has(column) ? 'NULL' : column);
      // 2026-11-20：启动器允许来回切版本。切回旧版本时它会重建一张空的旧表，用户在旧版里重新生成过的槽
      // 与新表里已有的同槽冲突，原来的 INSERT 会触发 UNIQUE 约束、整个数据库初始化失败、后端起不来。
      // 现在以新表为准（INSERT OR IGNORE），有冲突时旧表改名保留、不删除，供需要时手动核对。
      const legacyRows = db.prepare(`SELECT COUNT(*) AS n FROM ${legacyTable}`).get().n;
      const inserted = db.prepare(`INSERT OR IGNORE INTO expression_standings (${columns}) SELECT ${values.join(', ')} FROM ${legacyTable}`).run().changes;
      migrateStandingInteractionRegionReferences(db, legacyTable);
      if (inserted < legacyRows) {
        const kept = `${legacyTable}_conflict_${Date.now()}`;
        db.exec(`ALTER TABLE ${legacyTable} RENAME TO ${kept}`);
        console.warn(`[db] 表情立绘旧表 ${legacyTable} 有 ${legacyRows - inserted} 行与新表同槽冲突（多半是切回旧版本后又生成过），`
          + `已以新表为准；旧表改名为 ${kept} 保留，未删除`);
      } else {
        db.exec(`DROP TABLE ${legacyTable}`);
      }
    }
    if (exists.get('player_expression_standings')) {
      const oldColumns = new Set(db.pragma('table_info(player_expression_standings)').map(column => column.name));
      const copyColumns = slotColumns.filter(column => oldColumns.has(column) || column === 'status');
      const values = copyColumns.map(column => oldColumns.has(column) ? column : "CASE WHEN image_url != '' THEN 'done' ELSE 'empty' END");
      db.exec(`INSERT INTO expression_standings (${copyColumns.join(', ')})
        SELECT ${values.join(', ')} FROM player_expression_standings`);
      db.exec('DROP TABLE player_expression_standings');
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expression_standings_player_slot
      ON expression_standings(slot_id) WHERE character_id IS NULL`);
  }).immediate();
}

export function recoverExpressionStandingJobs(db) {
  db.transaction(() => {
    db.prepare(`UPDATE expression_standings SET status='failed',error='服务重启导致生成中断，请重试' WHERE status IN ('queued','generating')`).run();
    db.prepare(`UPDATE expression_standing_jobs SET status='failed',error='服务重启导致生成中断，请重试' WHERE status IN ('queued','outfits','prompts','generating','stopping','paused')`).run();
    db.prepare(`UPDATE player_expression_standing_jobs SET status='failed',error='服务重启导致生成中断，请重试' WHERE status IN ('queued','prompts','generating','stopping','paused')`).run();
  })();
}
