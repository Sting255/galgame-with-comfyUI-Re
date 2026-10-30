import express from 'express';
import { getDb } from '../db/index.js';
import { createLorebookRepository } from '../db/lorebookRepository.js';
import { normalizeBook, normalizeSettings } from '../services/lorebook/engine.js';
import { prepareLorebook } from '../services/lorebook/runtime.js';
import { probeLorebookCache } from '../services/lorebook/cacheProbe.js';

const router = express.Router();
const repository = () => createLorebookRepository(getDb());
router.param('worldId', (req,res,next,value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || !getDb().prepare('SELECT id FROM world_settings WHERE id=?').get(id)) return res.status(404).json({error:'世界观不存在'});
  req.worldId = id; next();
});
router.get('/world-settings/:worldId/lorebook', (req,res) => res.json({ book:repository().get(req.worldId) }));
router.put('/world-settings/:worldId/lorebook', (req,res) => {
  try {
    const result = repository().save(req.worldId,req.body);
    res.json(result);
    if (result.book.enabled && (result.book.settings.vectorAll || Object.values(result.book.document.entries).some(e => e.vectorized && !e.disable))) {
      void import('../services/lorebook/vectors.js').then(({warmLorebook}) => warmLorebook(result.book))
        .catch(error => console.warn('[lorebook] 向量预建失败:', error.message));
    }
  }
  catch(error) { res.status(error.message.includes('其他窗口')?409:400).json({error:error.message}); }
});
router.delete('/world-settings/:worldId/lorebook', (req,res) => { repository().remove(req.worldId); res.json({ok:true}); });
router.get('/world-settings/:worldId/lorebook/export', (req,res) => {
  const book = repository().get(req.worldId);
  if (!book) return res.status(404).json({error:'尚未挂载世界书'});
  res.json(book.document);
});
router.post('/world-settings/:worldId/lorebook/preview', async(req,res) => {
  try {
    const book = req.body.document ? {document:normalizeBook(req.body.document).document,settings:req.body.settings} : repository().get(req.worldId);
    if (!book) return res.status(404).json({error:'尚未挂载世界书'});
    const context = { ...req.body.context, history:req.body.context?.history || [{role:'user',content:String(req.body.text || '')}] };
    const world = getDb().prepare('SELECT content FROM world_settings WHERE id=?').get(req.worldId);
    const worldText = world.content ? `<world_setting>\n${world.content}\n</world_setting>` : '基础世界观未填写';
    const persona = context.characterDescription || '通用预览角色：一位正在了解当前世界的小镇居民。';
    const messages = [{role:'system',content:worldText}, {role:'system',content:persona}, ...context.history];
    const result = await prepareLorebook(messages,{...context,worldId:req.worldId,book:{...book,enabled:true,worldId:req.worldId,revision:book.revision || 0,settings:normalizeSettings(book.settings)},dryRun:true,personaTexts:[persona],staticTexts:[worldText],historyStart:2,historyEnd:messages.length});
    res.json({...result.report,messages:result.messages,activation:result.activation,document:book.document,warnings:[...result.report.warnings,'这是通用结构预览；私聊、群聊和朋友圈会按各自稳定区与历史结构定位。']});
  } catch(error) { res.status(400).json({error:error.message}); }
});
export default router;
router.post('/world-settings/:worldId/lorebook/cache-probe', async(req,res)=>{
  try { res.json(await probeLorebookCache(req.worldId)); }
  catch(error) { res.status(502).json({error:error.message}); }
});
