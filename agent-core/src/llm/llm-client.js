import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { config, updateFreeEggEnabled, FREE_EGG_MODELS } from '../config.js';
import { compressLlmImageInputs } from '../services/llmImageInput.js';
import { acquireSlot, releaseSlot } from '../services/llmConcurrency.js';
import { recordLlmCall } from '../services/llmTelemetry.js';
// 本地独有（上游没有）：上下文用量回填 + 破限层注入
import { notePromptUsage } from '../services/contextUsage.js';
import { applyShield } from '../services/promptShield.js';
// 本地独有：拒答检测（模型把"我无法提供"当结果返回时重发一次，见 services/refusalDetector.js）
import { isRefusal, REFUSAL_RETRY_INSTRUCTION } from '../services/refusalDetector.js';
// 上游 v3.10.0：输出额度统一由设置页决定（按 baseURL/模型猜上限）
import { defaultMaxTokens, isValidMaxTokens } from './modelCapabilities.js';
import { createVertexClient, clearVertexTokenCache, vertexBaseURL } from './vertex-client.js';

/**
 * 把调用方的中文 `label` 映射到破限规则集的**投递目标 key**。
 *
 * 为什么要有它：全仓 100+ 个调用点各自传自己的中文 label（'私聊' / '群聊' / '奇遇生成'…），
 * 让它们全都再传一个 `target` 是不现实的（改 100 处、且以后新调用点一定会忘）。
 * 这里在收口处按前缀识别一次，`opts.target` 显式传了就以显式值优先。
 *
 * 认不出来的一律返回 `undefined` = **照常注入**（见 applyShield 的缺省投递语义），
 * 所以漏映射的后果是"少一条过滤"，不是"破限词失效"。
 */
const LABEL_TARGET_PREFIXES = [
  ['私聊', 'chat'],
  ['群聊', 'group'],
  ['奇遇', 'event'],
  ['事件分支', 'event'],
  ['事件结局', 'event'],
  ['日程', 'schedule'],
  ['朋友圈', 'moment'],
  ['话题', 'moment'],
  ['日记', 'diary'],
  ['信箱', 'mailbox'],
  ['信件', 'mailbox'],
  ['媒体', 'media'],
  ['小镇', 'town'],
];

/**
 * 统一使用设置页的输出额度，旧业务参数不再单独限制输出。
 * extraBody 可选择协议字段，但数值始终以 MAX_tokens 设置为准。
 *
 * ⚠️ 上游 v3.10.0 原样引入（本地没有做「显式优先」的扩展）。
 *    决定依据：实测 9/9 模型在无逐调用点额度时输出仍恒定 1 字、判定 0 翻转、
 *    JSON 5/5 可解析 ⇒ 删掉逐调用点额度对功能无影响，只是个别链路可能多烧 token。
 *    详见 目标/20261019-下一步方案-上游v3.10.0合并.md §2.3。
 *    守卫：test/smallAllowanceParsing.test.js（变化探测器）。
 */
