import { getDb } from '../../db/index.js';
import { config } from '../../config.js';
import { generateImage } from '../imageSkill.js';
import { charArtistOverride } from '../characterImageOpts.js';
import { RAG_TIMEOUT_FAST_MS } from '../imagePromptKnowledge.js';
import { invalidateGalleryCache } from '../galleryCache.js';
import { saveBase64Image } from '../imagePaths.js';
import { broadcast } from '../unifiedStreamBus.js';
import { ensureDreamOnDemand, generateLiveDreamMurmur, decorateDreamImagePrompt } from '../dreamService.js';
import { _parseLoras } from './shared.js';

/**
 * 睡眠模式替代响应：角色没有醒，被消息声搅了一下 —— 用户触发即当场造梦：
 * 1. 按需生成一场梦（幂等，已有本会话梦则复用；失败不阻塞）；
 * 2. 当场 LLM 现编一句新鲜梦话应答（上下文=刚生成的梦 + user 消息「声音渗进梦里」）；
 * 3. 梦话文字先推送（token），随后现场 ComfyUI 生成梦境配图，
 *    走完整 generate_start/progress/done 推送流（前端渲染生图气泡的遮罩与进度）。
 * SSE 事件契约与原睡眠路径一致；用户消息已照常写入 reply_queue，醒后仍会合并回复。
 */
