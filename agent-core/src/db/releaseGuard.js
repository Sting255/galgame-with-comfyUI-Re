/**
 * 数据库降级保护（2026-11-20，规划 N8）。
 *
 * 升级后的库被旧版本打开，旧代码不认识的新表 / 新字段语义可能被它的迁移或维护逻辑写坏，
 * 而且用户往往察觉不到。验收清单 04 §7 要求「新版回旧版：明确拒绝，不尝试兼容」。
 *
 * 两道检查，都在 initSchema 之前做（拒绝时这份库一个字节都不改）：
 *   1. PRAGMA user_version 高于本程序的 SCHEMA_VERSION ⇒ 结构来自更新的版本；
 *   2. system_settings.app_release_version 记录的发行版本高于本程序的 VERSION ⇒ 被更新的版本打开过。
 * 迁移与维护全部成功后，才把当前 VERSION 写进标记（只升不降）。
 *
 * 逃生口：环境变量 LINSHE_ALLOW_DB_DOWNGRADE=1 跳过检查（开发切分支、或确认要用旧版本时）。
 * 4.5.0 之前的版本没有这道检查，它们打开新库不会被拦——升级说明里要写明不要这样做。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const RELEASE_MARKER_KEY = 'app_release_version';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function parseRelease(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** a > b 返回正数，相等 0，a < b 负数；只比较 主.次.修订，忽略 -c 这类构建后缀 */
export function compareRelease(a, b) {
  const pa = parseRelease(a);
  const pb = parseRelease(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** 本程序的发行版本（仓库根 VERSION）；读不到或格式不对返回 null，此时跳过版本标记检查 */
export function readAppRelease(rootDir = ROOT_DIR) {
  try {
    const value = fs.readFileSync(path.join(rootDir, 'VERSION'), 'utf8').trim();
    return parseRelease(value) ? value : null;
  } catch {
    return null;
  }
}

function readMarker(database) {
  try {
    return database.prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get(RELEASE_MARKER_KEY) ?? null;
  } catch {
    return null;   // 全新库还没有 system_settings 表
  }
}

/**
 * 打开后、任何建表 / 迁移之前调用。发现库来自更新的版本时抛错（code = DB_NEWER_THAN_APP）。
 * @param {object} database better-sqlite3 句柄
 * @param {{ schemaVersion: number, current?: string|null, env?: object }} opts
 */
export function assertNotDowngrade(database, { schemaVersion, current = readAppRelease(), env = process.env } = {}) {
  if (env.LINSHE_ALLOW_DB_DOWNGRADE === '1') return;
  const userVersion = Number(database.pragma('user_version', { simple: true })) || 0;
  if (Number.isFinite(schemaVersion) && userVersion > schemaVersion) {
    throw Object.assign(new Error(
      `这份数据库的结构版本是 ${userVersion}，高于本程序支持的 ${schemaVersion}：它来自更新的版本。`
      + '请用新版本打开，或从升级前的备份恢复；确认要强制打开请设置 LINSHE_ALLOW_DB_DOWNGRADE=1。',
    ), { code: 'DB_NEWER_THAN_APP' });
  }
  if (!current) return;
  const stored = readMarker(database);
  if (stored && parseRelease(stored) && compareRelease(stored, current) > 0) {
    throw Object.assign(new Error(
      `这份数据已被 v${stored} 打开过，高于当前程序 v${current}。为避免旧版本把新数据写坏，已拒绝启动。`
      + '请用 v' + stored + ' 或更新的版本打开，或从升级前的备份恢复；确认要强制打开请设置 LINSHE_ALLOW_DB_DOWNGRADE=1。',
    ), { code: 'DB_NEWER_THAN_APP' });
  }
}

/** 迁移与维护成功后调用：把当前版本写进标记，只升不降。返回是否写入。 */
export function recordAppRelease(database, current = readAppRelease()) {
  if (!current) return false;
  const stored = readMarker(database);
  if (stored && parseRelease(stored) && compareRelease(current, stored) <= 0) return false;
  database.prepare(`
    INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP
  `).run(RELEASE_MARKER_KEY, current);
  return true;
}
