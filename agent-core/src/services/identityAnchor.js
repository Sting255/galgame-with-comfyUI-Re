/**
 * identityAnchor.js — 角色身份锚点（2026-11-08 用户定）
 *
 * ── 解决什么问题 ──
 *
 * 用户原话：「点自动生成会把本来的角色 tag 替换掉，导致有的时候不像这个角色，无法锚点这个角色。
 * 热门角色模型还认识的还好，一旦是冷门角色或者 lora 角色，衣服和人物就容易飘。」
 *
 * 根因是「角色是谁」只存在于 `base_prompt` 的 `## 你的外观` 段里，而这一段同时被当成
 * `character_outfits` 里 work（默认）那一套的衣服描述：任何对 work 的生成/改写都会顺手换掉角色。
 * 上一轮（commit a3027698）从入口、生成、注入三侧堵住了这条通道，但身份仍然**没有自己的位置** ——
 * 它依赖卡文本格式（`Name (Series) has ...` 能提，danbooru tag 串部分能提，别的形态提不到），
 * 无法手改、无法重算。
 *
 * 本模块把身份拆成独立一层：`characters.identity_anchor`（+ `identity_anchor_source`）。
 *
 * ── 口径 ──
 *
 * 锚点 = 「身份 tag（Name (Series)）」+「关键身体特征（发色/发型/瞳色/肤色/体型/身体标记）」。
 * 自动建立顺序：正则优先（零成本、可预测）→ 正则提不到时 LLM 抽一次（一次性成本）→ 落库。
 * 手改过的（source = manual）永不被自动流程覆盖，除非显式要求 overwrite。
 *
 * ── 与其它模块的边界 ──
 *
 *   · 不进聊天人格、不进 short_prompt、不参与记忆与关系
 *   · 不改 `## 你的外观` 段的结构与位置（仍然是角色卡最后一段）
 *   · 不进服装生成链路：`sceneOutfitPrompt` 的 work 已被禁生成，本模块也不写服装表
 */

import { getDb } from '../db/index.js';
import { chatSync } from '../llm/llm-client.js';
import { config } from '../config.js';
import { extractCharacterIdentityTag, extractAppearanceSection } from './characterPersona.js';
import { BODY_TRAIT_RE, WEARABLE_RE } from './sceneOutfitPrompt.js';

/** 锚点上限：太长会稀释构图注意力，实测 200 字符 / 24 项足够锚住一个人 */
const MAX_ANCHOR_CHARS = 200;
const MAX_ANCHOR_ITEMS = 24;
/** 身体特征项上限（锚点里 body 段最多几项） */
const MAX_BODY_ITEMS = 14;

/** `auto` 自动维护；`manual` 用户手改过（自动流程不动它） */
export const ANCHOR_SOURCE_AUTO = 'auto';
export const ANCHOR_SOURCE_MANUAL = 'manual';

/**
 * 把卡里的外观文本按「句」切开。
 * 中文卡常用逗号/顿号/句号，英文 tag 串用逗号，还有分号与换行 —— 全部当分隔符。
 */
function splitPhrases(text) {
  return String(text || '')
    .split(/[,，、;；\r\n]+/)
    // 英文句号也当句界：`pale skin. She wears a dress` 是两句，不拆开就会因为后半句有 dress
    // 把前面的身体特征一起丢掉（真机数据里流萤的 "slim petite figure" 就是这么消失的）
    .flatMap(s => s.split(/(?<=[A-Za-z0-9])\.\s+/))
    .map(s => s.replace(/^[\s\-*·]+|[\s。．.]+$/g, '').trim())
    .filter(Boolean);
}

/** 画质 / 构图 / 风格这类噪声：不是人，也不是衣服 */
const NOISE_RE = /^(masterpiece|best quality|top quality|high quality|ultra detailed|very detailed|intricate details?\s*:?[\d.]*|absurdres|highres|high res|\d+k|official art( style)?|anime style|illustration|realistic|\d+girl|1girl|1boy|solo|full body|upper body|cowboy shot|portrait|standing|sitting|looking at viewer|looking at camera|from side|from above|from below|simple background|white background|gradient background|blue background|depth of field|blurry|sharp focus|artist name|signature|watermark|rating|safe|sensitive|nsfw|explicit)$/i;

/** 表情 / 神态：瞬时状态，不属于「她长什么样」，锚进 prompt 反而限制构图 */
const EXPRESSION_RE = /(expression|smile|frown|gaze|glance|blush|smirk|pout|grin|tear|stare|squint)/i;

