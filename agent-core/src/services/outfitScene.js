/**
 * outfitScene.js — 场景服装（裸体 / 常服 / 私服 / 居家 / 睡衣）
 *
 * ── 解决什么问题 ──
 *
 * 角色的「## 你的外观」是一套固定描述，于是不管在上班、逛街还是睡觉，生图都用同一身衣服。
 * 本模块让角色拥有**多套场景服装**，由**日程**决定此刻该穿哪套 —— 这样朋友圈配图、聊天、
 * 立绘才会「场合正确」。
 *
 * ── 与其他换装机制的关系（三条通道，互不干扰）──
 *
 *   character_outfits.scene IS NOT NULL  → 场景服装（本模块；可多套并存，按日程选一套）
 *   character_outfits.enabled = 1        → 角色专属形态（道具变身，同时只一套，有 expires_at）
 *   global_outfits  enabled = 1          → 通用限时服饰（可多套叠加）
 *
 * 注入优先级：**限时服饰/道具 > 场景服装 > 人物卡原本外观**。
 * 也就是「用户主动用了换装道具」时不该被自动的场景服装盖掉。
 *
 * ── 身体与服装分层（2026-10-13 移植 PR #24）──────────────────
 *
 * character_outfits.body 是**该角色 5 套共用的身体描述**（发色/发型/瞳色/肤色/体型/显著特征），
 * description 只存**这一套的衣服**；注入时由 composeOutfitText() 拼成自包含文本。
 * 身体只存一份 ⇒ 不会在「外观段 / work / casual」三处互相矛盾。
 *
 * ── 裸体是私密专用（PR #24 硬规则）─────────────────────────
 *
 * 只有日程**显式标注**才会用到它；兜底（没标注 / 没日程）**绝不落到裸体**，
 * 否则角色会在街上"兜底成裸体"。睡眠时段也**绝不标裸体**（睡觉一律穿睡衣）。
 */

import { getDb, getSystemRules } from '../db/index.js';
import { registerSceneOutfitProvider } from './sceneOutfitRegistry.js';
import { splitAppearanceSection } from './characterPersona.js';
import { buildSceneOutfitMessages, normalizeDesignScenes, parseSceneOutfitDesign } from './sceneOutfitPrompt.js';
import { getLocalDateKey } from '../utils/localDate.js';
import { chatSync } from './lorebook/runtime.js';
import { config } from '../config.js';

/**
 * 场景枚举。key 会落到 character_outfits.scene，改这里必须同步迁移注释。
 *
 * defaultName：界面**不再让用户填服装名**（名称对生图毫无用处，描述才是交给 ComfyUI 的东西），
 * 名称仅剩一个用途 —— 日程的 `outfit` 字段按**名称**标注「这一刻换了哪套」，
 * `getSceneOutfitForNow` 也按名称回查。所以留一组稳定的默认名，界面自动写入、用户不用管。
 */
export const OUTFIT_SCENES = [
  { key: 'nude', label: '裸体', defaultName: '裸体', desc: '不穿任何衣物。**只用于私密场景**：洗浴、泡澡，以及在自己家里/酒店客房等私密空间里的性场景。**睡眠时段不用它**（睡觉一律穿睡衣）' },
  { key: 'work', label: '常服', defaultName: '日常装', desc: '上班、出勤、执行职务时穿（角色的招牌/常态形象）' },
  { key: 'casual', label: '私服', defaultName: '便装', desc: '上街、社交、休闲外出时穿的便装' },
  { key: 'home', label: '居家', defaultName: '居家服', desc: '在家中休息、做家务时穿的宽松舒适衣物；**脚下穿室内拖鞋（slippers）或赤脚，不写户外鞋**' },
  { key: 'sleep', label: '睡衣', defaultName: '睡衣', desc: '睡觉时穿的睡衣或内衣，**赤脚、不穿鞋袜**。**睡眠时段强制使用这一套**' },
];

/**
 * 只用于私密场景的那一套（裸体）。
 * `getSceneOutfitForNow` 的兜底必须跳过它 —— 否则日程里没有 `outfit` 标注时，
 * 角色会在街上「兜底成裸体」。洗浴/私密性场景必须由日程**显式标注**才会用到。
 */
export const PRIVATE_SCENE = 'nude';

/** 场景 key → 默认服装名（界面保存时自动写入，用户看不到这个字段） */
export const DEFAULT_NAME_BY_SCENE = Object.fromEntries(OUTFIT_SCENES.map(s => [s.key, s.defaultName]));

const SCENE_KEYS = OUTFIT_SCENES.map(s => s.key);
const LABEL_BY_KEY = Object.fromEntries(OUTFIT_SCENES.map(s => [s.key, s.label]));

