import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkWorkflowHealth, restoreWorkflow, ACTIVE_WORKFLOW, PRO_WORKFLOW } from '../services/workflowTemplates.js';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(__dirname, '..', '..', '..', 'workflow');

// GET /api/workflows — 列出 workflow 目录下的 JSON 工作流（**含内置生图工作流**）
//
// 与上游的差异（2026-10-20 用户口径）：上游把 `制图工作流.json` / `制图工作流-pro.json` 排除，
// 于是「自定义工作流」在没有自备文件的机器上根本不出卡片 —— 等于功能不可用。
// 现在把这两个**内置生图工作流**也列出来（builtin: true），「自定义」开箱即可选；
// 放大的两个细化工作流由前端按 NON_GENERATION_WORKFLOWS 过滤（它们不是生图模板）。
router.get('/', (req, res) => {
  try {
    const BUILTIN = new Set([ACTIVE_WORKFLOW, PRO_WORKFLOW]);
    const files = fs.readdirSync(WORKFLOW_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ filename: f, label: f.replace('.json', ''), builtin: BUILTIN.has(f) }))
      // 内置的排前面，其余按文件名
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.filename.localeCompare(b.filename, 'zh'));
    res.json({ workflows: files });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// GET /api/workflows/status — 检查工作流文件健康状况
router.get('/status', (req, res) => {
  const health = checkWorkflowHealth();
  res.json({ ok: true, ...health });
});

// POST /api/workflows/restore — 恢复工作流（写入 turbo → 制图工作流.json, base → 制图工作流-pro.json）
router.post('/restore', (req, res) => {
  try {
    const result = restoreWorkflow();
    res.json(result);
  } catch (err) {
    console.error('[workflows] restore error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
