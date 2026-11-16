/**
 * 世界书向量检索（P1-17）。
 *
 * 与聊天记忆共用同一套 embedding provider，而不是各写一套。
 *
 * 原来的问题：这里直接用 `vectorClient.embedBatch/embedText`（本地向量服务自带模型），
 * 而聊天记忆走 `memoryProviders`（用户可配远端 provider）。两边各有一套 provider 与
 * 缓存失效规则，导致：
 *   · 用户配了远端嵌入后，世界书仍然只用本地模型（配置没生效）；
 *   · 世界书缓存键不含 provider 指纹，换模型后仍命中旧向量（语义空间不一致）。
 *
 * 现在的口径：
 *   1. 嵌入调用统一走 `memoryProviders.embedMemoryTexts`（provider 选择唯一入口）；
 *   2. 缓存键带上当前 provider 指纹（见 vectorStore 的 providerFingerprint）；
 *   3. 本地向量服务只是 provider 之一，不再是世界书的隐式默认。
 */
import { embedMemoryTexts, getPreferredMemoryEmbeddingProfile } from '../memory/memoryProviders.js';
import { createLorebookVectorStore } from './vectorStore.js';

/** 批量嵌入：返回纯向量数组，与 vectorStore 的期望形状一致 */
async function embedBatch(texts, options = {}) {
  const { signal, timeoutMs } = options;
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const result = await embedMemoryTexts(texts, undefined, { timeoutMs });
  if (!Array.isArray(result?.embeddings) || result.embeddings.length !== texts.length) {
    throw new Error('世界书嵌入返回数量不符');
  }
  // 本地回落时 embeddings 是 null（让向量服务自己编码），世界书这条链路必须拿到真实向量，
  // 所以遇到 null 就退回 vectorClient 的本地编码。
  if (result.embeddings.some(value => !Array.isArray(value))) {
    const { embedBatch: localBatch } = await import('../vectorClient.js');
    return localBatch(texts, options);
  }
  return result.embeddings;
}

/** 单条嵌入（vectorStore 只在少数路径用到） */
async function embedText(text, options = {}) {
  const [vector] = await embedBatch([text], options);
  return vector;
}

/** 当前生效的嵌入 provider 指纹（缓存键的一部分） */
function providerFingerprint() {
  try {
    return getPreferredMemoryEmbeddingProfile().fingerprint || 'local_builtin';
  } catch {
    return 'local_builtin';
  }
}

// Separate from the memory corpus. Restart after changing the embedding model.
const store = createLorebookVectorStore({ embedBatch, embedText, providerFingerprint });
export const recallLorebook = (book, query) => store.recall(book, query);
export const warmLorebook = book => store.warm(book);