// ── 向 characterPersona 注册「此刻该穿哪套」──────────────────
// 注册表叶子（sceneOutfitRegistry.js）是为了打破循环：本文件 import characterPersona
// 取 splitAppearanceSection，而 characterPersona 也要在 outfits='auto' 时问本文件要场景服装
// ⇒ 两边静态互引会成环（本仓 TDZ 血泪史）。加载期注册、调用期取用，两边都不直接依赖对方。
/**
 * 基准形象固装的场景（PR#24 缺口③「sceneOutfitParam」）。
 *
 * 为什么要单独一个开关：头像 / 立绘 / 表情包是**角色的招牌形象**，必须永远是常服。
 * 而 `getSceneOutfitForNow` 按时间选 —— 半夜生成头像会得到穿睡衣的角色（实测踩过）。
 */
export const BASE_SCENE = 'work';

registerSceneOutfitProvider((characterId, opts = {}) => {
  try {
    if (opts?.scene === 'base') {
      const base = getBaseSceneOutfit(characterId);
      return base ? asPersonaOutfits(base) : null;
    }
    const now = getSceneOutfitForNow(characterId);
    return now ? asPersonaOutfits(now) : null;
  } catch {
    return null;   // 场景服装查询失败 ⇒ 零注入，绝不拖垮生图主链
  }
});

/**
 * 拼出「注入用的自包含外观文本」= 身体 + 该套服装。
 *
 * ── 为什么这样拆（2026-10-13，移植 PR #24）──────────────────
 * 原先 description 把身体和衣服混写，于是同一部位在「角色外观段 / work / casual」
 * 三处互相矛盾，且裸体场景没有身体真源。
 * 现在：`body` 一列存**该角色 5 套共用的身体描述**，`description` 只存**衣服**；
 * 注入时才拼成自包含文本 —— 身体只存一份，不会在各套之间漂移。
 *
 * `nude` 那套的 garment 为空/`no clothing`，拼出来就是纯身体描述，
 * 正好满足「洗浴/私密场景只用身体」。
 */
export function composeOutfitText(body, garment) {
  const b = String(body || '').trim().replace(/[,\s]+$/, '');
  const g = String(garment || '').trim().replace(/[,\s]+$/, '');
  if (b && g) return `${b}, ${g}`;
  return b || g;
}

// ── 出口层脚部口径兜底（移植 PR#24 `outfitScene.js:144-218`，逐字保留行为）──────
// 2026-10-20：提示词已经写了「居家=室内拖鞋/睡衣=赤脚」，但模型仍会随机发挥
// （PR#24 实测存量 15 套居家里 2 套裸脚、3 套自相矛盾，如「barefoot + 拖鞋」）。
// 所以写库前与读取时都过一遍这个函数 —— 提示词负责"大概率对"，这里负责"必然对"。
const FOOT_RE = /slipper|shoe|sneaker|boot|heel|sandal|loafer|sock|stocking|pantyhose|tights|barefoot|bare\s+feet|bare\s+foot|bare\s+ankle|ankle\s+warm|拖鞋|室内鞋|棉拖|袜子|长袜|赤脚|光脚|赤足|光着脚/i;
const SLIPPER_RE = /slipper|拖鞋|室内鞋|棉拖/i;
// 「裸脚踝/脚链」这类**不是鞋**的脚部描述 —— 居家场景下与拖鞋并不冲突（拖鞋本来就露脚踝）
const ANKLE_KEEP_RE = /bare\s+ankle|anklet|脚链/i;

/**
 * 强制「居家＝拖鞋、睡衣＝赤脚」这一对相反的脚部口径。
 *
 * 两条纪律（踩过坑）：
 *   ① 不能只删关键词 —— 会留下悬空片段（"covered in fuzzy slippers and ankle socks" 删词后只剩 "covered in"）；
 *   ② 不能把拖鞋挪到末尾重排 —— 会打乱原描述结构，读起来像换了个人。
 * 所以按逗号分段后**原位**替换/删除。
 *
 * @param {string} scene
 * @param {string} description
 * @returns {string} 处理后的描述（空值原样返回，不凭空造鞋）
 */