/** 负面权重写法 `(wrong hair color:0.1)`：这是负面提示词漏进了外观段，不是特征 */
const WEIGHT_TOKEN_RE = /\([^()]*:\s*[\d.]+\)/;

/**
 * 从角色卡里抽「身体特征」句子：命中身体词、且不含任何衣服/穿戴词。
 *
 * 为什么要求「不含穿戴词」：`long silver hair with a black hair ribbon` 这种混写里
 * 一旦把整句拿走，就顺带把发饰当成身体锚死了。宁可少锚一句，也不要锚错。
 *
 * 2026-11-08 真机数据修正（跑开发库 8 张卡看出来的）：
 *   · `Name (Series) has ...` 整句会被当成身体句 ⇒ 身份 tag 在锚点里出现两遍（tag + 原句），
 *     所以先剥掉 tag 前缀再判断
 *   · 配饰（waist sash / brooch / anklet / camera device）、表情（gentle smile / expression）、
 *     构图（full body）都会混进来 ⇒ 各有词表拦住
 *   · 负面权重写法 `(wrong hair color:0.1)` 是负面提示词漏进外观段，直接丢
 *
 * @param {string} appearanceText 外观段（或整卡）
 * @param {string} [identityTag] 已抽出的身份 tag，用于剥掉重复前缀
 */
export function extractBodyTraits(appearanceText, identityTag = '') {
  const tag = String(identityTag || '').trim().toLowerCase();
  const segs = splitPhrases(appearanceText);
  const kept = [];
  for (let seg of segs) {
    if (WEIGHT_TOKEN_RE.test(seg)) continue;                 // 负面权重写法
    if (NOISE_RE.test(seg)) continue;                        // 画质/构图/风格
    // 剥掉「身份 tag + has」前缀：身体部分照样要，tag 已经在锚点最前面了
    if (tag && seg.toLowerCase().includes(tag)) {
      seg = seg.replace(new RegExp(`^[^()]*\\([^()]*\\)\\s*has\\s+`, 'i'), '').trim();
      if (seg.toLowerCase().includes(tag)) continue;
      if (!seg) continue;
    }
    if (!BODY_TRAIT_RE.test(seg)) continue;                  // 不是身体描述
    if (WEARABLE_RE.test(seg)) continue;                     // 混着衣服/配饰，跳过
    if (EXPRESSION_RE.test(seg)) continue;                   // 表情/神态
    if (!kept.some(k => k.toLowerCase() === seg.toLowerCase())) kept.push(seg);
    if (kept.length >= MAX_BODY_ITEMS) break;
  }
  return kept.join(', ');
}

/**
 * 正则优先建立锚点（纯函数，不落库）。
 *
 * @param {object} character - characters 表行（至少含 base_prompt / short_prompt / display_name）
 * @returns {{tag: string, body: string, anchor: string}} 锚点为空时 anchor = ''
 */
export function buildIdentityAnchorFromCard(character) {
  const base = String(character?.base_prompt || character?.short_prompt || '');
  if (!base) return { tag: '', body: '', anchor: '' };
  const tag = extractCharacterIdentityTag(character) || '';
  // 外观段优先；没有外观段时退回整卡（原创角色卡常常把身体写在正文里）
  const appearance = extractAppearanceSection(base);
  const body = extractBodyTraits(appearance || base, tag);
  const anchor = composeAnchor(tag, body);
  return { tag, body, anchor };
}

/** 组装锚点文本：身份 tag 在最前，后面接身体特征；限长限项 */export function composeAnchor(tag, body) {
  const parts = [];
  const cleanTag = String(tag || '').trim();
  if (cleanTag) parts.push(cleanTag);
  const bodyItems = splitPhrases(body)
    .filter(item => !WEARABLE_RE.test(item))
    .slice(0, MAX_BODY_ITEMS);
  const seen = new Set(parts.map(p => p.toLowerCase()));
  for (const item of bodyItems) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(item);
  }
  if (!parts.length) return '';
  const joined = parts.join(', ');
  return joined.length <= MAX_ANCHOR_CHARS
    ? joined
    : parts.slice(0, MAX_ANCHOR_ITEMS).join(', ').slice(0, MAX_ANCHOR_CHARS).replace(/[,\s]+$/, '');
}

