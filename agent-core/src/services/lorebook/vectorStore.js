import { hash } from './engine.js';

const cosine = (a, b) => {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return dot / (Math.sqrt(aa * bb) || 1);
};
const validVector = value => Array.isArray(value) && value.length > 0 && value.every(Number.isFinite);
function retain(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

/** Bound both network/response-body work and uncooperative provider promises. */
async function bounded(work, timeoutMs, message) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(message)); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}

export function createLorebookVectorStore({ embedBatch, embedText, queryTimeoutMs = 1500, indexTimeoutMs = 30000, retryMs = 30000 }) {
  const indexes = new Map(), vectors = new Map(), pending = new Map(), failures = new Map();
  const describe = book => {
    const entries = Object.values(book.document.entries).filter(e => !e.disable && (e.vectorized || book.settings.vectorAll));
    // Include IDs, not revision: resaving reuses the index; changing an ID never
    // returns a stale UID. Content vectors are reusable across book edits.
    return { entries, key: `${book.worldId}:${hash(entries.map(e => [String(e.uid), e.content]))}` };
  };
  const warm = book => {
    const { entries, key } = describe(book);
    if (indexes.has(key)) return Promise.resolve(indexes.get(key));
    if (pending.has(key)) return pending.get(key);
    const failure = failures.get(key);
    if (failure && Date.now() - failure.at < retryMs) return Promise.reject(new Error(failure.message));
    if (pending.size >= 4) return Promise.reject(new Error('世界书向量索引队列繁忙，本次使用关键词匹配'));
    if (entries.length > 4096) return Promise.reject(new Error('世界书向量条目超过 4096 条，本次使用关键词匹配'));
    const job = bounded(async signal => {
      const byContent = new Map(entries.map(e => [hash(e.content), e.content]));
      const resolved = new Map(), missing = [];
      for (const [key, content] of byContent) {
        if (vectors.has(key)) resolved.set(key, vectors.get(key)); else missing.push([key, content]);
      }
      for (let i = 0; i < missing.length; i += 16) {
        signal.throwIfAborted();
        const batch = missing.slice(i, i + 16);
        const result = await embedBatch(batch.map(([, content]) => content), { signal, timeoutMs:indexTimeoutMs });
        signal.throwIfAborted();
        if (!Array.isArray(result) || result.length !== batch.length || !result.every(validVector)) throw new Error('世界书向量返回格式无效');
        batch.forEach(([key], j) => { resolved.set(key, result[j]); retain(vectors, key, result[j], 4096); });
      }
      return entries.map(e => ({ id:String(e.uid), vector:resolved.get(hash(e.content)) }));
    }, indexTimeoutMs, '世界书向量索引构建超时').then(index => {
      retain(indexes, key, index, 4);
      failures.delete(key);
      return index;
    }).catch(error => {
      retain(failures, key, { at:Date.now(), message:error.message }, 32);
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  };
  return {
    warm,
    async recall(book, query) {
      if (!query.trim()) return [];
      const { entries, key } = describe(book);
      if (!entries.length) return [];
      const index = indexes.get(key);
      if (!index) {
        const failure = failures.get(key);
        if (failure && Date.now() - failure.at < retryMs) throw new Error(failure.message);
        // Cold requests never wait for a whole book. Concurrent callers share
        // this background job and use keyword matching until it finishes.
        void warm(book).catch(() => {});
        throw new Error('世界书向量索引正在后台准备，本次使用关键词匹配');
      }
      retain(indexes, key, index, 4);
      const vector = await bounded(signal => embedText(query, { signal, timeoutMs:queryTimeoutMs }), queryTimeoutMs, '世界书向量查询超时，本次使用关键词匹配');
      if (!validVector(vector)) throw new Error('世界书查询向量格式无效');
      return index.filter(e => e.vector.length === vector.length)
        .map(e => ({ id:e.id, score:cosine(vector, e.vector) }))
        .filter(e => e.score >= (book.settings.vectorThreshold ?? 0.3))
        .sort((a, b) => b.score - a.score).slice(0, book.settings.vectorMaxEntries || 5).map(e => e.id);
    },
  };
}
