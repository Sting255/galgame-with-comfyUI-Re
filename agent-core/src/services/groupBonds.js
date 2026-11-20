/**
 * groupBonds.js —— 角色之间的温度（2026-11-06）
 *
 * 为什么单独做：现有的 `character_relationships` 只写"她是她姐姐"这种静态定义，
 * 角色之间到底亲近还是别扭，系统里没有变量。群聊里"谁跟谁不对付"只能靠模型临场发挥，
 * 下一轮就忘了 —— 于是她们永远像刚认识。
 *
 * 口径刻意朴素（零 LLM 成本）：
 *   · 群聊里"谁对谁说了什么"这一条（inter_character_events）顺带做一次微调；
 *   · 负面语气扣 0.3、其余加 0.1，分数夹在 -5 ~ +5；
 *   · 同一对角色**每天最多变动 1 点**，不会一夜之间从陌生变亲密；
 *   · 只读给 prompt 一句人话（"有点别扭"/"相处得不错"），不做数值 UI。
 */
import { getDb } from '../db/index.js';

const SCORE_MIN = -5;
const SCORE_MAX = 5;
const DAILY_CAP = 1;
const NEGATIVE_RE = /闭嘴|滚|烦死|笨蛋|蠢|吵死|别闹|懒得|讨厌|少管|走开|别碰/;

/** 某一对角色当前温度（无记录 = 0） */
export function readBond(fromId, toId) {
  try {
    const row = getDb().prepare('SELECT score FROM character_bonds WHERE from_character_id=? AND to_character_id=?')
      .get(Number(fromId), Number(toId));
    return Number(row?.score) || 0;
  } catch {
    return 0;
  }
}

/** 按一次互动微调温度；true = 真的改了 */
export function nudgeBond(fromId, toId, { text = '', at = new Date() } = {}) {
  try {
    const db = getDb();
    const from = Number(fromId);
    const to = Number(toId);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from === to) return false;
    const day = at.toISOString().slice(0, 10);
    const delta = NEGATIVE_RE.test(String(text || '')) ? -0.3 : 0.1;
    const row = db.prepare('SELECT score, day, day_delta FROM character_bonds WHERE from_character_id=? AND to_character_id=?')
      .get(from, to);
    if (!row) {
      db.prepare('INSERT INTO character_bonds(from_character_id,to_character_id,score,day,day_delta,updated_at) VALUES (?,?,?,?,?,?)')
        .run(from, to, Math.max(SCORE_MIN, Math.min(SCORE_MAX, delta)), day, delta, at.toISOString());
      return true;
    }
    const dayDelta = row.day === day ? Number(row.day_delta) || 0 : 0;
    if (Math.abs(dayDelta + delta) > DAILY_CAP) return false;   // 当天预算用完
    const next = Math.max(SCORE_MIN, Math.min(SCORE_MAX, (Number(row.score) || 0) + delta));
    db.prepare('UPDATE character_bonds SET score=?, day=?, day_delta=?, updated_at=? WHERE from_character_id=? AND to_character_id=?')
      .run(next, day, dayDelta + delta, at.toISOString(), from, to);
    return true;
  } catch (err) {
    console.warn('[group] bond nudge failed:', err?.message || err);
    return false;
  }
}

/** 温度 → 一句话（注入 prompt 用） */
export function describeBond(score) {
  const value = Number(score) || 0;
  if (value >= 2) return '很亲近，会主动搭话、替对方解围';
  if (value >= 0.8) return '相处得不错，说话随意';
  if (value <= -2) return '关系紧张，能避开就避开，说话带刺';
  if (value <= -0.8) return '有点别扭，容易被对方的话惹到';
  return '普通，客客气气';
}

/**
 * 从一段台词里识别"提到了谁"，顺手微调说话者与对方之间的温度（2026-11-06）。
 * 群聊走的是"谁点名了谁"的结构化记录；私聊里她只对着用户说话，
 * 但提到别人的语气一样能说明她此刻对那人的态度，所以补这一条。
 * 只截取名字前后各 12 字判断语气，避免整段话里的负面词误伤无关的人。
 * @returns {number} 实际变动的关系对数
 */
export function nudgeBondsFromText(fromId, text) {
  try {
    const body = String(text || '');
    const from = Number(fromId);
    if (!Number.isSafeInteger(from) || !body) return 0;
    const rows = getDb().prepare("SELECT id, display_name FROM characters WHERE id != ? AND COALESCE(is_system, 0) = 0").all(from) || [];
    let changed = 0;
    for (const row of rows) {
      const name = String(row.display_name || '').trim();
      if (!name) continue;
      const at = body.indexOf(name);
      if (at < 0) continue;
      const around = body.slice(Math.max(0, at - 12), Math.min(body.length, at + name.length + 12));
      if (nudgeBond(from, row.id, { text: around })) changed += 1;
    }
    return changed;
  } catch (err) {
    console.warn('[group] bond nudge from text failed:', err?.message || err);
    return 0;
  }
}

/** 读一批温度，渲染成注入块（没有记录时返回空串） */
export function buildBondsBlock(groupId) {
  try {
    const rows = getDb().prepare(`
      SELECT b.score, cf.display_name AS from_name, ct.display_name AS to_name
      FROM character_bonds b
      JOIN group_members mf ON mf.character_id = b.from_character_id AND mf.group_id = ?
      JOIN group_members mt ON mt.character_id = b.to_character_id AND mt.group_id = ?
      JOIN characters cf ON cf.id = b.from_character_id
      JOIN characters ct ON ct.id = b.to_character_id
      ORDER BY ABS(b.score) DESC, b.updated_at DESC
      LIMIT 8
    `).all(Number(groupId), Number(groupId)) || [];
    if (!rows.length) return '';
    const lines = rows.map(row => `- ${row.from_name} 对 ${row.to_name}：${describeBond(row.score)}`);
    return `<character_bonds>\n她们彼此之间的温度（影响语气和互动方式，不必说明）：\n${lines.join('\n')}\n</character_bonds>`;
  } catch {
    return '';
  }
}
