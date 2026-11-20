import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as baseline from './0001-baseline.js';

// 新增结构变更：新增 0002-xxx.js，导出 version / description / up，再加入本数组。
// 仅历史基线不包大事务；其内部事务、PRAGMA 与修复执行顺序全部保留。
export const MIGRATIONS = Object.freeze([baseline]);
export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map(item => item.version));
const BASELINE_REVISION = '2026-11-20.1';
const BASELINE_KEY = 'migration_baseline_revision';

export function runSchemaMigrations(db, { migrations = MIGRATIONS, baselineApplied = false } = {}) {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const versions = ordered.map(item => item.version);
  if (versions.some((v, i) => !Number.isSafeInteger(v) || v !== i + 1)) throw new Error('迁移版本必须从 1 连续编号且不能重复');
  const from = Number(db.pragma('user_version', { simple: true })) || 0;
  const applied = [];
  for (const migration of ordered) {
    if (migration.version <= from) continue;
    const apply = () => {
      if (!(migration.version === 1 && baselineApplied)) migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    };
    try {
      if (migration.transactional === false && migration.version === 1) apply();
      else db.transaction(apply).immediate();
      applied.push(migration.version);
    } catch (cause) {
      throw new Error(`数据库迁移 ${migration.version}（${migration.description}）失败：${cause.message}`, { cause });
    }
  }
  const to = Number(db.pragma('user_version', { simple: true })) || 0;
  if (applied.length) console.log(`[db] schema 版本 ${from} → ${to}（应用 ${applied.join(', ')}）`);
  return { from, to, applied };
}

/**
 * getDb 是同步入口，使用 SQLite VACUUM INTO 取得含 WAL 已提交内容的一致快照。
 * 仅首次采用本基线或有待升级的版本时快照；全新库 / 内存库不创建文件。
 * 快照失败即拒绝迁移，成功启动之后才清理旧快照，失败的现场始终保留。
 */
export function prepareMigrationSnapshot(db) {
  if (!db.name || db.name === ':memory:') return null;
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (!hasTables) return null;
  let revision;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_settings'").get()) {
    revision = db.prepare('SELECT setting_value FROM system_settings WHERE setting_key=?').pluck().get(BASELINE_KEY);
  }
  if (revision === BASELINE_REVISION && Number(db.pragma('user_version', { simple: true })) >= SCHEMA_VERSION) return null;
  const file = path.resolve(`${db.name}.pre-migrate-${SCHEMA_VERSION}-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`);
  db.prepare('VACUUM INTO ?').run(file);
  console.log(`[db] 迁移前快照：${path.basename(file)}`);
  return file;
}

export function finishMigrationSnapshot(db, snapshot) {
  db.prepare('INSERT OR REPLACE INTO system_settings(setting_key,setting_value) VALUES(?,?)').run(BASELINE_KEY, BASELINE_REVISION);
  if (!snapshot) return;
  const directory = path.dirname(snapshot);
  const prefix = `${path.basename(db.name)}.pre-migrate-`;
  // 保留清理是尽力而为；目录被占用、文件被同步软件移动均不能使已成功的迁移变成启动失败。
  try {
    const files = fs.readdirSync(directory)
      .filter(name => name.startsWith(prefix) && /^\d+-\d{13}-[a-f0-9]{8}\.sqlite$/.test(name.slice(prefix.length)))
      .map(name => path.join(directory, name))
      .map(file => ({ file, stat: fs.lstatSync(file) }))
      .filter(item => item.stat.isFile())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.file.localeCompare(a.file));
    for (const { file } of files.slice(2)) {
      try { fs.unlinkSync(file); }
      catch (err) { console.warn('[db] 旧迁移快照保留（清理失败）:', err.message); }
    }
  } catch (err) {
    console.warn('[db] 旧迁移快照保留（读取目录失败）:', err.message);
  }
}
