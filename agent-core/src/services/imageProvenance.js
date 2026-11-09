/**
 * 图片来源快照（2026-11-09，方案 A04）
 *
 * ── 解决什么问题 ──
 *
 * 「重新生成」原来只按文件名反查数据库里的 prompt，再用**当前**全局配置（画风串、全局 LoRA、
 * 宽高）重画一遍。于是同一张图重生成两次可能长得很不一样，用户也无法知道原图到底用了什么。
 * 更糟的是排队期间用户改了全局设置：任务提交时看到的是 A，执行时用的是 B。
 *
 * ── 设计口径 ──
 *
 * · 快照在**任务提交那一刻**采集，随任务一起传下去，排队多久都不会被后来的全局改动污染。
 * · 只记能重放画面所需的配置，不记 Key、请求头、内部路径等无关内容。
 * · 区分「角色 LoRA」与「全局 LoRA」来源：重生成默认沿用角色身份与角色 LoRA；
 *   是否换用当前全局画风由用户明确选择，不静默替换。
 * · 版本化：`version` 变更时读取端按可恢复数据回退，不假装能精确还原。
 * · 不承诺「除随机种子外完全还原」—— 全局 LoRA 刷新、自定义节点版本变化都会带来差异。
 *
 * ── 存放位置 ──
 *
 * 绑定在规范完整资源路径（`/images/<dir>/<file>`）上，存在 `image_provenance` 表。
 * 不用旁路 sidecar 文件：那会和数据库各成一套真源，图片被移动/删除后两边必然打架。
 */

import { getDb } from '../db/index.js';

/** 当前快照版本。结构有不兼容变化时 +1，读取端据此决定能否重放。 */
export const PROVENANCE_VERSION = 1;

/** 一次生成最多记多少个 LoRA（防止异常数据把行撑爆） */
const MAX_LORA_ENTRIES = 40;

/** 单条提示词字段最大长度（超出截断，来源记录不该拖垮数据库） */
const MAX_TEXT = 8000;

function clip(value, max = MAX_TEXT) {
  const s = typeof value === 'string' ? value : '';
  return s.length > max ? s.slice(0, max) : s;
}

/** LoRA 归一化：只留重放需要的字段，去掉内部路径之外的杂物 */
function normalizeLora(entry, source) {
  if (!entry) return null;
  const path = typeof entry === 'string' ? entry : entry.path;
  if (!path || typeof path !== 'string') return null;
  const weight = Number(typeof entry === 'object' ? entry.weight : NaN);
  return {
    path: clip(path, 500),
    name: clip(String((typeof entry === 'object' && (entry.name || entry.file)) || path.split(/[\\/]/).pop() || ''), 200),
    weight: Number.isFinite(weight) ? weight : null,
    triggerWord: clip(String((typeof entry === 'object' && entry.triggerWord) || ''), 300),
    source,   // 'character' | 'global'
  };
}

/**
 * 采集一份来源快照。
 *
 * 在**生成开始前**调用（此时全局配置就是本次实际要用的），生成结束后把返回对象
 * 连同产物路径一起交给 `saveImageProvenance`。
 *
 * @param {object} spec
 * @param {string} spec.promptOriginal 调用方传入的原始画面描述
 * @param {string} [spec.promptRefined] 经 RAG/优化后真正送进 CLIP 的描述
 * @param {string} [spec.workflowMode] 实际使用的工作流模式（wfMode）
 * @param {string} [spec.workflowFile] 工作流文件名（不含绝对路径）
 * @param {boolean} [spec.customWorkflow] 是否走了角色自定义工作流
 * @param {string} [spec.artist] 画师串
 * @param {number} [spec.width]
 * @param {number} [spec.height]
 * @param {string} [spec.negativePrompt] 最终负面提示词（已合成角色负面）
 * @param {string} [spec.qualityPrompt]
 * @param {object} [spec.identity] 身份锚点信息 { characterId, anchor }
 * @param {Array}  [spec.characterLoras] 角色 LoRA
 * @param {Array}  [spec.globalLoras] 全局 LoRA（本次实际生效的那些）
 * @param {string} [spec.provider] 'comfyui' | 'novelai'
 * @returns {object} 版本化快照
 */
