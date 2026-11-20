import { Router } from 'express';
import { randomUUID } from 'node:crypto';

const FIELDS = { chat: 'chat_bg_path', galgame: 'galgame_bg_path' };

/** 独立的背景槽位；依赖注入便于验证上传/生图失败与角色切换，无需连接真实生图服务。 */
export function createCharacterBackgroundRouter({ getDb, saveBase64Image, deleteImageFileByUrl, invalidateGalleryCache, generateBackground }) {
  const router = Router();
  const busy = new Set();

  async function update(req, res, generate) {
    const target = req.body?.target ?? (generate ? 'galgame' : 'chat');
    const field = FIELDS[target];
    const previewOnly = generate && req.body?.previewOnly === true;
    if (!Object.hasOwn(FIELDS, target)) return res.status(400).json({ error: '未知的背景类型' });
    const db = getDb();
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    if (!character) return res.status(404).json({ error: 'Character not found' });
    const key = `${character.id}:${target}`;
    if (busy.has(key)) return res.status(409).json({ error: '该背景正在处理中，请稍候' });
    let newUrl = null;
    let committed = false;
    busy.add(key);
    try {
      const generated = generate ? await generateBackground(character, String(req.body?.requirement || '').trim().slice(0, 500)) : null;
      const base64 = generated?.base64 ?? req.body?.base64;
      if (typeof base64 !== 'string') return res.status(400).json({ error: '请提供背景图片，或传入空字符串恢复默认' });
      if (base64) {
        const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(base64);
        if (!match) return res.status(400).json({ error: '背景图片须为 PNG、JPEG 或 WebP' });
        const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
        newUrl = saveBase64Image('chatbg', `${target}bg_${character.id}_${randomUUID()}.${extension}`, base64);
      }
      db.transaction(() => {
        if (previewOnly) {
          if (!db.prepare('SELECT id FROM characters WHERE id = ?').get(character.id)) throw new Error('角色已被删除');
        } else {
          const updated = db.prepare(`UPDATE characters SET ${field} = ? WHERE id = ?`).run(newUrl, character.id);
          if (!updated.changes) throw new Error('角色已被删除');
        }
        if (generated) db.prepare(`INSERT INTO image_tasks (conversation_id, prompt_original, prompt_refined, status, output_paths, workflow_template, finished_at)
          VALUES (?, ?, ?, 'done', ?, ?, datetime('now'))`).run(`char_${character.id}_${target}bg`, generated.prompt, generated.promptRefined, JSON.stringify([newUrl]), generated.workflow);
      })();
      committed = true;
      // 普通聊天沿用旧清理行为；沉浸背景保留在相册，方便找回生成结果。
      if (!previewOnly && target === 'chat' && character.chat_bg_path && character.chat_bg_path !== character.galgame_bg_path) {
        try { deleteImageFileByUrl(character.chat_bg_path); } catch { /* 清理不阻断已保存的背景 */ }
      }
      invalidateGalleryCache();
      res.json(previewOnly ? { ok: true, characterId: character.id, target, imageUrl: newUrl, previewOnly: true } : { ok: true, characterId: character.id, target, [field]: newUrl });
    } catch (err) {
      if (newUrl && !committed) { try { deleteImageFileByUrl(newUrl); } catch { /* best effort */ } }
      res.status(500).json({ error: err.message || '背景处理失败' });
    } finally { busy.delete(key); }
  }

  router.post('/:id/chat-bg', (req, res) => update(req, res, false));
  router.post('/:id/generate-chat-bg', (req, res) => update(req, res, true));
  return router;
}