export function enforceSceneFootwear(scene, description) {
  if (description == null || description === '') return description;
  const d = String(description);
  if (scene !== 'home' && scene !== 'sleep') return d;

  const segs = d.split(/[,，]/).map(s => s.trim()).filter(Boolean);

  const cleaned = (arr) => {
    // 相邻重复段合并（如 "indoor slippers, indoor slippers" → 一个），再清标点
    const dedup = [];
    for (const s of arr) {
      const last = dedup[dedup.length - 1];
      if (last && last.toLowerCase() === s.toLowerCase() && SLIPPER_RE.test(s)) continue;
      dedup.push(s);
    }
    return dedup.join(', ').replace(/,\s*,/g, ',').replace(/[,\s]+$/, '').trim();
  };

  if (scene === 'home') {
    // 居家：把「赤脚/袜子」段原位换成拖鞋；已有拖鞋段原样保留；裸脚踝段保留原位。
    // ★ 全文已有拖鞋时不再替换（只把赤脚/袜子段删掉），否则会出现重复的 slippers 段。
    const hasSlipperAnywhere = segs.some(s => SLIPPER_RE.test(s));
    const out = [];
    for (const s of segs) {
      if (!FOOT_RE.test(s)) { out.push(s); continue; }
      if (SLIPPER_RE.test(s)) { out.push(s); continue; }
      if (ANKLE_KEEP_RE.test(s)) { out.push(s); continue; }
      if (!hasSlipperAnywhere) out.push('indoor slippers');
    }
    if (!out.some(s => SLIPPER_RE.test(s))) out.push('indoor slippers');
    return cleaned(out);
  }

  // 睡衣：原位删除所有脚部段（画面里不出现任何鞋袜，含裸脚踝/脚套），末尾补 barefoot
  const out = segs.filter(s => !FOOT_RE.test(s));
  return `${cleaned(out)}, barefoot`.replace(/^,\s*/, '').trim();
}

/** 该角色的全部场景服装（按场景顺序，便于界面展示与匹配） */
export function listSceneOutfits(characterId) {
  if (!characterId) return [];
  const rows = getDb().prepare(
    `SELECT id, name, description, scene, body FROM character_outfits
     WHERE character_id = ? AND scene IS NOT NULL AND scene != ''
     ORDER BY CASE scene WHEN 'nude' THEN 0 WHEN 'work' THEN 1 WHEN 'casual' THEN 2 WHEN 'home' THEN 3 WHEN 'sleep' THEN 4 ELSE 9 END, id ASC`
  ).all(characterId);
  return rows.map(r => ({
    ...r,
    // 出口层兜底：存量数据里居家裸脚/睡衣穿鞋的脏值，读出来就修好（不改库，避免迁移脚本）
    description: enforceSceneFootwear(r.scene, r.description),
    sceneLabel: LABEL_BY_KEY[r.scene] || r.scene,
    // 注入用文本（自包含：身体 + 服装）
    text: composeOutfitText(r.body, enforceSceneFootwear(r.scene, r.description)),
  }));
}

/**
 * 写角色的「身体描述」，**同步到该角色全部服装行**。
 *
 * 这是"单一真源"的落点：界面只让用户编辑一个身体字段，保存时写进每一行，
 * 既避免重复维护，也保证 5 套之间不会漂移。
 */
export function setCharacterBody(characterId, body) {
  const clean = String(body || '').trim().slice(0, 2000);
  const r = getDb().prepare('UPDATE character_outfits SET body = ? WHERE character_id = ?')
    .run(clean, characterId);
  return { ok: true, updated: r.changes };
}

