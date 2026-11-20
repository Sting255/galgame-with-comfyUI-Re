import { config } from '../config.js';

/**
 * 向量服务 HTTP 客户端
 *
 * 2026-11-09（方案 B06）改成**单一超时生命周期**：
 * 原来 `fetchWithTimeout` 只把 `fetch` 包进 timer，函数返回后 timer 就清了，
 * 而 `res.json()` / 错误体读取都由各导出函数在 timer 之外做 —— 服务端「响应头
 * 先回来、body 卡住」时这些请求会无限挂住，超时形同虚设。现在 fetch → 状态
 * 检查 → 读错误体 → 解析 JSON 全在同一个 timer 未清除的区间内完成。
 *
 * 调用方 signal 与超时 signal 用 AbortSignal.any 合并：任一方中止都能中断整个
 * 链路（包括正在读的 body）。预算按操作可覆盖，后台索引默认走宽松的
 * DEFAULT_TIMEOUT，不为了省时间把它压短。
 */
const BASE = config.vectorService.url;
// 主聊天流的 RAG 已由 chatMemoryRecall 用 2.5s race 限时；
// 这里统一使用宽松默认超时，避免后台记忆索引（upsert/delete）等被误杀。
const DEFAULT_TIMEOUT = config.vectorService.defaultTimeoutMs;
const HEALTH_TIMEOUT = 2500;

/**
 * 一次向量服务请求：fetch + 状态 + 错误体 + JSON 全在同一个超时内。
 * 空 body（部分 delete / health 兼容）返回 {}，不伪造成功数据。
 */
async function requestJson(path, { method = 'POST', body, timeoutMs = DEFAULT_TIMEOUT, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('vector request timeout')), timeoutMs);
  let combined = controller.signal;
  if (signal) {
    try { combined = AbortSignal.any([signal, controller.signal]); }
    catch { combined = controller.signal; }   // 极老环境无 AbortSignal.any 时退回超时信号
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combined,
    });
    // 状态检查、错误体读取、JSON 解析都在这里 —— timer 还没清，超时仍生效
    if (!res.ok) {
      const detail = await describeFailure(res);
      throw new Error(`${path} error: ${detail}`);
    }
    const raw = await res.text();
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 失败响应的可读描述：FastAPI 的校验错误是 {detail:[{loc,msg,input,...}]}，
 * 直接拼进模板串会变成 "[object Object]"，把真正的失败原因（比如语料白名单不匹配）吃掉。
 */
async function describeFailure(res) {
  const body = await res.json().catch(() => null);
  const detail = body?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (detail) return JSON.stringify(detail);
  return `HTTP ${res.status}`;
}

async function embedRequest(text, { signal, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  return requestJson('/embed', { body: { text }, signal, timeoutMs });
}

export async function embedText(text, options) {
  const data = await embedRequest(text, options);
  // 单文本返回第一个向量
  return data.embeddings?.[0] ?? data.embedding;
}

export async function embedBatch(texts, options) {
  const data = await embedRequest(texts, options);
  return data.embeddings;
}

export async function vectorSearch(text, {
  topK = 20, filterType = null, conversationId = null, corpus = 'memory_fragments',
  embedding = null, timeoutMs = DEFAULT_TIMEOUT, signal = null,
} = {}) {
  const data = await requestJson('/search', {
    body: { text, embedding, top_k: topK, filter_type: filterType, conversation_id: conversationId, corpus },
    timeoutMs, signal,
  });
  return data.results;
}

export async function upsertVector(chromaId, text, metadata = {}, fragmentType = null, corpus = 'memory_fragments', embedding = null, options = {}) {
  const data = await requestJson('/upsert', {
    body: {
      chroma_id: chromaId,
      text,
      embedding,
      metadata,
      fragment_type: fragmentType,
      corpus,
    },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    signal: options.signal ?? null,
  });
  return data.chroma_id;
}

export async function upsertVectors(items, corpus = 'memory_fragments', timeoutMs = DEFAULT_TIMEOUT, options = {}) {
  const data = await requestJson('/upsert-batch', {
    body: { items, corpus },
    timeoutMs,
    signal: options.signal ?? null,
  });
  return data.count;
}

export async function deleteVector(chromaId, corpus = 'memory_fragments', options = {}) {
  await requestJson('/delete', {
    body: { chroma_id: chromaId, corpus },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    signal: options.signal ?? null,
  });
  return true;
}

export async function deleteByConversation(conversationId, corpus = 'memory_fragments', options = {}) {
  const data = await requestJson('/delete-by-conversation', {
    body: { conversation_id: conversationId, corpus },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    signal: options.signal ?? null,
  });
  return data.deleted;
}

export async function getImageKnowledgeCount() {
  try {
    const data = await requestJson('/health', { method: 'GET', timeoutMs: HEALTH_TIMEOUT });
    return Number.isInteger(data.image_prompt_knowledge_count) ? data.image_prompt_knowledge_count : null;
  } catch {
    return null;
  }
}

export async function healthCheck() {
  try {
    const data = await requestJson('/health', { method: 'GET', timeoutMs: HEALTH_TIMEOUT });
    return data.status === 'ok';
  } catch {
    return false;
  }
}
