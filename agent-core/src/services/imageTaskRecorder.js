import { getDb } from '../db/index.js';
import { saveImageProvenance, captureProvenance } from './imageProvenance.js';

/**
 * 来源快照落库的唯一入口（2026-11-09 方案 A04）。
 *
 * 优先用调用方传来的 `provenance`（来自 imageSkill._execute 的采集结果，含真实全局/角色
 * LoRA、身份锚点、负面提示词）；拿不到时用本函数已有的字段构造一份基础版。
 * 两者都写进**同一张表、同一个字段**，不产生互相冲突的第二真源。
 *
 * 绑定在 `outputPaths[0]`（规范完整资源路径）上，与图库唯一键、删除结果集合同一口径。
 */
function persistProvenance({ provenance, outputPaths, promptOriginal, promptRefined, style, resolution, workflowTemplate, conversationId }, db) {
  const url = Array.isArray(outputPaths) ? outputPaths.find(Boolean) : null;
  if (!url) return;
  let snapshot = provenance;
  if (!snapshot) {
    const charMatch = String(conversationId || '').match(/^char_(\d+)/);
    snapshot = captureProvenance({
      promptOriginal,
      promptRefined,
      workflowMode: workflowTemplate,
      artist: style,
      width: Number(String(resolution || '').split('x')[0]) || null,
      height: Number(String(resolution || '').split('x')[1]) || null,
      identity: charMatch ? { characterId: Number(charMatch[1]) } : null,
    });
  }
  saveImageProvenance(url, snapshot, db);
}

export function recordCompletedImageTask({
  conversationId = null,
  promptOriginal,
  promptRefined,
  outputPaths,
  style = null,
  resolution = null,
  workflowTemplate = null,
  provenance = null,
  db = getDb(),
}) {
  const paths = Array.isArray(outputPaths) ? outputPaths.filter(Boolean) : [];
  if (!promptOriginal || paths.length === 0) return null;
  const result = db.prepare(`
    INSERT INTO image_tasks (
      conversation_id, prompt_original, prompt_refined, style, resolution,
      workflow_template, status, output_paths, finished_at
    ) VALUES (?, ?, ?, ?, COALESCE(?, '1024x1024'), ?, 'done', ?, datetime('now'))
  `).run(
    conversationId,
    promptOriginal,
    promptRefined || promptOriginal,
    style,
    resolution,
    workflowTemplate,
    JSON.stringify(paths),
  );
  // 来源快照记账失败不能反过来把业务链路带崩（saveImageProvenance 内部已 try/catch）
  try {
    persistProvenance({ provenance, outputPaths: paths, promptOriginal, promptRefined, style, resolution, workflowTemplate, conversationId }, db);
  } catch { /* 忽略 */ }
  return Number(result.lastInsertRowid);
}

/**
 * 记录一次**失败**的生图任务（2026-10-01 补）。
 *
 * 出图失败原来只打一行 console.warn，库里一条痕迹都不留，事后分不出
 * ①根本没触发 ②触发了但失败 ③成功但文件后来丢了。代价只有一行 INSERT。
 *
 * @returns {number|null} 新行 id；没有 prompt 可记时返回 null
 */
export function recordFailedImageTask({
  conversationId = null,
  promptOriginal,
  promptRefined = null,
  errorMessage = null,
  style = null,
  resolution = null,
  workflowTemplate = null,
  db = getDb(),
}) {
  if (!promptOriginal) return null;
  try {
    const result = db.prepare(`
      INSERT INTO image_tasks (
        conversation_id, prompt_original, prompt_refined, style, resolution,
        workflow_template, status, output_paths, error_message, finished_at
      ) VALUES (?, ?, ?, ?, COALESCE(?, '1024x1024'), ?, 'failed', '[]', ?, datetime('now'))
    `).run(
      conversationId,
      promptOriginal,
      promptRefined || promptOriginal,
      style,
      resolution,
      workflowTemplate,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
    );
    return Number(result.lastInsertRowid);
  } catch (err) {
    // 记账失败绝不能反过来把业务链路带崩
    console.warn('[imageTaskRecorder] 记录失败任务时出错（忽略）:', err?.message || err);
    return null;
  }
}
