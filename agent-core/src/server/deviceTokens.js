/**
 * 设备令牌（P0-02）。
 *
 * 背景：远程 `/api/stream` 需要配对凭证，而 Android 原生 SSE 用的是
 * `HttpURLConnection`，拿不到网页里的 HttpOnly Cookie。原来原生侧只带 `Accept`，
 * 于是「网页配对成功、后台通知永远收不到」，401 还被当成普通断线无限重连。
 *
 * 根配对码不适合直接当长期 Bearer：
 *   · 它是**全局**的，撤销一台设备等于撤销所有设备；
 *   · 它写在 `data/.access-token`，用户能在设置页看到，天生该是一次性交换用的。
 *
 * 所以这里签发**每设备独立、可单独撤销**的令牌：
 *   · 存在 `system_settings.device_tokens`（JSON 数组，只存 sha256 摘要，不存原文）；
 *   · 签发时返回一次原文，之后任何读取接口都不再回显；
 *   · 校验时按摘要比对，支持 revoked 与 last_used_at。
 *
 * 单用户单实例部署，不需要完整的设备管理 UI：签发、列出（不含原文）、撤销即可。
 */
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';

const SETTING_KEY = 'device_tokens';
const MAX_TOKENS = 32;

function readAll(db) {
  try {
    const raw = db.prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get(SETTING_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(db, tokens) {
  db.prepare(`
    INSERT INTO system_settings(setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP
  `).run(SETTING_KEY, JSON.stringify(tokens.slice(0, MAX_TOKENS)));
}

function digest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * 签发一个新设备令牌。
 * @param {object} [db]
 * @param {{label?: string}} [opts]
 * @returns {{id:string, token:string, label:string, createdAt:string}}
 *   `token` 只在这一次返回，之后不可再取回。
 */
export function issueDeviceToken(db = getDb(), { label = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomBytes(8).toString('hex');
  const record = {
    id,
    hash: digest(token),
    label: String(label || '').slice(0, 60),
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: false,
  };
  const tokens = readAll(db);
  tokens.unshift(record);
  writeAll(db, tokens);
  return { id, token, label: record.label, createdAt: record.created_at };
}

/** 列出设备令牌（不含原文，只给元数据） */
export function listDeviceTokens(db = getDb()) {
  return readAll(db).map(({ hash, ...rest }) => rest);
}

/** 撤销一个设备令牌（其它设备不受影响） */
export function revokeDeviceToken(db = getDb(), id) {
  const tokens = readAll(db);
  const target = tokens.find(item => item.id === id);
  if (!target) return { ok: false, reason: 'not_found' };
  target.revoked = true;
  target.revoked_at = new Date().toISOString();
  writeAll(db, tokens);
  return { ok: true };
}

/** 撤销全部设备令牌 */
export function revokeAllDeviceTokens(db = getDb()) {
  const tokens = readAll(db);
  const now = new Date().toISOString();
  for (const item of tokens) {
    if (!item.revoked) { item.revoked = true; item.revoked_at = now; }
  }
  writeAll(db, tokens);
  return { ok: true, revoked: tokens.length };
}

/**
 * 校验一个 Bearer 值是否是有效且未撤销的设备令牌。
 * 命中时顺手更新 last_used_at（节流：同一令牌 60 秒内不重复写库）。
 */
export function verifyDeviceToken(db = getDb(), token) {
  const text = String(token || '').trim();
  if (!text) return false;
  const hash = digest(text);
  const tokens = readAll(db);
  const target = tokens.find(item => item.hash === hash);
  if (!target || target.revoked) return false;

  const now = Date.now();
  const lastUsed = target.last_used_at ? new Date(target.last_used_at).getTime() : 0;
  if (Number.isFinite(lastUsed) && now - lastUsed > 60_000) {
    target.last_used_at = new Date(now).toISOString();
    try { writeAll(db, tokens); } catch { /* 只是统计信息，写失败不影响鉴权 */ }
  }
  return true;
}
