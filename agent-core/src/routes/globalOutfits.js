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
import { BODY_TRAIT_RE, WEARABLE_RE } from '../services/sceneOutfitPrompt.js';
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
    skipped: task.skipped,
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

/** 颜色词：形制摘要里要把它们剥掉 —— 配色本来就按角色 seed 区分，不该进"已用形制"清单 */
const COLOR_WORDS = /\b(off[-\s]?white|sky[-\s]?blue|ivory|beige|purple|crimson|brown|black|white|rose|yellow|gold|silver|blue|red|green|pink|grey|gray|burgundy|navy|teal|aqua|cream|peach|lavender|maroon|turquoise)\b/gi;

/**
 * 从一条服装描述里提取「形制关键词」（2026-11-09）。
 *
 * 用途：给后续角色列"已用过的形制，别再用"。
 *
 * ⚠ 必须剥掉颜色词，也不能整段照搬 —— 实测把别人的完整描述喂进提示词，
 * 模型会直接复制里面的高频短语，重合度不降反升。这里只留结构与部件（轮廓/领口/袖型/裙摆/配饰），
 * 并且不带颜色，才是真正的"形制"约束。
 */
function extractOutfitForms(description) {
  const segs = String(description || '').split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
  const forms = [];
  for (const seg of segs) {
    // 纯身体特征段（不是穿戴物）跳过
    if (BODY_TRAIT_RE.test(seg) && !WEARABLE_RE.test(seg)) continue;
    const cleaned = seg.replace(COLOR_WORDS, '').replace(/\s{2,}/g, ' ').trim();
    if (cleaned.length < 8) continue;      // 剥完颜色只剩 "sheer" 这种，没信息量
    forms.push(cleaned);
    if (forms.length >= 5) break;
  }
  return forms;
}

