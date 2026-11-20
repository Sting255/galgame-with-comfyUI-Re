import crypto from 'crypto';
import { embedBatch } from '../vectorClient.js';
import { getMemorySettings } from './memoryConfig.js';

/**
 * 记忆嵌入 / 重排 provider 选择。
 *
 * 2026-11-16（P0-01）之前这里内置了一个 XOR 混淆的云端 provider（URL / 模型 / Key 都写在源码里，
 * 靠一个固定字符串异或解码）。那不是秘密存储：任何人拿到源码或交付包都能还原，
 * 而它当时还是默认链路，等于把共享凭据随包分发。现在已整段删除。
 *
 * 现行口径：
 *   1. 用户在设置页配了完整的自定义 provider → 用它；
 *   2. 没配 → 直接回落本地向量服务（vector-service 自带模型），不再有中间那层共享云服务。
 *
 * 回落不是降级故障：本地模型一直是最终兜底，只是以前要先烧掉一次内置服务的失败额度才走到这里。
 */

const LOCAL_PROFILE = Object.freeze({
  fingerprint: 'local_builtin',
  corpus: 'memory_fragments',
  source: 'local',
});

function endpoint(baseURL, suffix) {
  const normalized = String(baseURL || '').replace(/\/$/, '');
  if (normalized.endsWith(suffix)) return normalized;
  return `${normalized}${suffix}`;
}

function hasCredential(provider) {
  const headers = provider?.headers || {};
  return Boolean(provider?.apiKey || headers.Authorization || headers.authorization);
}

function isCompleteUserProvider(provider) {
  if (!provider?.enabled || !provider.baseURL || !provider.model || !hasCredential(provider)) return false;
  try { new URL(provider.baseURL); return true; } catch { return false; }
}

function profileFor(provider, source) {
  if (source === 'local') return LOCAL_PROFILE;
  const raw = JSON.stringify({ source, provider: provider.provider, baseURL: provider.baseURL, model: provider.model, dimensions: provider.dimensions || null });
  const fingerprint = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return { fingerprint, corpus: `memory_v2_${fingerprint}`, source };
}