function applyOutputTokenLimit(params, maxTokens = config.llm.maxTokens, baseURL = config.llm.baseURL) {
  const field = Object.hasOwn(params, 'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens';
  delete params.max_tokens;
  delete params.max_completion_tokens;
  delete params.max_output_tokens;
  params[field] = isValidMaxTokens(maxTokens) ? maxTokens : defaultMaxTokens(baseURL, params.model);
}

function resolveShieldTarget(label) {
  const text = String(label || '');
  if (!text) return undefined;
  for (const [prefix, target] of LABEL_TARGET_PREFIXES) {
    if (text.startsWith(prefix)) return target;
  }
  return undefined;
}

const _limitEnabled = () => config.features.serializeBackgroundLLM;

function isDeepseek() {
  return (config.llm.baseURL || '').includes('deepseek.com');
}

function providerLabel() {
  const url = config.llm.baseURL || '';
  try {
    return new URL(url).hostname;
  } catch {
    return url || 'LLM';
  }
}

/**
 * 思考模式 → 请求参数。
 *
 * 2026-10-15：新增 `reasoning_effort` 这条路。有些网关（实测 `wb2api` 上的
 * `cn:glm-5.3-flash`，`only_reasoning:true` + `can_disable_thinking:true` +
 * `reasoning_supported_efforts:["low","high","max"]`）对 `thinking:{type:'disabled'}`
 * **完全不买账**，甚至反而把思考拉满（实测传 disabled 时 reasoning 372 字、正文只剩 8 字）；
 * 而 `reasoning_effort:'low'` 能真正做到 `reasoning_len=0`、1.2 秒返回正文。
 *
 * 所以这里按 `LLM_REASONING_EFFORT` 环境变量发 `reasoning_effort`（`low|high|max`），
 * 与既有的 `thinking` 两条路并存：调用方显式传 `thinking` 时仍以调用方为准。
 */
function configuredThinking() {
  if (config.llm.thinkingMode === 'omit') return null;
  return { type: config.llm.thinkingMode === 'enabled' ? 'enabled' : 'disabled' };
}

/**
 * 关闭/降低思考的强度。默认 'low'，非免费鸡蛋通道且有思考口径时永远有值。
 *
 * 两条路必须一起发，缺一条都有模型会漏：
 *   · `thinking:{type:'disabled'}` —— deepseek 系靠它真正关掉（不传则 reasoning_len≈294）
 *   · `reasoning_effort:'low'`      —— 少数模型（cn:glm-5.1）不传就直接被网关拒
 *   两个一起发对 deepseek 无害（实测仍 reasoning_len=0）。
 *
 * 不发的场景：
 *   · **免费鸡蛋通道**（直接判 `config.llm.freeEgg`，不用"空串"推断 ——
 *     空串在 config 层会被归一，靠它区分会把"配置被清空"误判成 freeEgg）
 *   · **思考模式为 'omit'（不传）**：用户明确要求"完全不干预思考"，
 *     此时 thinking 与 reasoning_effort 一个都不发 —— 第三方中转对这两个
 *     非标准字段最敏感，发出去就可能换来 400。
 */
function configuredReasoningEffort() {
  if (config.llm.freeEgg) return null;
  if (config.llm.thinkingMode === 'omit') return null;
  const effort = String(config.llm.reasoningEffort ?? '').trim().toLowerCase();
  // config 层已保证 low/high/max，这里再兜一次底
  return ['low', 'high', 'max'].includes(effort) ? effort : 'low';
}

// 模型输出日志上限：小镇相关日志（label 以「小镇」开头）完全输出，不截断
function outputLogLimit(label) {
  const name = String(label || '');
  if (name.startsWith('小镇')) return Infinity;
  return name.startsWith('schedule-gen:') ? 300 : 2000;
}

// 复用单个 OpenAI 客户端实例，避免每次调用都创建新的 HTTP Agent
// 频繁创建 client 会实例化底层 undici 连接池，在高并发场景下浪费 FD 和内存
//
// §6.1（审查 2026-09-30）：客户端必须跟着**配置**走。以前只靠调用方记得调 `resetClient()`，
// 一旦某条更新路径漏了（config.js 的 `updateLlmConfig` / `activateLlmProfile` 是直接改 config 对象的），
// 用户就会遇到"改了 Key/地址不重启不生效"。现在每次取客户端都拿**配置指纹**比一下，
// 变了就自愈重建 —— 不依赖调用方约定，`resetClient()` 仍然有效。
let _client = null;
let _clientFingerprint = '';

/**
 * 给客户端**实际使用的 fetch** 套一层诊断：非 2xx 时把原始响应体打进日志。
 *
 * 有的中转（tokenrhythm 等）出错时返回 `{code,message,traceId}`，不是 OpenAI 的
 * `{error:{message,...}}` 形状 ⇒ SDK 解析不到 message，只抛 "400 status code (no body)"，
 * 真实原因（max_tokens 超限 / 不支持 thinking 参数 / 模型不存在）全被吞掉。
 *
 * ⚠️ 必须在 `new OpenAI()` **之后**包 `client.fetch`，不能自己传一个 fetch：
 *   · 测试会通过 `openai/shims/web` 或 require.cache 换掉 SDK 的 fetch 做网络打桩，
 *     自己传 fetch 会绕过桩（2026-10-20 踩过两次：penalty/reroll 10 条 + 媒体 12 条）
 *   · 包在 client.fetch 上 ⇒ 无论 SDK 解析到 node-fetch 还是 web shim，都走它原本那条路
 */
function withErrorBodyLogging(client, label) {
  const original = client.fetch;
  if (typeof original !== 'function') return client;
  client.fetch = async (input, init) => {
    const res = await original.call(client, input, init);
    if (!res.ok) {
      try {
        const text = await res.clone().text();
        const url = typeof input === 'string' ? input : (input?.url || '');
        console.error(`[llm${label ? ':' + label : ''}] HTTP ${res.status} ${url} :: ${text.slice(0, 800)}`);
      } catch { /* 读不到就算了，别影响主流程 */ }
    }
    return res;
  };
  return client;
}

/**
 * 网关兼容降级：400 时去掉「可选参数」重试一次。
 *
 * 2026-10-20 实测：tokenrhythm 的聊天接口对 `thinking:{type:'disabled'}` /
 * `reasoning_effort` 这类**非 OpenAI 标准字段**直接回 400（127 字节自有错误体，
 * SDK 解析不出 message），而同一个 Key 的「连接测试」不带这两个字段所以是通的 ⇒
 * 用户看到「测试已连接但聊天全 400」。换模型也没用，因为参数还在。
 *
 * 这里只在 400 且确实带了可选参数时重试一次：去掉后大多数中转都能正常回。
 * 成功路径零变化；其它错误（401/429/5xx）原样抛出，不做静默重试。
 */
const OPTIONAL_GATEWAY_PARAMS = ['thinking', 'reasoning_effort'];

async function createCompletionWithFallback(client, params, options, label) {
  try {
    return await client.chat.completions.create(params, options);
  } catch (err) {
    const present = OPTIONAL_GATEWAY_PARAMS.filter(key => Object.hasOwn(params, key));
    if (Number(err?.status) !== 400 || present.length === 0) throw err;
    for (const key of present) delete params[key];
    console.error(`[llm${label ? ':' + label : ''}] HTTP 400：去掉可选参数 ${present.join('/')} 后重试一次`);
    return await client.chat.completions.create(params, options);
  }
}

/** 影响客户端实例的配置指纹（baseURL / apiKey / 自定义头 / 免费鸡蛋开关） */
function clientFingerprint() {
  let headers = null;
  try { headers = JSON.stringify(config.llm.headers || null); } catch { headers = 'unserializable'; }
  return [config.llm.baseURL || '', config.llm.apiKey || '', headers, config.llm.freeEgg ? 'egg' : 'self'].join('\u0000');
}

function getClient() {
  // 上游 v3.10.0：Vertex AI 走独立客户端（服务账号鉴权，不是 OpenAI 兼容协议）。
  // 放在最前面 —— 它不需要下面那套 baseURL/apiKey/freeEgg 的处理。
  if (config.llm.connectionType === 'vertexai') {
    if (!_client) _client = createVertexClient(config.llm);
    return _client;
  }
  const fingerprint = clientFingerprint();
  if (_client && _clientFingerprint !== fingerprint) {
    console.warn('[llm] 检测到 LLM 配置变化，自动重建客户端（无需调用方记得 resetClient）');
    _client = null;
  }
  if (!_client) {
    const opts = {
      baseURL: config.llm.baseURL,
      apiKey: config.llm.apiKey,
    };
    const headers = config.llm.headers;
    if (headers && Object.keys(headers).length > 0) {
      opts.defaultHeaders = headers;
    }
    // 每日免费鸡蛋：端点免 Key。SDK 构造时要求 apiKey 非 undefined（用随机占位符绕过），
    // 且值为 null 的请求头会被 SDK 从请求中删除 → 真正不发送 Authorization。
    // 2026-09 起 zen 免费档强制要求 x-opencode-session 头（否则 400 MissingSessionID），
    // 与 apiKey 占位符共用同一个随机 UUID，客户端生命周期内保持不变。
    if (config.llm.freeEgg) {
      const sessionId = randomUUID();
      opts.apiKey = sessionId; // 占位符，非真实凭据
      opts.defaultHeaders = { Authorization: null, 'x-opencode-session': sessionId, ...(opts.defaultHeaders || {}) };
    }
    _client = withErrorBodyLogging(new OpenAI(opts), 'chat');
    _clientFingerprint = fingerprint;
  }
  return _client;
}

/** 显式重建客户端（配置更新的调用方仍然可以调；返回值无） */
export function resetClient() {
  _client = null;
  _clientFingerprint = '';   // 本地：配置指纹，用于自动重建客户端
  clearVertexTokenCache();   // 上游 v3.10.0：Vertex 的 access token 也要失效
}

// ── 免费鸡蛋模型轮换：按 FREE_EGG_MODELS 名单依次请求，每个模型只请求一次；
//    本轮（本次开启期间）失败过的模型记在内存里，后续请求直接跳过。
//    全部模型都失败后关闭鸡蛋，并用恢复后的自有配置立即重发当前请求 ──
let _freeEggFailedModels = new Set();

/** 手动开关鸡蛋时清空本轮失败模型记录，下次开启重新从 deepseek 开始 */
export function resetFreeEggFailureCount() {
  _freeEggFailedModels.clear();
}

function freeEggCandidates() {
  return FREE_EGG_MODELS.filter(model => !_freeEggFailedModels.has(model));
}

/**
 * 记录本轮免费鸡蛋中失败的模型；全部模型都失败时关闭鸡蛋并重置客户端。
 * @returns {boolean} true 表示本轮可用模型已全部失败，调用方应改用自有配置重发
 */
function recordFreeEggFailure(model, err) {
  if (!config.llm.freeEgg) return false;
  _freeEggFailedModels.add(model);
  const msg = err?.message || String(err || '');
  console.warn(`[free-egg] 模型 ${model} 失败，本轮免费鸡蛋不再使用：${msg}`);
  if (_freeEggFailedModels.size >= FREE_EGG_MODELS.length) {
    updateFreeEggEnabled(false);
    resetClient();
    _freeEggFailedModels.clear();
    console.warn(`[free-egg] 本轮可用免费模型已全部失败，已自动关闭每日免费鸡蛋，改用自有 LLM 配置（最后错误：${msg}）`);
    return true;
  }
  return false;
}

/**
 * 判断是否可重试的错误
 * 中转站 API 偶尔出现 401/500 但仍有输出，以及网络瞬断都属于可恢复错误
 */
function isRetryableError(err) {
  const status = err?.status || err?.response?.status;
  const message = (err?.message || '') + (err?.error?.message || '');
  const code = err?.code || err?.error?.code || '';
  // 中转站：401 可能是认证中间件抖动，500/502/503 是后端瞬断
  if (status === 401 || status === 429 || (status >= 500 && status < 600)) return true;
  // 网络层错误
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') return true;
  if (message.includes('fetch failed') || message.includes('timeout') || message.includes('abort')) return true;
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 打印 token 用量与前缀缓存命中率。
 * DeepSeek 官方返回 prompt_cache_hit_tokens；OpenAI 风格渠道返回 prompt_tokens_details.cached_tokens。
 * 两者都没有时只打印用量，不打印命中率。
 */
/**
 * 思考型网关的「额度被思考吃光」兜底（2026-10-22）
 *
 * 真机探针实证（127.0.0.1:7863 + cn:deepseek-v4-pro）：
 *   请求 `max_tokens: 128` → usage 里 `completion_tokens: 128` 且
 *   `completion_tokens_details.reasoning_tokens: 128`，**正文 output 为空字符串**。
 *   同一份 prompt 换成更大额度才有正文。
 *
 * 后果：朋友圈首评/回评/续评、主动聊天开场白、回复预测这些 `max_tokens: 128` 的
 * 短任务会间歇性拿到空串；`max_tokens: 5` 的「判断需要图片」必然全空，
 * 于是判定恒为「不需要图」。
 *
 * 处置：拿到空正文且**确实是思考吃掉了额度**时，把额度放大后重发一次（只一次）。
 * 不做无脑重试——重试同样的额度只会得到同样的空结果。
 */
const REASONING_STARVED_MIN_TOKENS = 2048;

function isReasoningStarved(usage, content) {
  if (typeof content === 'string' && content.trim()) return false;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
    ?? usage?.completion_thinking_tokens;
  return Number.isFinite(reasoning) && reasoning > 0;
}

/**
 * 网关 usage 合理性告警（2026-10-22）
 *
 * 实测：一次 17299 字符的请求，网关回报 `prompt_tokens: 209`；日程生成报 99/260 tokens
 * 却产出 975 tokens 的完整日程。`logUsage` 直接用网关的 usage，所以上下文用量面板和
 * 成本统计都会被这个假数字带偏。
 *
 * 这里**不改统计行为**（本地估算未必更准），只在数量级明显不对时打一条告警，
 * 让"面板数字不对"这件事有据可查，也便于判断是网关的问题还是本地取值的问题。
 */
function warnUsageAnomaly(label, messages, usage) {
  const reported = usage?.prompt_tokens;
  if (!Number.isFinite(reported) || reported <= 0) return;
  const chars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  // 中文约 1 字/token，英文约 4 字符/token ⇒ chars/4 是一个保守下界
  const lowerBound = Math.floor(chars / 4);
  if (lowerBound > 0 && reported * 5 < lowerBound) {
    console.warn(`[usage] ${label}: 网关回报 ${reported} prompt tokens，但请求正文 ${chars} 字符（下界约 ${lowerBound} tokens）—— 该网关的 usage 可能不可信，上下文面板/成本统计会失真`);
  }
}

function logUsage(label, usage) {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  if (hit != null && prompt > 0) {
    const pct = ((hit / prompt) * 100).toFixed(0);
    console.log(`[cache] ${label}: 命中 ${hit}/${prompt} prompt tokens (${pct}%) | 输出 ${completion}`);
  } else {
    console.log(`[usage] ${label}: prompt ${prompt} | 输出 ${completion}`);
  }
}

/**
 * 合并连续同角色（非 system）消息，适配 LM Studio 等严格 Jinja 模板
 * 仅处理 user/assistant 的连续同角色，不合并 system 消息（system 分层是有意设计）
 */
function mergeConsecutiveRoles(messages) {
  const merged = messages.map(message => ({ ...message }));
  for (let i = merged.length - 1; i > 0; i--) {
    if (merged[i].role !== 'system' && merged[i].role === merged[i - 1].role) {
      merged[i - 1].content += '\n\n' + merged[i].content;
      merged.splice(i, 1);
    }
  }
  return merged;
}

/** 免费鸡蛋同步请求：依次尝试本轮尚未失败过的免费模型，每个模型只请求一次 */
async function _chatSyncFreeEgg(messages, opts) {
  throwIfSyncAborted(opts.signal);
  const candidates = freeEggCandidates();
  if (candidates.length === 0) {
    const err = new Error('free egg: all models already failed in this session');
    err.__freeEggFailover = true;
    throw err;
  }
  let lastError = null;
  for (const model of candidates) {
    throwIfSyncAborted(opts.signal);
    if (!config.llm.freeEgg) {
      lastError = lastError || new Error('free egg disabled');
      lastError.__freeEggFailover = true;
      throw lastError;
    }
    try {
      return await _chatSyncInner(messages, { ...opts, model, retries: 0 });
    } catch (err) {
      throwIfSyncAborted(opts.signal, err);
      if (opts.freeEggFailover === false) throw err;
      lastError = err;
      if (recordFreeEggFailure(model, err)) {
        err.__freeEggFailover = true;
        throw err;
      }
    }
  }
  throwIfSyncAborted(opts.signal);
  if (config.llm.freeEgg) {
    updateFreeEggEnabled(false);
    resetClient();
    _freeEggFailedModels.clear();
  }
  lastError.__freeEggFailover = true;
  throw lastError;
}

/**
 * 非流式聊天（用于摘要、实体抽取、情绪评估等任务）
 * 外层包装：免费鸡蛋全部模型失败触发时（错误带 __freeEggFailover 标记），
 * 立即用恢复后的自有配置把本次请求重发一遍（model/thinking 等默认值重新求值）
 * @param {number} opts.retries - 最大重试次数（默认 2，共 3 次尝试）
 * @param {number} opts.retryDelay - 初始重试延迟 ms（默认 1000，指数退避 ×2）
 * @param {AbortSignal} opts.signal - 覆盖排队、退避、请求与免费模型切换；取消后不再重发
 * @param {number} opts.timeout - SDK 单次请求超时 ms（不含排队）；缺省沿用 SDK 默认
 * @param {number} opts.maxRetries - SDK 内部重试次数；与外层 retries 独立，缺省不变
 * @param {boolean} opts.returnMeta - true 时返回 { content, finishReason }（判断是否被 max_tokens 截断）；缺省仍只返回 content 字符串
 * @param {boolean} opts.refusalRetry - true（默认）时，命中拒答话术会追加纠正指令重发一次；false 关闭（用于逐字校对类任务）
 * @param {boolean} opts.freeEggFailover - false 禁止免费模型轮换/回退自有端点，缺省保持旧行为
 * @param {number|null} opts.presence_penalty - 反重复采样参数；缺省用 config.llm.antiRepetitionPenalty，null 时请求体不发送该字段
 * @param {number|null} opts.frequency_penalty - 同上
 * 单次请求用 { signal, timeout: 10000, retries: 0, maxRetries: 0, freeEggFailover: false }。
 */
export async function chatSync(messages, opts = {}) {
  throwIfSyncAborted(opts.signal);
  if (opts.timeout !== undefined && (!Number.isSafeInteger(opts.timeout) || opts.timeout < 1 || opts.timeout > 2147483647)) {
    throw new TypeError('chatSync timeout must be a positive integer in milliseconds');
  }
  if (opts.maxRetries !== undefined && (!Number.isSafeInteger(opts.maxRetries) || opts.maxRetries < 0)) {
    throw new TypeError('chatSync maxRetries must be a nonnegative integer');
  }
  messages = await compressLlmImageInputs(messages);
  // 提示词破限：在这一处收口注入（所有 LLM 调用都过这里）。
  // 未开开关 / 正文为空 / 本轮已注过 → 原样返回同一个数组引用，零开销。
  // 放在 compressLlmImageInputs **之后**：那条路会重排/裁剪消息，先注入会被它打乱位置。
  messages = applyShield(messages, {
    label: opts.label || 'chatSync',
    // 投递范围：显式 opts.target 优先，否则按 label 前缀识别（见 resolveShieldTarget）
    target: opts.target !== undefined ? opts.target : resolveShieldTarget(opts.label),
  });
  // 所有非流式调用的唯一收口：网络失败由内层重试，**拒答**在这里兜一次。
  // 之前只有 applyShield（注入破限词），拒答文本与正常结果同路径返回，上层无从分辨。
  const runOnce = (msgs) => (config.llm.freeEgg
    ? _chatSyncFreeEgg(msgs, opts)
    : _chatSyncInner(msgs, opts));
  try {
    let result = await runOnce(messages);
    if (opts.refusalRetry !== false) {
      const firstText = opts.returnMeta ? result.content : result;
      if (isRefusal(firstText)) {
        // 只重发一次：纠正指令贴在原消息之后，原有 system（角色/格式要求）继续生效。
        console.warn(`[refusal] ▸ 模型拒答，追加纠正指令重发一次 (${opts.label || 'chatSync'})`);
        try {
          const retried = await runOnce([...messages, REFUSAL_RETRY_INSTRUCTION]);
          const retriedText = opts.returnMeta ? retried.content : retried;
          if (isRefusal(retriedText)) {
            console.warn(`[refusal] ▸ 重发后仍是拒答，按原样返回 (${opts.label || 'chatSync'})`);
          } else {
            result = retried;
          }
        } catch (retryErr) {
          // 重发失败不掩盖第一次的结果：上层拿到的仍是原始返回，行为与加检测前一致。
          throwIfSyncAborted(opts.signal, retryErr);
          console.warn(`[refusal] ▸ 重发失败，保留首次结果 (${opts.label || 'chatSync'}): ${retryErr?.message || retryErr}`);
        }
      }
    }
    return opts.returnMeta ? result : result.content;
  } catch (err) {
    throwIfSyncAborted(opts.signal, err);
    if (err && err.__freeEggFailover && opts.freeEggFailover !== false) {
      console.warn(`[free-egg] ▸ 立即改用自有配置重发本次请求 (${opts.label || 'sync'})`);
      const retried = await _chatSyncInner(messages, opts);
      return opts.returnMeta ? retried : retried.content;
    }
    throw err;
  }
}

// Sync-path helpers only; streaming and the shared semaphore API retain their existing contract.
function throwIfSyncAborted(signal, error) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  if (error?.name === 'AbortError' || error?.name === 'APIUserAbortError') throw error;
}

function awaitSyncSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    // Attach both handlers even for pre-abort, so a late semaphore resolution/rejection is observed.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

/**
 * 反重复采样参数（专题 L3 / 规划 C5）：presence_penalty / frequency_penalty 透传。
 *
 * 口径（2026-09-30）：
 *   · 调用方没传（undefined）→ 回退 config.llm.antiRepetitionPenalty / antiRepetitionFrequency
 *   · 求值后为 null → **请求体里完全不发送该字段**（与加参数前逐字节一致，默认就是这个状态）
 *   · 数字（含 0）→ 原样透传
 * 注意：未确认中转站是否接受该参数前，设置页默认留空 ⇒ 行为与历史完全一致。
 * （专题要求先拿真网关打探针再上 UI；探针属于真实 LLM 调用，需用户授权，本轮未做。）
 */
function resolveAntiRepetitionPenalties(presencePenalty, frequencyPenalty) {
  const presence = presencePenalty === undefined ? config.llm.antiRepetitionPenalty : presencePenalty;
  const frequency = frequencyPenalty === undefined ? config.llm.antiRepetitionFrequency : frequencyPenalty;
  const out = {};
  if (presence !== null && presence !== undefined) out.presence_penalty = presence;
  if (frequency !== null && frequency !== undefined) out.frequency_penalty = frequency;
  return out;
}

async function acquireSyncSlot(signal) {
  throwIfSyncAborted(signal);
  let acquired = false, abandoned = false;
  const pending = acquireSlot().then(() => {
    // The existing semaphore cannot remove queued waiters. Return a cancelled waiter's slot immediately.
    if (abandoned) releaseSlot();
    else acquired = true;
  });
  try {
    await awaitSyncSignal(pending, signal);
    throwIfSyncAborted(signal);
  } catch (error) {
    abandoned = true;
    if (acquired) releaseSlot();
    throw error;
  }
}

async function syncRetryDelay(ms, signal) {
  throwIfSyncAborted(signal);
  let timer;
  try { await awaitSyncSignal(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
  throwIfSyncAborted(signal);
}

/**
 * 用当前或表单中的 LLM 配置发一次最小对话请求，用于设置页的连接测试。
 * 不修改全局 config，也不走免费鸡蛋/并发队列，避免影响真实聊天请求。
 *
 * 上游 v3.10.0：支持 Vertex AI（服务账号鉴权）—— 它的端点不是 OpenAI 兼容协议，
 * 要用 createVertexClient + vertexBaseURL，不能当成普通 baseURL 处理。
 */
export async function testLlmConnection({ baseURL, apiKey, model, maxTokens, headers = {}, extraBody = {}, connectionType, vertexRegion, vertexServiceAccount } = {}) {
  const effectiveBaseURL = connectionType === 'vertexai'
    ? vertexBaseURL(vertexRegion)
    : String(baseURL || config.llm.baseURL || '').trim().replace(/\/+$/, '');
  if (!effectiveBaseURL) throw new Error('API 地址未配置');
  try {
    const parsed = new URL(effectiveBaseURL);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error('API 地址格式无效');
  }

  const effectiveModel = model || config.llm.model || 'deepseek-flash';
  const effectiveApiKey = apiKey || config.llm.apiKey || '';
  const effectiveHeaders = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};
  const effectiveExtraBody = extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : {};

  const clientOptions = {
    baseURL: effectiveBaseURL,
    apiKey: effectiveApiKey || 'free-egg',
    timeout: 15000,
    maxRetries: 0,
  };
  if (Object.keys(effectiveHeaders).length) clientOptions.defaultHeaders = effectiveHeaders;
  if (!effectiveApiKey) {
    clientOptions.defaultHeaders = { Authorization: null, ...(clientOptions.defaultHeaders || {}) };
  }
  const client = connectionType === 'vertexai'
    ? createVertexClient({ vertexServiceAccount: vertexServiceAccount ?? config.llm.vertexServiceAccount, vertexRegion: vertexRegion ?? config.llm.vertexRegion, headers: effectiveHeaders, timeout: 15000 })
    : withErrorBodyLogging(new OpenAI(clientOptions), 'test');

  const params = {
    model: effectiveModel,
    messages: [{ role: 'user', content: 'ping' }],
  };
  Object.assign(params, effectiveExtraBody);
  // 上游 v3.10.0：额度统一由设置页决定（连测试也不再用写死的 8）。
  // 显式传入的 maxTokens 优先，否则退回全局设置。
  applyOutputTokenLimit(params, isValidMaxTokens(maxTokens) ? maxTokens : undefined, effectiveBaseURL);

  const startedAt = Date.now();
  const response = await client.chat.completions.create(params);
  return {
    ok: true,
    model: effectiveModel,
    endpoint: effectiveBaseURL,
    latencyMs: Date.now() - startedAt,
    reply: response?.choices?.[0]?.message?.content?.slice(0, 80) || '',
  };
}

// 日志打印前压缩超大内容：ANIMA3 模板与视觉消息里的图片 base64（几 MB）都不进控制台
function compressLogMessages(messages) {
  return messages.map(m => {
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map(part =>
          part?.type === 'image_url'
            ? { ...part, image_url: { url: `[image base64 omitted: ${String(part.image_url?.url || '').length} chars]` } }
            : part
        ),
      };
    }
    if (m.content && m.content.includes('ANIMA3 提示词生成模板')) {
      return { ...m, content: '# ANIMA3 提示词生成模板 v3.0（已省略，共 ' + m.content.length + ' 字符）' };
    }
    return m;
  });
}

