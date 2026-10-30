import express from 'express';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { createPresetRepository } from '../db/presetRepository.js';
import { compilePreset, injectPreset, normalizePreset } from '../services/presets/engine.js';

export function createPresetRouter(repository = () => createPresetRepository(getDb())) {
  const router = express.Router();
  const handle = fn => (req,res) => { try { fn(req,res,repository()); } catch(error) { res.status(error.status || 400).json({error:error.message}); } };
  router.get('/', handle((req,res,repo) => res.json({ items:repo.list() })));
  router.post('/', handle((req,res,repo) => { const item=repo.save(null,req.body); res.status(201).json({item,items:repo.list()}); }));
  router.post('/preview', handle((req,res) => {
    const context = {userName:config.user.nickname || '用户',personaDescription:config.user.persona || '',...req.body.context};
    const compiled = compilePreset(req.body.document,context,req.body.orderId,{trace:true});
    const messages = [{role:'system',content:'system0 · 邻舍基础规则与世界观'}, {role:'system',content:'后续邻舍规则、人设与上下文'}, {role:'user',content:req.body.context?.lastUserMessage || '执行本次任务'}];
    res.json({...compiled,document:normalizePreset(req.body.document),messages:injectPreset(messages,compiled)});
  }));
  router.param('id', (req,res,next,value) => { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({error:'预设 ID 无效'}); req.presetId=id; next(); });
  router.put('/:id', handle((req,res,repo) => { const item=repo.save(req.presetId,req.body); res.json({item,items:repo.list()}); }));
  router.put('/:id/active', handle((req,res,repo) => {
    if (typeof req.body.active !== 'boolean') throw new Error('active 必须是布尔值');
    res.json({item:repo.activate(req.presetId,req.body.expectedRevision,req.body.active)});
  }));
  router.delete('/:id', handle((req,res,repo) => { repo.remove(req.presetId,req.body.expectedRevision); res.json({ok:true}); }));
  router.get('/:id/export', handle((req,res,repo) => { const item=repo.get(req.presetId); if (!item) return res.status(404).json({error:'预设不存在'}); res.json(item.document); }));
  return router;
}
export default createPresetRouter();
