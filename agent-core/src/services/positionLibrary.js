/**
 * positionLibrary.js — 84 条体位的**规范化词表**（PR#24 融合方案 §2/§3 的本地落点）
 *
 * 数据源：`src/data/sexPositions.js`（由 PR#24 自动生成，含 84 条：中文定格、英文核心标签、
 * 男/女方标签、画幅、负向标签、英文提示词模板）。那份文件只读，不要手改。
 *
 * 本模块只做**规范化与分类**，不碰 DB、不发请求：
 *   · key   = `pr24.<no>.<ascii>` —— 与本地既有 17 条 `PREFERRED_POSITION_KEYS`（英文打包串）
 *             天然不冲突；PR#24 约束：知识库 id 前缀固定 `pose.pr24.*`
 *   · actKey = 行为分类（vaginal / anal / oral / paizuri / handjob / fingering / tribadism / other）
 *   · penetrative = 是否插入式（玩法门控要用；判错会让用户点不动，所以只认明确插入词）
 *
 * 与 `intimateActionService.PREFERRED_POSITION_KEYS` 的关系：那 17 条是**面板精选**，
 * 本表是**全量词库**。两者并行存在，精选表不动（PR#24 硬约束）。
 */

import { SEX_POSITIONS } from '../data/sexPositions.js';
import { SEX_POSITIONS_EXTRA } from '../data/sexPositionsExtra.js';

/** 明确「插进去」的标签词（宁可多认：这是玩法门控） */
const PENETRATIVE_TAGS = [
  'vaginal', 'anal', 'penetration', 'insertion', 'sex', 'doggystyle', 'missionary',
  'cowgirl', 'straddle', 'mating press', 'prone bone', 'standing sex', 'full nelson',
  'spitroast', 'piledriver', 'penis', 'cock', '中出', '抽送', '插入',
];

/** 行为分类：**顺序敏感**（anal 要先于 vaginal 判，否则 anal sex 会被算成 vaginal） */
const ACT_RULES = [
  { actKey: 'anal', re: /\banal\b|anus|后庭|肛/i },
  { actKey: 'oral', re: /blowjob|fellatio|deepthroat|cunnilingus|oral|口交|舔/i },
  { actKey: 'paizuri', re: /paizuri|titjob|breast sex|乳交/i },
  { actKey: 'handjob', re: /handjob|fingering|指交|手交/i },
  { actKey: 'tribadism', re: /tribadism|scissoring|磨/i },
  { actKey: 'vaginal', re: /vaginal|vagina|sex from behind|插入|性交/i },
];

/**
 * key 的可读尾段：用**行为分类**而不是 core 首标签。
 * core 常以 `2girls` / `1girl` 开头，直接拿它做尾段会出现大量重复（002/003/004 全叫 `2girls`），
 * 而 `pr24.<no>` 已保证唯一性，尾段只承担可读性。
 */
function slugOf(pos, actKey) {
  return actKey === 'other' ? 'pose' : actKey;
}

function pickActKey(pos) {
  const hay = [...(pos.core || []), ...(pos.male || []), ...(pos.female || []), pos.name || ''].join(' | ');
  for (const rule of ACT_RULES) if (rule.re.test(hay)) return rule.actKey;
  return 'other';
}

/**
 * 是否插入式。
 *
 * ⚠ 只看**标签**（core / male / female），不看 `prompt`：84 条里有 60 多条 prompt 会提到
 * penis（哪怕是乳交/足交），用 prompt 判会把非插入全判成插入（实测 78/84，明显错）。
 * 另外 paizuri / handjob / tribadism 这三类**天生非插入**，除非标签里明确写了 vaginal/anal。
 */
function isPenetrative(pos, actKey) {
  const tags = [...(pos.core || []), ...(pos.male || []), ...(pos.female || [])].join(' | ').toLowerCase();
  const explicit = /vaginal|anal\b|penetration|insertion/.test(tags);
  if (['paizuri', 'handjob', 'tribadism'].includes(actKey) && !explicit) return false;
  if (explicit) return true;
  return PENETRATIVE_TAGS.some(t => tags.includes(t.toLowerCase()));
}

/**
 * 规范化后的全量体位表（84 条，顺序与源文件一致）。
 * @type {ReadonlyArray<{key:string,no:string,name:string,limit:string,limitOn:string,
 *   actKey:string,penetrative:boolean,knowledgeId:string,core:string[],male:string[],
 *   female:string[],frames:string[],negative:string[],prompt:string,frozen:string,conflicts:string,
 *   girls?:number,boys?:number,solo?:boolean}>}
 */
/** 图库补全的体位：编号加 `g` 前缀，避免与现有三位数字编号撞 key（`pr24.gP001.xxx`） */
const GALLERY_POSITIONS = SEX_POSITIONS_EXTRA.map(pos => ({ ...pos, no: `g${pos.no}` }));

