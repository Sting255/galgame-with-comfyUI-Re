import { Router } from 'express';
import { getDb } from '../db/index.js';
import { generateEventTypes, generateTopics, describeLibraryImage } from '../services/libraryGenerator.js';

const router = Router();

// ── 工具函数 ──

function toSnakeKey(raw) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toStringVal(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function parseFunFrom(raw) {
  if (Array.isArray(raw)) return raw.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim());
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim());
    } catch { /* not JSON, fall through to comma split */ }
    return raw.replace(/[，]/g, ',').split(',').map(f => f.trim()).filter(Boolean);
  }
  return [];
}

// key 兜底生成：优先从名称派生；纯中文或空名时用随机后缀保证唯一
function autoKey(name) {
  const base = toSnakeKey(name);
  if (base) return base;
  return `custom_evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// 对候选 key 做去重：冲突时追加序号
function dedupeKey(candidate, used) {
  let key = candidate;
  let n = 1;
  while (used.has(key)) key = `${candidate}_${n++}`;
  used.add(key);
  return key;
}

function eventTypeToApi(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    durationMin: row.duration_min,
    urgency: row.urgency,
    funFrom: parseFunFrom(row.fun_from),
    desc: row.desc,
    source: row.source,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function topicToApi(row) {
  return {
    id: row.id,
    name: row.name,
    desc: row.desc,
    source: row.source,
    // checked = 是否参与「自动抽取」（手动点题不受它限制）。老行没有该列时按 1（参与）兜底。
    checked: row.checked === undefined ? 1 : row.checked,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 话题判重是**按来源**的：同一个 name 允许在 default 与 custom 里各存在一条
 * （用户自定义话题可以与系统话题同名；表上的唯一索引是 `(name, source)`）。
 *
 * 2026-10-15 从「全表 name 唯一」改过来：原来的 `name TEXT NOT NULL UNIQUE`
 * 让"自定义话题与系统话题同名"直接插不进去（真机表现是建话题返回 409）。
 *
 * @param {object} db
 * @param {string} name
 * @param {string} source  'default' | 'custom'
 * @param {number} [excludeId]  编辑场景下要排除自己
 */
function findTopicDuplicate(db, name, source, excludeId = null) {
  return db.prepare(
    `SELECT id FROM moment_topics WHERE name = ? AND source = ? AND (? IS NULL OR id != ?)`
  ).get(name, source, excludeId, excludeId);
}

/** 克制的布尔归一：只有显式 false/'false'/0/'0' 才是关 */
function toBoolInt(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  return fallback;
}

// POST /api/library/describe-image — 参考图 → 场景方向（2026-10-13 合并上游 v3.9.0）
// Body: { image: dataURL, type: 'event-types'|'topics', direction?: string }
// 产出中文场景方向文本，供前端塞进 event-types/topics 的 generate 方向框
router.post('/describe-image', async (req, res) => {
  try {
    const direction = await describeLibraryImage(req.body || {});
    res.json({ direction });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[library] describe-image failed:', err.message);
    res.status(status).json({ error: 'describe_failed', message: err.message });
  }
});

// ──────────────── 奇遇事件类型库 ────────────────

// GET /api/library/event-types — 全部活动条目
router.get('/event-types', (req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM event_types WHERE is_active = 1 ORDER BY id`
  ).all();
  res.json(rows.map(eventTypeToApi));
});

// POST /api/library/event-types — 新建一条自定义事件类型
router.post('/event-types', (req, res) => {
  const name = toStringVal(req.body?.name);
  if (!name) return res.status(400).json({ error: 'invalid_name', message: 'name 不能为空' });

  const db = getDb();
  const used = new Set(db.prepare(`SELECT key FROM event_types`).all().map(r => r.key));
  const key = dedupeKey(toSnakeKey(req.body?.key) || autoKey(name), used);

  // 手动新增统一 60 分钟；批量生成时仍保留 LLM 给出的各自时长
  const durationMin = 60;
  const urgency = clampInt(req.body?.urgency, 1, 5, 1);
  const funFrom = parseFunFrom(req.body?.funFrom);
  const desc = toStringVal(req.body?.desc);

  const result = db.prepare(
    `INSERT INTO event_types (key, name, duration_min, urgency, fun_from, desc, source, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 'custom', 1)`
  ).run(key, name, durationMin, urgency, JSON.stringify(funFrom), desc);

  const row = db.prepare(`SELECT * FROM event_types WHERE id = ?`).get(result.lastInsertRowid);
  res.json(eventTypeToApi(row));
});