async function _chatSyncInner(messages, { model = config.llm.model || 'deepseek-flash', temperature = 0.7, response_format, thinking, presence_penalty: presencePenalty, frequency_penalty: frequencyPenalty, label = 'sync', retries = 2, retryDelay = 1000, signal, timeout, maxRetries } = {}) {
  throwIfSyncAborted(signal);
  if (config.features.mergeMessages) messages = mergeConsecutiveRoles(messages);
  const limited = _limitEnabled();
  if (limited) await acquireSyncSlot(signal);
  try {
  throwIfSyncAborted(signal);
  const requestOptions = {};
  if (signal !== undefined) requestOptions.signal = signal;
  if (timeout !== undefined) requestOptions.timeout = timeout;
  if (maxRetries !== undefined) requestOptions.maxRetries = maxRetries;
  const params = {
    model,
    messages,
  };
  // temperature 为 null 时不发送（deepseek-reasoner 不支持此参数）
  if (temperature != null) {
    params.temperature = temperature;
  }
  // 反重复 penalty：默认 null ⇒ 不发送，请求体逐字节不变（见 resolveAntiRepetitionPenalties）
  Object.assign(params, resolveAntiRepetitionPenalties(presencePenalty, frequencyPenalty));
  if (response_format) {
    params.response_format = response_format;
  }
  // 全局三态配置默认注入 disabled；选择“不传”时完全省略。
  // 调用方显式传入 thinking/null 时仍可覆盖全局设置。
  const effectiveThinking = thinking === undefined ? configuredThinking() : thinking;
  if (effectiveThinking !== null) {
    params.thinking = effectiveThinking;
  }
  // 部分网关只认 reasoning_effort（不认 thinking.type）——见 configuredReasoningEffort 的注释。
  // 放在 thinking 之后、extraBody 之前：extraBody 仍可覆盖它。
  const reasoningEffort = configuredReasoningEffort();
  if (reasoningEffort) {
    params.reasoning_effort = reasoningEffort;
  }
  // 合并自定义请求体参数（extraBody 可覆盖上述默认值以适配自定义 API）
  const extraBody = config.llm.extraBody;
  if (extraBody && Object.keys(extraBody).length > 0) {
    Object.assign(params, extraBody);
  }
  // 上游 v3.10.0：最后统一确定输出额度（会删掉 extraBody 里的额度字段，
  // 再按 config.llm.maxTokens / 模型能力填一个）。放在 extraBody 之后是有意的 ——
  // 上游的口径是「数值始终以 MAX_tokens 设置为准」，见 applyOutputTokenLimit 注释。
  applyOutputTokenLimit(params);

  // 日志打印时压缩 ANIMA3 模板内容，避免刷屏
  const logMsgs = compressLogMessages(messages);
  // 先缓存请求日志，等响应返回后一起输出，避免并行调用时控制台输出串行
  const requestLog =
    `\n══════════ [${providerLabel()} → ${label}] ══════════\n` +
    JSON.stringify(logMsgs, null, 2) + '\n' +
    '───────────────────────────────────────────────';

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 重试前等待（指数退避）
      if (attempt > 0) {
        const delay = retryDelay * Math.pow(2, attempt - 1);
        console.warn(`[${providerLabel()}] ▸ 第 ${attempt}/${retries} 次重试 (${delay}ms 后退避)...`);
        await syncRetryDelay(delay, signal);
      }

      throwIfSyncAborted(signal);
      const res = await createCompletionWithFallback(getClient(), params, requestOptions, 'sync');
      throwIfSyncAborted(signal);
      const choice = res.choices[0];
      const content = choice.message.content;

      // 请求+响应一起输出，保证每次调用的日志是完整的原子块
      console.log(requestLog);
      console.log(`[${providerLabel()} ← ${label}]`);
      const outputLimit = outputLogLimit(label);
      const outputText = content || '';
      console.log(outputLimit === Infinity ? outputText : outputText.slice(0, outputLimit));
      warnUsageAnomaly(label, messages, res.usage);
      logUsage(label, res.usage);
      recordLlmCall(label, res.usage);
      // 上下文面板：把真实 prompt_tokens 回填到当前会话的快照（标签不匹配时自动忽略）
      notePromptUsage(label, res.usage);
      console.log('═════════════════════════════════════════════\n');

      // 思考型网关把额度吃光时，正文为空。此时把额度放大重发一次（只一次）：
      // 同额度重试只会得到同样的空结果，所以不能走普通重试路径。
      if (isReasoningStarved(res.usage, content)) {
        const starved = params.max_tokens ?? params.max_completion_tokens;
        if (!Number.isFinite(starved) || starved < REASONING_STARVED_MIN_TOKENS) {
          console.warn(`[usage] ${label}: 思考吃光了 ${starved} tokens 的额度、正文为空，放大到 ${REASONING_STARVED_MIN_TOKENS} 重发一次`);
          const retryParams = { ...params, [params.max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens']: REASONING_STARVED_MIN_TOKENS };
          const retried = await createCompletionWithFallback(getClient(), retryParams, requestOptions, 'sync');
          const retryChoice = retried?.choices?.[0];
          const retryContent = retryChoice?.message?.content;
          if (typeof retryContent === 'string' && retryContent.trim()) {
            logUsage(label, retried.usage);
            recordLlmCall(label, retried.usage);
            console.log('═════════════════════════════════════════════\n');
            return { content: retryContent, finishReason: retryChoice.finish_reason ?? null };
          }
          console.warn(`[usage] ${label}: 放大额度后正文仍为空`);
        }
      }

      // finish_reason 只在 opts.returnMeta 时回传：调用方用它判断输出是不是被 max_tokens 砍断
      return { content, finishReason: choice.finish_reason ?? null };
    } catch (err) {
      throwIfSyncAborted(signal, err);
      lastError = err;
      const status = err?.status || err?.response?.status;
      const code = err?.code || err?.error?.code || '';
      const msg = err?.message || '';


      if (attempt < retries && isRetryableError(err)) {
        console.warn(
          `[${providerLabel()} ← ${label}] 失败 (status=${status}, code=${code}, msg=${msg}), ` +
          `准备重试 (${attempt + 1}/${retries})`
        );
        continue;
      }
      // 不可重试或已耗尽重试次数 → 抛出
      console.log(requestLog);
      // 2026-10-02（真机日志：`[replyQueue] Schedule refresh failed …: 404 404 page not found`）——
      // 网关的 404 只说"找不到"，**看不出是哪个地址/哪个模型**，用户根本无从排查。
      // 这里把生效的 model 与 baseURL 一起打出来：404 基本只有两种原因（地址写错 / 模型名不存在）。
      if (Number(status) === 404) {
        const effectiveModel = model || config.llm.model || 'deepseek-flash';
        console.error(`[${providerLabel()} ← ${label}] 404 定位信息：model=${effectiveModel}`
          + ` baseURL=${config.llm.baseURL || '(未配置)'}`
          + ` —— 404 通常是「API 地址不对」或「模型名不存在」；请到设置页核对这两项。`);
      }
      console.log(`[${providerLabel()} ← ${label}] ❌ 最终失败: status=${status}, code=${code}, msg=${msg}`);
      recordLlmCall(label, null, { failed: true });
      console.log('═════════════════════════════════════════════\n');
      throw err;
    }
  }
  throw lastError;
  } finally {
    if (limited) releaseSlot();
  }
}