/**
 * 把锚点拆回「身份 tag」与「身体特征」两半。
 *
 * 锚点格式固定为 `Name (Series), 身体特征, 身体特征`；没有身份 tag 时整段都是身体。
 * 这是「身体唯一真源」的拆解点：`character_outfits.body` 那份不再被优先读取。
 */
export function splitIdentityAnchor(anchor) {
  const text = String(anchor || '').trim();
  if (!text) return { tag: '', body: '' };
  const lead = text.match(/^([^,]*\([^()]*\))\s*,\s*/);
  if (lead) return { tag: lead[1].trim(), body: text.slice(lead[0].length).trim() };
  const bare = text.match(/^([^,]*\([^()]*\))$/);
  if (bare) return { tag: bare[1].trim(), body: '' };
  return { tag: '', body: text };
}

/** 身体段最短可用长度：太短（如只剩 "bright green eyes"）时宁可用旧回退，别把身体锚窄了 */
const MIN_BODY_CHARS = 12;

/**
 * 取某角色「此刻该用的身体描述」——**身体唯一真源**（2026-11-08 用户定）。
 *
 * 优先级：
 *   ① 库里 `characters.identity_anchor` 拆出来的身体段（干净，不含衣服）
 *   ② 落库为空时从卡里现算（不写库）
 *   ③ 都拿不到 ⇒ 返回 ''，调用方自行回退到 character_outfits.body
 *
 * @param {number|string} characterId
 * @param {object} [character] 已有角色行时传入，省一次查询
 * @returns {string}
 */
export function getIdentityBody(characterId, character = null) {
  const id = Number(characterId || character?.id);
  const fromCard = () => {
    if (!character) return '';
    const built = buildIdentityAnchorFromCard(character);
    return splitIdentityAnchor(built.anchor).body || '';
  };
  let anchor = String(character?.identity_anchor || '').trim();
  if (!anchor && id) anchor = getStoredIdentityAnchor(id).anchor;
  if (!anchor) anchor = buildIdentityAnchorFromCard(character || {}).anchor;
  const body = splitIdentityAnchor(anchor).body;
  if (body.length >= MIN_BODY_CHARS) return body;
  // 锚点身体太窄：用卡里现算的那份兜一次
  const fallback = fromCard();
  return fallback.length > body.length ? fallback : body;
}

/** LLM 抽取的提示词（按仓内 LLM 输出规范：给出完整 JSON 示例与每字段约束） */
function buildAnchorExtractMessages(character) {
  const name = String(character?.display_name || '角色').trim();
  const card = String(character?.base_prompt || '').trim().slice(0, 4000);
  return [
    {
      role: 'system',
      content: `你是角色身份提取器。从角色卡里抽出这个角色在**生图提示词**中用来固定身份的信息，只输出 JSON。

【要抽什么】
1. \`tag\`：角色的 danbooru 角色识别标签，格式固定为 \`Name (Series)\`，例如 \`Huohuo (Honkai: Star Rail)\`、\`nahida (genshin impact)\`。
   - 名字与作品都必须是英文，作品名用卡里出现的正式英文名。
   - **原创角色、或卡里看不出所属作品时，\`tag\` 返回空字符串** —— 不要猜、不要把画师名、会社名（miHoYo / HoYoverse 等）、画质词当作品。
2. \`body\`：只有**身体特征**，英文小写 tag，逗号分隔，最多 14 项，按「发色 → 发型 → 瞳色 → 肤色 → 体型/身高 → 显著身体标记（痣、疤、纹身、兽耳、兽尾、角、翅膀）」的顺序写。
   - 只写卡里明确写了的内容，不要脑补；卡里没写的部位直接跳过。
   - **绝对不要写**：服装、鞋袜、配饰、发饰、表情、姿势、镜头、画质词、画风词。
   - 发型可以带上长度与形状（\`long silver hair\`、\`short wavy bob\`），但不要写发饰。

【输出格式（严格照此，不要输出任何解释或 JSON 以外的文字）】
{"tag":"Huohuo (Honkai: Star Rail)","body":"long mint-green hair, small ahoge, jade green eyes, pale skin, petite, small floating tail spirit"}

【再强调一遍】
- 原创角色：\`{"tag":"","body":"..."}\`
- 只有 JSON，没有别的东西。`,
    },
    {
      role: 'user',
      content: `角色名：${name}\n\n角色卡：\n${card}`,
    },
  ];
}

