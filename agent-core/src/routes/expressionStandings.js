import { Router } from 'express';
import { getDb } from '../db/index.js';
import { listExpressionStandings, listStandingOverview, startAllStandingBatches, startStandingBatch, controlStandingBatch, updateStandingPrompt, editStandingImage, deleteStanding } from '../services/expressionStandingService.js';
import { getStandingDisplay } from '../services/standingDisplay.js';
// 上游 v3.9.0 合并：立绘互动 —— 触碰配置（save/saveRegions 本地暂无 UI 入口，但接口与
// standingInteractionService 一并合进来，供以后接互动设置面板；台词三件套是当前实际使用的链路。
import { createStandingInteractionService } from '../services/standingInteractionService.js';
import { imageUrlExists } from '../services/imagePaths.js';
import { broadcast } from '../services/unifiedStreamBus.js';
import { readTouchLines, saveTouchLines, fillMissingTouchLines } from '../services/standingTouchLines.js';
import { regenerateStandingTouchLines, generateStandingTouchLines } from '../services/expressionStandingService.js';
import { previewStandingBatches, previewCharacterStandingBatch } from '../services/expressionStandingService.js';

const router = Router();
router.get('/expression-standings/overview', (_req, res) => res.json({ characters: listStandingOverview() }));
router.post('/expression-standings/preflight', (req, res) => res.json(previewStandingBatches(req.body)));
router.post('/expression-standings/generate', (req, res) => res.status(202).json(startAllStandingBatches(req.body)));
router.post('/expression-standings/touch-lines/fill', (_req,res)=>res.status(202).json(fillMissingTouchLines({db:getDb(),generate:generateStandingTouchLines,emit:broadcast})));
const base = '/characters/:id/expression-standings';
// 台词三件套（立绘管理的「反馈台词管理」用）
router.get(`${base}/touch-lines`, (req,res)=>{
  if(!getDb().prepare('SELECT id FROM characters WHERE id=?').get(req.params.id))return res.status(404).json({error:'角色不存在'});
  res.json(readTouchLines(getDb(),req.params.id));
});
router.put(`${base}/touch-lines`, (req,res)=>res.json(saveTouchLines({db:getDb(),id:Number(req.params.id),lines:req.body.lines,expectedVersion:req.body.expectedVersion,emit:broadcast})));
router.post(`${base}/touch-lines/generate`, (req,res)=>res.status(202).json(regenerateStandingTouchLines(req.params.id,req.body.expectedVersion)));
// 批量补齐：给所有还没有台词的角色各起一个后台台词任务
router.post('/expression-standings/touch-lines/fill', (_req,res)=>res.status(202).json(fillMissingTouchLines({db:getDb(),generate:generateStandingTouchLines,emit:broadcast})));
// 触碰配置（本地暂无前端入口，接口随服务一并合并）
const interactions = () => createStandingInteractionService({ db: getDb(), imageExists: imageUrlExists, emit: broadcast });
router.get('/characters/:id/standing-interaction', (req, res) => res.json(interactions().get(req.params.id)));
router.put('/characters/:id/standing-interaction', (req, res) => res.json(interactions().save(req.params.id, req.body)));
router.put(`${base}/:slot/interaction-regions`, (req, res) => res.json(interactions().saveRegions(req.params.id, req.params.slot, req.body)));
router.get(base, (req, res) => res.json(listExpressionStandings(req.params.id)));
router.post(`${base}/preflight`, (req, res) => res.json(previewCharacterStandingBatch(req.params.id, req.body)));
router.post(`${base}/generate`, (req, res) => res.status(202).json(startStandingBatch(req.params.id, req.body)));
router.post(`${base}/jobs/:jobId/:action`, (req, res) => res.json(controlStandingBatch(req.params.id, req.params.jobId, req.params.action)));
router.patch(`${base}/:slot/prompt`, (req, res) => {
  updateStandingPrompt(req.params.id, req.params.slot, req.body.prompt, req.body.generation);
  res.json({ ok: true });
});
for (const action of ['upload', 'image', 'crop', 'hires']) {
  router.post(`${base}/:slot/${action}`, async (req, res) => {
    await editStandingImage(req.params.id, req.params.slot, action, req.body);
    res.json({ ok: true });
  });
}
router.delete(`${base}/:slot`, (req, res) => { deleteStanding(req.params.id, req.params.slot); res.json({ ok: true }); });
router.get('/standing-display/state', (_req, res) => res.json(getStandingDisplay().snapshot()));
// 上游 v3.9.0 合并：单个角色的立绘展示快照（galgame 舞台 useDialogueStanding 走这个）
router.get('/characters/:id/standing-display', (req, res) => {
  if (!getDb().prepare('SELECT id FROM characters WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '角色不存在' });
  res.json(getStandingDisplay().characterSnapshot(req.params.id));
});
router.put('/standing-display/active', (req, res) => {
  const { characterId, clientId, sequence } = req.body;
  if (!Number.isInteger(Number(characterId)) || !getDb().prepare('SELECT id FROM characters WHERE id=?').get(characterId)) return res.status(404).json({ error: '角色不存在' });
  res.json(getStandingDisplay().select(Number(characterId), String(clientId || '').slice(0, 100), Number(sequence)));
});
export default router;
