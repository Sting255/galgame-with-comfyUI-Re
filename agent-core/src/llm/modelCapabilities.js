// Pure helpers shared by settings UI and server. No credentials, I/O or runtime config.
//
// 2026-11-07：上游 `/v1/models` 本来就带 `max_output_tokens` / `context_length`，
// 但后端只把 id 列表返回给前端，能力字段全丢了，前端那套 llmModelCapabilities 永远是空的，
// 于是额度只能退回下面这张硬编码表猜。真机实测（中转站 sz-yzg）：
//   cn:deepseek-v4.1-flash → 输出上限 393216、上下文 1000000
//   cn:deepseek-v4-pro     → 输出上限 393216、上下文 1000000
// 而硬编码表给 deepseek v4 族猜的是 32768 —— 少了 92%，还让日志打出
// 「300000 远超该模型常用上限 32768」这种误报，把人往更小的值上带。
// 现在：拿到过上游能力就记在进程内，defaultMaxTokens 优先按真实值算；没拿到才回落硬编码。
export const DEEPSEEK_MAX_TOKENS = 393216;
export const FALLBACK_MAX_TOKENS = 8192;

export function isValidMaxTokens(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const normalizeBaseURL = (baseURL) => String(baseURL || '').trim().replace(/\/+$/, '');

/**
 * 进程内记住上游声明过的能力：key = `baseURL|model`。
 * 不是缓存层，只是「这次获取模型列表时问到了，后面算额度时别装作不知道」。
 * 拿不到就继续用硬编码兜底，不会因为这里没有而阻塞任何调用。
 */
const upstreamCapabilities = new Map();

export function rememberUpstreamCapabilities(baseURL, capabilities) {
  const key = normalizeBaseURL(baseURL);
  if (!key || !capabilities || typeof capabilities !== 'object') return;
  for (const [model, cap] of Object.entries(capabilities)) {
    if (!model || !cap || typeof cap !== 'object') continue;
    if (!isValidMaxTokens(cap.maxTokens) && !isValidMaxTokens(cap.contextWindow)) continue;
    upstreamCapabilities.set(`${key}|${model}`, {
      ...(isValidMaxTokens(cap.maxTokens) ? { maxTokens: cap.maxTokens } : {}),
      ...(isValidMaxTokens(cap.contextWindow) ? { contextWindow: cap.contextWindow } : {}),
    });
  }
}

/** 查某个地址+模型上游声明过的能力（没问到返回 null） */
export function getUpstreamCapability(baseURL, model) {
  return upstreamCapabilities.get(`${normalizeBaseURL(baseURL)}|${model}`) || null;
}

/** 测试用：清掉记住的上游能力 */
export function clearUpstreamCapabilities() {
  upstreamCapabilities.clear();
}

export function defaultMaxTokens(baseURL = '', model = '') {
  // 上游明确说过就按它的来——这是唯一不靠猜的分支
  const known = getUpstreamCapability(baseURL, model);
  if (isValidMaxTokens(known?.maxTokens)) return known.maxTokens;
  try {
    if (new URL(baseURL).hostname === 'api.deepseek.com') return DEEPSEEK_MAX_TOKENS;
  } catch { /* incomplete custom URL */ }
  const name = String(model).toLowerCase();
  // Known text families; image/audio variants and unknown models use the conservative fallback.
  if (/gemini-(?:2\.5|3(?:\.\d+)?)-/.test(name) && !/image|audio|tts|live/.test(name)) return 65536;
  if (/deepseek-(?:flash|v4)/.test(name)) return 32768;
  return FALLBACK_MAX_TOKENS;
}

export function normalizeModelCapabilities(rows) {
  const result = Object.create(null);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || row.name || '').replace(/^models\//, '');
    if (!id) continue;
    // DeepSeek, Gemini native, OpenRouter and commonly used compatible endpoints.
    const maxTokens = [row.max_output_tokens, row.outputTokenLimit, row.max_completion_tokens,
      row.top_provider?.max_completion_tokens].find(isValidMaxTokens);
    // 上下文窗口各家字段名不同：中转常用 context_length / max_allowed_size，
    // OpenRouter 用 context_length，Llama 系自建服务用 max_model_len。
    const contextWindow = [row.context_length, row.max_allowed_size, row.max_context_length,
      row.context_window, row.max_model_len].find(isValidMaxTokens);
    if (!maxTokens && !contextWindow) continue;
    result[id] = {
      ...(maxTokens ? { maxTokens } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    };
  }
  return result;
}
