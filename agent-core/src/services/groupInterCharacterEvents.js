/**
 * groupInterCharacterEvents.js —— 角色之间的互动记录（2026-11-06）
 *
 * 目的：让群聊里的角色手里有"她们俩最近发生过什么"这种可接的话头。
 * 现在模型只知道静态关系（"她是姐姐"）和聊天原文，缺了中间这一层，
 * 表现就是每个角色都只对着玩家说话 —— 没有别人的话可接，自然只剩"回应玩家"。
 *
 * 口径（刻意做成零 LLM 成本）：
 *   · 抽取规则是确定性的：本轮某条台词里点了另一位成员的名字，就记一条 `A → B`；
 *   · 每轮每个发言者对同一个人最多一条，整轮最多 12 条，避免刷库；
 *   · 摘要取原话前 60 字，不做润色（润色要调模型，成本与一致性都不划算）；
 *   · 名字按长度降序匹配，避免"银狼"误命中"银狼LV.999"。
 */
import { getDb } from '../db/index.js';
import { nudgeBond } from './groupBonds.js';

const MAX_EVENTS_PER_ROUND = 12;
const SUMMARY_MAX = 60;

function memberNameList(members) {
  return (members || [])
    .map(member => ({ id: Number(member.id), name: String(member.display_name || member.name || '').trim() }))
    .filter(item => Number.isSafeInteger(item.id) && item.id > 0 && item.name)
    .sort((a, b) => b.name.length - a.name.length);   // 长名字优先，避免短名子串误命中
}

/** 把本轮台词里"谁点了谁的名"落成互动记录；返回写入条数 */
export function recordInterCharacterEvents(group, { speakerLines = [] } = {}) {
  try {
    const groupId = Number(group?.id);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return 0;
    const names = memberNameList(group?.members);
    if (names.length < 2 || !Array.isArray(speakerLines) || speakerLines.length === 0) return 0;

    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO inter_character_events(group_id, from_character_id, to_character_id, kind, summary, created_at) VALUES (?,?,?,?,?,?)'
    );
    const now = new Date().toISOString();
    const seen = new Set();
    let count = 0;
    let lastSpeaker = 0;

    for (const line of speakerLines) {
      if (count >= MAX_EVENTS_PER_ROUND) break;
      const fromId = Number(line?.characterId);
      const text = String(line?.text || '').trim();
      if (!Number.isSafeInteger(fromId) || !text) continue;
      const hit = names.find(item => item.id !== fromId && text.includes(item.name));
      if (hit) {
        const key = `${fromId}:${hit.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          try {
            insert.run(groupId, fromId, hit.id, 'said_to', text.slice(0, SUMMARY_MAX), now);
            // 关系温度（2026-11-06）：这一句是带刺还是带笑，顺手记进两人之间的分数
            nudgeBond(fromId, hit.id, { text });
            count += 1;
          } catch (err) {
            console.warn('[group] inter-character event insert failed:', err?.message || err);
            break;
          }
        }
      } else if (lastSpeaker && lastSpeaker !== fromId) {
        // 真机实测（2026-11-06）：角色互相称呼是"云姐""哥""师傅"，很少直呼全名，
        // 于是按名字匹配一条都记不到。这里退化成"谁接了谁的话"——不给温度加权，
        // 只留一条可以给群聊当话头的痕迹。
        const key = `${fromId}:${lastSpeaker}`;
        if (!seen.has(key)) {
          seen.add(key);
          try {
            insert.run(groupId, fromId, lastSpeaker, 'replied_to', text.slice(0, SUMMARY_MAX), now);
            count += 1;
          } catch (err) {
            console.warn('[group] inter-character event insert failed:', err?.message || err);
            break;
          }
        }
      }
      lastSpeaker = fromId;
    }
    if (count > 0) console.log(`[group] recorded ${count} inter-character event(s) for group ${groupId}`);
    return count;
  } catch (err) {
    console.warn('[group] inter-character events failed:', err?.message || err);
    return 0;
  }
}

/** 读本群最近的成员互动（供本轮指令块用；只读，不写） */
export function readRecentInterCharacterEvents(groupId, limit = 6) {
  try {
    const gid = Number(groupId);
    if (!Number.isSafeInteger(gid) || gid <= 0) return [];
    return getDb().prepare(`
      SELECT e.kind, e.summary, e.created_at, cf.display_name AS from_name, ct.display_name AS to_name
      FROM inter_character_events e
      JOIN characters cf ON cf.id = e.from_character_id
      JOIN characters ct ON ct.id = e.to_character_id
      WHERE e.group_id = ?
      ORDER BY e.id DESC LIMIT ?
    `).all(gid, Math.max(1, Math.min(20, Number(limit) || 6))) || [];
  } catch {
    return [];
  }
}

/** 渲染成本轮指令块；没有记录时返回空串（零注入） */
export function buildRecentInteractionsBlock(groupId, limit = 6) {
  const rows = readRecentInterCharacterEvents(groupId, limit);
  if (!rows.length) return '';
  const lines = rows.reverse().map(row => (row.kind === 'replied_to'
    ? `- ${row.from_name} 接了 ${row.to_name} 的话：${row.summary}`
    : `- ${row.from_name} → ${row.to_name}：${row.summary}`));
  return `<recent_character_events>\n群成员之间最近发生过这些互动（可以作为话头自然提起，不必逐条复述，也不要当成玩家说过的话）：\n${lines.join('\n')}\n</recent_character_events>`;
}

/**
 * 清理过期的成员互动（2026-11-06）。
 * 群聊每轮最多记 12 条，不清理会一年涨到几万行；只服务"最近发生过什么"，留 90 天足够。
 * @returns {number} 删除行数
 */
export function pruneInterCharacterEvents(days = 90) {
  try {
    const cutoff = new Date(Date.now() - Math.max(7, Number(days) || 90) * 86400_000).toISOString();
    const row = getDb().prepare('DELETE FROM inter_character_events WHERE created_at < ?').run(cutoff);
    return row.changes || 0;
  } catch (err) {
    console.warn('[group] prune inter-character events failed:', err?.message || err);
    return 0;
  }
}
