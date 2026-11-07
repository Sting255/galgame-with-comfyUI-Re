/**
 * modelRouting.js — 按调用链分配 LLM 模型
 *
 * ── 为什么要有它 ────────────────────────────────────────────────
 * 所有链路共用 `config.llm.model`。真机发现这不够用：神说需要「愿意写、不设防」的模型，
 * 日程 / 事件结局需要「稳定输出完整 JSON」的模型，两类需求常常指向不同供应商。
 * 一个模型通吃的结果是两头都不够好——保守的模型把正文写成擦边，
 * 宽松的模型在长 JSON 上被服务商中途掐断。
 *
 * ── 数据落在哪 ──────────────────────────────────────────────────
 * `system_settings.llm_model_routes`，JSON 对象：`{ "angel": "model-a", "schedule": "model-b" }`。
 * 值与键都做校验；空串 / 缺键 = 该链路走 `config.llm.model` 默认模型。
 *
 * ── 与破限 target 的关系 ────────────────────────────────────────
 * **两套独立的键，刻意不复用**：破限的 `jailbreak_targets` 已经存了用户勾选结果，
 * 往里塞新键会让「不在存储数组里」的链路被判成未投递，神说的破限会静默失效。
 * 路由这套多了 `angel`（神说单独一条，用户常给它配不同模型），少了无意义的细分。
 *
 * ── 生效点 ──────────────────────────────────────────────────────
 * `llm-client.js` 的三个收口：chatSync / chatStream / chatAgentStream。
 * 调用方显式传了 `opts.model` 时以显式值为准（路由只补默认值）。
 * 免费鸡蛋模式下不路由——模型由免费池决定。
 * 输出额度不随路由变化，仍以设置页的全局额度为准。
 */
import { getSetting, setSetting } from '../db/settings.js';
import { config } from '../config.js';

const ROUTES_KEY = 'llm_model_routes';

/** 可路由的调用链 */
export const ROUTE_KEYS = ['angel', 'chat', 'group', 'event', 'schedule', 'moment', 'diary', 'mailbox', 'media', 'town'];

/** 中文名（服务端与前端共用一份，避免两边各写一遍翻译） */
export const ROUTE_LABELS = {
  angel: '神说（天使）',
  chat: '私聊',
  group: '群聊',
  event: '奇遇 / 事件',
  schedule: '日程',
  moment: '朋友圈',
  diary: '日记',
  mailbox: '信箱',
  media: '媒体',
  town: '小镇',
};

/**
 * label 前缀 → 路由键。
 *
 * 调用点传的是中文 label（'私聊' / '神说 [11月7日第2次对话/round-1]' / 'schedule-gen:默认助手'…），
 * 在收口处按前缀识别一次，不改 100+ 个调用点。
 * 认不出来 → 空串 = 不路由，走默认模型。
 */
const LABEL_ROUTE_PREFIXES = [
  ['神说', 'angel'],
  ['私聊', 'chat'],
  ['群聊', 'group'],
  ['奇遇', 'event'],
  ['事件分支', 'event'],
  ['事件结局', 'event'],
  ['日程', 'schedule'],
  ['schedule', 'schedule'],
  ['朋友圈', 'moment'],
  ['话题', 'moment'],
  ['发朋友圈', 'moment'],
  ['发帖人', 'moment'],
  ['朋友', 'moment'],
  ['日记', 'diary'],
  ['信箱', 'mailbox'],
  ['信件', 'mailbox'],
  ['媒体', 'media'],
  ['media', 'media'],
  ['小镇', 'town'],
];

/** 内存缓存：每轮对话要查好几次，不值得每次都读 DB。写入时失效。 */
let _cache = null;

function normalizeRoutes(value) {
  const out = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of ROUTE_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    const model = raw.trim();
    if (model) out[key] = model;
  }
  return out;
}

function storedRoutes() {
  if (_cache) return _cache;
  let parsed = null;
  try {
    const raw = getSetting(ROUTES_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // DB 还没准备好（启动早期的 LLM 调用）或 JSON 坏了：本次不路由，且**不写缓存**——
    // 否则会把「暂时读不到」永久固化成「没配过」，用户配好的路由要重启才生效。
    return Object.create(null);
  }
  _cache = normalizeRoutes(parsed);
  return _cache;
}

/** 全部路由（只含已配置的键；前端用 getModelRouteSummary 拿补全空串的版本） */
export function getModelRoutes() {
  return { ...storedRoutes() };
}

/** 给前端用的全量视图：每个可路由链路都出现，未配置的为空串 */
export function getModelRouteSummary() {
  const routes = storedRoutes();
  const list = ROUTE_KEYS.map(key => ({ key, label: ROUTE_LABELS[key], model: routes[key] || '' }));
  return { routes: list, defaultModel: config.llm.model || '', freeEgg: !!config.llm.freeEgg };
}

/**
 * 保存路由。只覆盖传进来的键；传空串或 null 表示**清掉**该链路。
 * @param {object} patch 形如 `{ angel: 'model-a', schedule: '' }`
 */
export function setModelRoutes(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('routes 必须是对象'), { status: 400 });
  }
  const next = { ...storedRoutes() };
  for (const [key, value] of Object.entries(patch)) {
    if (!ROUTE_KEYS.includes(key)) {
      throw Object.assign(new Error(`未知的调用链: ${key}`), { status: 400 });
    }
    if (value === null || value === undefined || value === '') {
      delete next[key];
      continue;
    }
    if (typeof value !== 'string') {
      throw Object.assign(new Error(`模型名必须是字符串: ${key}`), { status: 400 });
    }
    const model = value.trim();
    if (model) next[key] = model;
    else delete next[key];
  }
  setSetting(ROUTES_KEY, JSON.stringify(next));
  _cache = next;
  return { ...next };
}

/** label → 路由键；认不出来返回空串 */
export function resolveRouteKey(label) {
  const text = String(label || '');
  if (!text) return '';
  for (const [prefix, key] of LABEL_ROUTE_PREFIXES) {
    if (text.startsWith(prefix)) return key;
  }
  return '';
}

/**
 * 这条链路该用哪个模型。
 * @returns {string|null} 配了且非空 → 模型名；否则 null（调用方用默认模型）
 */
export function resolveModelForLabel(label) {
  if (config.llm.freeEgg) return null;
  const key = resolveRouteKey(label);
  if (!key) return null;
  const model = storedRoutes()[key];
  return model || null;
}

/** 测试用：清掉缓存，强制下次从 DB 重读 */
export function invalidateModelRoutes() {
  _cache = null;
}