/** 批量写入场景服装（供「一键生成」用）。同名同场景则更新描述，避免重复堆叠 */
export function upsertSceneOutfits(characterId, outfits) {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?, ?, ?, ?, ?)`
  );
  const upd = db.prepare(
    `UPDATE character_outfits SET name = ?, description = ?, body = COALESCE(?, body) WHERE id = ?`
  );
  const find = db.prepare(
    `SELECT id FROM character_outfits WHERE character_id = ? AND scene = ? LIMIT 1`
  );
  let added = 0, updated = 0;
  const tx = db.transaction(() => {
    for (const o of outfits) {
      // `nude` 那套允许 description 为空（纯身体），所以这里只卡 scene/name
      if (!o?.scene || !SCENE_KEYS.includes(o.scene) || !o.name) continue;
      const body = o.body != null ? String(o.body).trim().slice(0, 2000) : null;
      // 写库前过一遍脚部口径：居家→拖鞋、睡衣→赤脚（见 enforceSceneFootwear 注释）
      const desc = enforceSceneFootwear(o.scene, String(o.description || '').trim()).slice(0, 1200);
      const exist = find.get(characterId, o.scene);
      if (exist) { upd.run(o.name, desc, body, exist.id); updated++; }
      else { ins.run(characterId, o.name, desc, o.scene, body || ''); added++; }
    }
  });
  tx();
  return { added, updated };
}

// ── LLM 生成基础场景服装 ──────────────────────────────────

/** 截取角色人格 prompt：从开头到 "##你的外观" 之前 */
function cropPersona(basePrompt) {
  const split = splitAppearanceSection(String(basePrompt || ''));
  return split.before.trim();
}

/** 仅设计几套换装；默认外观只作为基准，不进入返回值与保存流程。 */
export async function generateSceneOutfits(character, opts = {}) {
  const displayName = character?.display_name || '角色';
  const persona = cropPersona(character?.base_prompt);
  if (!persona) throw new Error('角色人格为空，无法生成外观');

  // ── 反推锚点（2026-10-13 移植 PR #24：替代固定「按工装推其余三套」）──
  const seeds = (Array.isArray(opts.seeds) ? opts.seeds : [])
    .filter(s => SCENE_KEYS.includes(s?.scene) && (s.body || s.description))
    .map(s => ({
      scene: s.scene,
      name: String(s.name || '').trim(),
      body: String(s.body || '').trim(),
      description: String(s.description || '').trim(),
    }));
  const seedScenes = new Set(seeds.map(s => s.scene));

  // 未指定就补「所有还没有的」
  const wanted = Array.isArray(opts.scenes) ? opts.scenes.filter(s => SCENE_KEYS.includes(s)) : [];
  const targetScenes = (wanted.length ? wanted : SCENE_KEYS).filter(s => !seedScenes.has(s));
  if (!targetScenes.length) return [];

  const baseAppearance = String(opts.baseAppearance || '').trim();

  /**
   * 身体真源的选择（决定整组的一致性）：
   *   ① 锚点里有 nude → 用它（纯身体，最干净）
   *   ② 否则锚点里的 work/casual → 用其 body（这两套区分度最大、信息最全）
   *   ③ 都没有 → 用角色卡外观段（首次生成走这条）
   * 刻意**不用 sleep 当锚** —— 它的 description 常常极短（如"一件宽松的白T恤"），信息量不够。
   */
  const pickBody = () => {
    const byScene = new Map(seeds.map(s => [s.scene, s]));
    for (const k of [PRIVATE_SCENE, 'work', 'casual']) {
      const b = byScene.get(k)?.body;
      if (b) return b;
    }
    return seeds.find(s => s.body)?.body || baseAppearance || '';
  };
  const bodySource = pickBody();

  const msgs = buildSceneOutfitMessages({
    systemRules: getSystemRules({ roleplay: false }),
    persona,
    shortPrompt: character?.short_prompt,
    displayName,
    baseAppearance,
    scenes: targetScenes,
    seeds,
    bodySource,
  });

  const raw = await chatSync(msgs, {
    model: config.llm.model || 'deepseek-chat', temperature: 0.8, response_format: { type: 'json_object' }, label: '场景服装生成',
  });
  return parseSceneOutfitDesign(raw, targetScenes, { bodySource });
}
// ── 按日程决定此刻的服装 ──────────────────────────────────

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 当前分钟数（本地时间） */
function nowMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 取今日日程的活动数组（没生成/解析失败返回 []） */
function todayActivities(characterId, date = new Date()) {
  try {
    const row = getDb().prepare(
      'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
    ).get(characterId, getLocalDateKey(date));
    if (!row) return [];
    const parsed = JSON.parse(row.schedule_json);
    const arr = Array.isArray(parsed) ? parsed : (parsed?.activities || []);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 找当前所处的时段下标。
 * 日程要求「上一个 endTime === 下一个 startTime」且覆盖完整 24 小时，所以必有命中；
 * 仍做兜底（取最后一段）以防数据异常。
 */
function findCurrentIndex(activities, minutes) {
  for (let i = 0; i < activities.length; i++) {
    const start = toMinutes(activities[i].startTime);
    let end = toMinutes(activities[i].endTime);
    if (end <= start) end += 24 * 60;                    // 跨午夜
    const cur = minutes < start ? minutes + 24 * 60 : minutes;
    if (cur >= start && cur < end) return i;
  }
  return activities.length - 1;
}

/**
 * 基准形象固装：生成**头像 / 立绘 / 表情包**时固定用常服那一套，
 * 忽略当前时间、忽略日程标注（半夜也不例外）。
 *
 * 回退链：work → casual → 第一套非 nude（都没有就 null，让调用方零注入）。
 * @param {number} characterId
 * @returns {object|null} `{ outfit, scene, source: 'base' }`
 */
export function getBaseSceneOutfit(characterId) {
  const outfits = listSceneOutfits(characterId);
  if (!outfits.length) return null;
  const pick = outfits.find(o => o.scene === BASE_SCENE)
    || outfits.find(o => o.scene === 'casual')
    || outfits.find(o => o.scene !== PRIVATE_SCENE && o.scene !== 'sleep')
    || null;
  return pick ? { outfit: pick, scene: pick.scene, source: 'base' } : null;
}

/**
 * 此刻该穿哪套场景服装。
 *
 * 判定顺序：
 *  1. 角色没有场景服装 → null（调用方回落原外观）
 *  2. 当前时段是睡眠（replyDelay=-1）→ **强制** sleep 那套（硬规则，优先于任何标注）
 *  3. 否则从当前时段**向前回溯**，找最近一个有 outfit 标注的时段 → 按名字匹配
 *     （日程只在「换装的那一刻」标注 outfit，其余留空，这样换装次数天然被限制）
 *  4. 都没匹配上 → 回到该角色的第一套**日常**服装（兜底，避免没衣服穿）
 *
 * ⚠ **兜底绝不能落到 `nude`** —— 那是"只用于私密场景"的一套，
 *   若成了兜底，日程里没写 outfit 的角色会在大街上裸体。见 PRIVATE_SCENE。
 *
 * @returns {{outfit: object, scene: string, source: string}|null}
 *          source 便于排查：'sleep' | 'schedule' | 'fallback'
 */
export function getSceneOutfitForNow(characterId, date = new Date()) {
  const outfits = listSceneOutfits(characterId);
  if (!outfits.length) return null;

  const sleepOutfit = outfits.find(o => o.scene === 'sleep') || null;
  // 「白天可兜底」的服装：排除睡眠、也排除私密裸体
  const dayOutfits = outfits.filter(o => o.scene !== 'sleep' && o.scene !== PRIVATE_SCENE);
  const byName = new Map(outfits.map(o => [o.name, o]));
  const byId = new Map(outfits.map(o => [String(o.id), o]));

  const acts = todayActivities(characterId, date);
  if (!acts.length) {
    // 没有日程：用第一套白天服装兜底（实在没有才退睡衣；**绝不用裸体**）
    const fallback = dayOutfits[0] || sleepOutfit;
    return fallback ? { outfit: fallback, scene: fallback.scene, source: 'fallback' } : null;
  }

  const idx = findCurrentIndex(acts, nowMinutes(date));
  const cur = acts[idx] || {};

  // ② 睡眠：硬规则，优先于任何标注（**包括日程显式标的 nude** —— 睡觉一律穿睡衣）
  if (Number(cur.replyDelay) === -1 && sleepOutfit) {
    return { outfit: sleepOutfit, scene: 'sleep', source: 'sleep' };
  }

  // ③ 向前回溯最近的换装点（含当前段）；上限防止绕一圈
  for (let step = 0; step < acts.length; step++) {
    const i = (idx - step + acts.length) % acts.length;
    const o = acts[i]?.outfit;
    if (!o) continue;
    const text = String(o).trim();
    if (!text) continue;
    const hit = byName.get(text) || byId.get(text);
    if (hit) return { outfit: hit, scene: hit.scene, source: 'schedule' };
    // 标注了但匹配不到（LLM 编了个名字）→ 继续往前找，别停在一个无效值上
  }

  // ④ 兜底（同样排除 nude）
  const fallback = dayOutfits[0] || sleepOutfit;
  return fallback ? { outfit: fallback, scene: fallback.scene, source: 'fallback' } : null;
}

/** 把当前场景服装包成 characterPersona 认的 outfits 结构（走 limited 通道） */
export function asPersonaOutfits(sceneOutfit) {
  if (!sceneOutfit?.outfit) return null;
  const o = sceneOutfit.outfit;
  // ⚠ 注入的是**组合后**的文本（身体 + 服装）—— `o.description` 现在只存衣服，
  //   直接用它会丢掉身体特征。listSceneOutfits 已算好 `text`；这里的对象可能来自别处，故兜底现算。
  const text = o.text || composeOutfitText(o.body, o.description);
  return { limited: [{ name: o.name, description: text }], exclusive: null };
}

// ── 日程生成时的服装标注层 ──────────────────────────────────

/**
 * 为日程生成拼一段「服装标注」提示词。
 * 只有角色配了场景服装时才调用；没配的角色日程生成保持原样（零影响）。
 *
 * 2026-10-13 移植 PR #24 的换装标注修复：旧口径写「最多 4 次」上限，
 * LLM 用完额度就漏掉「出门/回家」那一次 ⇒ 角色穿着居家服在街上活动。
 * 新口径：**4 个必换时点一个都不能漏** + 写完逐时段自检 + 去掉次数上限。
 * @returns {string|null}
 */
export function buildOutfitAnnotateLayer(characterId) {
  const outfits = listSceneOutfits(characterId);
  if (outfits.length < 2) return null;   // 只有一套就没什么可分配的

  // 清单里给的是「组合后的自包含文本」—— 模型要照着这个判断"哪一套像什么场合"，
  // 也给模型一个身体描述可抄（反推时照抄这一份，五套才一致）
  const list = outfits.map(o =>
    `- "${o.name}"（${LABEL_BY_KEY[o.scene] || o.scene}）：${(o.text || composeOutfitText(o.body, o.description)).slice(0, 90)}`
  ).join('\n');
  const hasSleep = outfits.some(o => o.scene === 'sleep');
  const sleepName = outfits.find(o => o.scene === 'sleep')?.name;
  const nudeName = outfits.find(o => o.scene === PRIVATE_SCENE)?.name;
  const workName = outfits.find(o => o.scene === 'work')?.name;
  const casualName = outfits.find(o => o.scene === 'casual')?.name;
  const homeName = outfits.find(o => o.scene === 'home')?.name;
  // 「白天的服装」要排除睡眠与裸体 —— 把裸体列进这里等于教模型"白天可以光着"
  const dayNames = outfits.filter(o => o.scene !== 'sleep' && o.scene !== PRIVATE_SCENE)
    .map(o => `"${o.name}"`).join(' / ') || '（无）';

  // 示例用角色真实拥有的服装名，避免出现"示例里写了 A、可选清单里没有 A"的自相矛盾
  const exOut = workName || casualName || outfits[0].name;
  const exHome = homeName || outfits[0].name;

  // 裸体那一段只在角色真的配了「裸体」时才讲 —— 没配的角色别被提示词带偏
  const nudeBlock = nudeName ? `

