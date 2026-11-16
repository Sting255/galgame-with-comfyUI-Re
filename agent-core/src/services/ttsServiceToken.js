/**
 * TTS 服务 Token（P1-15）。
 *
 * 现状问题：`tts-service/server.py` 与 `indexTtsClient.js` 都从
 * `TTS_SERVICE_TOKEN` 取 Token，而没有任何地方设置它 —— 两端都拿到空串，
 * 于是 `hmac.compare_digest('', '')` 恒为真，**本机任何进程都能调用语音服务**
 * （虽然服务只监听回环、且校验 Host 与 Origin，但那只是降低风险，不是鉴权）。
 *
 * 现在的口径：
 *   1. 首次需要时生成一个 32 字节随机 Token，写到 `data/.tts-service-token`（0600）；
 *   2. 之后每次读同一个文件，保证 agent-core 与 TTS 服务用同一个值；
 *   3. 环境变量 `TTS_SERVICE_TOKEN` 仍然优先——显式配置（例如独立部署）不被覆盖；
 *   4. 文件读不出来就退回内存态随机值（本次进程内两端一致，重启后换新的，
 *      这比"空 Token"安全，代价是重启后 TTS 需要一起重启）。
 *
 * 不把这个 Token 放进 DB：它属于进程间握手，不该跟着业务数据一起被备份带走。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const TOKEN_FILE = path.join(DATA_DIR, '.tts-service-token');

/** 进程内缓存：同一个进程内所有调用拿到同一个值 */
let cached = null;

function readTokenFile() {
  try {
    const value = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

function writeTokenFile(token) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return true;   // 别人先写了，用他的
    console.warn('[tts] 无法写入服务 Token 文件（本次用内存态随机值）:', err.message);
    return false;
  }
}

/**
 * 取当前应使用的 TTS 服务 Token。
 * @returns {string} 非空字符串
 */
export function ttsServiceToken() {
  const fromEnv = String(process.env.TTS_SERVICE_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  if (cached) return cached;

  const existing = readTokenFile();
  if (existing) {
    cached = existing;
    return cached;
  }

  const generated = crypto.randomBytes(32).toString('base64url');
  if (writeTokenFile(generated)) {
    // 可能是并发写：以磁盘上的为准
    cached = readTokenFile() || generated;
  } else {
    cached = generated;
  }
  console.log('[tts] 已生成本机语音服务 Token（写入 data/.tts-service-token）');
  return cached;
}

/**
 * 给 TTS 子进程用的环境变量。
 *
 * restart.ps1 不设这个变量，所以必须在启动命令的 env 里带上；
 * 否则服务端仍是空 Token，而客户端已经改成随机值 ⇒ 全部 403。
 */
export function ttsServiceEnv(env = process.env) {
  return { ...env, TTS_SERVICE_TOKEN: ttsServiceToken() };
}
