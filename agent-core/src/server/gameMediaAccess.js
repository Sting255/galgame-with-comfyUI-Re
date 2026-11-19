import { createHmac, timingSafeEqual } from 'node:crypto';

// 游戏使用 opaque-origin iframe，不能把设备 Cookie 或 Bearer 交给游戏代码。
// 宿主只为已授权游戏响应中的图片签发限时路径凭据，不能用于 API、写操作或其他路径。
const TTL_MS = 24 * 60 * 60 * 1000;
const EXP = '__game_exp', SIG = '__game_sig';

function mediaPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return null;
  try {
    // 必须在 URL 构造器消去 dot-segment 之前拒绝越级路径，和调用方的权限前缀同口径。
    const rawPath = decodeURIComponent(value.split(/[?#]/, 1)[0]);
    if (/[\\\0]/.test(rawPath) || rawPath.split('/').some(part => part === '.' || part === '..')) return null;
    const url = new URL(value, 'http://game.invalid');
    const decoded = decodeURIComponent(url.pathname);
    if (!/^\/(images|avatars|game-media)\//i.test(decoded) || /[\\\0]/.test(decoded)
      || decoded.split('/').some(part => part === '.' || part === '..')) return null;
    return { url, pathname: decoded };
  } catch { return null; }
}

export function createGameMediaAccess(secret, now = Date.now) {
  const signature = (pathname, expires) => createHmac('sha256', secret)
    .update(`linshe-game-media-v1\n${expires}\n${pathname}`).digest('base64url');
  return {
    sign(value) {
      const media = mediaPath(value);
      if (!media) return value;
      const expires = String(now() + TTL_MS);
      media.url.searchParams.set(EXP, expires);
      media.url.searchParams.set(SIG, signature(media.pathname, expires));
      return media.url.pathname + media.url.search;
    },
    verify(value) {
      const media = mediaPath(value);
      if (!media) return false;
      const expires = media.url.searchParams.get(EXP), supplied = media.url.searchParams.get(SIG);
      if (!/^\d{13}$/.test(expires || '') || Number(expires) <= now() || Number(expires) > now() + TTL_MS) return false;
      const expected = signature(media.pathname, expires);
      if (!/^[A-Za-z0-9_-]{43}$/.test(supplied || '')) return false;
      return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    },
  };
}

export function mapGameMediaUrls(value, sign) {
  if (typeof value === 'string') return sign(value);
  if (Array.isArray(value)) return value.map(item => mapGameMediaUrls(item, sign));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapGameMediaUrls(item, sign)]));
  }
  return value;
}