async function postJson(url, body, provider) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', ...provider.headers };
    if (provider.apiKey && !headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${provider.apiKey}`;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || data.detail || `HTTP ${response.status}`);
    return { data, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function requestEmbeddings(texts, provider, source) {
  const body = { model: provider.model, input: texts };
  if (provider.dimensions && provider.provider !== 'siliconflow') body.dimensions = provider.dimensions;
  const { data, elapsedMs } = await postJson(endpoint(provider.baseURL, '/embeddings'), body, provider);
  const ordered = [...(data.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const embeddings = ordered.map(item => item.embedding);
  if (embeddings.length !== texts.length || embeddings.some(value => !Array.isArray(value) || value.length === 0)) {
    throw new Error('嵌入接口返回的向量数量或格式无效');
  }
  return { profile: profileFor(provider, source), embeddings, source, elapsedMs };
}

/**
 * 当前生效的嵌入 profile。
 * kind 参数保留是为了兼容既有调用签名（embedding / embedding_index / reranker），
 * 但已不再参与判断——内置服务删除后，只有「用户自定义」与「本地」两种结果。
 */
export function getPreferredMemoryEmbeddingProfile(settings = getMemorySettings({ includeSecrets: true })) {
  if (isCompleteUserProvider(settings.embedding)) return profileFor(settings.embedding, 'user');
  return LOCAL_PROFILE;
}

export async function embedMemoryTexts(texts, settings = getMemorySettings({ includeSecrets: true }), options = {}) {
  const { timeoutMs } = options;
  const userProvider = settings.embedding;
  if (isCompleteUserProvider(userProvider)) {
    try {
      return await requestEmbeddings(texts, { ...userProvider, timeoutMs: timeoutMs || userProvider.timeoutMs }, 'user');
    } catch (error) {
      console.warn('[memory-provider] user embedding failed, falling back to local model:', error.message);
    }
  }

  // A null embedding asks the local vector service to run its bundled model.
  return { profile: LOCAL_PROFILE, embeddings: texts.map(() => null), source: 'local', elapsedMs: null };
}

export async function embedMemoryText(text, settings, options) {
  const result = await embedMemoryTexts([text], settings, options);
  return { profile: result.profile, embedding: result.embeddings[0], source: result.source, elapsedMs: result.elapsedMs };
}

/**
 * 重排 query 的长度上限（字符）。
 *
 * 2026-10-20 日志实证：群聊记录整段拼进 query 后，内置重排直接回
 * `Query is too long. Please provide a shorter query.`，整轮降级成无重排（hits 质量下降）。
 * 这里统一截断——保留开头（通常含最新一轮）而不是简单截尾。
 */
const RERANK_QUERY_MAX_CHARS = 1000;

function clampRerankQuery(query) {
  const text = String(query ?? '');
  if (text.length <= RERANK_QUERY_MAX_CHARS) return text;
  const head = text.slice(0, RERANK_QUERY_MAX_CHARS - 200);
  const tail = text.slice(-200);
  return `${head} … ${tail}`;
}

async function requestRerank(query, candidates, provider, source) {
  const topN = Math.min(provider.topN || 7, candidates.length);
  const { data, elapsedMs } = await postJson(endpoint(provider.baseURL, '/rerank'), {
    model: provider.model,
    query,
    documents: candidates.map(item => item.judgment),
    top_n: topN,
  }, provider);
  const results = data.results || [];
  if (!Array.isArray(results) || results.length === 0) throw new Error('重排序接口返回格式无效');
  return results
    .filter(item => Number.isInteger(item.index) && candidates[item.index])
    .map(item => ({ ...candidates[item.index], rerank_score: Number(item.relevance_score ?? item.score ?? 0), rerank_source: source, rerank_elapsed_ms: elapsedMs }));
}

async function localRerank(query, candidates, topN) {
  const startedAt = Date.now();
  const vectors = await embedBatch([query, ...candidates.map(item => item.judgment)]);
  if (!Array.isArray(vectors) || vectors.length !== candidates.length + 1) throw new Error('本地模型返回格式无效');
  const queryVector = vectors[0];
  return candidates
    .map((item, index) => ({ ...item, rerank_score: cosineSimilarity(queryVector, vectors[index + 1]), rerank_source: 'local', rerank_elapsed_ms: Date.now() - startedAt }))
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, Math.min(topN, candidates.length));
}

export async function rerankMemories(query, candidates, settings = getMemorySettings({ includeSecrets: true })) {
  if (candidates.length < 2) return candidates;
  // 超长 query 直接截断：重排接口会拒绝，降级比截断更亏（顺序不变但会丢掉语义信号）
  query = clampRerankQuery(query);
  const userProvider = settings.reranker;
  if (isCompleteUserProvider(userProvider)) {
    try {
      return await requestRerank(query, candidates, userProvider, 'user');
    } catch (error) {
      console.warn('[memory-provider] user reranker failed, falling back to local model:', error.message);
    }
  }

  return localRerank(query, candidates, settings.reranker.topN || settings.topK || 7);
}

export async function testEmbeddingProvider(settings) {
  if (!isCompleteUserProvider(settings.embedding)) throw new Error('请先开启并完整填写服务地址、模型名称和访问密钥');
  const result = await requestEmbeddings(['聊天记忆连接测试'], settings.embedding, 'user');
  return { ok: true, dimensions: result.embeddings[0].length, profile: result.profile.fingerprint };
}

export async function testRerankerProvider(settings) {
  if (!isCompleteUserProvider(settings.reranker)) throw new Error('请先开启并完整填写服务地址、模型名称和访问密钥');
  const candidates = [{ judgment: '用户喜欢咖啡' }, { judgment: '用户常用本地模型' }];
  const result = await requestRerank('用户喜欢喝什么', candidates, settings.reranker, 'user');
  return { ok: true, resultCount: result.length };
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
}
