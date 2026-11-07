/**
 * /api/global-outfits —— 全角色统一服装类型（2026-11-07）
 *
 * 设置里定义一次（如「婚纱」），每个角色都多出这一套；再一键把所有人的
 * 描述与立绘跑完。批量生成是后台任务：N 个角色 × (描述 + 立绘) 动辄十几分钟，
 * 不能挂在一个同步请求上。
 */
import { Router } from 'express';
import { getDb } from '../db/index.js';
import {
  listGlobalOutfitTypes, createGlobalOutfitType, renameGlobalOutfitType, deleteGlobalOutfitType,
  applyTypeToAllCharacters, sceneKeyOf,
} from '../services/globalOutfitTypes.js';
import { generateSceneOutfits, upsertSceneOutfits, listSceneOutfits } from '../services/outfitScene.js';
import { generateSceneStandingForCharacter } from './characters.js';

const router = Router();

function fail(res, err) {
  const status = err?.statusCode || 500;
  console.error('[global-outfits]', err?.message || err);
  res.status(status).json({ error: err?.message || '操作失败' });
}

// 批量任务状态：进程内保留最近一次，前端轮询这个
const tasks = new Map();

function publicTask(task) {
  if (!task) return null;
  return {
    running: task.running,
    withStanding: task.withStanding,
    total: task.total,
    done: task.done,
    current: task.current,
    failed: task.failed,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

function baseAppearanceOf(character) {
  const work = listSceneOutfits(character.id).find(row => row.scene === 'work');
  const fromWork = String(work?.text || work?.description || '').trim();
  if (fromWork) return fromWork;
  const raw = String(character.base_prompt || '');
  const idx = raw.search(/##\s*你的外观/);
  return idx >= 0 ? raw.slice(idx).trim() : raw.trim();
}

async function runBatch(typeId, withStanding) {
  const db = getDb();
  const type = db.prepare('SELECT id, name FROM global_outfit_types WHERE id = ?').get(typeId);
  const task = tasks.get(typeId);
  if (!type || !task) return;
  const scene = sceneKeyOf(typeId);
  const characters = db.prepare('SELECT * FROM characters ORDER BY id').all();

  for (const character of characters) {
    if (task.cancelled) break;
    task.current = character.display_name || `角色 ${character.id}`;
    try {
      // ① 描述：复用五态生成口径（会按世界观与人设写这套衣服）
      const outfits = await generateSceneOutfits(character, {
        scenes: [scene],
        baseAppearance: baseAppearanceOf(character),
      });
      const target = (Array.isArray(outfits) ? outfits : []).find(item => item.scene === scene);
      if (!target?.description) throw new Error('模型没有返回这一套的描述');
      upsertSceneOutfits(character.id, [{ scene, name: type.name, description: target.description }]);

      // ② 立绘：按刚写好的描述出图
      if (withStanding) await generateSceneStandingForCharacter(character.id, scene);
      task.done++;
    } catch (error) {
      task.failed.push({
        characterId: character.id,
        name: character.display_name || `角色 ${character.id}`,
        step: withStanding ? '描述或立绘' : '描述',
        error: String(error?.message || error).slice(0, 200),
      });
    }
  }
  task.running = false;
  task.current = '';
  task.finishedAt = new Date().toISOString();
}

// GET /api/global-outfits — 统一服装类型列表（含应用/描述/立绘统计）
router.get('/', (_req, res) => {
  try { res.json({ types: listGlobalOutfitTypes() }); } catch (err) { fail(res, err); }
});

// POST /api/global-outfits — Body: { name }
router.post('/', (req, res) => {
  try { res.status(201).json(createGlobalOutfitType(req.body?.name)); } catch (err) { fail(res, err); }
});

// PUT /api/global-outfits/:id — Body: { name }
router.put('/:id', (req, res) => {
  try { res.json(renameGlobalOutfitType(Number(req.params.id), req.body?.name)); } catch (err) { fail(res, err); }
});

// DELETE /api/global-outfits/:id — 连同各角色这套的描述与立绘一起删
router.delete('/:id', (req, res) => {
  try { res.json(deleteGlobalOutfitType(Number(req.params.id))); } catch (err) { fail(res, err); }
});

// POST /api/global-outfits/:id/apply — 给还没有这套的角色补空行
router.post('/:id/apply', (req, res) => {
  try {
    const id = Number(req.params.id);
    const type = getDb().prepare('SELECT id, name FROM global_outfit_types WHERE id = ?').get(id);
    if (!type) return res.status(404).json({ error: '服装类型不存在' });
    res.json({ applied: applyTypeToAllCharacters(type) });
  } catch (err) { fail(res, err); }
});

// POST /api/global-outfits/:id/generate — Body: { withStanding?: boolean }
// 已在跑时直接返回当前任务，不重复启动
router.post('/:id/generate', (req, res) => {
  try {
    const id = Number(req.params.id);
    const type = getDb().prepare('SELECT id FROM global_outfit_types WHERE id = ?').get(id);
    if (!type) return res.status(404).json({ error: '服装类型不存在' });
    const existing = tasks.get(id);
    if (existing?.running) return res.json({ task: publicTask(existing), started: false });
    const withStanding = req.body?.withStanding !== false;
    const total = getDb().prepare('SELECT COUNT(*) AS n FROM characters').get()?.n || 0;
    const task = {
      running: true, withStanding, total, done: 0, current: '', failed: [],
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    tasks.set(id, task);
    runBatch(id, withStanding).catch(error => {
      task.running = false;
      task.finishedAt = new Date().toISOString();
      console.error('[global-outfits] 批量生成异常:', error?.message || error);
    });
    res.status(202).json({ task: publicTask(task), started: true });
  } catch (err) { fail(res, err); }
});

// GET /api/global-outfits/:id/task — 轮询进度
router.get('/:id/task', (req, res) => {
  res.json({ task: publicTask(tasks.get(Number(req.params.id))) });
});

export default router;