export function captureProvenance(spec = {}) {
  const characterLoras = (Array.isArray(spec.characterLoras) ? spec.characterLoras : [])
    .slice(0, MAX_LORA_ENTRIES)
    .map(l => normalizeLora(l, 'character'))
    .filter(Boolean);
  const globalLoras = (Array.isArray(spec.globalLoras) ? spec.globalLoras : [])
    .slice(0, MAX_LORA_ENTRIES)
    .map(l => normalizeLora(l, 'global'))
    .filter(Boolean);

  return {
    version: PROVENANCE_VERSION,
    provider: spec.provider === 'novelai' ? 'novelai' : 'comfyui',
    prompt: {
      original: clip(spec.promptOriginal),
      refined: clip(spec.promptRefined || spec.promptOriginal),
    },
    workflow: {
      mode: clip(String(spec.workflowMode || ''), 200),
      file: clip(String(spec.workflowFile || ''), 300),
      custom: spec.customWorkflow === true,
    },
    params: {
      artist: clip(String(spec.artist || '')),
      width: Number(spec.width) || null,
      height: Number(spec.height) || null,
      negative: clip(String(spec.negativePrompt || '')),
      quality: clip(String(spec.qualityPrompt || '')),
    },
    identity: spec.identity
      ? {
        characterId: Number(spec.identity.characterId) || null,
        anchor: clip(String(spec.identity.anchor || ''), 2000),
      }
      : null,
    loras: { character: characterLoras, global: globalLoras },
    // 记录「这次全局 LoRA 是本次采集时生效的那批」，不是"现在的全局配置"
    capturedAt: new Date().toISOString(),
  };
}