### 二点五、「裸体」什么时候才用（严格）
"${nudeName}"**只用于私密场景**，一天里通常只有 1~2 段：
- **洗浴类**：洗澡、泡澡、冲凉、泡温泉。
- **私密性场景**：在自己家里、酒店客房这类**私密空间**里做爱。

判定要点：
- **地点必须在私密空间**（自己家 / 酒店客房 / 浴室）。在**外面**（街上、酒馆、车站、广场、
  公园、河岸）做爱**不标裸体** —— 那种场合角色仍穿着衣服或不整，标对应的外出服。
- **睡眠时段绝不标裸体**（睡觉一律穿"${sleepName || '睡衣'}"，硬规则，哪怕裸睡）。
- 洗完澡接着过日常时，别忘了**从浴室出来那一段重新标上衣服**（居家或外出）。
- 用不到就完全不出现这个值 —— 不要为了"丰富"而给角色安排裸体时段。` : '';

  return `## 着装标注（额外要求）
这个角色在一天中会换衣服。可选服装如下：
${list}

请在生成日程时，为**每个时段**额外输出一个字段 \`outfit\`：
- 值为上面某套服装的**名称**（原样照抄，不要改写）。
- **只在「换装的那一刻」填写**，其余时段填 \`null\`（表示沿用上一段的穿着）。

### 一、先给每个时段判断「在自己住所内 / 在住所外」
- **住所内**＝这个角色自己的住处（卧室、浴室、客厅、厨房等）。
- **住所外**＝其余一切地方：街道、商店、胡同、车站、广场、公园、河岸、酒馆、学校、公司，
  以及**别人家**（哪怕在室内，也不是"在家"）。

### 二、以下 4 个时点**必须**标 outfit，一个都不能漏
1. **入睡** → 标"${sleepName || '睡衣'}"（睡眠时段的 outfit 必须是它）。
2. **睡醒起床** → 标一套白天的衣服。
3. **从住所出门**（去任何"住所外"的地方）→ 标一套**外出**的（常服或私服）。
4. **从外面回到住所** → 标"${exHome}"。${nudeBlock}

### 三、写完自检（逐时段过，发现矛盾就补标）
- 某个"住所外"的时段，穿的却是**居家服或睡衣** → ✗ 错。在这一段补标一套外出服。
  （唯一例外：明确写的是家门口的短暂活动，如"下楼取快递""楼下便利店"，可沿用。）
- 某个"住所内"的时段，穿的却是外出服 → ✗ 错。在这一段补标居家服。
- \`outfit\` 非 null 的时段**通常是 4~6 个**；一天里出门几次、回家几次，就要标几次。
  **不要为了凑少数几次，把"出门"或"回家"漏掉** —— 漏掉的后果是角色会穿着睡衣/居家服在街上活动。
- 反过来也别无理由频繁换装（同一地点、同一活动内不要反复换）。

- 可用作白天的服装：${dayNames}。

示例（仅示意 outfit 字段的密度与位置，实际按角色真实日程；注意"出门"与"回家"两处都有标注）：
{"startTime":"07:00","endTime":"07:30","activity":"晨间梳洗","location":"公寓浴室","replyDelay":0,"tags":["日常"],"description":"……","outfit":"${exHome}"}
{"startTime":"08:00","endTime":"12:00","activity":"上班","location":"公司","replyDelay":0,"tags":["工作"],"description":"……","outfit":"${exOut}"}
{"startTime":"12:00","endTime":"13:00","activity":"午休回公寓","location":"公寓客厅","replyDelay":0,"tags":["日常"],"description":"……","outfit":"${exHome}"}
{"startTime":"13:00","endTime":"18:00","activity":"继续上班","location":"公司","replyDelay":0,"tags":["工作"],"description":"……","outfit":"${exOut}"}
{"startTime":"19:00","endTime":"22:00","activity":"在家做饭休息","location":"公寓客厅","replyDelay":0,"tags":["日常"],"description":"……","outfit":"${exHome}"}
{"startTime":"22:00","endTime":"07:00","activity":"就寝","location":"公寓卧室","replyDelay":-1,"tags":["睡眠"],"description":"……","outfit":${hasSleep ? `"${sleepName}"` : 'null'}}`;
}