// PUT /api/library/event-types/:id — 更新（系统/自定义均可）
router.put('/event-types/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM event_types WHERE id = ? AND is_active = 1`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'event_type_not_found' });

  const body = req.body || {};
  const key = body.key !== undefined ? toSnakeKey(body.key) : row.key;
  const name = body.name !== undefined ? toStringVal(body.name, row.name) : row.name;
  const durationMin = body.durationMin !== undefined ? clampInt(body.durationMin, 1, 1440, row.duration_min) : row.duration_min;
  const urgency = body.urgency !== undefined ? clampInt(body.urgency, 1, 5, row.urgency) : row.urgency;
  const funFrom = body.funFrom !== undefined ? parseFunFrom(body.funFrom) : parseFunFrom(row.fun_from);
  const desc = body.desc !== undefined ? toStringVal(body.desc, row.desc) : row.desc;

  if (!key) return res.status(400).json({ error: 'invalid_key', message: 'key 不能为空' });
  if (!name) return res.status(400).json({ error: 'invalid_name', message: 'name 不能为空' });

  const dup = db.prepare(`SELECT id FROM event_types WHERE key = ? AND id != ?`).get(key, row.id);
  if (dup) return res.status(409).json({ error: 'duplicate_key', message: `key「${key}」已被其他条目使用` });

  db.prepare(
    `UPDATE event_types SET key = ?, name = ?, duration_min = ?, urgency = ?, fun_from = ?, desc = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(key, name, durationMin, urgency, JSON.stringify(funFrom), desc, row.id);

  const updated = db.prepare(`SELECT * FROM event_types WHERE id = ?`).get(row.id);
  res.json(eventTypeToApi(updated));
});

// DELETE /api/library/event-types/:id — 软删除
router.delete('/event-types/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare(
    `UPDATE event_types SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_active = 1`
  ).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'event_type_not_found' });
  res.json({ ok: true });
});

// POST /api/library/event-types/generate — LLM 生成一批（8 条，不落库）
router.post('/event-types/generate', async (req, res) => {
  try {
    const items = await generateEventTypes(req.body?.direction || '');
    res.json({ items });
  } catch (err) {
    console.error('[library] generate event-types failed:', err.message);
    res.status(500).json({ error: 'generate_failed', message: err.message });
  }
});

// POST /api/library/event-types/save-batch — 批量保存预览编辑后的条目（source=custom）
router.post('/event-types/save-batch', (req, res) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (rawItems.length === 0) return res.status(400).json({ error: 'empty_items', message: '没有要保存的条目' });

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO event_types (key, name, duration_min, urgency, fun_from, desc, source, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 'custom', 1)`
  );

  const used = new Set(
    db.prepare(`SELECT key FROM event_types`).all().map(r => r.key)
  );
  const saved = [];
  const errors = [];

  for (const it of rawItems) {
    const name = toStringVal(it.name);
    if (!name) { errors.push({ index: saved.length, error: 'invalid_name' }); continue; }
    const key = dedupeKey(toSnakeKey(it.key) || autoKey(name), used);

    const durationMin = clampInt(it.durationMin, 1, 1440, 20);
    const urgency = clampInt(it.urgency, 1, 5, 1);
    const funFrom = parseFunFrom(it.funFrom);
    const desc = toStringVal(it.desc);

    const result = insert.run(key, name, durationMin, urgency, JSON.stringify(funFrom), desc);
    const row = db.prepare(`SELECT * FROM event_types WHERE id = ?`).get(result.lastInsertRowid);
    saved.push(eventTypeToApi(row));
  }

  res.json({ saved, errors });
});

// ──────────────── 朋友圈话题库 ────────────────