/**
 * LLM 兜底：正则提不到身份 tag（或身体特征几乎为空）时抽一次。
 * 失败不抛，返回空结构 —— 调用方按「未建立」处理即可，绝不阻塞保存。
 */
export async function extractIdentityAnchorWithLLM(character) {
  try {
    const raw = await chatSync(buildAnchorExtractMessages(character), {
      model: config.llm.model || 'deepseek-chat',
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      label: '身份锚点提取',
    });
    const parsed = JSON.parse(String(raw || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
    const tag = String(parsed?.tag || '').trim();
    const body = String(parsed?.body || '').trim();
    // 只认 `Name (Series)` 形态，模型编别的就丢掉
    const safeTag = /^[A-Za-z][A-Za-z0-9 .'\-:]{1,50}\s*\([^()]{2,60}\)$/.test(tag) ? tag : '';
    return { tag: safeTag, body, anchor: composeAnchor(safeTag, body) };
  } catch (err) {
    console.warn('[identityAnchor] LLM 提取失败:', err?.message || err);
    return { tag: '', body: '', anchor: '' };
  }
}

/**
 * 启动补齐：给「还没有锚点」的角色建立正则锚点（不调 LLM）。
 *
 * 只为 `identity_anchor` 为空的行工作，所以是幂等的：第二次启动没有任何写入。
 * 老库升级后第一次启动会补一次；之后新增/改卡走各自路径。
 *
 * @param {{limit?: number}} [opts]
 * @returns {number} 本次建立的条数
 */
export function backfillIdentityAnchors({ limit = 500 } = {}) {
  let built = 0;
  try {
    const rows = getDb().prepare(
      `SELECT id, display_name, base_prompt, short_prompt FROM characters
       WHERE COALESCE(identity_anchor, '') = '' LIMIT ?`
    ).all(limit);
    for (const row of rows) {
      try {
        const { anchor } = buildIdentityAnchorFromCard(row);
        if (!anchor) continue;   // 原创/无外观的卡提不出来：留给前端「重新自动提取」走 LLM
        saveIdentityAnchor(row.id, anchor, ANCHOR_SOURCE_AUTO);
        built++;
      } catch (err) {
        console.warn(`[identityAnchor] backfill skip char ${row.id}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.warn('[identityAnchor] backfill failed:', err?.message || err);
  }
  return built;
}

/** 读库里的锚点行（只取两列，避免调用方为了锚点去拉整张卡） */
export function getStoredIdentityAnchor(characterId) {
  try {
    const row = getDb().prepare('SELECT identity_anchor, identity_anchor_source FROM characters WHERE id = ?').get(Number(characterId));
    return {
      anchor: String(row?.identity_anchor || '').trim(),
      source: String(row?.identity_anchor_source || '').trim(),
    };
  } catch {
    return { anchor: '', source: '' };
  }
}

/** 落库（source 只接受 auto / manual，其它值按 auto） */
export function saveIdentityAnchor(characterId, anchor, source = ANCHOR_SOURCE_AUTO) {
  const clean = String(anchor || '').trim().slice(0, 600);
  const src = clean ? (source === ANCHOR_SOURCE_MANUAL ? ANCHOR_SOURCE_MANUAL : ANCHOR_SOURCE_AUTO) : '';
  const r = getDb().prepare('UPDATE characters SET identity_anchor = ?, identity_anchor_source = ? WHERE id = ?')
    .run(clean || null, src || null, Number(characterId));
  return { ok: true, anchor: clean, source: src, updated: r.changes };
}

/**
 * 建立/刷新锚点（落库主入口）。
 *
 * 规则：
 *   · source = manual 且非 force ⇒ 原样返回，一个字都不动
 *   · 正则提出来的能用 ⇒ 用它（auto），零模型成本
 *   · 正则提不到 tag 且 allowLLM ⇒ 调一次 LLM；仍提不到就存空（下次点按钮再试）
 *
 * @param {object} character characters 表行
 * @param {{force?: boolean, allowLLM?: boolean}} [opts]
 * @returns {Promise<{anchor: string, source: string, from: 'manual'|'regex'|'llm'|'none', changed: boolean}>}
 */
export async function ensureIdentityAnchor(character, opts = {}) {
  const id = Number(character?.id);
  const stored = id ? getStoredIdentityAnchor(id) : { anchor: '', source: '' };
  if (stored.source === ANCHOR_SOURCE_MANUAL && !opts.force) {
    return { anchor: stored.anchor, source: ANCHOR_SOURCE_MANUAL, from: 'manual', changed: false };
  }

  const regex = buildIdentityAnchorFromCard(character);
  // 正则能给出身份 tag ⇒ 直接用（最稳、可预测，不受模型发挥影响）
  if (regex.tag && regex.anchor) {
    if (stored.anchor === regex.anchor && stored.source === ANCHOR_SOURCE_AUTO) {
      return { anchor: regex.anchor, source: ANCHOR_SOURCE_AUTO, from: 'regex', changed: false };
    }
    if (id) saveIdentityAnchor(id, regex.anchor, ANCHOR_SOURCE_AUTO);
    return { anchor: regex.anchor, source: ANCHOR_SOURCE_AUTO, from: 'regex', changed: true };
  }

  // 正则拿不到身份 tag：只有在允许调模型时才试 LLM 兜底
  if (opts.allowLLM) {
    const llm = await extractIdentityAnchorWithLLM(character);
    if (llm.anchor) {
      if (id) saveIdentityAnchor(id, llm.anchor, ANCHOR_SOURCE_AUTO);
      return { anchor: llm.anchor, source: ANCHOR_SOURCE_AUTO, from: 'llm', changed: true };
    }
  }

  // 只剩身体特征（原创角色常见）：也存下来，至少把身体锚住
  if (regex.anchor) {
    if (stored.anchor === regex.anchor && stored.source === ANCHOR_SOURCE_AUTO) {
      return { anchor: regex.anchor, source: ANCHOR_SOURCE_AUTO, from: 'regex', changed: false };
    }
    if (id) saveIdentityAnchor(id, regex.anchor, ANCHOR_SOURCE_AUTO);
    return { anchor: regex.anchor, source: ANCHOR_SOURCE_AUTO, from: 'regex', changed: true };
  }

  return { anchor: '', source: '', from: 'none', changed: false };
}

/**
 * 生图用：拿这个角色此刻该前置的锚点文本。
 *
 * **不写库**（生图热路径绝不落数据），优先级：库里的锚点 → 卡里现算。
 * 库里的可能来自 LLM（卡里提不到 tag 的情况），所以它优先级更高。
 */
export function getIdentityAnchorForPrompt(character) {
  const stored = String(character?.identity_anchor || '').trim();
  if (stored) return stored;
  const id = Number(character?.id);
  if (id) {
    const row = getStoredIdentityAnchor(id);
    if (row.anchor) return row.anchor;
    // 库里也没有：调用方有时只传了部分字段（如 schedule 的 `SELECT id, display_name`），
    // 这时按 id 补一次整卡再现算，否则会静默不锚定。
    if (!String(character?.base_prompt || '').trim()) {
      try {
        const full = getDb().prepare('SELECT id, display_name, base_prompt, short_prompt FROM characters WHERE id = ?').get(id);
        if (full) return buildIdentityAnchorFromCard(full).anchor;
      } catch { /* 查不到就当没有 */ }
    }
  }
  return buildIdentityAnchorFromCard(character).anchor;
}

const DREAM_PREFIX = 'A surreal dreamscape scene:';

/**
 * 注入：把锚点前置到生图 prompt（幂等）。
 *
 * 判定规则：
 *   · 锚点为空 ⇒ 原样返回（零影响）
 *   · prompt 里已经出现锚点的身份 tag ⇒ 不前置（避免"双份身份"以及无意义的 token 重复）
 *   · 梦境配图以固定前缀开头 ⇒ 插在前缀冒号之后，不破坏前缀约定
 */
export function applyIdentityAnchorToPrompt(prompt, anchor) {
  const text = String(prompt || '').trim();
  const anchorText = String(anchor || '').trim();
  if (!text || !anchorText) return text;

  // 身份 tag = 锚点第一个 `Name (Series)` 形态的片段
  const tagMatch = anchorText.match(/^[^,]*\([^()]*\)/);
  const tag = tagMatch ? tagMatch[0].trim() : '';
  const lowerText = text.toLowerCase();
  if (tag) {
    const bareName = tag.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (lowerText.includes(tag.toLowerCase()) || (bareName && lowerText.includes(bareName.toLowerCase()))) {
      return text;
    }
  }

  if (text.startsWith(DREAM_PREFIX)) {
    return `${DREAM_PREFIX} ${anchorText}.${text.slice(DREAM_PREFIX.length)}`;
  }
  return `${anchorText}. ${text}`;
}
