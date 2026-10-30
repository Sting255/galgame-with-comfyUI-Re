import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { vectorSearch, upsertVectors, deleteVector, getImageKnowledgeCount } from './vectorClient.js';
import { isUserQuiet } from './imageSkill.js';

export const IMAGE_PROMPT_CORPUS = 'image_prompt_knowledge';
const RRF_K = 60;
const VECTOR_THRESHOLD = 0.22;
const MAX_PER_CATEGORY = 2;
const FRAMEWORK_KEYWORD_BOOST = 15;
const ADULT_RESCUE_SLOTS = 2;
const VECTOR_SYNC_BATCH_SIZE = 12;
export const RAG_TIMEOUT_DEFAULT_MS = 8000;
export const RAG_TIMEOUT_FAST_MS = 2500;
const VECTOR_FAILURE_LIMIT = 5;
const VECTOR_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
let vectorFailureCount = 0;
let vectorDisabledUntil = 0;
const SYNC_VERSION_SETTING_KEY = 'image_prompt_knowledge_synced_version';
const SYNC_CURSOR_SETTING_KEY = 'image_prompt_knowledge_sync_cursor';
const SYNC_BATCH_DELAY_MS = 50;
let persistedVersionLoaded = false;
let syncedVersion = null;
let syncCursor = null;
let syncPromise = null;

function parseScenes(value) {
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function parseExecutableTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => ({
        tag: String(item?.tag || '').trim(),
        label: String(item?.label || '').trim(),
        group: String(item?.group || '').trim(),
      }))
      .filter(item => item.tag);
  } catch {
    return [];
  }
}

function tokenize(text) {
  const normalized = String(text || '').toLowerCase();
  const latin = normalized.match(/[a-z0-9_()-]{2,}/g) || [];
  // 中文按固定 4 字切块会错过语料 key（如“穿地雷系...”错过“地雷系”）。
  // 使用滑动 n-gram 才能命中标签里的连续子串。
  const han = [...normalized.matchAll(/[\u3400-\u9fff]+/g)].flatMap(([word]) => {
    if (word.length === 1) return [word];
    const grams = [];
    for (let size = Math.min(4, word.length); size >= 2; size -= 1) {
      for (let index = 0; index <= word.length - size; index += 1) {
        grams.push(word.slice(index, index + size));
      }
    }
    return grams;
  });
  return [...new Set([...latin, ...han])];
}

function rowToItem(row) {
  return {
    id: row.knowledge_id,
    category: row.category,
    title: row.title,
    content: row.content,
    executableTags: parseExecutableTags(row.executable_tags),
    searchTerms: row.search_terms || '',
    scenes: parseScenes(row.scenes),
    isDefault: Boolean(row.is_default),
    priority: row.priority,
    version: row.version,
  };
}

function sceneMatches(row, scene) {
  const scenes = parseScenes(row.scenes);
  return !scene || scenes.length === 0 || scenes.includes(scene);
}

// ── 成人类目闸门已整条拆除（2026-10-21，用户裁定「聊天出图不要有任何审查限制」）─────────
//
// 旧口径（2026-09-02 → 2026-10-21）：`adult_*` 类目只有 query 命中
// `EXPLICIT_ADULT_PATTERN` 露骨词表时才允许召回；`pose.pr24.*`（84 条体位）在
// 10-21 那次先被单独豁免。真机反馈是**画面和对话对不上**：对话本身写得含蓄、
// 或只有「她继续」这种短句时，露骨词表一条都不命中 ⇒ 整个体位/解剖词库被整类屏蔽
// ⇒ 英文画面描述里已经写了性行为，尾巴上却补不到任何体位/身体细节 tag。
//
// 现在的口径：**成人内容不再参与检索准入判断**，只保留「相关性」——
//   ① 关键词召回必须真的命中（`score > 0`）；
//   ② 向量召回必须过 `VECTOR_THRESHOLD`；
//   ③ `pose.pr24.*` 另加体位意图词约束（见 `POSE_INTENT_RE`，那是防日常照片被
//      体位词污染，不是内容封禁）。
// 所以日常照片不会平白冒出体位标签，而露骨语境一律拿得到全套成人词库。
//
// ⚠️ 不要恢复这条闸门：`test/imagePromptAdultRetrieval.test.js` 钉住了
// 「非露骨 query 也能召回成人词库」与「日常 query 仍不追加成人 tag」两条边界。

