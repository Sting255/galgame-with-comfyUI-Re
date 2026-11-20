/**
 * groupBystanderReaction.js —— 群聊「旁观者接一句」（2026-11-06）
 *
 * 问题现场（真机日志）：在群里对某位角色做亲密 / 玩具动作，只有她自己有反应，
 * 其他在场成员一句话都没有 —— 群里像只有两个人，沉浸感直接断掉。
 *
 * 与触摸链分工（不要重复做同一件事）：
 *   · 触摸链（routes/touch.js）早就把旁观者写在**同一次**反应调用的 prompt 里（buildTouchBystanderRule），
 *     那个口径保持不动，只把默认概率抬到"常态会有人应声"；
 *   · 亲密推进 / 玩具这两条链是"她一个人演一段"的结构，没有旁观位 —— 本模块补一次**独立的小调用**：
 *     挑一位在场、醒着的成员，让她接一句围观 / 起哄 / 别过头去的话，写进群会话并广播。
 *
 * 边界：
 *   · 概率沿用 features.touchBystanderChance（与触摸链同一口径，null/false 关闭）；
 *   · 单次最多 1 人发言，避免整群刷屏（沿用 planTouchBystander 的裁决）；
 *   · 睡着的人不围观（她被叫醒是另一条链路 applyGroupWake 的事）；
 *   · 全程 try/catch + 不抛错：旁观是旁路，绝不能影响动作本身的结果与返回。
 */
import { chatSync } from '../llm/llm-client.js';
import { getDb } from '../db/index.js';
import { writeGroupInsertMessage } from './groupInsertMessage.js';
import { broadcast } from './unifiedStreamBus.js';
import { planTouchBystander, resolveTouchBystanderChance } from './groupTouchConsumption.js';
import { buildCharacterPersona } from './characterPersona.js';
import { isSleeping } from './scheduleManager.js';

/** 旁观冷却：同一个人 10 分钟内不再插话，避免"每次都是她抢答"（2026-11-06） */
const BYSTANDER_COOLDOWN_MS = 10 * 60 * 1000;
const recentBystanders = new Map();   // `${groupId}:${characterId}` -> 上次插话时间戳

function isCoolingDown(groupId, characterId, now = Date.now()) {
  const at = recentBystanders.get(`${groupId}:${characterId}`);
  return Boolean(at) && now - at < BYSTANDER_COOLDOWN_MS;
}

function markSpoke(groupId, characterId, now = Date.now()) {
  recentBystanders.set(`${groupId}:${characterId}`, now);
  // 顺手清理过期项，避免长期运行无限增长
  if (recentBystanders.size > 200) {
    for (const [key, at] of recentBystanders) {
      if (now - at >= BYSTANDER_COOLDOWN_MS) recentBystanders.delete(key);
    }
  }
}

/** 读群成员（含人格字段，够拼 short 版人格） */
function readMembers(groupId) {
  return getDb().prepare(`
    SELECT c.id, c.name, c.display_name, c.short_prompt, c.base_prompt
    FROM group_members m JOIN characters c ON c.id = m.character_id
    WHERE m.group_id = ? ORDER BY m.id ASC
  `).all(Number(groupId)) || [];
}

/** 最近几条群聊上下文（只作语气参考，不要求她复述） */
function readRecentLines(groupId, limit = 4) {
  const rows = getDb().prepare(
    'SELECT role, content FROM raw_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
  ).all(`group_${Number(groupId)}`, limit) || [];
  return rows.reverse()
    .map(row => String(row.content || '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200);
}

/** 把模型那一句收拾干净：去掉名字前缀、引号、括号动作、多余换行 */
function cleanLine(raw, name) {
  let text = String(raw || '').trim();
  if (!text) return '';
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped) text = text.replace(new RegExp('^\\s*\\[?' + escaped + '\\]?\\s*[:：]\\s*'), '');
  text = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] || '';
  text = text.replace(/^["“”'「」]+|["“”'「」]+$/g, '').trim();
  if (!text) return '';
  return text.slice(0, 120);
}

/**
 * 动作发生后，让一位在场成员接一句话。
 *
 * @param {object} args
 * @param {number} args.groupId  群 id
 * @param {number} args.actorId  被互动的角色 id（排除出旁观候选）
 * @param {string} args.actionLabel 刚发生的动作（"继续抽插""戴上…"），只用于给旁观者一个由头
 * @param {string} [args.actorLine] 她刚才那句反应（给旁观者当上下文）
 * @returns {Promise<object|null>} 写进去的群消息载荷；没触发/失败都返回 null
 */
export async function maybeAddBystanderReaction({ groupId, actorId, actionLabel = '', actorLine = '' } = {}) {
  try {
    const gid = Number(groupId);
    if (!Number.isSafeInteger(gid) || gid <= 0) return null;
    const chance = resolveTouchBystanderChance();
    if (chance === null) return null;

    // 睡着的人不围观 + 刚插过话的人本轮跳过（冷却）：避免同一个人连续抢话
    const now = Date.now();
    const candidates = readMembers(gid).filter(member => {
      if (Number(member.id) === Number(actorId)) return false;
      if (isCoolingDown(gid, member.id, now)) return false;
      try { return !isSleeping(member.id).sleeping; } catch { return true; }
    });
    const plan = planTouchBystander({ members: candidates, excludeId: actorId, chance });
    const bystander = plan?.allowed ? plan.member : null;
    if (!bystander) return null;

    const name = bystander.display_name || bystander.name || '她';
    const actorRow = readMembers(gid).find(member => Number(member.id) === Number(actorId));
    const actorName = actorRow?.display_name || actorRow?.name || '同伴';
    const context = readRecentLines(gid);

    const system = [
      buildCharacterPersona(bystander, { variant: 'short', person: name }),
      '',
      `你正在群聊里旁观：${actorName}刚被「${actionLabel || '那样对待'}」。`,
      '你要以群成员的身份，对眼前这一幕**说一句话**——可以起哄、吐槽、别过头去、替她说话、或者假装没看见但忍不住评论。',
      '只输出这一句台词本身：不要写名字前缀，不要用引号，不要括号动作，不要旁白，不要解释，不要第二句。控制在 30 字以内，口语化。',
    ].join('\n');

    const user = context
      ? `最近的群聊记录：\n${context}\n\n${actorName}刚刚的一句反应：${String(actorLine || '').slice(0, 200) || '（没说话）'}\n\n现在轮到你，只说一句话。`
      : `${actorName}刚刚的一句反应：${String(actorLine || '').slice(0, 200) || '（没说话）'}\n\n现在轮到你，只说一句话。`;

    const raw = await chatSync(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.95, max_tokens: 160, label: '群聊旁观', retries: 0 },
    );
    const line = cleanLine(raw, name);
    if (!line) return null;

    const written = writeGroupInsertMessage(gid, bystander, line, { source: 'bystander' });
    if (!written?.payload) return null;
    markSpoke(gid, bystander.id);
    broadcast('group_message', written.payload);
    console.log(`[group] bystander reaction: ${name}(${bystander.id}) → ${line.slice(0, 40)}`);
    return written.payload;
  } catch (err) {
    console.warn('[group] bystander reaction failed:', err?.message || err);
    return null;
  }
}