// GET /api/library/topics — 全部活动条目
router.get('/topics', (req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM moment_topics WHERE is_active = 1 ORDER BY id`
  ).all();
  res.json(rows.map(topicToApi));
});

// POST /api/library/topics/set-checked — 批量勾选 / 取消勾选（{ ids: [...] } 或 { all: true }）
// 勾选只决定这条话题参不参与抽题，条目本身保留，随时能再勾回来（区别于 DELETE 的软删除）。
// 上游 v3.10.0 有、本地 2026-10-19 前整块缺失；本地 UI 目前走 PUT /topics/:id，两者并存不冲突。
router.post('/topics/set-checked', (req, res) => {
  const db = getDb();
  const checked = req.body?.checked ? 1 : 0;
  const all = req.body?.all === true;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!all && ids.length === 0) {
    return res.status(400).json({ error: 'empty_ids', message: '没有指定条目' });
  }

  const info = all
    ? db.prepare(`UPDATE moment_topics SET checked = ?, updated_at = CURRENT_TIMESTAMP WHERE is_active = 1`)
      .run(checked)
    : db.prepare(`UPDATE moment_topics SET checked = ?, updated_at = CURRENT_TIMESTAMP
                  WHERE id IN (${ids.map(() => '?').join(',')}) AND is_active = 1`)
      .run(checked, ...ids);

  res.json({ ok: true, checked, changed: info.changes });
});

// POST /api/library/topics — 新建一条自定义话题
// 判重按来源：与系统话题同名是允许的（同来源内重复才 409）
router.post('/topics', (req, res) => {
  const name = toStringVal(req.body?.name);
  if (!name) return res.status(400).json({ error: 'invalid_name', message: 'name 不能为空' });

  const db = getDb();
  if (findTopicDuplicate(db, name, 'custom')) {
    return res.status(409).json({ error: 'duplicate_name', message: `话题「${name}」已存在` });
  }

  const desc = toStringVal(req.body?.desc);
  const result = db.prepare(
    `INSERT INTO moment_topics (name, desc, source, checked, is_active) VALUES (?, ?, 'custom', ?, 1)`
  ).run(name, desc, toBoolInt(req.body?.checked, 1));

  const row = db.prepare(`SELECT * FROM moment_topics WHERE id = ?`).get(result.lastInsertRowid);
  res.json(topicToApi(row));
});

// PUT /api/library/topics/:id — 更新（系统/自定义均可）
// 判重按**该行原本的 source**：`source` 是只读字段，请求体里传了也不认
router.put('/topics/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM moment_topics WHERE id = ? AND is_active = 1`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'topic_not_found' });

  const body = req.body || {};
  const name = body.name !== undefined ? toStringVal(body.name, row.name) : row.name;
  const desc = body.desc !== undefined ? toStringVal(body.desc, row.desc) : row.desc;
  const checked = toBoolInt(body.checked, row.checked === undefined ? 1 : row.checked);

  if (!name) return res.status(400).json({ error: 'invalid_name', message: 'name 不能为空' });

  if (findTopicDuplicate(db, name, row.source, row.id)) {
    return res.status(409).json({ error: 'duplicate_name', message: `话题「${name}」已被同来源的其他条目使用` });
  }

  db.prepare(
    `UPDATE moment_topics SET name = ?, desc = ?, checked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(name, desc, checked, row.id);

  const updated = db.prepare(`SELECT * FROM moment_topics WHERE id = ?`).get(row.id);
  res.json(topicToApi(updated));
});

// DELETE /api/library/topics/:id — 软删除
router.delete('/topics/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare(
    `UPDATE moment_topics SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_active = 1`
  ).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'topic_not_found' });
  res.json({ ok: true });
});

// POST /api/library/topics/generate — LLM 生成一批（8 条，不落库）
router.post('/topics/generate', async (req, res) => {
  try {
    const items = await generateTopics(req.body?.direction || '');
    res.json({ items });
  } catch (err) {
    console.error('[library] generate topics failed:', err.message);
    res.status(500).json({ error: 'generate_failed', message: err.message });
  }
});

// POST /api/library/topics/save-batch — 批量保存预览编辑后的条目（source=custom）
//
// 判重口径（2026-10-15 改）：**只在该条目要落进的来源（custom）内部判重**。
// 以前用「全表已用名」当集合，于是「与系统话题同名」也被算成重名，加后缀从 `_1` 起跳；
// 新口径下同批两个同名条目应得到 `名字` + `名字_1`（第二批再得到 `_2`）。
// 数据库侧的唯一索引是 `(name, source)`，下面用 `存在就试下一个后缀` 的写法
// 与索引逐字对齐（不靠内存集合推进，避免集合与库里实际状态漂移）。
router.post('/topics/save-batch', (req, res) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (rawItems.length === 0) return res.status(400).json({ error: 'empty_items', message: '没有要保存的条目' });

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO moment_topics (name, desc, source, checked, is_active) VALUES (?, ?, 'custom', 1, 1)`
  );
  const nameTaken = db.prepare(`SELECT 1 FROM moment_topics WHERE name = ? AND source = 'custom'`);

  const saved = [];
  const errors = [];

  for (const it of rawItems) {
    const name = toStringVal(it.name);
    if (!name) { errors.push({ index: saved.length, error: 'invalid_name' }); continue; }
    // 同名被占 → 依次试 `name_1`、`name_2`… 直到空位（只在 custom 来源内判）
    let candidate = name;
    let n = 0;
    while (nameTaken.get(candidate)) candidate = `${name}_${++n}`;

    const desc = toStringVal(it.desc);
    const result = insert.run(candidate, desc);
    const row = db.prepare(`SELECT * FROM moment_topics WHERE id = ?`).get(result.lastInsertRowid);
    saved.push(topicToApi(row));
  }

  res.json({ saved, errors });
});

export default router;