/**
 * 体位意图词表：query 里没有这些词时，84 条体位（`pose.pr24.*`）不参与检索。
 *
 * 为什么需要：`standing` / `girl` 这类词在 84 条标签里高频出现，
 * 一句日常照片描述（`girl standing in a classroom`）会召回 31 条体位，把普通配图污染成体位图。
 * 这条约束只针对**相关性**，不涉及成人内容封禁（成人闸门 2026-10-21 已整条拆除）。
 */
const POSE_INTENT_RE = /体位|姿势|体式|性交|做爱|做愛|性爱|插|抽送|后入|骑乘|跪|趴|跨|张开腿|缠|合体|交合|口交|乳交|足交|手交|指交|肛|舔|射|潮吹|高潮|penetrat\w*|doggystyle|missionary|cowgirl|paizuri|fellatio|deepthroat|blowjob|handjob|fingering|cunnilingus|creampie|sex|nude|naked|nsfw|pose|position/i;

export function keywordSearchImagePromptKnowledge(query, { scene = 'chat', limit = 20, db = getDb() } = {}) {
  const terms = tokenize(query);
  const rows = db.prepare(`SELECT * FROM image_prompt_knowledge WHERE is_active = 1`).all();
  return rows
    .filter(row => sceneMatches(row, scene))
    .map(row => {
      const title = row.title.toLowerCase();
      const searchTerms = row.search_terms.toLowerCase();
      const content = row.content.toLowerCase();
      // `pose.pr24.*`（84 条体位）只按 searchTerms / title 匹配，**不按 content 匹配**：
      // 那些条目的 content 是英文画面模板（`the girl is lying on her back…`），
      // 一句普通的 `girl standing in a classroom` 会靠 `girl` 命中全部 84 条（实测 48/50）。
      // 这不是"过滤体位"，是修掉"通用词命中正文"造成的假召回。
      // `pose.pr24.*`（84 条体位）走**更严格**的匹配：
      //   ① 不看 content（内容是英文画面模板，`girl` 之类的通用词会命中全部 84 条）；
      //   ② 英文词按 **token 完全相等**匹配（不是子串）：否则 `includes('a')`、`includes('in')`
      //      会让任何英文 query 召回几乎全部体位（实测 45/50）；短于 3 字符的英文词直接忽略；
      //   ③ 中文仍允许子串 —— tokenize 对中文切的是 2-gram，靠子串才能命中「从后面插进来 → 后入」；
      //   ④ **必须带体位意图**（见 POSE_INTENT_RE）：一句「girl standing in a classroom」虽然含
      //      `standing`，但那是日常照片描述，不该把 84 条体位召进普通配图。
      // 这不是"过滤体位"：用户裁定的「不过滤」指的是不因成人内容封禁数据（成人闸门已拆除），
      // 这里约束的是**相关性**，体位/性行为语境下照样全额可用。
      const isPose = String(row.knowledge_id).startsWith('pose.pr24.');
      if (isPose && !POSE_INTENT_RE.test(query)) return null;
      const poseTokens = isPose ? new Set(searchTerms.split(/\s+/).filter(Boolean)) : null;
      let score = row.is_default ? 0.05 : 0;
      let matched = false;
      for (const term of terms) {
        if (isPose) {
          if (/^[a-z0-9_-]+$/i.test(term)) {
            if (term.length < 3) continue;
            if (poseTokens.has(term)) { score += 3; matched = true; }
            continue;
          }
          if (searchTerms.includes(term)) { score += 3; matched = true; }
          else if (title.includes(term)) { score += 2; matched = true; }
          continue;
        }
        if (searchTerms.includes(term)) { score += 3; matched = true; }
        if (title.includes(term)) { score += 2; matched = true; }
        if (content.includes(term)) { score += 1; matched = true; }
      }
      if (matched && !row.knowledge_id.startsWith('ipk.lib.')) score += FRAMEWORK_KEYWORD_BOOST;
      return { ...rowToItem(row), score };
    })
    .filter(item => item && item.score > 0)
    .sort((a, b) => b.score - a.score || b.priority - a.priority)
    .slice(0, limit);
}