/** 免费鸡蛋流式请求：依次尝试本轮尚未失败过的免费模型，每个模型只请求一次 */
async function* _chatStreamFreeEgg(messages, opts) {
  const candidates = freeEggCandidates();
  if (candidates.length === 0) {
    const err = new Error('free egg: all models already failed in this session');
    err.__freeEggFailover = true;
    throw err;
  }
  let lastError = null;
  for (const model of candidates) {
    if (!config.llm.freeEgg) {
      lastError = lastError || new Error('free egg disabled');
      lastError.__freeEggFailover = true;
      throw lastError;
    }
    // attemptYielded 必须声明在 try 之外：catch 块要读它。
    // 原先写在 try 内，let 的块作用域使 catch 里的读取必然抛 ReferenceError，
    // 于是"已输出内容就不再换模型"的守卫从未生效，真实错误也被替换成 "attemptYielded is not defined"。
    let attemptYielded = false;
    try {
      for await (const delta of _chatStreamInner(messages, { ...opts, model })) {
        attemptYielded = true;
        yield delta;
      }
      return;
    } catch (err) {
      lastError = err;
      if (recordFreeEggFailure(model, err)) {
        err.__freeEggFailover = true;
        throw err;
      }
      // 已输出过内容时不再换模型，避免同一回复拼接两段不同模型的输出
      if (attemptYielded) throw err;
    }
  }
  if (config.llm.freeEgg) {
    updateFreeEggEnabled(false);
    resetClient();
    _freeEggFailedModels.clear();
  }
  lastError.__freeEggFailover = true;
  throw lastError;
}