/** 建表（幂等，与仓库其它惰性迁移同一风格） */
export function ensureProvenanceTable(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_provenance (
      url TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      character_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_image_provenance_char ON image_provenance(character_id)');
}

/**
 * 保存/更新一张图的来源快照。
 *
 * 按**规范完整 URL**（去掉 query）绑定，与图库唯一键、删除结果集合同一口径。
 * 同一 URL 再次生成（覆盖原图）时更新为新快照 —— 旧图已经不存在了。
 */
export function saveImageProvenance(url, snapshot, db = getDb()) {
  if (!url || !snapshot) return false;
  const clean = String(url).replace(/\?.*$/, '');
  if (!clean.startsWith('/images/') && !clean.startsWith('/avatars/')) return false;
  try {
    ensureProvenanceTable(db);
    db.prepare(`
      INSERT INTO image_provenance (url, version, payload_json, character_id, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(url) DO UPDATE SET
        version = excluded.version,
        payload_json = excluded.payload_json,
        character_id = excluded.character_id,
        updated_at = datetime('now')
    `).run(
      clean,
      Number(snapshot.version) || PROVENANCE_VERSION,
      JSON.stringify(snapshot),
      Number(snapshot.identity?.characterId) || null,
    );
    return true;
  } catch (err) {
    // 来源记录失败绝不能把生图链路带崩
    console.warn('[provenance] 保存来源快照失败（忽略）:', err?.message || err);
    return false;
  }
}

/**
 * 读取一张图的来源快照。
 *
 * 读取端必须先看版本：结构不兼容时返回 `{ snapshot, compatible: false }`，
 * 调用方据此走「按可恢复数据回退」，而不是拿半截字段去重放。
 *
 * @returns {{ snapshot: object|null, compatible: boolean, reason?: string }}
 */
export function readImageProvenance(url, db = getDb()) {
  const clean = String(url || '').replace(/\?.*$/, '');
  if (!clean) return { snapshot: null, compatible: false, reason: 'empty_url' };
  let row;
  try {
    ensureProvenanceTable(db);
    row = db.prepare('SELECT version, payload_json FROM image_provenance WHERE url = ?').get(clean);
  } catch (err) {
    return { snapshot: null, compatible: false, reason: err?.message || 'db_error' };
  }
  if (!row) return { snapshot: null, compatible: false, reason: 'no_record' };

  let snapshot;
  try { snapshot = JSON.parse(row.payload_json); } catch {
    return { snapshot: null, compatible: false, reason: 'corrupt_payload' };
  }
  if (!snapshot || typeof snapshot !== 'object') {
    return { snapshot: null, compatible: false, reason: 'corrupt_payload' };
  }
  if (Number(row.version) !== PROVENANCE_VERSION) {
    return { snapshot, compatible: false, reason: `version_mismatch:${row.version}` };
  }
  return { snapshot, compatible: true };
}

/** 图片被删除时清掉来源记录（不留孤儿行） */
export function deleteImageProvenance(url, db = getDb()) {
  const clean = String(url || '').replace(/\?.*$/, '');
  if (!clean) return false;
  try {
    ensureProvenanceTable(db);
    const r = db.prepare('DELETE FROM image_provenance WHERE url = ?').run(clean);
    return r.changes > 0;
  } catch {
    return false;
  }
}

/**
 * 重生成参数：从快照还原一份可用的生成选项。
 *
 * **只还原画面相关的东西**：提示词、工作流、宽高、角色身份与角色 LoRA、负面提示词。
 * 全局 LoRA 与画风串单独给出（`useCurrentGlobal` 决定），因为那属于「当前画风」而不是
 * 「这张图的身份」—— 让用户明确选择，不静默替换。
 *
 * 返回的两个 LoRA 数组要**分别**传给 generateImageRaw：
 *   · `characterLoras` → `loras` 参数
 *   · `globalLoraSnapshot` → `globalLoraSnapshot` 参数（buildWorkflow 用它覆盖当前全局 LoRA）
 * 沿用原图时把快照里的全局 LoRA 传进去，buildWorkflow 就不会再拿 `config.comfyui.globalLora`
 * 来污染这次重放。只传一个合并后的 loras 是错的：那会和当前全局叠加。
 *
 * @param {object} snapshot 已确认兼容的快照
 * @param {object} [opts]
 * @param {boolean} [opts.useCurrentGlobal] true=用当前全局画风/LoRA；默认 false=沿用快照记录
 * @param {Array} [opts.currentGlobalLoras] useCurrentGlobal 为 true 时可显式传入当前全局 LoRA
 * @param {string} [opts.currentArtist] useCurrentGlobal 为 true 时用当前画风串
 */
export function buildRegenerateOptions(snapshot, opts = {}) {
  if (!snapshot) return null;
  const useCurrent = opts.useCurrentGlobal === true;
  const characterLoras = snapshot.loras?.character || [];
  const globalLoras = useCurrent
    ? (Array.isArray(opts.currentGlobalLoras) ? opts.currentGlobalLoras : null)  // null = 让 buildWorkflow 自己读当前配置
    : (snapshot.loras?.global || []);

  return {
    promptText: snapshot.prompt?.refined || snapshot.prompt?.original || '',
    artist: useCurrent ? (opts.currentArtist ?? null) : (snapshot.params?.artist ?? null),
    width: snapshot.params?.width || null,
    height: snapshot.params?.height || null,
    negativePrompt: snapshot.params?.negative || '',
    qualityPrompt: snapshot.params?.quality || '',
    customWorkflow: snapshot.workflow?.custom ? (snapshot.workflow?.file || null) : null,
    workflowMode: snapshot.workflow?.mode || null,
    characterLoras,
    globalLoraSnapshot: globalLoras,
    characterId: snapshot.identity?.characterId || null,
    identityAnchor: snapshot.identity?.anchor || '',
  };
}

/**
 * 人类可读的缺失说明。
 *
 * 重放时如果引用的 LoRA / 工作流文件已经不在，要**说清缺哪一项**，
 * 不能静默换成当前角色或悄悄退回默认工作流 —— 那样出来的图跟原图毫无关系，
 * 用户却以为「重生成只是换了个种子」。
 */
export function describeProvenanceGaps(snapshot, { loraExists, workflowExists } = {}) {
  const gaps = [];
  if (!snapshot) return gaps;
  for (const l of [...(snapshot.loras?.global || []), ...(snapshot.loras?.character || [])]) {
    if (typeof loraExists === 'function' && l.path && !loraExists(l.path)) {
      gaps.push({ kind: 'lora', name: l.name || l.path, path: l.path });
    }
  }
  if (snapshot.workflow?.custom && snapshot.workflow?.file
      && typeof workflowExists === 'function' && !workflowExists(snapshot.workflow.file)) {
    gaps.push({ kind: 'workflow', name: snapshot.workflow.file, path: snapshot.workflow.file });
  }
  return gaps;
}
