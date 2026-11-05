import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

export function resolveEnvPath(env = process.env) {
  return env.LINSHE_ENV_PATH
    ? resolve(env.LINSHE_ENV_PATH)
    : fileURLToPath(new URL('../../.env', import.meta.url));
}

// dotenv does not use JSON/shell escaping. Check every candidate with the actual
// parser so hashes, literal backslashes and multiline JSON survive a restart.
function serializeValue(key, value) {
  const raw = String(value);
  if (!raw.includes('\0')) {
    const candidates = [raw, `'${raw}'`, `\`${raw}\``, `"${raw.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`];
    for (const candidate of candidates) {
      const parsed = dotenv.parse(`${key}=${candidate}\n`);
      if (Object.keys(parsed).length === 1 && parsed[key] === raw) return candidate;
    }
  }
  throw new Error(`配置项 ${key} 含有 .env 无法无损保存的字符，请调整后重试`);
}

export function updateEnvContent(content, updates) {
  const pending = new Map(Object.entries(updates).map(([key, value]) => {
    if (!/^[\w.-]+$/.test(key)) throw new Error('无效的配置项名称');
    return [key, serializeValue(key, value)];
  }));
  const seen = new Set();
  // Match complete assignments, including quoted multiline values. Comments and
  // unrelated settings retain their original bytes; duplicate active keys collapse.
  const assignment = /^[\t ]*(?:export[\t ]+)?([\w.-]+)(?:[\t ]*=[\t ]*|:[\t ]+)('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]*)([\t ]*(?:#[^\r\n]*)?)(?=\r?$)/gm;
  let result = content.replace(assignment, (match, key, _value, comment) => {
    if (!pending.has(key)) return match;
    if (seen.has(key)) return '';
    seen.add(key);
    return `${key}=${pending.get(key)}${comment.trim() ? ` ${comment.trim()}` : ''}`;
  });
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of pending) {
    if (seen.has(key)) continue;
    if (result && !result.endsWith('\n')) result += eol;
    result += `${key}=${value}${eol}`;
  }
  const parsed = dotenv.parse(result);
  for (const [key, value] of Object.entries(updates)) {
    if (parsed[key] !== String(value)) throw new Error(`配置项 ${key} 保存校验失败，请检查 .env 格式`);
  }
  return result;
}

// One synchronous replacement per save: a failed write/rename leaves the old
// file intact, and callers publish their in-memory values only after this returns.
export function persistEnvValues(envPath, updates, { fsImpl = fs } = {}) {
  if (Object.keys(updates).length === 0) return;
  let content = '# 此文件由系统自动管理，通过 Settings 页面修改配置即可\n';
  let mode = 0o600;
  try {
    content = fsImpl.readFileSync(envPath, 'utf8');
    mode = fsImpl.statSync(envPath).mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = updateEnvContent(content, updates);
  const temporary = `${envPath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fsImpl.openSync(temporary, 'wx', mode);
    fsImpl.writeFileSync(fd, next, 'utf8');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(temporary, envPath);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
    if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
  }
}