export const POSITIONS = Object.freeze([...SEX_POSITIONS, ...GALLERY_POSITIONS].map(pos => {
  const actKey = pickActKey(pos);
  const key = `pr24.${pos.no}.${slugOf(pos, actKey)}`;
  return Object.freeze({
    key,
    no: String(pos.no),
    name: String(pos.name || ''),
    limit: String(pos.limit || ''),
    limitOn: String(pos.limitOn || ''),
    actKey,
    penetrative: isPenetrative(pos, actKey),
    /** 知识库 id（PR#24 硬约束：前缀固定 pose.pr24.） */
    knowledgeId: `pose.${key}`,
    core: Object.freeze([...(pos.core || [])]),
    male: Object.freeze([...(pos.male || [])]),
    female: Object.freeze([...(pos.female || [])]),
    frames: Object.freeze([...(pos.frames || [])]),
    negative: Object.freeze([...(pos.negative || [])]),
    prompt: String(pos.prompt || ''),
    frozen: String(pos.frozen || ''),
    conflicts: String(pos.conflicts || ''),
    girls: pos.girls ?? null,
    boys: pos.boys ?? null,
    solo: pos.solo === true,
  });
}));

const BY_KEY = new Map(POSITIONS.map(p => [p.key, p]));
const BY_NO = new Map(POSITIONS.map(p => [p.no, p]));

/** 全量体位（供面板/词表枚举） */
export function listPositions() {
  return POSITIONS;
}

/** 按 key 取（`pr24.002.stacked...`） */
export function getPosition(key) {
  return BY_KEY.get(String(key || '')) || null;
}

/** 按编号取（`002`） */
export function getPositionByNo(no) {
  return BY_NO.get(String(no || '')) || null;
}

/** 中文名/编号/标签 → key（宽松匹配，用于把 LLM 或用户输入归一到词表） */
export function resolvePositionKey(tag) {
  const s = String(tag || '').trim();
  if (!s) return null;
  if (BY_KEY.has(s)) return s;
  const byNo = BY_NO.get(s);
  if (byNo) return byNo.key;
  const hit = POSITIONS.find(p => p.name && (p.name === s || s.includes(p.name) || p.name.includes(s)));
  return hit ? hit.key : null;
}

/**
 * 行为分类视图：actKey → 该类的全部体位。
 * 与 `TOUCH_ACTIONS` 平行（那是"触摸动作"，这是"体位动作"），互不覆盖。
 */
export const POSITION_ACTIONS = Object.freeze(
  POSITIONS.reduce((acc, p) => {
    (acc[p.actKey] ||= []).push(p.key);
    return acc;
  }, {}),
);

/** 统计（测试与体检用） */
export function positionStats() {
  const byAct = {};
  let penetrative = 0;
  for (const p of POSITIONS) {
    byAct[p.actKey] = (byAct[p.actKey] || 0) + 1;
    if (p.penetrative) penetrative += 1;
  }
  return { total: POSITIONS.length, penetrative, byAct };
}

// ── 姿势形态大类（面板"选大类 → 让她在这类里挑"用）─────────────────────────
/**
 * 按**身体形态**分组（不是按行为）。用户在第一层看到的是「怎么摆」，
 * 点进去再让她挑具体体位 —— 84 条平铺太长，先分大类才好选。
 * 顺序敏感：骑乘要先于后入判（cowgirl 常带 doggystyle 标签），站立要先于仰卧判。
 */
const POSTURE_RULES = [
  // ⚠ 顺序是从「特征最具体」到「最宽泛」：cowgirl 常同时带 doggystyle/standing 标签，
  //   站立放前面会把一大半姿势都吞成"站立"（实测 37/84 全归站立，骑乘只剩 2 条）。
  { key: 'riding', label: '骑乘', re: /cowgirl|straddle|riding|reverse cowgirl/i },
  { key: 'paizuri', label: '乳交', re: /paizuri|titjob|breast sex/i },
  { key: 'oral', label: '口部', re: /blowjob|fellatio|deepthroat|cunnilingus|69|oral/i },
  { key: 'hand', label: '手交', re: /handjob|fingering/i },
  { key: 'frombehind', label: '后入', re: /doggystyle|from behind|on all fours|prone bone|spitroast/i },
  { key: 'onstomach', label: '俯卧', re: /on stomach|prone|face down/i },
  { key: 'onback', label: '仰躺', re: /on back|missionary|mating press|piledriver|legs up|full nelson/i },
  { key: 'kneeling', label: '跪姿', re: /kneel|seiza/i },
  { key: 'sitting', label: '坐位', re: /sitting|seated|chair|lap/i },
  { key: 'standing', label: '站立', re: /standing|against the wall|carried/i },
];

/** 大类清单（顺序即面板展示顺序） */
export const POSTURE_GROUPS = [
  ...POSTURE_RULES.map(r => ({ key: r.key, label: r.label })),
  { key: 'other', label: '其他' },
];

/** 按一段文本（打包 tag / 中文名）判形态大类；精选 17 条用的是打包 tag，走这条 */
export function postureOfText(text) {
  const hay = String(text || '');
  if (!hay) return 'other';
  for (const rule of POSTURE_RULES) if (rule.re.test(hay)) return rule.key;
  return 'other';
}

/** 一条体位属于哪个形态大类 */
export function postureOf(pos) {
  const hay = [...(pos.core || []), ...(pos.male || []), ...(pos.female || []), pos.name || ''].join(' | ');
  for (const rule of POSTURE_RULES) if (rule.re.test(hay)) return rule.key;
  return 'other';
}