function loadPersistedVersion(db) {
  persistedVersionLoaded = true;
  try {
    syncedVersion = db.prepare(
      `SELECT setting_value FROM system_settings WHERE setting_key = ?`
    ).pluck().get(SYNC_VERSION_SETTING_KEY) || null;
  } catch (error) {
    syncedVersion = null;
  }
}

function persistSyncVersion(db, version) {
  db.prepare(`
    INSERT INTO system_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `).run(SYNC_VERSION_SETTING_KEY, version);
  syncedVersion = version;
}

function loadSyncCursor(db) {
  try {
    const raw = db.prepare(
      `SELECT setting_value FROM system_settings WHERE setting_key = ?`
    ).pluck().get(SYNC_CURSOR_SETTING_KEY);
    syncCursor = raw ? JSON.parse(raw) : null;
  } catch (error) {
    syncCursor = null;
  }
}

function persistSyncCursor(db, cursor) {
  db.prepare(`
    INSERT INTO system_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `).run(SYNC_CURSOR_SETTING_KEY, JSON.stringify(cursor));
  syncCursor = cursor;
}

function clearSyncCursor(db) {
  try {
    db.prepare(`DELETE FROM system_settings WHERE setting_key = ?`).run(SYNC_CURSOR_SETTING_KEY);
  } catch (error) {
    console.warn('[imagePromptKnowledge] clear sync cursor failed:', error.message);
  }
  syncCursor = null;
}

const sleepSyncDelay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function computeKnowledgeVersion(db) {
  const rows = db.prepare(`SELECT * FROM image_prompt_knowledge WHERE is_active = 1 ORDER BY knowledge_id`).all();
  const staleIds = db.prepare(`
    SELECT knowledge_id FROM image_prompt_knowledge
    WHERE is_active = 0 AND knowledge_id LIKE 'ipk.lib.%'
    ORDER BY knowledge_id
  `).pluck().all();
  return [
    ...rows.map(row => `${row.knowledge_id}:${row.version}:${row.updated_at}`),
    ...staleIds.map(id => `stale:${id}`),
  ].join('|');
}