// ── 生成后校验 + 一次专注修复 ────────────────────────────────

/**
 * 校验日程的 outfit 标注，不达标就用一次**只做标注**的专注调用补回来。
 *
 * ── 为什么需要这道兜底（PR #24 实测）────────────────────────
 * 提示词已明确要求「出门/回家必须标」，但 LLM 有波动：同一角色连跑两次，
 * 一次给了 6 个换装点（含「换装出门」「回家换装」），另一次只有 3 个
 * —— 漏掉出门那一次，角色就会**穿着居家服/睡衣在街上活动**。
 * 只靠提示词压不住，所以加一道确定性的「生成 → 校验 → 修复」。
 *
 * 修复之所以有效：让模型**只干一件事**（对着已有日程填 outfit）比它同时
 * 编日程又填标注要可靠得多，且这份 prompt 极小、很快。
 *
 * @param {Array} schedule 已解析通过的日程数组（不改原数组）
 * @param {number} characterId
 * @param {(msgs, opts) => Promise<string>} [chat] 可注入的 LLM 调用（单测传假函数；缺省 chatSync）
 * @returns {Promise<{schedule: Array, repaired: boolean, reason: string}>}
 */
export async function ensureOutfitAnnotations(schedule, characterId, chat = chatSync) {
  const outfits = listSceneOutfits(characterId);
  if (outfits.length < 2 || !Array.isArray(schedule) || !schedule.length) {
    return { schedule, repaired: false, reason: 'no-outfits' };
  }
  const valid = new Set(outfits.map(o => o.name));

  // ── 校验 ──
  const marked = schedule.filter(a => a?.outfit).length;
  const illegal = schedule.filter(a => a?.outfit && !valid.has(String(a.outfit).trim()));

  /**
   * 阈值取「固定 4」而不是按地点切换次数推算。
   *
   * 曾试过 `transitions - 1`（地点段变了就大概要换装），但那个估算**过于激进**：
   * 「公寓卧室 → 公寓浴室」这种同住处的移动也会被算成一次切换，于是几乎每次都触发修复
   * —— 等于每次生成日程都白跑一次 LLM 调用（实测 3 轮全部触发）。
   *
   * 一天正常至少需要 4 个换装点（入睡 / 起床 / 出门 / 回家）；低于 4 才可疑。
   * 用户报的那个 case 正是 3 个 —— 能被抓住。而 6~9 个的正常日程不会再被误触发。
   */
  const floor = 4;

  const needsRepair = illegal.length > 0 || marked < floor;
  if (!needsRepair) return { schedule, repaired: false, reason: 'ok' };

  const reason = illegal.length
    ? `非法服装名 ${illegal.length} 处`
    : `换装点偏少（${marked} < ${floor}）`;
  console.log(`[outfitScene] 标注不合格（${reason}），发起一次专注修复`);

  // ── 修复：只输出与日程等长的 outfit 数组 ──
  const list = outfits.map(o => `- "${o.name}"（${LABEL_BY_KEY[o.scene] || o.scene}）`).join('\n');
  const sleepName = outfits.find(o => o.scene === 'sleep')?.name;
  const homeName = outfits.find(o => o.scene === 'home')?.name;
  const exOut = outfits.find(o => o.scene === 'work')?.name
    || outfits.find(o => o.scene === 'casual')?.name || outfits[0].name;
  const lines = schedule.map((a, i) =>
    `${i}. ${a.startTime}-${a.endTime}　${a.activity}　@${a.location || '（未写）'}`
    + `${Number(a.replyDelay) === -1 ? '　【睡眠】' : ''}`
  ).join('\n');

  const msgs = [
    { role: 'system', content: `你是着装校对员。下面是某角色一天的日程，请为**每个时段**判定该穿哪套衣服。

可选服装：
${list}

判定规则（逐时段过）：
1. 先判断该时段在「这个角色自己的住处内」还是「住所外」。
   住所内＝自己的卧室/浴室/客厅/厨房；住所外＝其余一切地方（街道、商店、车站、广场、公园、
   河岸、酒馆、学校、公司，以及**别人家**）。
2. 睡眠时段（标了【睡眠】的）→ 必须穿${sleepName ? ` "${sleepName}"` : '睡衣'}。
3. **住所外**的时段 → 必须穿外出服（常服或私服），**绝不能是居家服或睡衣**。
4. 回到自己住处 → 穿${homeName ? ` "${homeName}"` : '居家服'}。
5. **只在穿着发生变化的那一段**给出名字，没变化就填 null（表示沿用上一段）。
   出门、回家都是变化，都要给。

⚠ 只输出 JSON，格式严格如下（数组长度必须等于 ${schedule.length}，第 i 项对应上面第 i 条）：
{"outfits": ["${exOut}", null, "..."]}
不要输出任何解释或 JSON 以外的文字。` },
    { role: 'user', content: lines },
  ];

  let fixed = null;
  try {
    const raw = await chat(msgs, {
      temperature: 0.2, max_tokens: 900,
      response_format: { type: 'json_object' }, label: 'schedule-gen:着装校对',
    });
    const parsed = JSON.parse(String(raw || '')
      .replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
    const arr = Array.isArray(parsed?.outfits) ? parsed.outfits : null;
    // 只接受「长度对齐 + 名字全合法」的结果 —— 宁可保留原样，也不拿脏数据覆盖
    if (arr && arr.length === schedule.length
      && arr.every(v => v == null || valid.has(String(v).trim()))) {
      fixed = arr;
    } else {
      console.warn('[outfitScene] 修复结果不合格，保留原标注',
        arr ? `（长度 ${arr.length}≠${schedule.length}）` : '（无数组）');
    }
  } catch (err) {
    console.warn('[outfitScene] 修复调用失败，保留原标注:', err.message);
  }

  if (!fixed) return { schedule, repaired: false, reason: 'repair-failed' };

  const next = schedule.map((a, i) => ({ ...a, outfit: fixed[i] ? String(fixed[i]).trim() : null }));
  const newMarks = next.filter(a => a.outfit).length;
  console.log(`[outfitScene] 标注已修复：${marked} → ${newMarks} 个换装点`);
  return { schedule: next, repaired: true, reason };
}

/**
 * 老数据回填：把「4 态老数据」（description 里身体和衣服混写）拆成 body + 纯衣服。
 *
 * ── 什么时候跑 ──
 * 只在**角色详情页保存**时对该角色跑一次（幂等：已有 body 就跳过）。
 * 刻意不放进启动迁移：那会每次启动都读全部角色。
 *
 * 锚点优先级（PR #24 口径）：nude → work/casual → 角色卡外观段。
 * @returns {{updated: number, source: string}}
 */
export function backfillBodyFromExisting(characterId, { baseAppearance = '' } = {}) {
  const rows = getDb().prepare(
    'SELECT id, scene, description, body FROM character_outfits WHERE character_id = ? AND scene IS NOT NULL AND scene != ?',
  ).all(characterId, '');
  if (!rows.length) return { updated: 0, source: 'none' };

  // 已有任一行的 body 非空 ⇒ 已回填过
  if (rows.some(r => String(r.body || '').trim())) return { updated: 0, source: 'already' };

  const byScene = new Map(rows.map(r => [r.scene, r]));
  // 锚点：nude 最纯（只有身体）；其次 work/casual；最后角色卡外观段
  let source = 'none';
  let body = '';
  for (const k of [PRIVATE_SCENE, 'work', 'casual']) {
    const d = String(byScene.get(k)?.description || '').trim();
    if (d) { body = d; source = k; break; }
  }
  if (!body && String(baseAppearance || '').trim()) { body = String(baseAppearance).trim(); source = 'card'; }
  if (!body) return { updated: 0, source: 'none' };

  const r = getDb().prepare('UPDATE character_outfits SET body = ? WHERE character_id = ? AND scene IS NOT NULL')
    .run(body, characterId);
  return { updated: r.changes, source };
}
