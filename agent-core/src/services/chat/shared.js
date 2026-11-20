import { config } from '../../config.js';
import { recordFromConversationTail, recordUnspecifiedFromRawId } from '../intimateAutoRecord.js';
import { applyContextBudget } from '../contextAssembler.js';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── SLG 动作系统（触摸互动）· 待反应动作的读取与消费 ──────────────────────────
// 实现已搬到服务层 `services/touchEventStore.js`（task-24 P2-2），口径见那里的文件注释：
//   · status='pending'（隐式）：反应还没演过 → 本轮注入 mode='implicit' 让她写进回复；
//   · status='done'（即时已单独发过）→ 注入 mode='instant'（"别再演一遍"）；
//   · 只认私聊（group_id IS NULL）、**ASC（先点先演）**、超过 30 分钟自动作废。
// 读一次就置 'injected' ⇒ 一次动作只注入一次（markTouchEventInjected）。

// 阶段四：dynamicBlocks 预算降级包装（降级过程有日志，无静默截断）
export function applyBudgetToBlocks(blocks, budgetTokens) {
  const result = applyContextBudget({ blocks, budgetTokens });
  if (result.degraded.length > 0) {
    console.log(`[chat] context budget: ${result.tokensBefore} → ${result.tokensAfter} tokens（预算 ${budgetTokens}）；${result.degraded.join('；')}`);
  }
  return result.blocks;
}

// ── 打字节奏：按分句文字长度随机 300~900ms，模拟真人打字（短句快、长句慢、带随机抖动） ──
export const typingDelay = (text = '') => {
  const len = Math.min(30, (text || '').length || 1); // 长度封顶 30 字，避免超长句停顿过久
  const base = 300 + (len / 30) * 300;                // 长度映射 300~600ms
  const jitter = Math.random() * 300;                 // 随机抖动 0~300ms
  return Math.min(900, Math.round(base + jitter));    // 最终落在 300~900ms
};

// ── 临时表达风格池：小概率注入，让"怎么说"像真人一样随心情/话题变化 ──
// 只影响本次回复，不改变性格底色；放历史聊天之后，越靠近"现在要回复"越容易被接住。
export const TEMP_STYLE_POOL = [
  '先吐槽一句，再正常接话',
  '这次带点懒散随意的语气',
  '用一句玩笑话开场，再认真说',
  '这次说话稍微正经一点',
];

export const TEMP_STYLE_POOL_OATH = [
  ...TEMP_STYLE_POOL,
  '这次带点撒娇的意味',
  '语气软一点，带点想念',
];

// 低好感（<40）专用：风格池与关系深度档位同向，避免中性/亲昵风格把恶劣态度拉回去
export const TEMP_STYLE_POOL_HOSTILE = [
  '这次带点阴阳怪气的味儿，笑里藏刀',
  '先冷笑一声，再用敷衍的一句话把 ta 顶回去',
  '带点瞧不起的语气，把 ta 的话贬一顿再说',
  '用最短最冲的话回应，一副懒得搭理的样子',
];

// ── 智能配图计数器（per-conversation）：每轮用户发言 -1，生图成功后重置为配额，归零时跳过 LLM 判断直接生图 ──
// 同上：变空会让下一次读取回落到"满额"默认值（判定配额被静默重置），所以一并落库。

// ── character_id → conversation_id 映射 ──
export function convId(charId) { return `char_${charId}`; }

