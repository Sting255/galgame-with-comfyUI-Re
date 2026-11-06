import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

export function loadAccessToken(file) {
  if (!file) return randomBytes(24).toString('base64url');
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!/^[a-zA-Z0-9_-]{24,128}$/.test(token)) throw new Error('设备配对文件损坏，请从备份恢复或删除该文件后重新配对');
    return token;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomBytes(24).toString('base64url');
  try { fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return loadAccessToken(file); throw error; }
  return token;
}

export const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const normalize = value => String(value || '').replace(/^\[|\]$/g, '').toLowerCase();
const localHost = value => ['localhost', '127.0.0.1', '::1'].includes(normalize(value));
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** 默认仅信任本机直连。代理不会继承本机权限；远程设备使用配对 Cookie 或 Bearer。 */
export function createAccessControl({ token, development = false, hosts = [] }) {
  const cookieName = 'linshe_access';
  const session = createHmac('sha256', token).update('linshe-device-session-v1').digest('base64url');
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', ...hosts.map(normalize)]);
  for (const list of Object.values(os.networkInterfaces())) for (const address of list || []) allowedHosts.add(normalize(address.address));
  const attempts = new Map();
  return function accessControl(req, res, next) {
    let host, origin;
    try {
      host = new URL(`http://${req.headers.host}`).hostname;
      if (req.headers.origin) origin = new URL(req.headers.origin);
    } catch { return res.status(403).json({ error: '不允许的访问来源' }); }
    if (!allowedHosts.has(normalize(host))) return res.status(403).json({ error: '不允许的访问地址' });
    const forwarded = Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'));
    const local = isLoopback(req.socket.remoteAddress) && localHost(host) && !forwarded && (!origin || localHost(origin.hostname));
    const devOrigin = development && origin?.port === '5173' && allowedHosts.has(normalize(origin.hostname));
    if ((origin && origin.host !== req.headers.host && !devOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: '不允许跨站访问邻舍' });
    }
    if (devOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        return res.sendStatus(204);
      }
    }
    let cookie = '';
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [key, ...value] = part.trim().split('=');
      if (key === cookieName) cookie = value.join('=');
    }
    const authorized = local || sameSecret(cookie, session) || sameSecret(req.headers.authorization, `Bearer ${token}`);
    // Express 默认大小写不敏感、允许尾斜杠；授权边界必须采用同一口径。
    let pathname;
    try { pathname = decodeURIComponent(req.path).toLowerCase().replace(/\/+$/, '') || '/'; }
    catch { return res.status(400).json({ error: '无效的访问路径' }); }
    if (pathname === '/api/access' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ authorized, local, ...(local ? { pairingCode: token } : {}) });
    }
    if (pathname === '/api/access/session' && req.method === 'POST') {
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const address = req.socket.remoteAddress;
      const attempt = attempts.get(address) || { count: 0, until: now + 60_000 };
      if (attempt.count >= 10 || attempts.size >= 1024) return res.status(429).json({ error: '尝试次数过多，请一分钟后重试' });
      if (!sameSecret(req.body?.code, token)) {
        attempt.count++; attempts.set(address, attempt);
        return res.status(401).json({ error: '配对码不正确' });
      }
      attempts.delete(address);
      res.setHeader('Cache-Control', 'no-store');
      res.cookie(cookieName, session, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: 30 * 24 * 3600_000 });
      return res.json({ ok: true });
    }
    // 健康检查不含聊天/配置内容，启动器必须能在配对前检查实例身份。
    if (pathname === '/api/health') return next();
    const protectedPath = /^\/(api(?:\/|$)|images(?:\/|$)|avatars(?:\/|$)|town-assets(?:\/|$))/.test(pathname);
    if (protectedPath && !authorized) return res.status(401).json({ error: '请先在本机设置页获取配对码并连接此设备', code: 'PAIRING_REQUIRED' });
    if (!local && (pathname === '/api/shutdown' || pathname === '/api/config/llm/key' || /^\/api\/data(?:\/|$)/.test(pathname))) {
      return res.status(403).json({ error: '数据备份、恢复与密钥操作请在电脑本机完成' });
    }
    next();
  };
}
