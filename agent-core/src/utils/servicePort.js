import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { resolveEnvPath } from './envFile.js';

export const DEFAULT_SERVICE_PORT = 3099;

// 所有启动入口读取同一份 PORT；不加载密钥或打开数据库。
export function resolveServicePort({ env = process.env, envPath = resolveEnvPath(env) } = {}) {
  let fileEnv = {};
  try { fileEnv = dotenv.parse(fs.readFileSync(envPath)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = env.PORT ?? fileEnv.PORT;
  if (value === undefined || value === '') return DEFAULT_SERVICE_PORT;
  if (!/^\d+$/.test(String(value).trim())) throw new Error('PORT must be an integer between 1 and 65535');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  return port;
}

export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export async function isLinsheService(baseUrl, { fetchImpl = fetch, pid } = {}) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.application === 'linshe' && body.status === 'ok' && (pid === undefined || body.pid === pid);
  } catch { return false; }
}

export async function shutdownLinshe(baseUrl, { fetchImpl = fetch } = {}) {
  if (!await isLinsheService(baseUrl, { fetchImpl })) return false;
  const response = await fetchImpl(`${baseUrl}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  return response.ok;
}