export async function handleDreamTalkReply(res, characterId, conversationId, userMsgId, character, userMessage) {
  const db = getDb();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.socket) res.socket.setTimeout(0);
  res.setTimeout(0);
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  let msgRowId = null;
  let genTaskId = null;
  let dream = null;

  try {
    // 通知前端日程系统当前处于睡眠（与原睡眠路径一致）
    broadcast('schedule_state_change', {
      character_id: characterId,
      is_sleeping: true,
      sleep_until: character.sleep_until || null,
      temporary_wake_until: null,
      wake_mode: null,
    });

    // 1. 用户消息保存确认（先于 LLM 调用发送）
    send('msg_saved', { id: userMsgId, role: 'user', created_at: new Date().toISOString() });

    // 2. 用户触发 → 当场造一场梦（幂等；已有本会话梦直接复用；失败不阻塞，梦话退化为无梦境上下文）
    dream = await ensureDreamOnDemand(characterId, character.sleep_until || null);

    // 3. 当场 LLM 现编新鲜梦话（无预置）；失败抛错 → 走 Zzz 兜底
    const murmured = await generateLiveDreamMurmur(characterId, userMessage);
    if (!murmured) throw new Error('live dream murmur generation failed');
    const { talk, imagePrompt } = murmured;

    // 3. 双表写入（raw 带语境包裹，LLM 后续知道"我说过这个？我不记得了"；messages 展示纯文本），
    //    梦话文字先发出去
    const rawResult = db.prepare(
      `INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`
    ).run(conversationId, `（睡梦中的梦话）${talk}`);
    const msgResult = db.prepare(
      `INSERT INTO messages (conversation_id, raw_id, role, content, seq) VALUES (?, ?, 'assistant', ?, 0)`
    ).run(conversationId, rawResult.lastInsertRowid, talk);
    msgRowId = msgResult.lastInsertRowid;

    send('token', { content: talk });
    send('bubble_break', {});

    // 4. 现场生成梦境配图：完整 generate_start/progress/done 推送流（用户正在等图，走高优先级队列）
    const finalPrompt = decorateDreamImagePrompt(imagePrompt);
    if (finalPrompt) {
      genTaskId = db.prepare(
        'INSERT INTO image_tasks (conversation_id, prompt_original, prompt_refined, status) VALUES (?, ?, ?, ?)'
      ).run(conversationId, '', '', 'running').lastInsertRowid;

      send('generate_start', { taskId: genTaskId });

      const loras = _parseLoras(character);
      const loraOpts = {};
      if (character.custom_workflow) loraOpts.customWorkflow = character.custom_workflow;
      if (loras.length > 0) loraOpts.loras = loras;
      const charArtist = charArtistOverride(character);
      if (charArtist !== null) loraOpts.artist = charArtist;

      const result = await generateImage(finalPrompt, {
        scene: 'chat',
        characterNegative: character.negative_prompt || '',
        // 上游 v3.10.0：梦话配图的 RAG query 用「本轮用户消息 + 梦话正文」，
        // 而不是英文 prompt —— 这样知识库召回贴住梦境语境。
        ragQuery: `${config.user.nickname || '用户'}: ${userMessage}\n${character.display_name || '角色'}: ${talk}`,
        ragTimeoutMs: RAG_TIMEOUT_FAST_MS,
        onProgress: (p) => {
          if (p.stage === 'retrying') {
            send('generate_retrying', { taskId: genTaskId, attempt: p.attempt, maxRetries: p.maxRetries });
          }
          if (p.progress != null) {
            send('generate_progress', { taskId: genTaskId, progress: p.progress, totalSteps: p.totalSteps });
          }
        },
        ...loraOpts,
        // 梦话配图的主角就是她本人：身份锚点统一由 imageSkill 前置（梦境前缀会被正确保留）
        identity: character,
      });

      if (!result.success || !result.images?.length) {
        throw new Error(result.error || 'dream image generation failed');
      }

      // 5. 落盘并挂到梦话气泡；同步回填为梦境档案配图（醒后主动分享出口复用）
      const urls = [];
      for (const img of result.images) {
        const filename = `${Date.now()}_${img.filename || 'dream.png'}`;
        const url = saveBase64Image('chat', filename, img.base64);
        if (url) urls.push(url);
      }
      if (urls.length > 0) {
        db.prepare('UPDATE messages SET images = ? WHERE id = ?')
          .run(JSON.stringify(urls), msgRowId);
        if (dream?.id) {
          try {
            db.prepare('UPDATE character_dreams SET image_path = ? WHERE id = ? AND image_path IS NULL')
              .run(urls[0], dream.id);
          } catch (err) { console.debug('[chat/dreamTalk] 梦境配图关联写入失败:', err.message); }
        }
      }

      db.prepare(`UPDATE image_tasks SET status = 'done', prompt_original = ?, prompt_refined = ?, output_paths = ?, finished_at = datetime('now') WHERE id = ?`)
        .run(finalPrompt, result.promptRefined || finalPrompt, JSON.stringify(urls), genTaskId);

      invalidateGalleryCache();

      send('generate_done', { taskId: genTaskId, images: result.images.map(img => ({ ...img, url: img.url })) , source: result.source });
    }

    console.log(`[dream] ${character.display_name} 睡中被叫，现编了一句梦话: "${talk}"${finalPrompt ? ' + 现场梦境图' : ''}`);
  } catch (err) {
    console.error('[chat] dream talk reply error:', err.message);
    if (genTaskId) {
      try {
        db.prepare(`UPDATE image_tasks SET status = 'failed', error_message = ?, finished_at = datetime('now') WHERE id = ?`)
          .run(err.message, genTaskId);
      } catch (writeErr) { console.debug('[chat/dreamTalk] 配图失败状态写入失败:', writeErr.message); }
      send('generate_error', { taskId: genTaskId, error: err.message });
    }
    if (!msgRowId) {
      // 梦话文本都没发出去 → 兜底退回最简 Zzz 气泡，保证前端流正常收尾
      try {
        db.prepare('INSERT INTO messages (conversation_id, raw_id, role, content, seq) VALUES (?, NULL, ?, ?, 0)')
          .run(conversationId, 'assistant', '(Zzz...)');
        send('token', { content: '(Zzz...)' });
        send('bubble_break', {});
      } catch (writeErr) { console.debug('[chat/dreamTalk] 梦话兜底消息写入失败:', writeErr.message); }
    }
  } finally {
    send('done', {});
    try { res.end(); } catch { /* 客户端可能已关闭连接，无需再次报告同一次断开。 */ }
  }
}
