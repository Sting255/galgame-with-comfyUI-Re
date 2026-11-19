import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { verifyDeviceToken, issueDeviceToken, listDeviceTokens, revokeDeviceToken, revokeAllDeviceTokens } from './deviceTokens.js';
import { createGameMediaAccess } from './gameMediaAccess.js';

const BEARER_PREFIX = 'bearer ';

/**
 * 设备令牌校验的安全包装（P0-02）。
 *
 * 鉴权中间件不能因为 DB 未就绪/读失败就抛异常把请求打成 500：
 * 那种情况下应当按「未授权」处理，让客户端走配对流程。
 */
function verifyDeviceTokenSafe(authorizationHeader) {
  const header = String(authorizationHeader || '').trim();
  if (header.length <= BEARER_PREFIX.length) return false;
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return false;
  const value = header.slice(BEARER_PREFIX.length).trim();
  if (!value) return false;
  try {
    return verifyDeviceToken(undefined, value);
  } catch {
    return false;
  }
}

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
  const gameMedia = createGameMediaAccess(token);
  return function accessControl(req, res, next) {
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    const gameAsset = /^\/(?:game-assets\/|game-sdk\.js(?:\?|$))/i.test(req.originalUrl || req.url || '');
    const signedMedia = readOnly && gameMedia.verify(req.originalUrl || req.url || '');
    const gameRead = readOnly && (gameAsset || signedMedia);
    const opaqueGameRead = req.headers.origin === 'null' && gameRead;
    let host, origin;
    try {
      host = new URL(`http://${req.headers.host}`).hostname;
      if (req.headers.origin && !opaqueGameRead) origin = new URL(req.headers.origin);
    } catch { return res.status(403).json({ error: '不允许的访问来源' }); }
    if (!allowedHosts.has(normalize(host))) return res.status(403).json({ error: '不允许的访问地址' });
    const forwarded = Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'));
    const local = !opaqueGameRead && isLoopback(req.socket.remoteAddress) && localHost(host) && !forwarded && (!origin || localHost(origin.hostname));
    const devOrigin = development && origin?.port === '5173' && allowedHosts.has(normalize(origin.hostname));
    if (!gameRead && ((origin && origin.host !== req.headers.host && !devOrigin) || req.headers['sec-fetch-site'] === 'cross-site')) {
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
    if (gameRead && !devOrigin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Vary', 'Origin');
    }
    let cookie = '';
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [key, ...value] = part.trim().split('=');
      if (key === cookieName) cookie = value.join('=');
    }
    const authorized = local || sameSecret(cookie, session) || sameSecret(req.headers.authorization, `Bearer ${token}`);
    // P0-02：设备令牌（Bearer 的另一种合法取值）。
    // 根配对码是全局的，撤销一台等于撤销所有；原生 SSE 需要每设备独立、可单独撤销的凭证。
    // 这里只在根配对码不匹配时才去查设备令牌，避免常规路径多一次 DB 读取。
    const deviceAuthorized = !authorized && verifyDeviceTokenSafe(req.headers.authorization);
    const isAuthorized = authorized || deviceAuthorized;
    // 让路由能区分「本机直连」与「已配对远程设备」。
    // 背景（P0-01）：/api/maibot 注释写「仅本机使用」，但它挂在 /api 下会被配对 Cookie 放行，
    // 于是已配对设备能读写 MaiBot 管理凭据。写权限必须按这个标记再收一次。
    req.linsheLocal = local;
    res.locals.linsheLocal = local;
    res.locals.gameMediaUrl = gameMedia.sign;
    // Express 默认大小写不敏感、允许尾斜杠；授权边界必须采用同一口径。
    let pathname;
    try { pathname = decodeURIComponent(req.path).toLowerCase().replace(/\/+$/, '') || '/'; }
    catch { return res.status(400).json({ error: '无效的访问路径' }); }
    if (pathname === '/api/access' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      // 设备令牌也算已授权：原生 SSE 用 Bearer 时，网页这边同样应看到「已连接」
      return res.json({ authorized: isAuthorized, local, ...(local ? { pairingCode: token } : {}) });
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
    // ── 设备令牌签发（P0-02）──
    //
    // 配对成功后，网页把这里的令牌交给原生层（Android 桥），原生 SSE 用 Bearer 连接。
    // 只允许**已授权**的请求签发：否则任何能访问 /api/access/session 的人都能自助发令牌。
    if (pathname === '/api/access/device-token' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      if (!isAuthorized) return res.status(401).json({ error: '请先完成配对再申请设备令牌', code: 'PAIRING_REQUIRED' });
      try {
        const issued = issueDeviceToken(undefined, { label: req.body?.label || '' });
        // 原文只在这里出现一次，之后任何接口都只给元数据
        return res.json({ ok: true, ...issued });
      } catch (error) {
        return res.status(500).json({ error: `签发设备令牌失败：${error.message}` });
      }
    }
    if (pathname === '/api/access/device-tokens' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      if (!isAuthorized) return res.status(401).json({ error: '请先完成配对', code: 'PAIRING_REQUIRED' });
      return res.json({ tokens: listDeviceTokens() });
    }
    if (pathname === '/api/access/device-tokens/revoke' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      // 撤销是敏感操作：只允许本机（远程设备不能互相踢下线）
      if (!local) return res.status(403).json({ error: '撤销设备令牌请在运行邻舍的电脑本机操作' });
      const id = String(req.body?.id || '').trim();
      if (id) return res.json(revokeDeviceToken(undefined, id));
      return res.json(revokeAllDeviceTokens(undefined));
    }
    // 健康检查不含聊天/配置内容，启动器必须能在配对前检查实例身份。
    if (pathname === '/api/health') return next();
    const protectedPath = /^\/(api(?:\/|$)|images(?:\/|$)|avatars(?:\/|$)|town-assets(?:\/|$)|game-media(?:\/|$))/.test(pathname);
    if (protectedPath && !isAuthorized && !signedMedia) return res.status(401).json({ error: '请先在本机设置页获取配对码并连接此设备', code: 'PAIRING_REQUIRED' });
    if (signedMedia) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    if (!local && (pathname === '/api/shutdown' || pathname === '/api/config/llm/key' || /^\/api\/data(?:\/|$)/.test(pathname))) {
      return res.status(403).json({ error: '数据备份、恢复与密钥操作请在电脑本机完成' });
    }
    next();
  };
}