async function syncKnowledgeVectors(db = getDb(), timeoutMs = config.vectorService.defaultTimeoutMs) {
  const rows = db.prepare(`SELECT * FROM image_prompt_knowledge WHERE is_active = 1 ORDER BY knowledge_id`).all();
  const staleIds = db.prepare(`
    SELECT knowledge_id FROM image_prompt_knowledge
    WHERE is_active = 0 AND knowledge_id LIKE 'ipk.lib.%'
    ORDER BY knowledge_id
  `).pluck().all();
  const version = [
    ...rows.map(row => `${row.knowledge_id}:${row.version}:${row.updated_at}`),
    ...staleIds.map(id => `stale:${id}`),
  ].join('|');
  if (!persistedVersionLoaded) {
    loadPersistedVersion(db);
    loadSyncCursor(db);
  }
  if (syncedVersion === version) return;
  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
    const currentSeedVersion = db.prepare(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'image_prompt_knowledge_version'`
    ).pluck().get() || '';

    // 游标仅在“知识库内容未变、同步未完成”时有效，否则丢弃重来
    if (syncCursor && syncCursor.seedVersion !== currentSeedVersion) syncCursor = null;
    if (syncedVersion && syncedVersion !== version) {
      syncCursor = null;
      clearSyncCursor(db);
    }

    // 首次运行（无持久化版本、无游标）且向量库已有完整数据且知识库版本一致 → 直接标记已同步
    if (!syncedVersion && !syncCursor) {
      const knownCount = await getImageKnowledgeCount();
      if (Number.isInteger(knownCount) && knownCount >= rows.length) {
        persistSyncVersion(db, version);
        return;
      }
    }

    for (const id of staleIds) {
      await deleteVector(id, IMAGE_PROMPT_CORPUS);
    }

    const vectorItems = rows.map(row => ({
      chroma_id: row.knowledge_id,
      text: `${row.title}\n${row.search_terms}\n${row.content}`,
      metadata: {
        category: row.category,
        version: row.version,
        priority: row.priority,
      },
      fragment_type: null,
    }));
    const startFrom = syncCursor ? syncCursor.lastId : null;
    for (let offset = 0; offset < vectorItems.length; offset += VECTOR_SYNC_BATCH_SIZE) {
      const batch = vectorItems.slice(offset, offset + VECTOR_SYNC_BATCH_SIZE);
      const toWrite = startFrom ? batch.filter(item => item.chroma_id > startFrom) : batch;
      if (toWrite.length > 0) {
        await upsertVectors(toWrite, IMAGE_PROMPT_CORPUS, timeoutMs);
        const lastWrittenId = toWrite[toWrite.length - 1].chroma_id;
        persistSyncCursor(db, { lastId: lastWrittenId, seedVersion: currentSeedVersion });
        await sleepSyncDelay(SYNC_BATCH_DELAY_MS);
      }
    }
    clearSyncCursor(db);
    persistSyncVersion(db, version);
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

function fuseRrf(keywordItems, vectorItems, rowsById) {
  const scores = new Map();
  const add = (id, rank, weight) => scores.set(id, (scores.get(id) || 0) + weight / (RRF_K + rank + 1));
  keywordItems.forEach((item, rank) => add(item.id, rank, 1));
  vectorItems.forEach((item, rank) => add(item.id, rank, 1));

  return [...scores.entries()]
    .map(([id, score]) => {
      const item = rowsById.get(id);
      return item ? { ...item, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.priority - a.priority);
}

// 成人 query 下，角色词（如「初音未来」）的 n-gram 命中常把无关组顶进 topN，而体位等
// 纯 keyword 召回的 adult 组可能被向量侧条目 + priority 决胜整体挤出配额。
// 对融合结果中完全缺席的成人类目，从 keyword 召回里补一个最佳条目作保底位。
//
// 2026-10-21：`containsExplicitAdultContent(query)` 的前置判断一并去掉（成人闸门已拆）。
// 现在只要 keyword 召回里**真的出现了** adult_* 条目（= 已过相关性匹配），就该保住它，
// 不再要求 query 命中露骨词表 —— 否则"对话含蓄、画面露骨"的那种轮次仍然拿不到词库。
export function collectAdultRescueItems(query, fused, keywordItems, { maxSlots = ADULT_RESCUE_SLOTS } = {}) {
  const adultKeywordItems = keywordItems.filter(item => String(item.category || '').startsWith('adult_'));
  if (adultKeywordItems.length === 0) return [];
  const fusedAdultCategories = new Set(
    fused.filter(item => String(item.category || '').startsWith('adult_')).map(item => item.category)
  );
  const rescuedCategories = new Set();
  const rescued = [];
  for (const item of keywordItems) {
    if (!String(item.category || '').startsWith('adult_')) continue;
    if (fusedAdultCategories.has(item.category) || rescuedCategories.has(item.category)) continue;
    rescuedCategories.add(item.category);
    rescued.push(item);
    if (rescued.length >= maxSlots) break;
  }
  return rescued;
}

function applyCategoryQuota(items, defaults, limit, reservedItems = []) {
  const selected = [];
  const ids = new Set();
  const counts = new Map();
  const add = item => {
    if (!item || ids.has(item.id) || selected.length >= limit) return;
    const count = counts.get(item.category) || 0;
    if (count >= MAX_PER_CATEGORY) return;
    selected.push(item);
    ids.add(item.id);
    counts.set(item.category, count + 1);
  };

  reservedItems.forEach(add);
  items.forEach(add);
  defaults.sort((a, b) => b.priority - a.priority).forEach(add);
  return selected;
}

export async function retrieveImagePromptKnowledge(query, { scene = 'chat', limit = 9, db = getDb(), timeoutMs = RAG_TIMEOUT_DEFAULT_MS } = {}) {
  const startedAt = performance.now();
  const rows = db.prepare(`SELECT * FROM image_prompt_knowledge WHERE is_active = 1`).all();
  const sceneRows = rows.filter(row => sceneMatches(row, scene));
  const rowsById = new Map(sceneRows.map(row => [row.knowledge_id, rowToItem(row)]));
  const keywordItems = keywordSearchImagePromptKnowledge(query, { scene, limit: limit * 3, db });
  let vectorItems = [];
  let mode = 'keyword';
  let degraded = null;
  const vectorDisabled = Date.now() < vectorDisabledUntil;
  if (!persistedVersionLoaded) loadPersistedVersion(db);
  const vectorReady = syncedVersion === computeKnowledgeVersion(db);

  if (vectorDisabled) {
    degraded = 'cooldown';
  } else if (!vectorReady) {
    // 向量库尚未同步完成：不阻塞生图，直接本地 keyword 检索；同步由后台调度器在用户安静时执行
    degraded = 'pending-sync';
  } else {
    try {
      const results = await vectorSearch(query, { topK: limit * 3, corpus: IMAGE_PROMPT_CORPUS, timeoutMs });
      vectorItems = results
        .filter(result => result.score >= VECTOR_THRESHOLD && rowsById.has(result.id))
        .map(result => ({ ...rowsById.get(result.id), score: result.score }));
      mode = 'hybrid';
      if (vectorFailureCount > 0) vectorFailureCount = 0;
    } catch (error) {
      vectorFailureCount += 1;
      console.warn(`[imagePromptKnowledge] vector fallback (${vectorFailureCount}/${VECTOR_FAILURE_LIMIT}): ${error.message}`);
      if (vectorFailureCount >= VECTOR_FAILURE_LIMIT) {
        vectorFailureCount = 0;
        vectorDisabledUntil = Date.now() + VECTOR_FAILURE_COOLDOWN_MS;
        degraded = 'disabled';
        console.warn(`[imagePromptKnowledge] vector search disabled for ${VECTOR_FAILURE_COOLDOWN_MS / 1000}s`);
      } else {
        degraded = degraded || 'fallback';
      }
    }
  }

  const fused = fuseRrf(keywordItems, vectorItems, rowsById);
  const defaults = sceneRows.filter(row => row.is_default).map(rowToItem);
  const rescueItems = collectAdultRescueItems(query, fused, keywordItems);
  const items = applyCategoryQuota(fused, defaults, limit, rescueItems);
  return {
    mode,
    degraded,
    durationMs: Math.round(performance.now() - startedAt),
    scene,
    query,
    items,
    knowledgeIds: items.map(item => item.id),
    knowledgeVersion: [...new Set(items.map(item => item.version))].join(','),
  };
}

let syncSchedulerTimer = null;
let syncCheckInFlight = false;
const SYNC_CHECK_INTERVAL_MS = 60 * 1000;

export function startKnowledgeSyncScheduler() {
  if (syncSchedulerTimer) return;
  console.log('[imagePromptKnowledge] sync scheduler started (runs when user is quiet)');
  setTimeout(syncTick, 15 * 1000);
  syncSchedulerTimer = setInterval(syncTick, SYNC_CHECK_INTERVAL_MS);
}

async function syncTick() {
  if (syncCheckInFlight || syncPromise) return;
  syncCheckInFlight = true;
  try {
    const db = getDb();
    if (!persistedVersionLoaded) {
      loadPersistedVersion(db);
      loadSyncCursor(db);
    }
    if (syncedVersion === computeKnowledgeVersion(db)) return;
    if (!isUserQuiet()) return;
    await syncKnowledgeVectors(db);
  } catch (error) {
    console.warn(`[imagePromptKnowledge] background sync failed: ${error.message}`);
  } finally {
    syncCheckInFlight = false;
  }
}