// 灵魂快照列（memory_fragments.soul_snapshot）是 JSON 字符串；解析失败按无快照跳过。
// （上游 v3.9.0 灵魂引擎合并，供 RAG 召回段的 resonate 轨用。）
export function parseSoulSnapshot(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// 将 SQLite CURRENT_TIMESTAMP (UTC, 无时区标记) 转为 ISO 8601
// SQLite: "YYYY-MM-DD HH:MM:SS"  →  JS: 被误解析为本地时间（各浏览器行为不一致）
// 统一转为 "YYYY-MM-DDTHH:MM:SS.000Z" 确保前端正确按 UTC 转换显示
export function toISODate(sqliteDT) {
  if (!sqliteDT) return sqliteDT;
  return sqliteDT.replace(' ', 'T') + '.000Z';
}

/**
 * 亲密看板：按会话尾部（最近一条带生图 prompt 的 assistant 原始消息）自动记账。
 *
 * 为什么不逐个落库分支挂钩：assistant 原始消息在本文件有多个保存分支
 * （主流式落库 / needImage 新建 / needImage 合并回上一条），逐个挂钩容易漏；
 * read-after-write 地取尾部只需一个入口，且天然覆盖"合并回上一条"的情况。
 * 重复调用由 recordIntimateActs 的 source_uid（含 raw_id）幂等兜住。
 * 总开关 features.intimate 关闭时零写入。
 */
export function recordIntimateFromTail(characterId, conversationId) {
  if (config.features.intimate === false) return;
  try {
    recordFromConversationTail({ characterId, conversationId, scene: 'chat', partnerKind: 'user' });
  } catch (err) {
    // 记账失败不能影响聊天主流程
    console.warn('[intimate] auto record failed:', err.message);
  }
}

/**
 * 看板正文兜底：本轮**没有**任何生图 prompt（纯文字对话）时，正文命中成人内容判定就记一笔「未归类」。
 *
 * 为什么需要它：私聊原本只在 `tags.prompt` 存在时记账 ⇒ 纯文字轮次整段不进看板，
 * 用户看到的"内容与记录没进看板"就是这个缺口（群聊同理，见 groupChatEngine）。
 * 判定用项目现成的 containsExplicitAdultContent（自带中文词表），零 LLM、零新增词表，不猜具体行为。
 * 与 recordIntimateFromTail 互斥调用（有 prompt 走归类路径），幂等锚点同为 raw_id。
 */
export function recordIntimateTextFallback(characterId, rawId) {
  if (config.features.intimate === false) return;
  try {
    recordUnspecifiedFromRawId({ characterId, rawId, scene: 'chat', partnerKind: 'user' });
  } catch (err) {
    console.warn('[intimate] text fallback failed:', err.message);
  }
}

export function stripTags(content) {
  return content
    // 完整 JSON prompt 标签：处理 {"prompt":"..."} 和 {“prompt“:"..."} 等变体
    .replace(/\{[“”"]?prompt[“”"]?\s*:\s*[“”"](?:[^“”"]|\\[“”"])*[“”"]\}/gi, '')
    // 兜底：闸门漏过的未闭合或格式异常的 prompt 标签（从 {prompt": 开始清到行尾）
    .replace(/\{[“”"]?prompt[“”"]?\s*:\s*[“”"].*$/gm, '')
    .replace(/<generate>[\s\S]*?<\/generate>/gi, '')
    .replace(/<needImage>/gi, '')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 清洗括号动作描写（形如 "（兴奋地跳起来）"、"（语气温柔地）" 等舞台指示格式）
 * 正则说明：匹配中文全角括号内包含动词/形容词/神态/语气描述的内容
 */
export function stripBracketActions(text) {
  if (!text) return text;
  // 暂时不需要清洗括号动作描写，直接返回原文
  return text;
  // 匹配（...）内含动作/表情/语气/神态描写的括号块
  // 关键词: 地/着/一/眼/音/气/情/笑/脸/手/头/身/过/到/说/道/想/觉/动/跳/摇/点/看/回/转/愣/露/叹/拍/挥/伸/退/走/跑/坐/站/低/抬/转/指/瞪/闭/睁/留
  // 包含这些词且括号内字符数 ≥ 3 的视为动作描写
  const actionKeywords = /地|着|了|一下|起来|变得|露出|低头|抬头|眼睛|语气|声音|表情|笑容|身子|突然|轻轻|微微|有些|略带|伸手|脚步|转身|手指|目光|一眼|看了|说道|想到|觉得|动作|跳了|摇了|点了|看了|回了|转了|愣了|露了|叹了口气|拍了拍|挥了|指了指|伸了|退了|走了|跑了|坐了|站了|低了抬头|转了身|指了指|瞪了|闭了|睁了|留了/;
  return text.replace(/（[^）]{3,60}?）/g, (match) => {
    // 检查括号内容是否含动���/表情关键词
    const inner = match.slice(1, -1); // 去掉括号
    if (actionKeywords.test(inner)) {
      return ''; // 移除
    }
    return match; // 保留非动作括号（如补充说明）
  }).replace(/\n{3,}/g, '\n\n').trim();
}

export function _parseLoras(char) {
  if (!char.loras) return [];
  try {
    const parsed = typeof char.loras === 'string' ? JSON.parse(char.loras) : char.loras;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(l => l.path && typeof l.path === 'string').map(l => ({
      path: l.path,
      weight: typeof l.weight === 'number' ? l.weight : 0.6,
      triggerWord: l.triggerWord || '',
    }));
  } catch {
    return [];
  }
}

export function formatRelativeDay(days) {
  if (days == null) return '之前';
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  return `${days}天前`;
}