/**
 * 流式聊天（用于对话）
 * 外层包装：免费鸡蛋全部模型失败且尚未输出任何内容时，立即用恢复后的自有配置重发一遍；
 * 已输出过内容则不重发（避免重复输出），直接抛错
 * @returns {AsyncGenerator<string>}
 */
/**
 * 流式聊天（用于对话）
 * opts 额外支持 presence_penalty / frequency_penalty（不传 → 用 config.llm 的全局值；
 * 两者都为 null 时请求体里不出现这两个字段）。
 */
export async function* chatStream(messages, opts = {}) {
  messages = await compressLlmImageInputs(messages);
  // 同 chatSync：破限注入收口。opts.label 已经带了调用方标识（如 '私聊'/'群聊'），直接透传。
  messages = applyShield(messages, {
    label: opts.label || 'chatStream',
    target: opts.target !== undefined ? opts.target : resolveShieldTarget(opts.label),
  });
  let anyYielded = false;
  try {
    if (config.llm.freeEgg) {
      for await (const delta of _chatStreamFreeEgg(messages, opts)) {
        anyYielded = true;
        yield delta;
      }
    } else {
      for await (const delta of _chatStreamInner(messages, opts)) {
        anyYielded = true;
        yield delta;
      }
    }
  } catch (err) {
    if (!(err && err.__freeEggFailover && !anyYielded)) throw err;
    console.warn(`[free-egg] ▸ 立即改用自有配置重发本次请求 (${opts.label || 'stream'})`);
    for await (const delta of _chatStreamInner(messages, opts)) {
      yield delta;
    }
  }
}