async function runBatch(typeId, { withStanding = true, skipExisting = false, overwrite = false, characterIds = null } = {}) {
  const db = getDb();
  const type = db.prepare('SELECT id, name FROM global_outfit_types WHERE id = ?').get(typeId);
  const task = tasks.get(typeId);
  if (!type || !task) return;
  const scene = sceneKeyOf(typeId);
  // 处理范围：只取用户角色（系统内置角色不参与，见 services/characterScope.js 口径）；
  // 传了 characterIds 时只处理这几个人（前端「可选人物」）。
  const all = db.prepare('SELECT * FROM characters WHERE COALESCE(is_system, 0) = 0 ORDER BY id').all();
  const wanted = Array.isArray(characterIds)
    ? new Set(characterIds.map(Number).filter(Number.isFinite))
    : null;
  const characters = wanted ? all.filter(c => wanted.has(c.id)) : all;

  // 已定下来的款式（2026-11-09）：逐角色累积，后面的人必须明显错开。
  // 只取本轮新建/重做的，不含历史上已存在的 —— 那可能是用户手写的，不该拿来限制模型。
  const usedStyles = [];

  for (const character of characters) {
    if (task.cancelled) break;
    task.current = character.display_name || `角色 ${character.id}`;
    try {
      // 跳过已有描述：保护用户手写/改过的这一套，不被批量覆盖。
      // overwrite=true 时明确覆盖（前端在动手前已经问过用户）。
      if (!overwrite && skipExisting) {
        const existing = db.prepare(
          'SELECT description FROM character_outfits WHERE character_id = ? AND scene = ?'
        ).get(character.id, scene);
        if (String(existing?.description || '').trim()) { task.skipped++; continue; }
      }
      // ① 描述：复用五态生成口径（会按世界观与人设写这套衣服）
      const outfits = await generateSceneOutfits(character, {
        scenes: [scene],
        baseAppearance: baseAppearanceOf(character),
        avoidStyles: usedStyles,
      });
      const target = (Array.isArray(outfits) ? outfits : []).find(item => item.scene === scene);
      if (!target?.description) throw new Error('模型没有返回这一套的描述');
      upsertSceneOutfits(character.id, [{ scene, name: type.name, description: target.description }]);
      usedStyles.push({
        name: character.display_name || `角色 ${character.id}`,
        forms: extractOutfitForms(target.description),
      });

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

// POST /api/global-outfits/:id/generate — Body: { withStanding?, skipExisting?, overwrite?, characterIds? }
// characterIds 空/缺省 = 全部用户角色；overwrite=true 时连已有描述的一起重做（前端会先问过用户）
// 已在跑时直接返回当前任务，不重复启动
router.post('/:id/generate', (req, res) => {
  try {
    const id = Number(req.params.id);
    const type = getDb().prepare('SELECT id FROM global_outfit_types WHERE id = ?').get(id);
    if (!type) return res.status(404).json({ error: '服装类型不存在' });
    const existing = tasks.get(id);
    if (existing?.running) return res.json({ task: publicTask(existing), started: false });
    const withStanding = req.body?.withStanding !== false;
    const skipExisting = req.body?.skipExisting === true;
    const overwrite = req.body?.overwrite === true;
    const characterIds = Array.isArray(req.body?.characterIds) ? req.body.characterIds : null;
    const all = getDb().prepare('SELECT id FROM characters WHERE COALESCE(is_system, 0) = 0').all().map(r => r.id);
    // 传了数组就按数组来（空数组 = 一个都没选 → 400，不是「全部」）；
    // 只有没传（null/undefined）才表示「全部用户角色」。
    const wanted = characterIds ? new Set(characterIds.map(Number).filter(Number.isFinite)) : null;
    const total = wanted ? all.filter(id2 => wanted.has(id2)).length : all.length;
    if (!total) return res.status(400).json({ error: '没有选中要处理的角色' });
    const task = {
      running: true, withStanding, skipExisting, overwrite,
      total, done: 0, skipped: 0, current: '', failed: [],
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    tasks.set(id, task);
    runBatch(id, { withStanding, skipExisting, overwrite, characterIds }).catch(error => {
      task.running = false;
      task.finishedAt = new Date().toISOString();
      console.error('[global-outfits] 批量生成异常:', error?.message || error);
    });
    res.status(202).json({ task: publicTask(task), started: true });
  } catch (err) { fail(res, err); }
});

// GET /api/global-outfits/:id/characters — 这套服装在每个用户角色上的现状
// 前端用它做「可选人物」列表，并在动手前判断谁已经有同名服装（要不要覆盖）
router.get('/:id/characters', (req, res) => {
  try {
    const id = Number(req.params.id);
    const type = getDb().prepare('SELECT id, name FROM global_outfit_types WHERE id = ?').get(id);
    if (!type) return res.status(404).json({ error: '服装类型不存在' });
    const db = getDb();
    const scene = sceneKeyOf(id);
    const characters = db.prepare('SELECT id, display_name FROM characters WHERE COALESCE(is_system, 0) = 0 ORDER BY id').all();
    const described = new Map(db.prepare(
      'SELECT character_id, description FROM character_outfits WHERE scene = ?'
    ).all(scene).map(row => [row.character_id, String(row.description || '').trim()]));
    const standing = new Set(db.prepare(
      "SELECT character_id FROM character_standings WHERE scene = ? AND COALESCE(image_url, '') <> ''"
    ).all(scene).map(row => row.character_id));
    res.json({
      type: { id, name: type.name, scene },
      characters: characters.map(c => ({
        id: c.id,
        display_name: c.display_name,
        described: !!(described.get(c.id) || ''),
        hasStanding: standing.has(c.id),
      })),
    });
  } catch (err) { fail(res, err); }
});

// GET /api/global-outfits/:id/task — 轮询进度
router.get('/:id/task', (req, res) => {
  res.json({ task: publicTask(tasks.get(Number(req.params.id))) });
});

export default router;
