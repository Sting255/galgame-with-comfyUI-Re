/**
 * worldTimeline.js —— 世界时间轴的读写（2026-11-06）
 *
 * 写入：事件开场、神说的世界事实各记一条（source_id 幂等）。
 * 读取：给事件生成、日报、群聊提供"最近发生过什么"，让新内容能接上旧内容。
 *
 * 刻意不写朋友圈与群聊的单条消息：那是角色自己的经历，量也太大；
 * 时间轴只回答"这个世界最近发生了什么"，不回答"谁说了哪句话"。
 */
import { getDb } from '../db/index.js';
import { getProgramNow } from './programTime.js';

const SUMMARY_MAX = 200;

/**
 * 程序时间相对真实时间的偏移（毫秒）。
 * 时间轴统一存**世界时间**：补算是按真实时长算出来的，落到世界时间轴上前要先加上这个偏移，
 * 否则用户拨快/拨慢世界钟后，日报按程序日期找新闻、时间轴却写着真实日期，两边对不上。
 */
function programOffsetMs() {
  try {
    const now = getProgramNow();
    return Number.isFinite(now.getTime()) ? now.getTime() - Date.now() : 0;
  } catch {
    return 0;
  }
}

/**
 * 记一条世界发生。sourceId 相同则忽略（幂等）。
 * @returns {number|null} 新行 id；重复或失败返回 null
 */
export function recordWorldTimeline({ kind = 'event', title = '', summary = '', characterIds = [], sourceId = null, at = null } = {}, db = null) {
  try {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return null;
    const ids = Array.isArray(characterIds)
      ? characterIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
      : [];
    const target = db || getDb();
    // 入参的 at 一律视为**真实瞬间**，落库统一加偏移变成世界时间
    const realAt = at ? new Date(at) : new Date();
    const storedAt = new Date(realAt.getTime() + programOffsetMs()).toISOString();
    const row = target.prepare(
      'INSERT OR IGNORE INTO world_timeline(at, kind, title, summary, character_ids, source_id) VALUES (?,?,?,?,?,?)'
    ).run(
      storedAt,
      String(kind || 'event'),
      cleanTitle.slice(0, 120),
      String(summary || '').trim().slice(0, SUMMARY_MAX),
      ids.length ? JSON.stringify(ids) : null,
      sourceId ? String(sourceId) : null,
    );
    return row.changes ? Number(row.lastInsertRowid) : null;
  } catch (err) {
    console.warn('[worldTimeline] record failed:', err?.message || err);
    return null;
  }
}

/** 读最近的世界发生（默认 48 小时内，最多 N 条），按时间正序返回（便于阅读） */
export function recentWorldTimeline(limit = 5, { hours = 48 } = {}) {
  try {
    // 存储是程序时间，过滤也要用程序时间（否则拨过钟以后窗口会偏）
    const nowMs = (() => { try { return getProgramNow().getTime(); } catch { return Date.now(); } })();
    const since = new Date(nowMs - Math.max(1, Number(hours) || 48) * 3600_000).toISOString();
    const rows = getDb().prepare(`
      SELECT id, at, kind, title, summary
      FROM world_timeline
      WHERE at >= ?
      ORDER BY at DESC, id DESC
      LIMIT ?
    `).all(since, Math.max(1, Math.min(50, Number(limit) || 5))) || [];
    return rows.reverse();
  } catch {
    return [];
  }
}

/** 渲染成注入块；没有记录时返回空串（零注入，老库无表也不报错） */
export function buildWorldTimelineBlock(limit = 4, { hours = 48 } = {}) {
  const rows = recentWorldTimeline(limit, { hours });
  if (!rows.length) return '';
  const lines = rows.map(row => {
    const when = String(row.at || '').replace('T', ' ').slice(5, 16);
    return `- ${when}｜${row.title}${row.summary ? `：${row.summary}` : ''}`;
  });
  return `<world_timeline>\n这个世界最近发生过这些事（可作为前因承接，不必逐条提及）：\n${lines.join('\n')}\n</world_timeline>`;
}

/**
 * 清理过期的世界时间轴（2026-11-06）。
 * 这张表只服务"最近发生了什么"，留 90 天足够；不清理会随事件/补算无限增长。
 * @returns {number} 删除行数
 */
export function pruneWorldTimeline(days = 90) {
  try {
    const nowMs = (() => { try { return getProgramNow().getTime(); } catch { return Date.now(); } })();
    const cutoff = new Date(nowMs - Math.max(7, Number(days) || 90) * 86400_000).toISOString();
    const row = getDb().prepare('DELETE FROM world_timeline WHERE at < ?').run(cutoff);
    return row.changes || 0;
  } catch (err) {
    console.warn('[worldTimeline] prune failed:', err?.message || err);
    return 0;
  }
}