async function* _chatStreamInner(messages, {
  model = config.llm.model || 'deepseek-flash',
  temperature = 0.7,
  thinking,
  presence_penalty: presencePenalty,
  frequency_penalty: frequencyPenalty,
  label = 'stream',
  signal, // AbortSignal：客户端断开时中止上游请求，避免空烧 token
} = {}) {
  if (config.features.mergeMessages) messages = mergeConsecutiveRoles(messages);
  if (_limitEnabled()) await acquireSlot();
  let total = '';

  try {
    console.log(`\n══════════ [${providerLabel()} → ${label}] ══════════`);
    // 压缩 ANIMA3 等超长模板的日志输出
    const logMsgs = compressLogMessages(messages);
    console.log(JSON.stringify(logMsgs, null, 2));
    console.log('────────────────────────────────────────────────');

    const params = {
      model,
      messages,
      temperature,
      stream: true,
    };
    // 反重复 penalty：默认 null ⇒ 不发送，请求体逐字节不变（见 resolveAntiRepetitionPenalties）
    Object.assign(params, resolveAntiRepetitionPenalties(presencePenalty, frequencyPenalty));

    const effectiveThinking = thinking === undefined ? configuredThinking() : thinking;
    if (effectiveThinking !== null) {
      params.thinking = effectiveThinking;
    }
    // 同 _chatSyncInner：部分网关只认 reasoning_effort
    const reasoningEffort = configuredReasoningEffort();
    if (reasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }

    // 流式 usage（缓存命中率）：末尾 chunk 携带。仅对官方 API 发送，
    // 第三方渠道可能不认识 stream_options 直接报错。
    if (isDeepseek()) {
      params.stream_options = { include_usage: true };
    }

    // 合并自定义请求体参数（extraBody 可覆盖上述默认值以适配自定义 API）
    const extraBody = config.llm.extraBody;
    if (extraBody && Object.keys(extraBody).length > 0) {
      Object.assign(params, extraBody);
    }
    // 上游 v3.10.0：最后统一确定输出额度（流式与同步同一口径）
    applyOutputTokenLimit(params);

    const stream = await createCompletionWithFallback(getClient(), params, { signal }, label);

    console.log(`[${providerLabel()} ← ${label} start]`);

    let usage = null;
    for await (const chunk of stream) {
      if (signal?.aborted) {
        // 客户端已断开：主动终止上游流，不再消耗后续 token
        stream.controller?.abort?.();
        break;
      }
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        total += delta;
        yield delta;
      }
    }

    console.log(`[${providerLabel()} ← ${label} end]`);
    const outputText = total || '(empty)';
    const outputLimit = outputLogLimit(label);
    console.log(outputLimit === Infinity ? outputText : outputText.slice(0, outputLimit));
    if (outputLimit !== Infinity && outputText.length > outputLimit) console.log(`... (${outputText.length} chars total, truncated)`);
    logUsage(label, usage);
    recordLlmCall(label, usage);
    // 上下文面板：流式 usage 是主回复的真实 prompt_tokens 来源
    notePromptUsage(label, usage);
    console.log('═══════════════════════════════════════════════\n');
  } catch (err) {
    // 客户端主动中断不是错误，静默返回
    if (signal?.aborted || err.name === 'AbortError') {
      console.log(`[${providerLabel()} ← ${label}] aborted by client`);
      return;
    }
    console.error(`[${providerLabel()} ← ${label}] stream error:`, err.message);
    recordLlmCall(label, null, { failed: true });
    throw err;
  } finally {
    if (_limitEnabled()) releaseSlot();
  }
}

/**
 * 生成文本嵌入（通过本地向量服务，不调 DeepSeek）
 * @deprecated 嵌入用本地向量服务，此函数仅作 fallback 标注
 *
 * ⚠️ 死导出（2026-10-15 标注，**只标注不删**）：全仓只有这一处定义，src / test 都没有调用点。
 * 真正在用的是 `services/vectorClient.js` 的 `embedText`（走 `fetchWithTimeout` + 统一错误处理）。
 * 保留原因：它是"向量服务不可用时的手工兜底路径"这一设计意图的落点，删掉会丢掉这段历史；
 * 真要清理时**两个一起看**（别只删这份，留下 vectorClient 那份还以为没有兜底）。
 */
export async function embedText(text) {
  const res = await fetch(`${config.vectorService.url}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Vector service error: ${res.status}`);
  const data = await res.json();
  return data.embedding;
}
