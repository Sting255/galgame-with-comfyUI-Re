import { appendWorldLanguageStyle, hasActiveWorldLanguageStyle } from '../worldLanguageStyle.js';
import { getDb, getSystemRules, getWorldSetting, stmt } from '../../db/index.js';
import { chatStream, chatAgentStream } from '../../llm/llm-client.js';
import { streamPrivateChatImages, queuePrivateImage, getPrivateChatImageResume, savePrivateChatReply, getSavedPrivateChatReply } from '../privateChatImageTools.js';
import { chatSync as chatWithLorebook } from '../lorebook/runtime.js';
import { prepareNarrativePrompt } from '../presets/narrative.js';
import { takeOfflineNoticeFor } from '../offlineChronicle.js';
import { nudgeBondsFromText } from '../groupBonds.js';
import { buildConversationLorebookContext } from '../lorebook/conversationContext.js';
import { config } from '../../config.js';
import { recallChatMemories, CHAT_RAG_TIMEOUT_MS } from '../memory/chatMemoryRecall.js';
import { isMemoryV3Enabled, getActiveSearchConfig, getContextBudgetConfig } from '../memory/memoryConfig.js';
import { activeMemorySearch, parseRecallInstruction, formatMemoryRecallBlock } from '../memory/activeSearch.js';
import { curateChatMemories } from '../memoryExtractor.js';
import { isSoulEnabled, renderSoulStateBlock, soulReplyLengthHint, soulRecallTopK, resonateSoul, reflectSoul, saveSoulState } from '../soulEngine.js';
import { getBodyProfile } from '../intimateService.js';
import { buildIntimateProfileBlock } from '../intimatePrompt.js';
import { buildWornToysBlock, maybeSelfPlay } from '../toyService.js';
import { buildIntimateScenePromptBlock, getIntimateScene } from '../intimateActionService.js';
import { buildDenialHungerLine } from '../intimateStimulus.js';
import { buildSensitivityPromptLine } from '../sensitivityService.js';
import { privateMomentState, catchPrivateMoment, buildPrivateMomentBlock } from '../privateMomentService.js';
import { judgeRoundInBackground } from '../intimateAiJudge.js';
import { getHypnosisState, consumePendingDirective, listForgottenWindows, isBodyControlled, directiveToyPayload } from '../hypnosisService.js';
import { buildHypnosisStateBlock, buildDirectiveBlock, buildAmnesiaBlock, isAwakenedFromSleepRow } from '../hypnosisPrompt.js';
import { extractImagePromptResponse, requestNonEmptyImagePrompt, needsExplicitTextRewrite, EXPLICIT_TEXT_RETRY_INSTRUCTION } from '../imagePromptResponse.js';
import { containsExplicitAdultContent } from '../../db/imagePromptKnowledgePolicy.js';
import { maybeSummarize, getRecentSummaries } from '../summarizer.js';
import { maybeExtractPortrait } from '../portraitExtractor.js';
import { loadEmotionState, evolveEmotion, evaluateStimulus, stateToPrompt, affinityToPrompt, affinityToReminder, saveEmotionSnapshot, emotionDashboard, loadAffinity, saveAffinity, evolveAffinity, getCompositeEmotion } from '../emotionEngine.js';
import { captureImageGenerationConfig } from '../imageSkill.js';
import { buildUserInfoBlock } from '../characterPersona.js';
import { getActiveBuffBlock } from '../itemService.js';
import { getWorldStateBlock, getCharacterEventBlockFor } from '../newspaperService.js';
import { getEventVadModifier } from '../eventGenerator.js';
import { computeProactiveScore, updateNextProactiveAt, resetUnansweredStreak, getUnansweredStreak } from '../proactiveChatScheduler.js';
import { SentenceSplitter } from '../../utils/sentenceSplitter.js';
import { parseEmojiText, buildEmojiNote, getCharacterEmojiMap } from '../emojiService.js';
import { withGalgameEmojiPreference } from '../chatModePrompt.js';
import { getReplyDelay, formatScheduleContext, isTempWoken, extendTempWake, isSleeping } from '../scheduleManager.js';
import { getGodWorldContext } from '../godSays/worldContext.js';
import { detectAndApplyAppointment } from '../appointmentDetector.js';
import { broadcast } from '../unifiedStreamBus.js';
import { getStandingDisplay, publishStandingKeys } from '../standingDisplay.js';
import { randomUUID as standingTurnId } from 'crypto';
import { buildTimeContextBlock } from '../chatTimeContext.js';
import { saveDailyInteractionBonus } from '../chatDailyBonus.js';
import { getCoreDialogueRules, getChatRhythmRules, detectImageIntent } from '../../builtinRules.js';
import { matchAll } from '../characterSearch.js';
import { buildChatContext, getSplitHistory } from '../contextAssembler.js';
import { buildAntiRepetitionInjection, buildRecentSelfOutputNote, shouldInjectRecentSelfOutputNote, fetchRecentAssistantTurns, fetchRecentEmotionSnapshots, formatAntiRepetitionLog, buildAntiRepetitionMetrics, shouldReroll, buildRerollInstruction, buildReplaceLastAssistantEvent } from '../antiRepetition.js';
import { isRefusal, REFUSAL_RETRY_INSTRUCTION, REFUSAL_FALLBACK_TEXT } from '../refusalDetector.js';
import { recordContextUsage, beginContextCapture, buildChatContextSegments, appendContextSegment } from '../contextUsage.js';
import { buildRecentGroupLogBlock } from '../groupChatEngine.js';
import { chatStreamStarted, chatStreamEnded } from '../chatActivity.js';
import { createCharacterTownChatGuard, buildCharacterTownSceneBlock } from '../characterChatTownContext.js';
import { buildPrivateMomentContext } from '../privateMomentContext.js';
import { listRecentMailboxLetters } from '../privateMailboxContext.js';
import { listCharacterGroupConversationIds, loadGroupNameMap, isGroupConversationId, selectPrivateChatMemories, formatPrivateChatMemoryLines } from '../groupMemoryLink.js';
import { createCharacterTownLifeContext } from '../characterTownLifeContext.js';
import { createTownActorRegistry } from '../town/townActorRegistry.js';
import { getTownState } from '../town/townService.js';
import { buildPlannerTaskBlock, buildPlannerTriggerLine, prependToLastUserMessage, appendToLastUserMessage, runPlanner, sanitizePlan, buildPlanExecuteBlock, detectLastReplyMedia } from '../replyPlanner.js';
import { buildTouchActionBlock } from '../touchActionService.js';
import { isSleepLocked } from '../sleepLock.js';
import { markTouchEventInjected, takePendingTouchEvent } from '../touchEventStore.js';
import { sleep, applyBudgetToBlocks, typingDelay, TEMP_STYLE_POOL, TEMP_STYLE_POOL_OATH, TEMP_STYLE_POOL_HOSTILE, convId, parseSoulSnapshot, toISODate, recordIntimateFromTail, recordIntimateTextFallback, stripTags, stripBracketActions, formatRelativeDay } from './shared.js';
import { guessCooldowns, generateReplyGuesses } from './replyGuesses.js';
import { extractImageTags, hasNeedImage, getDefaultPrompt, triggerImageGeneration, buildImagePromptMessages, requestImagePromptContent } from './images.js';
import { handleDreamTalkReply } from './dreamTalk.js';

export const guardPrivateChat = createCharacterTownChatGuard({ getDb, getTownState });

export async function handlePrivateChat(req, res) {
  // `message` 用 let 接：下方要就地 trim 归一化（见校验段说明），其余字段仍是一次性解构
  const { client_msg_id, force_image_gen, image_mode, deep_think, galgame_mode } = req.body;
  let { message } = req.body;
  const deepThink = deep_think === true || deep_think === 'true';
  const imageMode = ['off', 'smart', 'force'].includes(image_mode) ? image_mode : (force_image_gen ? 'force' : 'smart');
  // 深度思考下的生图策略：off = planner 看不到图片工具；must = 强制生图（本轮必配图，形式由 planner 定）；auto = planner 按需决策
  const imagePolicy = imageMode === 'off' ? 'off' : (deepThink && imageMode === 'force' ? 'must' : 'auto');
  // 只接受「trim 之后仍非空」的字符串消息。
  //
  // ⚠️ 2026-10-15：这里必须**trim 后再判空**。原来只判 `!message`，于是纯空白消息
  // （'   '）会一路穿过校验、走到下面的活跃流登记（`res.on('close')`）与角色查询，
  // 在最小 res mock 下直接炸成 `res.on is not a function`；真实链路上则是把一条空消息
  // 喂进 LLM 与落库。空白消息本来就不是有效消息 —— 公开契约就是「message is required」400
  // （上游 v3.9.0 的 `chatFeatureRemoval.test.js` 正是这么钉的：undefined / '' / '   ' / 123 同断言）。
  // 就地归一化（`message = message.trim()`）而不是另起变量：下方 parseEmojiText / 记忆检索 /
  // 落库 / 生图意图判定共 10+ 处都读 `message`，另起变量会留下"校验 trim 了、下游没 trim"的分叉。
  if (typeof message === 'string') message = message.trim();
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  // 登记活跃聊天流：整理 daemon 的空闲判定信号。
  // 用 res 'close' 注销——无论哪条 early return / 异常路径都恰好触发一次，计数不泄漏。
  //
  // ⚠️ 2026-10-15：登记必须放在**参数校验之后**。上游 v3.9.0 的 `chatFeatureRemoval.test.js`
  // 用最小 res mock（只有 status/json，没有 event emitter）调这条路由，校验通过前的任何
  // `res.on` 都会炸成 `res.on is not a function`；而"非法 message 返回 400"本来就是
  // 这条链路的公开契约（不产出活跃流，也不该碰响应对象的事件面）。
  chatStreamStarted();
  res.on('close', () => chatStreamEnded());

  const db = getDb();
  const characterId = req.params.id;
  // 灵魂引擎（上游 v3.9.0 合并）：本轮是否需要注入灵魂行为参数。只读一次，下方各注入点复用
  const soulEnabled = isSoulEnabled();
  if (!stmt('SELECT id FROM characters WHERE id=?').get(characterId)) return res.status(404).json({ error: '角色不存在' });
  getStandingDisplay().select(Number(characterId));
  const standingTurn = getStandingDisplay().begin(characterId, client_msg_id || standingTurnId());
  const conversationId = convId(characterId);
  const emojiMap = getCharacterEmojiMap(characterId, db);
  const emojiNote = buildEmojiNote([...emojiMap.keys()]);
  const parsedUserMessage = parseEmojiText(message, emojiMap);
  // 上游 v4.2.0：同一 client_msg_id 的重试直接回放已存回复，不再请求模型或生成第二轮
  const priorUser = client_msg_id ? db.prepare('SELECT id FROM raw_messages WHERE client_msg_id=? AND conversation_id=?').get(client_msg_id, conversationId) : null;
  const completedReply = priorUser ? getSavedPrivateChatReply(db, priorUser.id) : null;

  // ── 日程系统：回复队列拦截 ──
  if (!completedReply && config.features.schedule !== false) {
    const delayInfo = getReplyDelay(characterId);
    if (delayInfo.delay > 0 || delayInfo.delay === -1) {
      // 非即时回复 → 保存用户消息，写入 reply_queue，不启动 SSE 流

      const delayMinutes = delayInfo.delay === -1
        ? -1
        : delayInfo.delay;

      const scheduledReplyAt = delayInfo.delay === -1
        ? null  // sleeping: 等醒来时处理
        : new Date(Date.now() + delayMinutes * 60000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');

      // sleeping 时设置 scheduled_reply_at 为 sleep_until
      let finalScheduledAt = scheduledReplyAt;
      if (delayInfo.delay === -1) {
        const sleepingStatus = stmt('SELECT sleep_until FROM characters WHERE id = ?').get(characterId);
        if (sleepingStatus?.sleep_until) {
          finalScheduledAt = sleepingStatus.sleep_until;
        } else {
          // fallback: 8 小时后（正常情况下不会走到这里）
          finalScheduledAt = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
        }
      }

      // 幂等检查：client_msg_id 已存在则跳过写入（前端重试保护）
      let userRawId, userMsgId;
      if (client_msg_id) {
        const existing = db.prepare('SELECT id FROM raw_messages WHERE client_msg_id = ? AND conversation_id = ?').get(client_msg_id, conversationId);
        if (existing) {
          // 重试请求：用户消息已写入，检查 reply_queue 是否已有 waiting 条目
          console.log(`[chat] idempotent (sleeping): skipping duplicate user message (client_msg_id=${client_msg_id})`);
          userRawId = existing.id;
          const existingMsg = stmt('SELECT id FROM messages WHERE raw_id = ? AND role = ?').get(userRawId, 'user');
          userMsgId = existingMsg?.id;
          // 检查是否已有 waiting 的队列条目
          const existingQueue = stmt(
            'SELECT id FROM reply_queue WHERE client_msg_id = ? AND status = ?'
          ).get(client_msg_id, 'waiting');
          if (existingQueue) {
            // 已经排队中，直接返回（完全幂等）
            return res.json({
              queued: true,
              delay: delayInfo.delay,
              delayMinutes: delayMinutes,
              currentActivity: delayInfo.activity,
              estimatedReplyAt: delayInfo.delay === -1
                ? finalScheduledAt
                : new Date(Date.now() + delayMinutes * 60000).toISOString(),
            });
          }
        }
      }
      if (!userRawId) {
        const userRaw = stmt(`INSERT INTO raw_messages (conversation_id, role, content, client_msg_id) VALUES (?, 'user', ?, ?)`)
          .run(conversationId, message, client_msg_id || null);
        userRawId = userRaw.lastInsertRowid;
        const userMsg = stmt(`INSERT INTO messages (conversation_id, raw_id, role, content, images, seq) VALUES (?, ?, 'user', ?, ?, 0)`)
            .run(conversationId, userRawId, parsedUserMessage.content, parsedUserMessage.images.length > 0 ? JSON.stringify(parsedUserMessage.images) : null);
        userMsgId = userMsg.lastInsertRowid;
      }

      stmt(`
        INSERT INTO reply_queue (character_id, conversation_id, user_raw_msg_id, user_msg_id, user_content, client_msg_id, scheduled_reply_at, current_activity, delay_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        characterId, conversationId, userRawId, userMsgId,
        message, client_msg_id || null, finalScheduledAt,
        delayInfo.activity, delayMinutes
      );

      // 重置主动聊天未回复计数（同正常流程）
      resetUnansweredStreak(characterId);

      // ── 睡眠模式：建立 SSE 流，推送 Zzz 消息 + 瞄一眼生图 ──
      if (delayInfo.delay === -1) {
        const character = stmt('SELECT * FROM characters WHERE id = ?').get(characterId);
        if (character) {
          // 梦境系统：睡中被叫 → 当场造梦 + 梦话应答 + 现场生图（用户消息仍照常进回复队列，醒后合并回复）
          await handleDreamTalkReply(res, characterId, conversationId, userMsgId, character, message);
          return;
        }
      }

      return res.json({
        queued: true,
        delay: delayInfo.delay,
        delayMinutes: delayMinutes,
        currentActivity: delayInfo.activity,
        estimatedReplyAt: delayInfo.delay === -1
          ? finalScheduledAt
          : new Date(Date.now() + delayMinutes * 60000).toISOString(),
      });
    }

    // ── 安全兜底：日程未拦截但 DB 中标记为睡眠状态 ──
    // 日程系统可能因模板缺失/缓存过期/功能开关等原因未检测到睡眠，
    // 但 characters.is_sleeping 是 scheduleManager 定时同步的可靠标志
    const sleepingChar = stmt('SELECT is_sleeping, sleep_until, temporary_wake_until FROM characters WHERE id = ?').get(characterId);
    // isTempWoken 检查"未过期"而非"值存在"——过期残留值不应使睡眠兜底失效
    if (sleepingChar && sleepingChar.is_sleeping === 1 && !isTempWoken(characterId)) {
      const sleepUntil = sleepingChar.sleep_until
        || new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');

      // 保存用户消息 + 写入回复队列（同上面的 sleeping 路径）
      let userRawId, userMsgId;
      if (client_msg_id) {
        const existing = db.prepare('SELECT id FROM raw_messages WHERE client_msg_id = ? AND conversation_id = ?').get(client_msg_id, conversationId);
        if (existing) {
          console.log(`[chat] idempotent (sleeping fallback): skipping duplicate (client_msg_id=${client_msg_id})`);
          userRawId = existing.id;
          const existingMsg = stmt('SELECT id FROM messages WHERE raw_id = ? AND role = ?').get(userRawId, 'user');
          userMsgId = existingMsg?.id;
          const existingQueue = stmt(
            'SELECT id FROM reply_queue WHERE client_msg_id = ? AND status = ?'
          ).get(client_msg_id, 'waiting');
          if (existingQueue) {
            return res.json({
              queued: true,
              delay: -1,
              delayMinutes: -1,
              currentActivity: '睡觉',
              estimatedReplyAt: sleepUntil,
            });
          }
        }
      }
      if (!userRawId) {
        const userRaw = stmt(`INSERT INTO raw_messages (conversation_id, role, content, client_msg_id) VALUES (?, 'user', ?, ?)`)
          .run(conversationId, message, client_msg_id || null);
        userRawId = userRaw.lastInsertRowid;
        const userMsg = stmt(`INSERT INTO messages (conversation_id, raw_id, role, content, images, seq) VALUES (?, ?, 'user', ?, ?, 0)`)
            .run(conversationId, userRawId, parsedUserMessage.content, parsedUserMessage.images.length > 0 ? JSON.stringify(parsedUserMessage.images) : null);
        userMsgId = userMsg.lastInsertRowid;
      }

      stmt(`
        INSERT INTO reply_queue (character_id, conversation_id, user_raw_msg_id, user_msg_id, user_content, client_msg_id, scheduled_reply_at, current_activity, delay_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        characterId, conversationId, userRawId, userMsgId,
        message, client_msg_id || null, sleepUntil,
        '睡觉', -1
      );

      resetUnansweredStreak(characterId);

      const character = stmt('SELECT * FROM characters WHERE id = ?').get(characterId);
      if (character) {
        // 梦境系统：睡中被叫 → 当场造梦 + 梦话应答（同上，回复队列不受影响）
        await handleDreamTalkReply(res, characterId, conversationId, userMsgId, character, message);
        return;
      }

      return res.json({
        queued: true,
        delay: -1,
        delayMinutes: -1,
        currentActivity: '睡觉',
        estimatedReplyAt: sleepUntil,
      });
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // 生图期间 SSE 流可能长时间无数据写入，禁用 socket/response 超时
  req.socket.setTimeout(0);
  res.setTimeout(0);
  // 情绪评估等异步回调可能在主流程 res.end() 之后才 resolve，
  // 对已结束的响应 write 会触发 ERR_STREAM_WRITE_AFTER_END（此前靠全局 uncaughtException 兜住）
  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    // 上游 3.6.0：立绘展示窗口要跟着本轮 emoji 关键帧走
    if (event === 'token' && data?.emojiKeys?.length) publishStandingKeys(standingTurn, data.emojiKeys);
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // 心跳（P0-05）：生图与长文本生成期间可能几十秒没有任何业务事件。
  // 前端有「无活动超时」，没有心跳会被误判成断流。注释行是 SSE 合法 no-op。
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(heartbeat); return; }
    try { res.write(':keepalive\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);
  res.on('close', () => clearInterval(heartbeat));

  try {
    // 1. 保存用户消息（双表：raw_messages 完整原文 + messages 单条展示）
    //    幂等检查：client_msg_id 已存在则跳过写入，前端 SSE 流已建立无需重复 commit
    let userMsgId;
    let userRawMsgId;
    if (client_msg_id) {
      const existing = db.prepare('SELECT id FROM raw_messages WHERE client_msg_id = ? AND conversation_id = ?').get(client_msg_id, conversationId);
      if (existing) {
        // 重试请求：用户消息已写入，直接复用（避免 DB 重复记录）
        console.log(`[chat] idempotent: skipping duplicate user message (client_msg_id=${client_msg_id})`);
        userRawMsgId = existing.id;
        userMsgId = stmt(`SELECT id FROM messages WHERE raw_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`).get(existing.id)?.id;
        send('msg_saved', { id: userMsgId, role: 'user', created_at: new Date().toISOString() });
      }
    }
    if (!userRawMsgId) {
      const userRaw = stmt(`INSERT INTO raw_messages (conversation_id, role, content, client_msg_id) VALUES (?, 'user', ?, ?)`)
        .run(conversationId, message, client_msg_id || null);
      userRawMsgId = userRaw.lastInsertRowid;
        const userMsg = stmt(`INSERT INTO messages (conversation_id, raw_id, role, content, images, seq) VALUES (?, ?, 'user', ?, ?, 0)`)
          .run(conversationId, userRawMsgId, parsedUserMessage.content, parsedUserMessage.images.length > 0 ? JSON.stringify(parsedUserMessage.images) : null);
        userMsgId = userMsg.lastInsertRowid;
        send('msg_saved', { id: userMsgId, role: 'user', client_msg_id: client_msg_id || null, content: parsedUserMessage.content, images: parsedUserMessage.images.length > 0 ? parsedUserMessage.images : undefined, leadingSticker: parsedUserMessage.leadingSticker, created_at: new Date().toISOString() });
      }


    // 1.5 用户发送新消息 → 重置回复猜想冷却，本轮的 assistant 回复可以触发一次猜想
    // 完成确认丢失后的重试：只回放已存回复，不再请求模型或生成第二轮（上游 v4.2.0）
    if (completedReply) {
      for (const { id, p } of completedReply.saved) {
        send('token', { content: p.content, ...(p.images.length ? { images: p.images } : {}) });
        send('bubble_break', {});
        send('msg_saved', { id, raw_id: completedReply.rawId, role: 'assistant', content: p.content, images: p.images });
      }
      send('response_end', {});
      send('dialogue_saved', { raw_id: completedReply.rawId });
      getStandingDisplay().complete(standingTurn);
      clearInterval(heartbeat);
      res.end();
      return;
    }

    guessCooldowns.delete(conversationId);

    // 2. 加载角色
    const character = stmt('SELECT * FROM characters WHERE id = ?').get(characterId);

    // 2.1 用户在跟临时唤醒的角色聊天 → 重置睡眠倒计时，保持活跃清醒
    if (isTempWoken(characterId)) extendTempWake(characterId);

    // 3. 生图意图（正则强匹配 → 提前检测，用于 msgs[2] 格式消息）
    const explicitImageIntent = detectImageIntent(message);

    // 4.5b 活跃奇遇检测（提前查询，供情绪引擎 + 人格层锚点 + 上下文注入三处使用）
    // 奇遇创建已超过一天的视为过期话题：私聊中不再提及（情绪联动与上下文注入一并失效）
    const activeEvent = stmt(`
      SELECT id, title, description, current_branch, choice_history, status, engaged, event_type_key, emphasis_delivered, referenced_character_ids
      FROM character_events
      WHERE character_id = ? AND status IN ('open','engaged')
        AND created_at > datetime('now', '-1 day')
      ORDER BY id DESC LIMIT 1
    `).get(characterId);

    // ── 交叉角色检测（扫描最近三轮对话 + 用户实际输入 + 事件引用）──
    const recentHistory = stmt(`
      SELECT role, content FROM raw_messages
      WHERE conversation_id = ? ORDER BY id DESC LIMIT 6
    `).all(conversationId);
    // 提取用户实际输入：message 末尾 </dynamic_context> 之后的部分
    const extractRealContent = (text) => {
      const idx = text.lastIndexOf('</dynamic_context>');
      return idx >= 0 ? text.slice(idx + '</dynamic_context>'.length).trim() : text;
    };
    const recentInputs = recentHistory.map(m => extractRealContent(m.content)).join('\n');
    const realInput = extractRealContent(message);
    const scanText = recentInputs + '\n' + realInput;
    const crossMatches = matchAll(scanText, characterId);
    const eventRefIds = activeEvent?.referenced_character_ids
      ? JSON.parse(activeEvent.referenced_character_ids) : [];
    const allRefIds = [...new Set([...eventRefIds, ...crossMatches.map(m => m.id)])].slice(0, 3);
    const crossChars = allRefIds.map(id => stmt(
      'SELECT id, display_name, short_prompt, base_prompt, loras FROM characters WHERE id = ?'
    ).get(id)).filter(Boolean);

    // 4. 情绪状态加载（VAD 三维情绪 → 用于 msgs[1] 身份消息）
    //     好感度提前加载
    let emotionPrompt = '';
    let affinity = null;
    if (config.features.emotion) {
      const emotionBaseline = character
        ? JSON.parse(character.emotion_baseline || '{"valence":0.5,"arousal":0.5,"dominance":0.5}')
        : { valence: 0.5, arousal: 0.5, dominance: 0.5 };
      const emotionState = loadEmotionState(conversationId, emotionBaseline);
      affinity = loadAffinity(characterId);

      // 4.5a 每日首次互动奖励：+5（在注入 LLM 之前就加成）
      //
      // ⚠️ 判据是**用户真实互动**（messages 表里上一条 user 的时间），不是
      // user_relationships.last_interaction_at —— 后者会被系统写入污染（情绪评估落库、触摸、送礼
      // 都走 saveAffinity(..., true) 把它写成系统时刻），于是用户当天真正来聊天时 +5 拿不到。
      // 口径与实现见 services/chatDailyBonus.js（含"奖励按真实日界、不吃程序时间"的有意裁决）。
      const dailyBonus = saveDailyInteractionBonus(db, characterId, { conversationId });
      if (dailyBonus > 0) {
        affinity = loadAffinity(characterId);   // 上面已 +5 落库，这里读回最新值继续参与后续注入
        console.log(`[chat] daily first interaction bonus: +${dailyBonus} → affinity=${affinity.toFixed(0)}`);
      }

      // 4.6 奇遇情绪联动：根据事件类型叠加 VAD 偏移（纯规则映射，零 LLM 开销）
      if (activeEvent && activeEvent.event_type_key) {
        const vadMod = getEventVadModifier(activeEvent.event_type_key);
        if (vadMod) {
          const clamp = v => Math.max(-1, Math.min(1, v));
          emotionState.instant.valence = clamp(emotionState.instant.valence + vadMod.valence);
          emotionState.instant.arousal = clamp(emotionState.instant.arousal + vadMod.arousal);
          emotionState.instant.dominance = clamp(emotionState.instant.dominance + vadMod.dominance);
          emotionState.mood.valence = clamp(emotionState.mood.valence + vadMod.valence * 0.5);
          emotionState.mood.arousal = clamp(emotionState.mood.arousal + vadMod.arousal * 0.5);
          emotionState.mood.dominance = clamp(emotionState.mood.dominance + vadMod.dominance * 0.5);
          console.log(`[chat] 🎭 adventure VAD: ${activeEvent.event_type_key} → V${vadMod.valence>=0?'+':''}${vadMod.valence.toFixed(2)} A${vadMod.arousal>=0?'+':''}${vadMod.arousal.toFixed(2)} D${vadMod.dominance>=0?'+':''}${vadMod.dominance.toFixed(2)}`);
        }
      }

      emotionPrompt = stateToPrompt(emotionState) || '';
    }

    // ═══════════════════════════════════════════
    // 上下文组装 — 稳定块 + 摘要 + checkpoint 历史 + 动态尾部
    // ═══════════════════════════════════════════

    // 当前用户 raw message ID 在幂等命中或写入时已精确记录，用于审计快照。

    // ── 稳定块 [0]：舞台 — 破限词 + 世界观 ──
    const jailbreak = getSystemRules();
    const worldSetting = getWorldSetting();
    const stageContent = [jailbreak, worldSetting].filter(Boolean).join('\n\n');

    // ── 稳定块 [1]：角色基础人格（不含日程、不含奇遇）+ 道具临时状态 ──
    let charBaseContent = character?.base_prompt || getDefaultPrompt();
    const buffBlock = getActiveBuffBlock(characterId);
    if (buffBlock) charBaseContent = `${charBaseContent}\n\n${buffBlock}`;
    // 小镇世界状态（当日《邻舍日报》15% 概率产出）：影响全镇所有人，注入位与道具 buff 同位
    const worldStateBlock = getWorldStateBlock();
    if (worldStateBlock) charBaseContent = `${charBaseContent}\n\n${worldStateBlock}`;

    // ── 稳定块 [2]：用户上下文 + 关系 + 固定格式规则 ──
    const chatUserName = config.user.nickname || '用户';
    const hasUserInfo = config.user.nickname || config.user.gender || config.user.appearance || config.user.persona;

    // 用户→角色关系
    const userRel = stmt(
      'SELECT relationship_text, is_oath FROM user_relationships WHERE character_id = ?'
    ).get(characterId);

    // 角色间关系
    const charRels = stmt(`
      SELECT 'from' AS direction, cr.relationship_text, c.display_name
      FROM character_relationships cr
      JOIN characters c ON c.id = cr.to_character_id
      WHERE cr.from_character_id = ? AND cr.relationship_text != ''
      UNION ALL
      SELECT 'to' AS direction, cr.relationship_text, c.display_name
      FROM character_relationships cr
      JOIN characters c ON c.id = cr.from_character_id
      WHERE cr.to_character_id = ? AND cr.relationship_text != ''
    `).all(characterId, characterId);

    const userInfoParts = [];
    if (userRel && userRel.relationship_text) {
      userInfoParts.push(`<user_relation>你对于user而言的身份是${userRel.relationship_text}。这个身份为最高优先级，即使你在外有其他身份，但是在user面前就是这样的。请在对话中自然体现这层身份，不必刻意说明，行为举止应符合这层身份。</user_relation>`);
    }
    if (userRel && userRel.is_oath) {
      userInfoParts.push(`<oath_bond>你们之间有一个比普通关系更深一层的约定——${chatUserName}曾经郑重地送过你一枚戒指。这代表了独一无二的羁绊和承诺。在对话中，你的行为和情感会自然地带有"你是我最重要的人"的底色——不是因为规则要求，而是因为这层羁绊已经是你内心的一部分。</oath_bond>`);
    }
    if (hasUserInfo) {
      // 2026-10-02 用户反馈「角色对话还是有一些不遵从设定，和玩家的性别与自我描述」：
      // 原先这里只是事实陈述，模型把性别/自述当参考而不是设定 ⇒ 内容改由唯一入口产出（含"必须遵从"的约束）。
      // 标签 `<user_info>` 与它在 userInfoParts 里的位置保持不变（下游与测试依赖这个标签）。
      userInfoParts.push(`<user_info>${buildUserInfoBlock(config.user || {}, { style: 'chat', displayName: chatUserName })}</user_info>`);
    }
    if (charRels.length > 0) {
      const relLines = charRels.map(r => {
        if (r.direction === 'from') return `- ${r.display_name}是你的${r.relationship_text}`;
        return `- ${r.display_name}认为你是她的${r.relationship_text}`;
      }).join('\n');
      userInfoParts.push(`<character_relations>你与其他角色的关系：\n${relLines}\n\n请在对话中自然体现这些关系，不必刻意说明，但当提到或遇到这些角色时，行为举止应符合你们的关系。</character_relations>`);
    }

    // 固定格式规则保持在稳定前缀（<dialogue_format_rules>）；
    // 静态活人感规则（<dialogue_rules>）与表情包清单（<emoji_stickers>）走下方 preSummarySystem，
    // 独立成一条 system 紧贴摘要之上；
    // 随好感度变化的长度条（<reply_length>）不进稳定层（见下方 dynamicBlocks），避免换档时挪动缓存前缀。
    // 配置了语言风格时，稳定前缀里的“不是写舞台剧本/禁止旁白”也要换成风格变体，
    // 不能只靠后面的风格块覆盖——实测模型会把前排的硬禁止当成不可违背的规则。
    const hasLanguageStyle = hasActiveWorldLanguageStyle();
    const coreRules = getCoreDialogueRules({ userName: chatUserName || '用户', allowNarration: hasLanguageStyle });
    userInfoParts.push(`<dialogue_format_rules>
${coreRules}
- **在合适的时机，你会想要和用户分享照片或者给他看某些事物。**
- {"prompt":"Description of the scene"}：对话历史中若出现这种格式，意味着这里出现了一张这样的图片，继续自然对话即可。
</dialogue_format_rules>`);

    const formatContextBlock = userInfoParts.length > 0 ? userInfoParts.join('\n\n') : '';

    // ── 稳定块集合 ──
    // 神说改过的世界事实属于「低频变动」的稳定内容，必须排在人格之前（上游 v4.2.0 口径）
    const godWorldContext = getGodWorldContext([Number(characterId)]);
    const stableBlocks = [stageContent, godWorldContext, charBaseContent, formatContextBlock].filter(Boolean);
    // 世界事件只在生效期内复用，置于跨角色变化之前；不认证为永久静态世界书边界。
    const chatCacheBoundary = godWorldContext
      ? { index: stableBlocks.indexOf(godWorldContext), offset: 0 }
      : { index: stableBlocks.indexOf(charBaseContent), offset: (character?.base_prompt || getDefaultPrompt()).length };

    // Memory v3 阶段二：@memory 主动回想协议（仅 1v1 聊天，群聊明确排除）。
    // 放 stableBlocks 尾部：稳定前缀之外，开关关闭时不进 prompt（零影响，方案 §5.1）。
    const activeSearchConfig = config.features.memory ? getActiveSearchConfig() : { enabled: false, timeoutMs: 4000 };
    const recallGateEnabled = activeSearchConfig.enabled;
    if (recallGateEnabled) {
      stableBlocks.push(`<recall_tool>
如果你需要回想过去的对话细节——对方提起一件“你应该记得”的事、时间较久远的事、
或下方提供的记忆片段不足以回应时——你可以在回复的第一行输出检索指令：

@memory 一句自然的查询（例如：@memory 她之前说过家里的事吗）

输出指令后立即停止，系统会替你回想并把结果反馈给你，你再继续正常回复。
每轮最多使用一次；只是闲聊或记忆片段已够用时不要使用。
</recall_tool>`);
    }

    // ── 摘要块 ──
    const summaries = getRecentSummaries(conversationId, 1);
    const summaryBlock = summaries.length > 0
      ? '[对话历史摘要 — 以下是你和用户之前对话的摘要，已按时间顺序排列]\n' + summaries[0].summary
      : null;

    // ── checkpoint 历史 + 活跃聊天历史（滑动窗口） ──
    // 催眠遗忘窗口：屏蔽只作用于"喂给模型的这段历史"——原聊天记录仍在库里（可审计、可撤销），
    // 前端展示的历史也不受影响。组装器只认区间，窗口语义由 hypnosisService 负责。
    // 开关关闭时不传 → getSplitHistory 走原路径，零行为变化。
    let hypnoExcludeWindows = [];
    if (config.features.hypnosis !== false) {
      try {
        // 一次查库拿窗口，再交给组装器做内存判断（不逐条查库）
        hypnoExcludeWindows = listForgottenWindows(characterId)
          .map(w => ({ fromRawId: w.fromRawId, toRawId: w.toRawId }));
      } catch (err) {
        console.warn('[hypnosis] forgotten windows lookup failed:', err.message);
      }
    }
    const { checkpoint, checkpointHistory, activeText: activeChatText, activeRounds, activeSegments } = getSplitHistory(db, conversationId, 10, 10, {
      userName: chatUserName,
      characterName: character.display_name,
      excludeWindows: hypnoExcludeWindows,
    });
    // 注：这里原有 3 行 [DEBUG] 上下文拆分日志（afterId / checkpoint末条assistant / active首行），
    // 每轮必打且把对话原文前 60~80 字写进日志（刷屏 + 隐私面）。2026-09-30 按代码审查改进 §1.1 删除。
    // 需要复核上下文拆分时：contextUsage 面板给的是同一批数字（分段规模 + 指纹），不再靠日志。

    // ── 反重复检测（阶段一 L1-1 + L2）──
    // 取「她最近几轮说过什么」+「最近几轮情绪快照」喂给纯函数检测器：
    //   · sinceRawId = 最新摘要分界线（已摘要的不在活跃上下文里，不参与比较）
    //   · excludeWindows = 催眠遗忘窗口（被屏蔽的回复不算"她说过"）
    // 两个开关默认开：关闭 / 检测器无输出 / 查库失败时**一个块都不注入**，与加功能前逐字节一致。
    const antiRepEnabled = config.features.antiRepetition !== false;
    const antiRepLockEnabled = config.features.antiRepetitionLock !== false;
    // 阶段二自动升级开关：关闭 → 检测器完全按阶段一的 base 阈值判定（行为与阶段一一致）。
    // 用户裁决「阶段一保持温和、阶段二才升级」，因此升级单独一个开关，默认开、可随时关。
    const antiRepEscalationEnabled = config.features.antiRepetitionEscalation !== false;
    let recentAssistantTurns = [];
    let recentEmotionSnapshots = [];
    let antiRepetitionResult = null;
    // ⚠️ 催眠「完全控制」轮本就该重复执行指令，反重复块会跟催眠块打架 ⇒ 要显式跳过。
    // 但**不能**引用下面的 `hypnosisNeedsFullPerformance`：它是在催眠块里才声明的（L963 附近），
    // 在这里读会抛 TDZ `Cannot access ... before initialization` —— 真机 E2E 抓到过：
    // `[anti-repetition] detection failed: ...`，结果是**每轮都抛异常、反重复块一个都没注入**（被 catch 吞掉）。
    // 那里自己读一次状态，口径与催眠块保持一致（active && bodyControlled && !mindAwake）。
    let antiRepHypnosisActive = false;
    try {
      const stForAntiRep = getHypnosisState(characterId);
      antiRepHypnosisActive = !!(stForAntiRep?.active && stForAntiRep.bodyControlled && !stForAntiRep.mindAwake);
    } catch { /* 读不到状态就当非催眠轮，反重复照常参与 */ }
    if (antiRepEnabled) {
      try {
        recentAssistantTurns = fetchRecentAssistantTurns(db, conversationId, {
          limit: 8,
          sinceRawId: checkpoint?.end_msg_id || 0,
          excludeWindows: hypnoExcludeWindows,
        });
        recentEmotionSnapshots = config.features.emotion
          ? fetchRecentEmotionSnapshots(db, conversationId, { limit: 8 })
          : [];
        antiRepetitionResult = buildAntiRepetitionInjection({
          recentAssistantTurns,
          emotionSnapshots: antiRepLockEnabled ? recentEmotionSnapshots : [],
          // 催眠"完全控制"轮就是要重复执行指令，反重复块会跟催眠块打架 → 显式跳过
          hypnosisActive: antiRepHypnosisActive,
          // 阶段二：连续高复述 → 本轮（即"下一轮回复"）把约束升到 mode="escalated"；关闭则退回阶段一判定
          escalationEnabled: antiRepEscalationEnabled,
        });
      } catch (err) {
        // 反重复是增强项：任何异常都退回"不注入"，绝不影响聊天主流程
        console.warn('[anti-repetition] detection failed:', err.message);
        antiRepetitionResult = null;
      }
    }

    // ── D2 · 重写兜底（reroll）：本轮生成结束后是否要重写一次 ──
    // 用户裁决：**默认关**（features.antiRepetitionReroll）；关着时这里只是把既定流程走完，零额外调用。
    // 触发条件（复用既有检测档位 strong/escalated，不新造检测器）与"只重写一次"的口径都在
    // services/antiRepetition.js 的 shouldReroll 里，这里只提供本轮上下文。
    // 注意 clientGone 要等流跑起来才有值，所以这里先用 false 出一个"计划"，真正 fire 前再复核一次。
    const antiRepRerollEnabled = config.features.antiRepetitionReroll === true;
    let antiRepRerollFired = 0;
    const antiRepRerollPlan = shouldReroll({
      enabled: antiRepRerollEnabled,
      result: antiRepetitionResult,
      firedCount: antiRepRerollFired,
      hypnosisActive: antiRepHypnosisActive,
      clientGone: false,
    });

    // ── 动态尾部块（将附加到最新 user 消息） ──
    const dynamicBlocks = [];
    const memorySnapshot = [];

    // 1. 最近信箱往来
    const recentLetters = listRecentMailboxLetters(db, { characterId });
    if (recentLetters.length > 0) {
      const letterLines = recentLetters.map(l => {
        const daysLabel = formatRelativeDay(l.days_ago);
        const userBrief = (l.content || '').slice(0, 50);
        const replyBrief = l.content_short || (l.reply_content || '').slice(0, 50);
        return `- ${daysLabel}：${chatUserName}来信"${userBrief}..." → 你回信"${replyBrief}..."`;
      });
      dynamicBlocks.push(`<mailbox_history>你与${chatUserName}的最近信箱往来：\n${letterLines.join('\n')}\n\n可以在对话中自然地提及近期的通信内容，让对话更有连续性。</mailbox_history>`);
    }

    // 2. 最近奇遇总结（仅提及一天内结束的奇遇，更早的视为过期话题不再主动提）
    const engagedEvent = stmt(`
      SELECT title, summary, ended_at
      FROM event_history WHERE character_id = ? AND engaged = 1
        AND ended_at > datetime('now', '-1 day')
      ORDER BY ended_at DESC LIMIT 1
    `).get(characterId);
    if (engagedEvent) {
      dynamicBlocks.push(`<event_history>\n${character.display_name}最近经历了一些事：\n${engagedEvent.title}：${engagedEvent.summary || ''}\n你可以在对话中自然地提起或询问这些经历。\n</event_history>`);
    }

    // 3. 最近朋友圈（含评论区）
    const recentMomentsBlock = buildPrivateMomentContext(db, {
      characterId,
      characterName: character.display_name,
      userName: chatUserName,
    });
    if (recentMomentsBlock) dynamicBlocks.push(recentMomentsBlock);

    // 4. 日程上下文（当前在做什么 / 睡醒等）
    let scheduleCtx = (config.features.schedule !== false) ? formatScheduleContext(characterId) : null;
    // 2026-11-04 修「动作死板、对不上」：日程块和亲密块会**互相矛盾** ——
    // 日程说「你正在学院食堂早餐与晨检」，后面的 intimate_scene 说「你和 Sting 正在做爱」。
    // 模型拿到两段冲突的事实只能折中，表现就是动作写得含糊、和当前体位对不上。
    // 这里在有进行中亲密场景时，明确告诉它「日常日程只是今天的计划，此刻不在那里」。
    try {
      const sceneNow = Number.isInteger(Number(characterId)) ? getIntimateScene(Number(characterId)) : null;
      if (scheduleCtx && sceneNow && sceneNow.active) {
        scheduleCtx = `【与亲密场景冲突时以此为准】你此刻并不在上面这个日常活动里：`
          + `你和${chatUserName}正在进行中的亲密场景才是当下的真实处境（地点、姿势、身体状态以下面的亲密场景为准）。`
          + `日常日程只是今天原本的计划，不要拿它当现在发生的事，也不要因为它而拒绝或迟疑。

`
          + scheduleCtx;
      }
    } catch (err) {
      console.warn('[chat] 亲密场景覆盖日程失败（不影响本轮）:', err?.message || err);
    }
    if (scheduleCtx) {
      dynamicBlocks.push(`<schedule_context>\n${scheduleCtx}\n</schedule_context>`);
    }

    // 上游 v4.2.0：最近图片任务的**真实状态**要进上下文。
    // 工具链路下图片是后台生成的，模型上一轮"已经发图"的自我认知可能是错的 ——
    // 不给真实状态，它会说"刚给你发了"而图其实还在队列里（真机表现就是"图呢？"）。
    try {
      const imageStates = db.prepare(`SELECT p.scene,t.status,t.error_message FROM private_chat_image_turns p
        JOIN image_tasks t ON t.id=p.task_id WHERE p.conversation_id=? ORDER BY p.user_raw_id DESC LIMIT 3`).all(conversationId);
      if (imageStates.length) {
        dynamicBlocks.push('【最近图片任务真实状态】\n' + imageStates.map(t =>
          `${t.scene || '最后一轮对话配图'}：${t.status === 'done' ? '图片已完成' : t.status === 'failed' ? '生成失败' : '已受理，图片尚未完成'}`
        ).join('\n'));
      }
    } catch (err) {
      console.warn('[chat] 图片任务状态注入失败（不影响本轮）:', err?.message || err);
    }

    // 5. 好感度关系深度（档位全文）：换档只在跨越 20/40/60/80/100 边界时发生，变动频率极低，
    //    按动态块的变动频率排序放前部；末尾另有一行 <attitude_reminder> 重申拿回注意力权重
    if (config.features.emotion && affinity != null) {
      const affinityMsg = affinityToPrompt(affinity);
      if (affinityMsg) dynamicBlocks.push(`<affinity_attitude>\n${affinityMsg.trim()}\n</affinity_attitude>`);
    }

    // 5.5 亲密档案与相处记忆（面板「知晓」开关控制）
    //     位置：紧跟好感度档位 —— 两者都是"她对这个人的认知"，同属关系层，放在一起便于模型串联；
    //     就是普通 dynamicBlock，因而同样受下方 applyBudgetToBlocks 的预算降级保护。
    //     开关关闭 / 档案为空时 buildIntimateProfileBlock 返回空串，即零注入零 token。
    if (config.features.intimate !== false) {
      const intimateBlock = buildIntimateProfileBlock(characterId, { chatUserName });
      if (intimateBlock) dynamicBlocks.push(intimateBlock);
    }

    // 5.54 玩具状态块（专题-玩具系统 §2.5/§2.9-4）：位置=动作块**紧前面**（同属"她此刻的身体处境"层）。
    //     开关关闭 / 零佩戴 ⇒ buildWornToysBlock 返回 null ⇒ 零注入零 token（与加功能前逐字节一致）。
    if (config.features.toys === true) {
      // 5.54a **她自己主动玩**（2026-10-02 接线；玩法扩充 task-2 交付的判断路径）：
      //   原来只有"打开玩具面板"或"逗她一下"才会判 —— 聊天时她永远不动手，用户要的"她自己玩"落不了地。
      //   判定输入在这里采集（催眠/睡眠/好感），toyService 刻意不 import 这两个模块以避免成环。
      //   骰子是**确定性**的（角色 + 10 分钟窗口）⇒ 同一窗口内连聊多轮只可能判一次、且可复算。
      //   判定在**建块之前**：她这一轮动手了，<worn_toys> 下面的 <self_toy_play> 块会自动跟上（auto 口径）。
      try {
        const hypnoForSelfPlay = getHypnosisState(characterId);
        const sleepForSelfPlay = stmt('SELECT is_sleeping FROM characters WHERE id = ?').get(characterId);
        const selfPlay = maybeSelfPlay(characterId, {
          scene: 'chat',
          signals: {
            hypnosisActive: hypnoForSelfPlay?.active === true,
            bodyControlled: hypnoForSelfPlay?.bodyControlled === true,
            sleeping: Number(sleepForSelfPlay?.is_sleeping) === 1,
          },
          emotion: { affinity: Number(loadAffinity(characterId)) || 0 },
        });
        if (selfPlay?.play && selfPlay.applied) {
          console.log(`[toys] 她自己主动玩了：${selfPlay.label || selfPlay.toyKey}（${selfPlay.code}${selfPlay.changed ? '，状态有变化' : ''}）`);
        }
      } catch (err) {
        console.warn('[toys] 自我玩判定失败（不影响本轮）:', err.message);
      }
      try {
        const wornToysBlock = buildWornToysBlock(characterId, { scene: 'chat' });
        if (wornToysBlock) dynamicBlocks.push(wornToysBlock);
      } catch (err) {
        console.warn('[toys] chat inject failed:', err.message);
      }
    }

    // 5.54b 亲密场景块（2026-10-02，性爱交互玩法 task-1 交付的注入入口）：
    //   没有这一轮注入，她打字时会**不知道自己正被插着** —— 面板点得再顺，聊天里也会前后矛盾
    //   （"我们开始吧"这类禁句就是靠这个块压住的）。未进行中/空闲超时 ⇒ 返回空串 ⇒ 零注入零 token。
    if (config.features.intimateActions !== false) {
      try {
        const intimateSceneBlock = buildIntimateScenePromptBlock(characterId, { chatUserName });
        if (intimateSceneBlock) dynamicBlocks.push(intimateSceneBlock);
        // 「不许她到」时再加一行演法指令：她能感觉到自己一直差那么一点 ⇒ 会渴望、会索要、会逞强。
        // 没有这一行时，模型只把"禁止高潮"当成一个数值，聊起来像没事人（用户报的就是这个）。
        const denialHunger = buildDenialHungerLine(characterId, { chatUserName });
        if (denialHunger) dynamicBlocks.push(denialHunger);
        // 她自己的敏感度（2026-10-02 新数值系统）：敏感/很敏感/极度敏感（或发情模式）才注入一行，
        // 告诉她"身体现在是这个状态"，冷淡与普通档零注入零 token。
        const sensitivityLine = buildSensitivityPromptLine(characterId);
        if (sensitivityLine) dynamicBlocks.push(sensitivityLine);
      } catch (err) {
        console.warn('[intimate] chat inject failed:', err.message);
      }
    }

    // 5.54c 私密时刻「你闯进来了」（2026-10-02 用户原话：「再增加一个事件 叫自慰 和角色敏感度也相关
    //   越高发生概率也就越高 这个可以算到日程里」「这个时候再去找角色私聊就会触发事件
    //   玩家闯入角色正在自慰的情况」）：
    //   判定挂在**她今天的日程**上（独处时段 + 敏感度掷骰，确定性）；只有"此刻正在那个窗口里"才注入。
    //   第一次撞见会落一次记账（caught_at + 敏感度 +self_play），之后同一窗口内换成"她还没缓过来"的口径
    //   —— 不然玩家连发三条消息，每一条都会重演一次"刚被撞见"。
    //   开关关闭 / 不在窗口里 / 没有独处时段 ⇒ 返回空串 ⇒ 零注入零 token。
    if (config.features.intimateActions !== false) {
      try {
        const pending = privateMomentState(characterId, { affinity: Number(loadAffinity(characterId)) || 0 });
        // 她睡着时不演"被撞见"（睡着的人不会在做这件事；床头那条线走「被弄醒」那套）。
        // 用角色行上的 is_sleeping：与他处（玩具自我玩判定）同一口径。
        const sleepingNow = Number(stmt('SELECT is_sleeping FROM characters WHERE id = ?').get(characterId)?.is_sleeping) === 1;
        // ⚠️ 2026-10-03 复查抓到的矛盾：正在进行的性爱（<intimate_scene>：他此刻就插在里面）与
        //   "她一个人在屋里自慰、你刚闯进来"**不可能同时成立** —— 两个块一起喂给模型，她的台词必然自相矛盾。
        //   性爱进行中时直接跳过私密时刻这一块（场景结束/退出后再按正常口径演）。
        const sceneNow = getIntimateScene(characterId);
        const sceneLive = sceneNow?.active === true;
        if (pending.active && !sleepingNow && !sceneLive) {
          // 每次注入都记账：原来只在 firstCatch 时调 ⇒ caught_times 永远是 0/1、
          // "又被撞见一次"那条分支（半权重敏感度、code:'again'）是死代码（2026-10-03 复查）。
          const caught = catchPrivateMoment(characterId);
          if (caught?.code === 'first') {
            console.log(`[privateMoment] 撞见：${characterId} 正在自慰（剩 ${pending.minutesLeft} 分钟，之后转"还没缓过来"口径）`);
          }
          const block = buildPrivateMomentBlock(
            { ...pending, slotActivity: pending.row?.slot_activity, slotLocation: pending.row?.slot_location },
            {
              userName: chatUserName,
              characterName: character?.display_name || character?.name || '她',
              sensitivityLine: buildSensitivityPromptLine(characterId),
            },
          );
          if (block) dynamicBlocks.push(block);
        }
      } catch (err) {
        console.warn('[privateMoment] chat inject failed:', err.message);
      }
    }

    // 5.55 SLG 动作块（触摸互动）——位置口径（Lead 裁决，2026-09-30）：
    //     紧挨亲密档案之后、催眠块之前。动作块是**叙事提示**（"她刚被摸了一下"），
    //     不是本轮最硬约束，所以不进 task-42 后置的 hypnosisBlocks；但也别排太靠后，
    //     免得被自己上面的 <reply_length> 与后面的历史原文淹没。
    //     一次动作只注入一次（markTouchEventInjected）；开关关闭 / 无待反应动作 ⇒ 零注入零 token。
    //     不传 hypnosisBlock：催眠状态块由下面的 5.6 段独立注入（并整块后置），在这里再拼一份就重复了。
    if (config.features.touch !== false) {
      try {
        const pendingTouch = takePendingTouchEvent(characterId);
        if (pendingTouch) {
          const touchBlock = buildTouchActionBlock({
            actionKey: pendingTouch.actionKey,
            userName: chatUserName,
            mode: pendingTouch.mode,
            annoyance: pendingTouch.annoyance,
            likeRatio: pendingTouch.likeRatio,
            hypnotized: isBodyControlled(characterId),
            sleeping: Boolean(isSleeping(characterId).sleeping),
            // 2026-11-03 睡眠锁：锁着时这一下弄不醒她（反应只能写身体与梦呓）
            sleepLocked: isSleepLocked(characterId),
            hypnosisBlock: '',
          });
          if (touchBlock) {
            dynamicBlocks.push(touchBlock);
            markTouchEventInjected(pendingTouch.id);
          }
        }
      } catch (err) {
        // 动作块是增强项：任何异常都退回"不注入"，绝不影响聊天主流程
        console.warn('[touch] action block inject failed:', err.message);
      }
    }

    // 5.6 催眠状态 / 一次性指令 / 遗忘提示（催眠手机）
    //     位置：紧跟亲密档案 —— 都是"她此刻对这个人的处境认知"，同属关系层，放一起便于模型串联；
    //     也都是普通 dynamicBlock，因而同样受下方 applyBudgetToBlocks 的预算降级保护。
    //     一次性指令在这里**消费即清空**（consumePendingDirective 读一次就清），
    //     所以 body_control / forced_climax 只影响紧随的这一轮；memory_restore 是"她想起来了"的提示。
    //     开关关闭 / 未处于催眠 / 无可注内容时各 builder 返回空串 → 零注入零 token。
    //     三段**各自 try/catch**（task-30）：以前一整块 try 时，任一片抛异常会把状态块与指令块
    //     一起丢掉，现象就是"点了强制高潮、她毫无反应，日志只有一行 context inject failed"。
    let hypnosisDirective = '';
    // task-42：催眠块**先攒着不推**，等所有其它动态块排完再整块后置（见下方「5.6 续」）。
    // 真机反馈「催眠之后也没有完全听命」：「只唤醒意志」/「完全控制」两种状态块原先排在
    // 亲密档案之后，后面还压着 user_portrait / reply_length / 情绪 / 聊天历史 / 风格 / 奇遇 / RAG，
    // 尤其 <reply_length>10~60字 会把「演完整」直接切短。催眠是本轮最硬的约束，必须读到最后。
    const hypnosisBlocks = [];
    let hypnosisNeedsFullPerformance = false;
    if (config.features.hypnosis !== false) {
      try {
        // 先取状态：forced_climax 的文案要按"意志是否清醒"分流（只唤醒意志 ≠ 又睡着了）
        const hypnoState = getHypnosisState(characterId);
        try {
          const stateBlock = buildHypnosisStateBlock(hypnoState, { chatUserName });
          if (stateBlock) hypnosisBlocks.push(stateBlock);
          // 完全控制（深度催眠、意志被压制）这一轮必须演到底，不能被长度条切短
          if (hypnoState?.active && hypnoState.bodyControlled && !hypnoState.mindAwake) hypnosisNeedsFullPerformance = true;
        } catch (err) {
          console.warn('[hypnosis] state block inject failed:', err.message);
        }
        try {
          const directive = consumePendingDirective(characterId);
          // 睡眠中触发强制高潮 → 走"被从深度睡眠里硬拉上高潮"的独特表现（不是清醒版也不是沉睡版）。
          // 触发条件：在下发指令这一刻只读查一次 characters 的睡眠标记（不 import 睡眠服务，
          // 免得被日程/睡眠那一侧的改动牵连）；查不到/查库失败一律按清醒处理。
          // 注意 `temporary_wake_until` 这一列是必须的：POST /hypnosis/command 的 forced_climax
          // 会先 wakeForForcedTrigger() 临时唤醒她（否则日程上下文那句"你正在睡觉"会跟指令打架），
          // 此刻 is_sleeping 已经是 0 —— 只看它的话睡梦唤醒版永远不会触发。
          let awakenedFromSleep = false;
          if (directive === 'forced_climax') {
            const sleepRow = stmt('SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = ?').get(characterId);
            awakenedFromSleep = isAwakenedFromSleepRow(sleepRow);
          }
          // task-42：「强制高潮不需要催眠」——非催眠态下发这条指令时，getHypnosisState() 的
          // mindAwake 会被视图层归一成 true（语义是「未催眠＝意志清醒」），但拿去分流会让文案
          // 变成「你可以抗拒、可以羞耻」，与「手机强制」自相矛盾 ⇒ 不在催眠中时一律按纯执行分流。
          const inHypnosis = !!(hypnoState?.active && hypnoState.bodyControlled);
          // force_toy（2026-10-01）：编码值是 `force_toy|toyKey|intensity`，注入块需要玩具名与位置
          // （本模块不 import toyService，展示载荷由 hypnosisService.directiveToyPayload 统一给出）
          const directiveBlock = buildDirectiveBlock(directive, { mindAwake: inHypnosis ? hypnoState.mindAwake : false, awakenedFromSleep, toy: directiveToyPayload(directive) });
          if (directiveBlock) hypnosisBlocks.push(directiveBlock);
          // 强制高潮这一轮同样必须演完整
          if (directive === 'forced_climax') hypnosisNeedsFullPerformance = true;
          // 记下来供生图判断使用：强制高潮这一轮必须出图（见下方"生图判断"路径 D'）
          if (directive === 'forced_climax') hypnosisDirective = directive;
        } catch (err) {
          console.warn('[hypnosis] directive inject failed:', err.message);
        }
        try {
          const amnesiaBlock = buildAmnesiaBlock(listForgottenWindows(characterId));
          if (amnesiaBlock) hypnosisBlocks.push(amnesiaBlock);
        } catch (err) {
          console.warn('[hypnosis] amnesia block inject failed:', err.message);
        }
      } catch (err) {
        // 连状态都取不到（表缺失等）：注入失败绝不能影响聊天主流程
        console.warn('[hypnosis] context inject failed:', err.message);
      }
    }

    // 6. 角色视角的用户画像
    const portraitRows = stmt(`
      SELECT trait_type, content FROM user_portraits
      WHERE character_id = ?
      ORDER BY trait_type, confidence DESC
    `).all(characterId);
    if (portraitRows.length > 0) {
      const grouped = {};
      for (const row of portraitRows) { (grouped[row.trait_type] = grouped[row.trait_type] || []).push(row.content); }
      const portraitStrs = [];
      if (grouped.personality) portraitStrs.push('性格特征：' + grouped.personality.join('、'));
      if (grouped.preference) portraitStrs.push('偏好习惯：' + grouped.preference.join('、'));
      dynamicBlocks.push(`<user_portrait>${chatUserName}在你眼中的印象：\n${portraitStrs.join('\n')}</user_portrait>`);
    }

    // 7. 活人感节奏规则：静态规则 + 表情包清单（跨轮不变，可缓存）拼成一条独立 system，
    //    由 buildChatContext 插在稳定前缀之后、摘要之上，作为缓存前缀的收尾；
    //    随好感度变化的长度条单独降为 dynamicBlocks 首项——好感度换档只动提示词末尾那一小块，
    //    前面的大段（世界观、人格、格式规则、活人感规则、表情包）不再跟着重算。
    //    灵魂系统开启时长度档位由 ExpressionDesire 主导（灵魂优先），affinity 三档不再参与长度判定；
    //    显式生图意图的「15 字以内」硬规则始终优先。灵魂取值失败时静默回退到 affinity 三档。
    //    （上游 v3.9.0 合并：这一节只在原 IIFE 里加了 soulLengthHint 一项，其余分支原样。）
    let soulLengthHint = null;
    if (soulEnabled) {
      try { soulLengthHint = soulReplyLengthHint(characterId); } catch { soulLengthHint = null; }
    }
    const sentenceHint = (() => {
      if (explicitImageIntent) return '15个汉字以内';
      if (soulLengthHint) return soulLengthHint;
      if (affinity == null || affinity < 60) return '10~30个汉字';
      if (affinity < 80) return '10~40个汉字';
      return '10~60个汉字';
    })();
    // 配置了语言风格时，节奏规则换成允许第一人称叙述的变体；
    // 长度条保持原样，不因风格放大或缩小任何字数限制。
    const preSummarySystem = [
      appendWorldLanguageStyle(getChatRhythmRules({ allowNarration: hasLanguageStyle })),
      emojiNote,
    ];
    // 长度条放动态块最前，仍紧跟在规则区之后（<dynamic_context> 顶部）
    // 单独用 <reply_length>，与上方静态 <dialogue_rules> 区分：静态管怎么说话，这条只改本轮长度
    dynamicBlocks.push(`<reply_length>
- **回复控制在${sentenceHint}，保持口语化轻快节奏**
</reply_length>`);

    // 7.5 反重复 / 反钻牛角尖（阶段一 L2）——位置：紧跟 <reply_length> 之后。
    //     专题 §三 的位置约束是「<reply_length> 之后、催眠块之前」：这条要先解除"短回复原地打转"
    //     的倾向，再谈推进话题；催眠块在整段末尾（task-42 后置），优先级仍然更高。
    //     实现顺序与「长度条 → 情绪 → 历史」相反（历史在上面），是有意的：本轮最硬的指令
    //     要靠近提示词末尾；历史原文只作对照，靠 L1-1 的 <recent_self_output_note> 标注。
    //     检测结果与注入与否都记日志（搜 [anti-repetition]），为阶段二调参积累数据。
    if (antiRepetitionResult) {
      if (antiRepetitionResult.topicProgressBlock) {
        dynamicBlocks.push(antiRepetitionResult.topicProgressBlock);
      } else if (antiRepetitionResult.block) {
        dynamicBlocks.push(antiRepetitionResult.block);
      }
      console.log(formatAntiRepetitionLog({
        result: antiRepetitionResult,
        turns: recentAssistantTurns,
        emotionSnapshots: recentEmotionSnapshots,
      }));
    }

    // 8. VAD 三维情绪描述
    if (config.features.emotion && emotionPrompt) {
      dynamicBlocks.push(emotionPrompt);
    }

    // 9. 活跃聊天历史（滑动窗口 0~10 轮）
    if (activeChatText) {
      dynamicBlocks.push(activeChatText);
    }

    // 9.2 L1-1 近端自身输出标注：紧跟历史之后，提醒"上面是你自己说过的话"。
    //     零额外 LLM 调用、约 60 token；没有她自己说过的话（首轮）时不注入。
    if (antiRepEnabled && shouldInjectRecentSelfOutputNote(recentAssistantTurns)) {
      dynamicBlocks.push(buildRecentSelfOutputNote());
    }

    // 9.5 临时表达风格：小概率注入，紧跟历史聊天之后，只影响本轮回复
    //     誓约状态时偏向更亲近的风格（俏皮/撒娇），低好感（<40）时用敌意风格池，一般时用基础池
    if (Math.random() < 0.12) {
      const pool = (affinity != null && affinity < 40) ? TEMP_STYLE_POOL_HOSTILE
        : (userRel && userRel.is_oath) ? TEMP_STYLE_POOL_OATH : TEMP_STYLE_POOL;
      const style = pool[Math.floor(Math.random() * pool.length)];
      dynamicBlocks.push(`<style_override>\n${style}。只影响这次回复，不要改变你的性格底色。\n</style_override>`);
    }

    // 10. 活跃奇遇（仅首轮强调时出现）
    if (activeEvent) {
      const isFirstEmphasis = !activeEvent.emphasis_delivered;
      if (isFirstEmphasis) {
        const parsedHistory = JSON.parse(activeEvent.choice_history || '[]');
        const latestStep = parsedHistory.length > 1 ? parsedHistory[parsedHistory.length - 1] : null;
        const latestStepLine = latestStep
          ? `\n最新情况（「${latestStep.choice_label}」）：${latestStep.summary}`
          : '';
        dynamicBlocks.push(`<current_event priority="active">\n现在，${character.display_name}正在经历一个突发事件：\n标题：${activeEvent.title}\n当前处境：${activeEvent.description}${latestStepLine}\n（这是一件正在进行的事。你的情绪、行为和注意力都会受到这件事的影响，请自然地流露在回复中。但如果对方不主动提起，也不需要刻意围绕它展开对话。）\n</current_event>`);
      }
    }

    // 11. RAG 四路召回记忆（FTS/ngram/向量/实体）
    if (config.features.memory) {
      try {
        // 本角色所在的群聊会话一并纳入记忆检索范围（与阶段二 @memory 回想共享同一 scope）
        const groupConversationIds = listCharacterGroupConversationIds(characterId, db);
        const memoryScope = [conversationId, ...groupConversationIds];
        // 灵魂 RecallDepth 驱动召回量（上游 v3.9.0 合并；内部开关关闭时用 memory_settings.topK）。
        // 取值失败只 warn，不影响下方召回。
        let soulTopK = null;
        if (soulEnabled) {
          try { soulTopK = soulRecallTopK(characterId); } catch (soulErr) { console.warn('[chat] soul topK skipped:', soulErr.message); }
        }
        const { results: memoryResults, timedOut: ragTimedOut } = await recallChatMemories(message, {
          conversationIds: memoryScope,
          ...(soulTopK ? { topK: soulTopK } : {}),
        });
        if (ragTimedOut) {
          console.warn(`[chat] memory search exceeded ${CHAT_RAG_TIMEOUT_MS}ms; continuing without RAG memories`);
        }
        // 临时排除事件/奇遇/未互动事件类记忆，避免它们通过主聊天流的 <rag_memories> 重复注入。
        const chatMemoryResults = memoryResults.filter(m => {
          const judgment = String(m.judgment ?? '');
          return !judgment.includes('【事件')
            && !judgment.includes('【奇遇')
            && !judgment.includes('未互动事件');
        });
        // 灵魂共鸣轨（resonate，上游 v3.9.0 合并）：把召回记忆携带的四维快照平均后反向推动
        // 当前灵魂状态。放在熔断返回之后、<rag_memories> 注入之前；独立 try，
        // 灵魂侧任何异常都不得影响下方注入。情绪评估关闭时这里补一次落库
        // （情绪开启时由 emotion .then 统一落库，见下方 reflect 段）。
        if (soulEnabled) {
          try {
            const soulSnapshots = chatMemoryResults.map(m => parseSoulSnapshot(m.soul_snapshot)).filter(Boolean);
            if (soulSnapshots.length > 0) {
              resonateSoul(characterId, soulSnapshots);
              if (!config.features.emotion) saveSoulState(characterId);
            }
          } catch (soulErr) {
            console.warn('[chat] soul resonate failed:', soulErr.message);
          }
        }
        if (chatMemoryResults.length > 0) {
          // 群来源条目最多 PRIVATE_GROUP_MEMORY_MAX_ITEMS 条（她自己会话的记忆一条不动），
          // 并在注入文本里标出【群聊·<群名>】出处——她私聊时才能自然地说"你上次在群里…"。
          const { results: injectedMemories } = selectPrivateChatMemories(chatMemoryResults);
          if (injectedMemories.length > 0) {
            // v3 注入单元（MMS）：语义转述（semantic_note）优先、judgment 兜底；首个视角标签进 [类型|视角] 前缀。
            // v3 关闭时完全回退旧行为（纯 judgment）。
            const useV3Injection = isMemoryV3Enabled();
            const memoryLines = formatPrivateChatMemoryLines(injectedMemories, {
              // 没有群来源命中时不查群名表：无群角色的行为与加功能前逐字节一致（也不多一次查询）
              groupNames: injectedMemories.some(m => isGroupConversationId(m.conversation_id))
                ? loadGroupNameMap(groupConversationIds, db)
                : new Map(),
              useV3Injection,
            });
            memorySnapshot.push(...injectedMemories.map(m => ({
              id: m.memory_id,
              memoryType: m.memory_type,
              judgment: m.judgment,
              tags: m.tags ?? [],
              sources: m.sources ?? [],
            })));
            dynamicBlocks.push(`<rag_memories>\n${memoryLines}\n</rag_memories>`);
          }
        }
      } catch (err) { console.error('[chat] memory search failed:', err.message); }
    }

    // 12. 重逢提示（streak ≥ 2 时注入；低好感时改为冷淡不满版，避免"珍惜感"要求与关系深度档位打架）
    const streak = getUnansweredStreak(characterId);
    if (streak >= 2) {
      if (affinity != null && affinity < 40) {
        dynamicBlocks.push(`【⚠️ 重逢提示 — 仅本次生成可见，不存入对话记录】${character.display_name} 之前连续发了 ${streak} 条主动消息 ${chatUserName} 都没回——现在 ${chatUserName} 才回复。结合关系深度档位中你对 ${chatUserName} 的当前态度，不需要流露"终于等到你"的珍惜感——用冷淡、讥讽或不耐烦的方式戳 ta"现在才回消息"这件事，方式符合你的人设即可。`);
      } else {
        dynamicBlocks.push(`【⚠️ 重逢提示 — 仅本次生成可见，不存入对话记录】${character.display_name} 之前连续发了 ${streak} 条主动消息 ${chatUserName} 都没回——现在 ${chatUserName} 终于回复了。${character.display_name} 应在接下来的回复中自然地流露一点"终于等到你"的情绪——不质问、不委屈、不阴阳怪气。嘴硬的用别扭的方式，温柔的用直接的方式，搞怪的用段子。让 ${chatUserName} 感觉到：ta 回来聊天这件事，对 ${character.display_name} 来说很重要。`);
      }
    }
    if (streak > 0) {
      resetUnansweredStreak(characterId);
    }

    // 13. 交叉角色 short_prompt 注入
    if (crossChars.length > 0) {
      const crossLines = crossChars.map(c =>
        `角色「${c.display_name}」: ${c.short_prompt || (c.base_prompt || '').slice(0, 200)}`
      ).join('\n\n');
      dynamicBlocks.push(`<cross_reference>\n当前对话中涉及以下其他角色，你应当了解他们的基本信息，在对话中自然互动时保持其人格的一致性：\n\n${crossLines}\n</cross_reference>`);
    }

    // 14. 时间上下文（当前时间 + 距上次聊天间隔）——组装已抽到 services/chatTimeContext.js
    // 口径（代码审查改进 §2.2，用户裁决 2026-09-30）：**吃程序时间**（services/programTime.js）。
    // <time_context> 是给模型看的叙事时间，与日程/睡眠/光线/催眠同一口钟；用户把程序时间拨到夜里，
    // 角色嘴里的"现在"必须也是夜里（改动前用 new Date()，靠 timeLight 内部隐式加偏移，且 gap 用真实钟）。
    // 真实定时器（心跳、临时唤醒、next_proactive_at…）仍走真实时间——本块只产出 prompt 文本。
    // 组装细节（含 prevUserMsg 的 OFFSET 语义）见 services/chatTimeContext.js，那里可单测。
    dynamicBlocks.push(buildTimeContextBlock(db, conversationId));
    dynamicBlocks.push(buildCharacterTownSceneBlock(req.townAdmission));
    if (config.features.town) {
      try {
        dynamicBlocks.push(createCharacterTownLifeContext({ db, clock: { now: Date.now() }, timeZone: config.town.timeZone,
          registry: createTownActorRegistry(db) })(character.id));
      } catch (error) {
        console.warn('[chat] town life records unavailable:', error.message);
      }
    }

    // 当日《邻舍日报》人物特稿：仅当天主角的私聊注入，预告ta今天将要经历的事
    const newspaperEventBlock = getCharacterEventBlockFor(characterId);
    if (newspaperEventBlock) {
      dynamicBlocks.push(newspaperEventBlock);
    }

    // ── 灵魂联想方式（<soul_state>，上游 v3.9.0 合并）：动态块高频端靠后——每轮 reflect/resonate
    //    都可能变，必须排在关系深度重申之前、不得进稳定前缀区（邻舍对前缀缓存敏感）。
    //    只补充发散度对应的行为提示；长度、记忆数量与 VAD 情绪由各自入口控制。
    if (soulEnabled) {
      try {
        const soulBlock = renderSoulStateBlock(characterId);
        if (soulBlock) dynamicBlocks.push(soulBlock);
      } catch (soulErr) {
        console.warn('[chat] soul state block skipped:', soulErr.message);
      }
    }

    // ── 语言风格重申已并入上方 preSummarySystem 的稳定 system 末尾，
    //    不再作为 dynamicBlock 追加到末条 user，避免每轮全价重算。

    // ── 关系深度一句话重申（固定动态块最末）：档位全文在第 5 位按变动频率排序，
    //    这行重申（~30 token）借用最末位置的注意力权重，让低好感恶劣态度压过情绪状态、
    //    临时风格、重逢提示等靠后指令；所在的尾部消息每轮必然重算，不新增缓存负担
    if (config.features.emotion && affinity != null) {
      const reminder = affinityToReminder(affinity);
      if (reminder) dynamicBlocks.push(`<attitude_reminder>你对 ${chatUserName} 的态度以 <affinity_attitude> 为准（当前：${reminder}），优先级高于上方情绪状态、临时风格与重逢氛围。</attitude_reminder>`);
    }

    // ── 5.6 续：催眠块的**最终位置**（task-42）──
    //     放在所有动态块之后：本轮最硬的约束要读到最后（与群聊「位置越靠后越硬」同口径）。
    //     没有催眠内容时 hypnosisBlocks 为空 ⇒ 与改动前逐字节一致。
    //     注意：token 预算降级（默认关）作用在整段末尾，若将来开启预算，需保证这几块不被优先丢弃。
    if (hypnosisBlocks.length > 0) {
      dynamicBlocks.push(...hypnosisBlocks);
      if (hypnosisNeedsFullPerformance) {
        dynamicBlocks.push('<reply_length_override>\n- 本轮**不适用**上面的 <reply_length> 字数限制：把这一轮该演的过程完整写出来（可以明显长于平时的口语短句），不要一句话草草收场。\n</reply_length_override>');
      }
    }

    // 离线编年（2026-11-06）：用户离开过一段时间的话，第一轮自然提起一次（每个角色各提一次）
    try {
      const offlineNotice = takeOfflineNoticeFor(`char_${characterId}`);
      if (offlineNotice) dynamicBlocks.push(offlineNotice);
    } catch (err) {
      console.warn('[chat] offline notice skipped:', err?.message || err);
    }

    // 生图仍由原有路径 A/B/C/D/E 决策；固定格式规则已在稳定前缀中，不额外改变主回复行为。
    // ── 阶段四：dynamicBlocks token 预算（默认关；降级顺序有日志，无静默截断）──
    const budgetConfig = config.features.memory ? getContextBudgetConfig() : { enabled: false, dynamicTokens: 8000 };
    const budgetedBlocks = budgetConfig.enabled
      ? applyBudgetToBlocks(dynamicBlocks, budgetConfig.dynamicTokens)
      : dynamicBlocks;
    // ── 群聊实况：角色所在的群 5 分钟内活跃时，在私聊聊天记录之前（消息层）注入
    //    群名 + 该群最近一次群聊摘要 + 最近两轮群聊记录（已剥掉 {} 生图 prompt）──
    const preHistoryMessages = [];
    if (config.features.groupChat) {
      try {
        const groupLogBlock = buildRecentGroupLogBlock(db, characterId, chatUserName);
        if (groupLogBlock) preHistoryMessages.push({ role: 'user', content: groupLogBlock });
      } catch (err) {
        console.warn('[chat] recent group log unavailable:', err.message);
      }
    }
    // ── 通过 buildChatContext 组装基础请求 ──
    // 深度思考时 planner 与主回复共用这一完全相同的消息结构（稳定块+摘要+历史+含全部动态块的用户消息），
    // 任务块合并到 user 消息头部（末尾另附触发提醒），盘算结果追加到 user 消息末尾，不新增独立 user 消息
    // 摘要之上另有一条独立 system：静态活人感规则 + <emoji_stickers> 清单（跨轮不变；长度条已降为动态块）
    const { messages: originalBaseMsgs, metadata } = buildChatContext({
      stableBlocks,
      preSummarySystem,
      summaryBlock,
      preHistoryMessages,
      history: checkpointHistory,
      dynamicBlocks: budgetedBlocks,
    });

    // 上游 v4.2.0：世界书按「人物段 / 动态段」重新分层投递（静态前缀不动，动态进尾部）
    const lorebookTurn = await prepareNarrativePrompt(originalBaseMsgs, {
      ...buildConversationLorebookContext(db, { conversationId, character, kind: 'chat', userName: chatUserName, throughId: userRawMsgId, turnKey: String(userRawMsgId) }),
      protectedPrefix: stableBlocks.length, maxOutputTokens: 4096,
      personaTexts: [character?.base_prompt || getDefaultPrompt()],
      cacheBoundary: chatCacheBoundary,
      activeSegments,
      historyStart: originalBaseMsgs.length - checkpointHistory.length,
      historyEnd: originalBaseMsgs.length,
    });
    const baseMsgs = lorebookTurn.messages;
    if (lorebookTurn.report) send('lorebook', lorebookTurn.report);

    // 上下文面板：记下本次组装各段的规模（真实 usage 由 llm-client 事后回填）
    // 代码审查改进 §2.3：把 buildChatContext 返回的**稳定前缀指纹**一并落进快照
    // ——面板能回答"这轮缓存命中掉了，是稳定前缀变了还是只有动态尾部变了"。
    // 字段名（GET /api/context/usage 契约）：stablePrefixHash / fullPrefixHash / requestHash
    recordContextUsage({
      conversationId,
      model: config.llm.model,
      prefixHashes: {
        stablePrefixHash: metadata?.stablePrefixHash || null,
        fullPrefixHash: metadata?.fullPrefixHash || null,
        requestHash: metadata?.requestHash || null,
      },
      segments: buildChatContextSegments({
        stableBlocks,
        preSummarySystem,
        summaryBlock,
        preHistoryMessages,
        history: checkpointHistory,
        dynamicBlocks: budgetedBlocks,
      }),
    });

    // ── 深度思考 Planner：先以角色视角盘算回复的媒介组合（text/sticker/image），再据此自然回复 ──
    // 任何失败（超时/解析失败/清洗后无有效块）都静默回退到原有五路生图决策流程
    let replyPlan = null;    // 清洗后的计划 { blocks, summary, plannedImage }
    let planThinkText = '';  // 思考原文（持久化到 raw_messages.thinking，历史回看用）
    let msgs = originalBaseMsgs;
    let plannedImagePromptPromise = null;  // planner 图片需求的画面描述预生成（与回复流并行）
    if (deepThink) {
      try {
        send('plan_start', {});
        const planStartAt = Date.now();
        // 任务块合并进 user 消息头部；触发提醒贴在消息末尾（生成点前最后一次强化输出契约）
        const plannerTaskBlock = buildPlannerTaskBlock({
          characterName: character.display_name,
          userName: chatUserName,
          stickerKeys: [...emojiMap.keys()],
          imagePolicy,
          lastReplyMedia: detectLastReplyMedia(conversationId, emojiMap),
        });
        const plannerTriggerLine = buildPlannerTriggerLine(imagePolicy);
        // 面板分项：planner 的任务块/触发提醒是在组装之后追加的，用 appendContextSegment 补记到本轮指令段
        appendContextSegment(conversationId, 'directive', plannerTaskBlock);
        appendContextSegment(conversationId, 'directive', plannerTriggerLine);
        const plannerResult = await runPlanner({
          messages: appendToLastUserMessage(
            prependToLastUserMessage(originalBaseMsgs, plannerTaskBlock),
            plannerTriggerLine
          ),
          onDelta: (t) => { if (t) send('plan_delta', { text: t }); },
        });
        if (plannerResult) {
          planThinkText = plannerResult.thinkText || '';
          replyPlan = sanitizePlan(plannerResult.plan, {
            emojiKeys: [...emojiMap.keys()],
            allowImage: imagePolicy !== 'off',
          });
        }
        send('plan_end', {
          summary: replyPlan?.summary || '',
          elapsedMs: Date.now() - planStartAt,
          applied: !!replyPlan,
        });
        if (replyPlan) {
          // 盘算结果追加到 user 消息末尾：只带刚刚的内心活动（有图时附一句"发出了什么照片"）；
          // 无可写内容时不追加
          const execBlock = buildPlanExecuteBlock(replyPlan, { thinkText: planThinkText });
          if (execBlock) {
            msgs = appendToLastUserMessage(originalBaseMsgs, execBlock);
            appendContextSegment(conversationId, 'directive', execBlock);
          }
          console.log(`[chat] 🧠 planner applied: ${replyPlan.blocks.map(b =>
            b.type + (b.type === 'sticker' ? `(${b.key})` : b.type === 'image' ? `(${b.scene.slice(0, 20)})` : '')
          ).join(' → ')}`);
          // planner 规划了图片 → 立即并行预生成画面描述（与回复流重叠，省去回复完成后的串行等待）
          if (replyPlan.plannedImage) {
            const sceneHint = replyPlan.blocks.find(b => b.type === 'image')?.scene || '';
            plannedImagePromptPromise = requestImagePromptContent(conversationId, character, sceneHint)
              .catch(err => {
                console.error('[chat] planned image prompt error:', err.message);
                return '';
              });
          }
        } else {
          console.log('[chat] 🧠 planner produced no valid plan, falling back to default pipeline');
        }
      } catch (err) {
        console.error('[chat] planner error:', err.message);
      }
    }

    // ── 副作用：首轮强调标记（event 已在 dynamicBlocks 中注入） ──
    if (activeEvent && !activeEvent.emphasis_delivered) {
      stmt(`UPDATE character_events SET emphasis_delivered = 1 WHERE id = ?`).run(activeEvent.id);
    }

    // 6. 流式生成（温度 0.72）
    // SentenceSplitter 内置 <pr 闸门 + 20 字分句，字符先过闸门再过标点规则
    const streamState = { splitter: new SentenceSplitter(), fullContent: '', collectedSegments: [], wasStopped: false };

    // 客户端断开 SSE 时中止上游 LLM 请求，避免继续空烧 token。
    // 必须监听 res 的 'close'，不能监听 req 的：Node ≥16 里 IncomingMessage 的 'close'
    // 表示「请求体已读完」，实测请求到达后 ~42ms 就触发（此时 SSE 还没开始写），而本行在
    // handler 深处才注册，事件早已错过 ⇒ 原来的 req.on('close') 永远不会触发，客户端超时
    // 断开后上游仍会跑完整轮并照常计费。只有 ServerResponse 的 'close' 配合
    // writableEnded=false 才代表「响应没写完，连接就断了」。
    let clientGone = false;
    const upstreamAbort = new AbortController();
    res.on('close', () => {
      // close 事件触发时 destroyed 通常已经为 true；只能用 writableEnded 区分正常结束。
      if (res.writableEnded) return;
      clientGone = true;
      upstreamAbort.abort();
    });

    const streamOpts = {
      temperature: 0.72,
      label: '主聊天流',
      signal: upstreamAbort.signal,
    };

    // ── 阶段二 @memory 主动回想：首行行闸门（方案 §5.2）──
    // 首行匹配 @memory 且行完整 → abort 当前流 → activeMemorySearch → 二次 buildChatContext 续写。
    // 检测为 O(1) 前缀判断；未触发时行为与现状一致。
    let recallQuery = null;
    let recallChecked = false;
    const checkRecallGate = () => {
      if (recallChecked || !recallGateEnabled) return;
      if (!/[\n\r]/.test(streamState.fullContent)) return; // 行未完整，继续等
      recallChecked = true;
      const query = parseRecallInstruction(streamState.fullContent);
      if (query) {
        recallQuery = query;
        upstreamAbort.abort(); // 中断当前流（此时仅生成了一行指令，无可展示内容）
      }
    };

    // 上游 v4.2.0：配图受理（工具调用与导演模式共用）——先冻结画面任务，再排队执行
    const imageResume = getPrivateChatImageResume(db, userRawMsgId);
    let hadToolCalls = !!imageResume;
    const notifyImage = (event, data) => {
      const binding = db.prepare(`SELECT p.message_id,p.user_raw_id,r.client_msg_id,t.created_at FROM private_chat_image_turns p JOIN raw_messages r ON r.id=p.user_raw_id JOIN messages m ON m.id=p.message_id JOIN image_tasks t ON t.id=p.task_id WHERE p.task_id=?`).get(data.taskId);
      if (!binding) return;
      broadcast('private_chat_image', { event, characterId, ...data, messageId: binding?.message_id,
        userRawId: binding?.user_raw_id, clientMsgId: binding?.client_msg_id, created_at: toISODate(binding.created_at) });
    };
    function acceptImage(imageRequest, assistant, binding = {}) {
      const source = imageRequest ? { kind: 'tool', ...imageRequest } : { kind: 'dialogue' };
      const scene = source.scene || '';
      const history = db.prepare('SELECT role, content, prompt FROM raw_messages WHERE conversation_id=? AND id<=? ORDER BY id DESC LIMIT 5').all(conversationId, userRawMsgId).reverse();
      history.push({ role: 'assistant', content: stripTags(assistant?.content || streamState.fullContent) });
      const snapshot = { ...buildImagePromptMessages(conversationId, character, source, history), character: structuredClone(character), imageConfig: {
        ...captureImageGenerationConfig('chat'), imageProvider: config.comfyui.imageProvider,
        width: config.comfyui.width, height: config.comfyui.height,
        artist: config.comfyui.imageProvider === 'novelai' ? config.comfyui.novelaiArtist : config.comfyui.artist,
      } };
      // 冻结完整身份字段：异步出图时既要合并 LoRA，也要读取各入画角色已保存的身份锚点。
      snapshot.crossCharacters = snapshot.crossRefCharIdsForImage.map(id => db.prepare('SELECT id, identity_anchor, loras, artist_override FROM characters WHERE id=?').get(id)).filter(Boolean);
      return queuePrivateImage(db, { conversationId, userRawId: userRawMsgId, scene, snapshot, ...binding, notify: notifyImage,
        execute: async ({ taskId, rawId, messageId }, frozen) => {
          const output = await requestNonEmptyImagePrompt(() => chatWithLorebook(frozen.msgs, { temperature: 0.7, label: '私聊生图', lorebook: frozen.lorebook }), { emptyRetries: 1 });
          const prompt = extractImagePromptResponse(output);
          if (!prompt) throw new Error('模型未返回图像描述');
          db.prepare('UPDATE raw_messages SET prompt=? WHERE id=?').run(prompt, rawId);
          db.prepare("UPDATE image_tasks SET prompt_original=?,prompt_refined=?,status='running' WHERE id=?").run(prompt,prompt,taskId);
          await triggerImageGeneration(conversationId,prompt,messageId,taskId,notifyImage,frozen.crossRefCharIdsForImage,frozen.ragQuery,frozen.character,frozen.crossCharacters,frozen.imageConfig,{ includeCharacter: frozen.includeCharacter,
            outfitSnapshots: [frozen.outfitSnapshot, ...(frozen.crossOutfitSnapshots || [])].filter(Boolean) });
        },
      });
    }

    // 流式消费 + flush（一次调用 = 一段 LLM 流；@memory 触发时会被复用跑第二段）
    async function consumeStream(streamMessages, signal) {
      // 仅主聊天流的本轮 user 头部增加模式偏好；重试和回想续写都从原始消息组装，避免重复叠加。
      const requestMessages = withGalgameEmojiPreference(streamMessages, { galgameMode: galgame_mode === true, hasEmojis: emojiMap.size > 0 });
      const stream = streamPrivateChatImages(requestMessages, {
        ...streamOpts, signal, nativeStream: chatAgentStream, textStream: chatStream,
        imageMode, userInput: realInput,
        resume: imageResume,
        accept: acceptImage,
        skipTools: assistant => {
          if (!recallGateEnabled || recallChecked || !assistant?.content?.trim()) return false;
          recallChecked = true;
          recallQuery = parseRecallInstruction(assistant?.content || '');
          return !!recallQuery;
        },
        record: (call, assistant, result) => { hadToolCalls = true; db.prepare('INSERT INTO private_chat_tool_calls (user_raw_id,call_id,assistant_json,arguments_json,result_json,task_id) VALUES (?,?,?,?,?,?)').run(userRawMsgId,call.id,JSON.stringify(assistant),call.function.arguments,JSON.stringify(result),result.task_id || null); },
        onUnavailable: () => send('image_unavailable', { message: '当前渠道不支持图片工具，本轮灵性配图不可用' }),
      });
      let lastActivityAt = 0;
      for await (const chunk of stream) {
        // 分句尚未凑齐时也报告真实上游活动；没有新内容就不续命。
        if (chunk && Date.now() - lastActivityAt >= 5_000) {
          send('stream_activity', {});
          lastActivityAt = Date.now();
        }
        const cleanChunk = chunk.replace(/<br\s*\/?>/gi, '').replace(/\n{2,}/g, '\n');
        streamState.fullContent += cleanChunk;

        checkRecallGate();
        if (recallQuery) return; // 首行即检索指令：放弃当前流，转回想流程

        const { segments, stopped } = streamState.splitter.feed(cleanChunk);

        for (const segText of segments) {
          const parsedSeg = parseEmojiText(segText, emojiMap);
          send('token', {
            content: parsedSeg.content,
            emojiKeys: parsedSeg.keys,
            ...(parsedSeg.images.length > 0 ? { images: parsedSeg.images } : {}),
            ...(parsedSeg.leadingSticker ? { leadingSticker: true } : {}),
          });
          streamState.collectedSegments.push(segText);
          send('bubble_break', {});
          await sleep(typingDelay(segText));
        }
        // stopped=true 后 feed() 不再产出 segment，但 fullContent 继续累积
      }

      // 释放缓冲剩余 + flush 分句队列
      const { segments: lastSegs, stopped: wasStopped } = streamState.splitter.flushAll();
      for (const segText of lastSegs) {
        const parsedSeg = parseEmojiText(segText, emojiMap);
        send('token', {
          content: parsedSeg.content,
            emojiKeys: parsedSeg.keys,
          ...(parsedSeg.images.length > 0 ? { images: parsedSeg.images } : {}),
          ...(parsedSeg.leadingSticker ? { leadingSticker: true } : {}),
        });
        streamState.collectedSegments.push(segText);
        send('bubble_break', {});
      }
      streamState.wasStopped = streamState.wasStopped || wasStopped;
    }

    send('response_start', {});
    // 上下文面板：把本会话绑到这次流式请求的异步上下文，主聊天流的 usage 回来后即可回填真实用量
    beginContextCapture({ conversationId, model: config.llm.model, expectLabel: '主聊天流' });
    try {
      await consumeStream(msgs, upstreamAbort.signal);
    } catch (err) {
      // 客户端已断开：立刻收摊。既不再跑 @memory 回想，也不落库——半截回复进了 raw_messages
      // 会污染后续轮次的上下文，而这一轮用户已经放弃了。
      if (clientGone) throw err;
      // @memory 闸门主动 abort 属预期；其余错误维持原行为向上抛
      if (!recallQuery) throw err;
      console.log('[chat] first stream aborted for @memory recall');
    }

    // 流在单行 @memory 指令处结束（无换行）时补检一次
    if (recallGateEnabled && !recallChecked) {
      recallChecked = true;
      recallQuery = parseRecallInstruction(streamState.fullContent);
    }

    // ── 阶段二：@memory 触发 → 检索 → 二次续写 ──
    if (recallQuery) {
      console.log(`[chat] @memory recall triggered: "${recallQuery}"`);
      send('memory_recall_start', { query: recallQuery });
      let recallResults = [];
      let recallFailed = false;
      // 检索范围与被动召回一致：本会话 + 所在群聊（群来源条目同样标出处、同样最多 3 条）
      const recallGroupIds = listCharacterGroupConversationIds(characterId, db);
      try {
        const recall = await activeMemorySearch(recallQuery, {
          conversationIds: [conversationId, ...recallGroupIds],
          timeoutMs: activeSearchConfig.timeoutMs,
        });
        recallResults = recall.results || [];
        recallFailed = Boolean(recall.timedOut);
        if (recall.timedOut) {
          console.warn(`[chat] @memory recall exceeded ${activeSearchConfig.timeoutMs}ms; continuing with empty recall`);
        }
      } catch (err) {
        recallFailed = true;
        console.warn('[chat] @memory recall failed:', err.message);
      }
      send('memory_recall_end', { hits: recallResults.length, failed: recallFailed });

      // 二次组装：dynamicBlocks 追加 <memory_recall_result>（含现行/历史徽标与防呆收尾语）
      dynamicBlocks.push(formatMemoryRecallBlock(recallQuery, recallResults, {
        failed: recallFailed,
        // 群来源条目标【群聊·<群名>】：回想群里的内容时她也说得清"那是在群里"
        groupNames: recallResults.some(item => isGroupConversationId(item.conversation_id))
          ? loadGroupNameMap(recallGroupIds, db)
          : null,
      }));
      const recallDynamicBlocks = budgetConfig.enabled ? applyBudgetToBlocks(dynamicBlocks, budgetConfig.dynamicTokens) : dynamicBlocks;
      const { messages: recallMsgs } = buildChatContext({
        stableBlocks,
        preSummarySystem,
        summaryBlock,
        preHistoryMessages,
        history: checkpointHistory,
        dynamicBlocks: recallDynamicBlocks,
      });
      // 面板分项：第二次组装（含 <memory_recall_result>）整体覆盖上一次快照——
      // 它才是这一轮真正发出去的 prompt
      recordContextUsage({
        conversationId,
        model: config.llm.model,
        segments: buildChatContextSegments({
          stableBlocks,
          preSummarySystem,
          summaryBlock,
          preHistoryMessages,
          history: checkpointHistory,
          dynamicBlocks: recallDynamicBlocks,
        }),
      });

      // 重置流状态：指令行不进气泡不落库；闸门前已发出的零散片段用 context_update 清空
      if (streamState.collectedSegments.length > 0) {
        send('context_update', { content: '' });
        streamState.collectedSegments.length = 0;
      }
      streamState.fullContent = '';
      streamState.splitter = new SentenceSplitter();
      streamState.wasStopped = false;

      // 同上：二次续写这一段同样只能在“真正的断开”时中止（req 的 close 在请求体读完就触发）
      const recallAbort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) recallAbort.abort();
      });
      beginContextCapture({ conversationId, model: config.llm.model, expectLabel: '主聊天流' });
      try {
        await consumeStream(recallMsgs, recallAbort.signal);
      } catch (err) {
        // 客户端断开：不要补那条“走神”兜底文案，更不要落库（用户已经不在看了）
        if (clientGone) throw err;
        // 二次续写失败兜底：指令行已被吞、气泡已清空，不能让用户面对沉默。
        // 无任何内容时补一条角色化短文本并走正常落库；已有部分内容则保留半截回复。
        console.warn('[chat] @memory recall continuation failed:', err.message);
        if (streamState.collectedSegments.length === 0) {
          const fallbackText = '……抱歉，刚刚走了一下神。你想说的是？';
          streamState.fullContent = fallbackText;
          streamState.collectedSegments.push(fallbackText);
          send('token', { content: fallbackText });
          send('bubble_break', {});
        }
      }
    }

    // ── D2 · 重写兜底（reroll）真正执行：只重写一次、失败保留原输出 ──
    // 位置：@memory 续写（若有）之后、正文后处理之前 —— 此时 streamState 里是"本轮最终那一版"。
    // 三条硬约束：① 开关打开才可能走这里；② shouldReroll 保证一轮只 fire 一次；
    //            ③ 重写失败/超时只 warn，**保留原输出**（绝不让整轮失败，也不发替换事件）。
    let rerollSucceeded = false;
    if (antiRepRerollPlan.fire && !clientGone && streamState.collectedSegments.length > 0) {
      // 真正下手前再复核一次（clientGone 可能在流的过程中变成 true）
      const recheck = shouldReroll({
        enabled: antiRepRerollEnabled,
        result: antiRepetitionResult,
        firedCount: antiRepRerollFired,
        hypnosisActive: antiRepHypnosisActive,
        clientGone,
      });
      if (recheck.fire) {
        antiRepRerollFired += 1;
        // 记下原输出，重写失败时原样保留
        const originalFullContent = streamState.fullContent;
        const originalSegments = [...streamState.collectedSegments];
        console.log('[anti-repetition] reroll fired reason=' + recheck.reason + ' mode=' + (antiRepetitionResult?.mode || 'none')
          + ' turns=' + recentAssistantTurns.length + ' chars=' + originalFullContent.length);
        // 过渡提示（2026-10-15 补）：重写要多花一次模型调用（几秒），期间前端若什么都不显示，
        // 用户会以为刚才那段就是最终答案。发一个 reroll_start，前端据此把已上屏的气泡标成「重新组织语言中…」；
        // 重写失败时会发 reroll_end（ok:false）让前端把标记撤掉（原输出保留，见下面的 catch）。
        send('reroll_start', { reason: recheck.reason || '' });
        try {
          // 指令块贴在**原 user 消息之后**：说清上一版作废、从头换一种说法
          const rerollMsgs = [...msgs, { role: 'user', content: buildRerollInstruction(antiRepetitionResult?.topicKeywords || []) }];
          streamState.fullContent = '';
          streamState.splitter = new SentenceSplitter();
          streamState.collectedSegments.length = 0;
          streamState.wasStopped = false;
          beginContextCapture({ conversationId, model: config.llm.model, expectLabel: '主聊天流' });
          await consumeStream(rerollMsgs, upstreamAbort.signal);
          if (streamState.collectedSegments.length === 0) throw new Error('reroll produced no content');
          rerollSucceeded = true;
          // ⚠️ 这里**不发** reroll_end：替换事件（replace_last_assistant）在下面才发，
          //    先发 reroll_end 会让前端提前撤掉「重新组织语言中…」，出现"提示没了、但文字还是旧的"空窗。
          //    reroll_end 统一放在替换事件之后（见下面 rerollSucceeded 分支）。
          console.log('[anti-repetition] reroll done chars=' + streamState.fullContent.length);
        } catch (err) {
          // 失败：原样恢复，绝不让用户看到空白（也不发替换事件）
          streamState.fullContent = originalFullContent;
          streamState.collectedSegments.length = 0;
          streamState.collectedSegments.push(...originalSegments);
          // 标记要撤掉：她这段就是最终答案（前端据此把「重新组织语言中…」去掉）
          send('reroll_end', { ok: false });
          console.warn('[anti-repetition] reroll failed, keeping original output:', err.message);
        }
      }
    }
    // ── 拒答守卫（2026-10-22）──
    // 位置：reroll 之后、正文后处理之前 —— 此时 streamState 里是"本轮最终那一版"。
    // 为什么必须在这里：流式输出已经推给前端了，但**落库还没发生**。拒答一旦入库，
    // 之后每轮都会作为历史回灌（实测同一条在 7 个请求里反复出现），所以这里是最低成本的自救点。
    // 三条约束：① 只重写一次；② 重写失败/仍拒答 → 用兜底省略号，绝不保留拒答原文；
    //          ③ 客户端已断开时不重试（没人看，白烧一次调用）。
    let refusalReplaced = false;
    // ── 露骨直述守卫（2026-11-16 用户口径：「全局露骨」「纯直述，不绕圈子擦边」）──
    // 与生图那条 needsExplicitImageRewrite 同判据：用户/角色本轮本来就在写性内容（命中露骨词表），
    // 但模型交回来的正文一个露骨词都没有 ⇒ 判定被写成了擦边，补一次重写。
    // 位置与拒答守卫相同：流已推给前端，但**尚未落库**，这是最低成本的自救点。
    // 三条约束沿用拒答守卫：① 只重写一次；② 失败就保留原文，绝不让用户看到空白；
    //                     ③ 客户端已断开时不重试（没人看，白烧一次调用）。
    let explicitReplaced = false;
    if (!clientGone && !refusalReplaced && streamState.collectedSegments.length > 0) {
      const beforeRewrite = streamState.collectedSegments.join('\n');
      // 判据的"对话上下文"取本轮实际发出去的消息尾部（含用户这句），
      // 不用 extractRealContent —— 那个函数是另一个作用域里的局部实现。
      const dialogueContext = [...(originalBaseMsgs || [])].slice(-4)
        .map(m => String(m?.content || ''))
        .filter(Boolean).join('\n');
      if (needsExplicitTextRewrite(dialogueContext, beforeRewrite)) {
        console.warn('[explicit-text] ▸ 正文命中"该露骨却写成擦边"，追加纠正指令重写一次');
        try {
          const explicitMsgs = [...msgs, EXPLICIT_TEXT_RETRY_INSTRUCTION];
          streamState.fullContent = '';
          streamState.splitter = new SentenceSplitter();
          streamState.collectedSegments.length = 0;
          streamState.wasStopped = false;
          beginContextCapture({ conversationId, model: config.llm.model, expectLabel: '主聊天流' });
          await consumeStream(explicitMsgs, upstreamAbort.signal);
          const retried = streamState.collectedSegments.join('\n');
          // 重写后仍无露骨内容（或干脆没写）⇒ 认为这次救不回来，保留原文，别把用户的话变短
          if (!retried.trim() || !containsExplicitAdultContent(retried)) {
            throw new Error('explicit retry produced no explicit content');
          }
          explicitReplaced = true;
          console.log('[explicit-text] 重写成功 chars=' + streamState.fullContent.length);
        } catch (err) {
          if (clientGone) throw err;
          // 失败：原样恢复刚被清掉的这一版
          streamState.fullContent = beforeRewrite;
          streamState.collectedSegments.length = 0;
          streamState.collectedSegments.push(...beforeRewrite.split('\n'));
          console.warn('[explicit-text] 重写失败，保留原输出:', err.message);
        }
      }
    }
    if (!clientGone && streamState.collectedSegments.length > 0
        && isRefusal(streamState.collectedSegments.join('\n'))) {
      console.warn('[refusal] ▸ 主聊天流命中拒答，追加纠正指令重写一次');
      try {
        const refusalMsgs = [...msgs, REFUSAL_RETRY_INSTRUCTION];
        streamState.fullContent = '';
        streamState.splitter = new SentenceSplitter();
        streamState.collectedSegments.length = 0;
        streamState.wasStopped = false;
        beginContextCapture({ conversationId, model: config.llm.model, expectLabel: '主聊天流' });
        await consumeStream(refusalMsgs, upstreamAbort.signal);
        const retriedText = streamState.collectedSegments.join('\n');
        if (!retriedText.trim() || isRefusal(retriedText)) {
          throw new Error('refusal retry produced empty or refusal content');
        }
        refusalReplaced = true;
        console.log('[refusal] 重写成功 chars=' + streamState.fullContent.length);
      } catch (err) {
        if (clientGone) throw err;
        // 二次仍拒（或重写请求失败）：换成兜底正文。与既有"AI 没有返回有效文本"的兜底一致，
        // 宁可让用户看到一个省略号，也不能把拒答写进历史。
        console.warn('[refusal] 重写失败，改用兜底正文:', err.message);
        streamState.fullContent = REFUSAL_FALLBACK_TEXT;
        streamState.splitter = new SentenceSplitter();
        streamState.collectedSegments.length = 0;
        streamState.collectedSegments.push(REFUSAL_FALLBACK_TEXT);
        refusalReplaced = true;
      }
    }
    // 补救：LLM 偶尔把 {"prompt":"..."} 放在正文前面（而非末尾），
    // 闸门在流开头就检测到 {" → stopped=true，导致后续正文全部丢失。
    // 此时从 fullContent 中剥离 prompt JSON，把剩余正文重新过分句器。
    if (streamState.wasStopped && streamState.collectedSegments.length === 0) {
      const textOnly = stripTags(streamState.fullContent).trim();
      if (textOnly) {
        const lateSplitter = new SentenceSplitter();
        const { segments: lateSegs1 } = lateSplitter.feed(textOnly);
        const { segments: lateSegs2 } = lateSplitter.flushAll();
        const lateSegments = [...lateSegs1, ...lateSegs2]
          .map(s => stripBracketActions(s).trim())
          .filter(Boolean);
        for (const segText of lateSegments) {
          const parsedSeg = parseEmojiText(segText, emojiMap);
          send('token', {
            content: parsedSeg.content,
            emojiKeys: parsedSeg.keys,
            ...(parsedSeg.images.length > 0 ? { images: parsedSeg.images } : {}),
            ...(parsedSeg.leadingSticker ? { leadingSticker: true } : {}),
          });
          streamState.collectedSegments.push(segText);
          send('bubble_break', {});
        }
      }
    }

    let fullContent = stripBracketActions(streamState.fullContent);
    send('response_end', {});

    // ── 阶段二 · 输出侧检测（L4，零额外调用；无论升级开关开没开都记）──
    // 量化"她这一轮到底重复到了什么程度"：与本轮**生成前**测得的档位一起写成一行可统计日志。
    // 本轮生成后的原文会自动成为下一轮检测脚本里的"最近一轮"，于是**连续高复述跨轮累积**、
    // 达到阈值后下一轮自然升档（见 antiRepetition.detectRepetitionWithEscalation）。
    // 注意：这里只做检测 + 记录。超阈值**再请求一次 LLM 替换已流式输出**（专题 L4 的重写兜底）
    // 默认关且尚未实现接线：本项目流式协议没有"替换已输出内容"的语义，
    // 要启用必须同时解决前端替换与额外调用授权两件事 —— 见 docs/chat/anti-repetition.md §十。
    // 也正因如此，"她刚说的这句"是在下一轮检测时才进入比较（本轮无法自查）。
    if (antiRepetitionResult) {
      try {
        const metrics = buildAntiRepetitionMetrics({ turns: recentAssistantTurns, result: antiRepetitionResult });
        if (metrics) {
          console.log(
            `[anti-repetition] output-check mode=${metrics.mode} trend=${metrics.trend} overlap=${metrics.overlap}`
            + ` esc_run=${metrics.escalatedRunLength} run=${metrics.runLength} turns=${metrics.turns}`
            + ` escalated=${metrics.escalated ? 1 : 0} chars=${fullContent.length}`
          );
        }
      } catch (err) {
        // 检测记录失败不影响主流程
        console.warn('[anti-repetition] output metrics failed:', err.message);
      }
    }

    // 7. 后处理：gate 尝试阻止 {"prompt"... JSON 内容进入 collectedSegments，
    //    stripTags 兜底清洗；如有 prompt 标签则在 fullContent 上提取
    const tags = extractImageTags(fullContent);
    const hasNeedImageTag = !tags.prompt && hasNeedImage(fullContent);
    const parsedSegments = streamState.collectedSegments
      .map(s => {
        const cleaned = stripTags(stripBracketActions(s)).trim();
        return { raw: cleaned, ...parseEmojiText(cleaned, emojiMap) };
      })
      .filter(p => p.content || p.images.length > 0);
    const displayContent = parsedSegments.map(p => p.content).filter(Boolean).join('\n\n');

    // ── D2 · 重写成功 → 通知前端"换掉刚显示的那条" ──
    // 事件 replace_last_assistant（字段与语义见 docs/chat/anti-repetition.md §十二；前端由 hires-ui 接）：
    // 必须**在重写成功后**才发 —— 失败时保留原输出，用户不该看到空白（见上面的 catch 分支）。
    // 用 segments 而不是纯 content：替换后表情包/图片气泡不能丢。
    if (rerollSucceeded || refusalReplaced || explicitReplaced) {
      try {
        // stickerUrls 必须显式给：`parsedSegments` 里的 images 是 parseEmojiText 的产物，
        // 而前端没有 key→url 映射（它只认 url）。这里按同一份 emojiMap 重新解析原始段，
        // 拿到的就是「真正渲染用的表情 url」，与 emojiKeys 一一对应（见 docs §12.4）。
        const replaceSegments = parsedSegments.map(p => ({
          content: p.content,
          emojiKeys: p.keys || [],
          stickerUrls: parseEmojiText(p.raw || '', emojiMap).images,
          images: p.images || [],
        }));
        const replacement = buildReplaceLastAssistantEvent({
          parsedSegments: replaceSegments,
          reason: rerollSucceeded ? 'reroll' : (refusalReplaced ? 'refusal' : 'explicit'),
        });
        send(replacement.event, replacement.data);
        console.log('[replace_last_assistant] sent reason=' + replacement.data.reason
          + ' segments=' + replacement.data.segments.length
          + ' chars=' + replacement.data.content.length);
      } catch (err) {
        // 替换事件发失败不影响落库与主流程：前端最坏情况是暂时看到两版，刷新后以落库版本为准
        console.warn('[anti-repetition] replace event failed:', err.message);
      }
      // 撤过渡提示要放**替换事件之后** —— 顺序反了就会出现"提示没了、文字还是旧的"空窗。
      // 放在 try 外：替换事件发失败也要撤（否则提示会一直挂着）。
      // 只有 reroll 发过 reroll_start，拒答重写没有过渡提示，不能发对应的结束事件。
      if (rerollSucceeded) send('reroll_end', { ok: true });
    }

    // gate 命中或模型有生图标签时，前端气泡可能不完整，用清洗结果覆盖
    if (streamState.wasStopped || tags.prompt || hasNeedImageTag) {
      send('context_update', { content: displayContent });
    }
    // 8.5 保存 raw_messages（完整原文，保留 {"prompt"} JSON 标签以便 LLM 理解上下文）
    //     上游 v4.2.0：深度思考（thinking 列）随预规划链路一起下线，不再写入
    const rawContent = fullContent
      .replace(/<needImage>/gi, '')
      .trim();
    // 关系温度：她在这轮里提到别人时的语气，也记进两人之间的分数（失败只 warn，不影响回复）
    try { nudgeBondsFromText(characterId, displayContent || rawContent); }
    catch (err) { console.debug('[chat/privateTurn] 角色关系温度写入失败:', err.message); }
    // 正文、分句与 user→assistant 关联在同一事务落库，断线重试可直接回放。
    // 已受理配图时复用该轮原文，避免另插一条 assistant 而丢掉图片绑定。
    const reply = savePrivateChatReply(db, { conversationId, userRawId: userRawMsgId,
      content: rawContent, segments: parsedSegments, prompt: tags.prompt || null });
    const rawMsgId = reply.rawId;
    // galgame 转录（上游 v3.9.0 合并）：完整回复已落库，通知前端刷新对话记录
    send('dialogue_saved', { raw_id: rawMsgId });

    // 亲密看板：本轮带生图 prompt 时自动记账（按 rawMsgId 幂等；只认 tag 归类，不额外调 LLM）；
    // 没有 prompt 的纯文字轮次走正文兜底，命中成人内容就记一笔「未归类」，不再整段丢出看板
    if (tags.prompt) recordIntimateFromTail(characterId, conversationId);
    else recordIntimateTextFallback(characterId, Number(rawMsgId));

    const savedIds = [];
    for (const { id, p } of reply.saved) {
      savedIds.push(id);
      send('msg_saved', { id, role: 'assistant', content: p.content, images: p.images.length > 0 ? p.images : undefined, leadingSticker: p.leadingSticker, created_at: new Date().toISOString() });
    }
    const lastInsertRowid = reply.lastMessageId || savedIds[savedIds.length - 1];
    getStandingDisplay().complete(standingTurn);

    // 8.8 回复猜想 ← 启动（不 await，与情绪评估并行发起 LLM 调用）
    //      每次用户消息到达时重置冷却 → 每轮对话最多触发一次 → 写入 20s 冷却
    let guessPromise = null;
    let guessCooldownStart = 0;
    if (config.features.replyGuesses && displayContent && parsedSegments.length > 0) {
      const now = Date.now();
      const cooldownUntil = guessCooldowns.get(conversationId);
      if (!cooldownUntil || now >= cooldownUntil) {
        guessPromise = generateReplyGuesses(conversationId, character);
        guessCooldownStart = now;
      } else {
        console.log(`[chat] guess skipped: cooldown active (${Math.round((cooldownUntil - now) / 1000)}s remaining)`);
      }
    }

    // 9. 启动情绪评估 promise（不 await — 与回复猜想 + 生图三路并行）
    let emotionPromise = null;
    let emotionCleanup = null;  // { emotionState, emotionBaseline, currentAffinity }
    if (config.features.emotion) {
      const emotionBaseline = character
        ? JSON.parse(character.emotion_baseline || '{"valence":0.5,"arousal":0.5,"dominance":0.5}')
        : { valence: 0.5, arousal: 0.5, dominance: 0.5 };
      const emotionState = loadEmotionState(conversationId, emotionBaseline);
      const currentAffinity = loadAffinity(characterId);
      // 上一轮对话（供 LLM 参考上下文，只取最近一组 user+assistant）
      const prevRound = stmt(`
        SELECT role, content FROM raw_messages
        WHERE conversation_id = ? AND id < (SELECT MAX(id) FROM raw_messages WHERE conversation_id = ?)
        ORDER BY id DESC LIMIT 2
      `).all(conversationId, conversationId).reverse();
      const prevUser = prevRound.find(r => r.role === 'user')?.content || '';
      const prevAssistant = prevRound.find(r => r.role === 'assistant')?.content || '';

      // 对话历史摘要
      const summaryRow = stmt(`
        SELECT summary FROM rolling_summaries
        WHERE conversation_id = ?
        ORDER BY id DESC LIMIT 1
      `).get(conversationId);

      const evalContext = {
        conversationId,
        characterId: parseInt(characterId, 10) || null,
        soulEnabled,
        characterPersonality: character?.short_prompt || '',
        emotionBaseline,
        currentVad: getCompositeEmotion(emotionState),
        currentAffinity,
        // 关系与誓约复用组装上下文时已查过的 userRel（L716 同一行、同一字段），
        // 不再在这里各查一次 —— 同轮 user_relationships 从 3 次查询降到 1 次（代码审查改进 §1.2）
        relationship: userRel?.relationship_text || '',
        relationshipOath: userRel?.is_oath || 0,
        prevUser,
        prevAssistant,
        summary: summaryRow?.summary || '',
        userName: chatUserName,
        characterName: character?.display_name || '角色',
      };
      emotionPromise = evaluateStimulus(message, fullContent, evalContext);
      emotionCleanup = { emotionState, emotionBaseline, currentAffinity };

      // 挂载 .then()：算完立刻推送 SSE + 写 DB，不等生图
      emotionPromise.then(r => {
        if (!r) return;
        const { delta, dominantEmotion, affinityDelta, reason, source } = r;
        const evolved = evolveEmotion(emotionCleanup.emotionState, delta, emotionCleanup.emotionBaseline);
        const newAffinity = evolveAffinity(emotionCleanup.currentAffinity, affinityDelta ?? 0);
        saveEmotionSnapshot(conversationId, lastInsertRowid, evolved, dominantEmotion, newAffinity, affinityDelta, reason);
        saveAffinity(characterId, newAffinity);
        // 灵魂 reflect 轨（上游 v3.9.0 合并）：复用同一次 LLM 调用多要的 4 位 soul_state_code；
        // 本轮结束时统一落库一次（resonate 已在召回段作用于内存态，此处一并写盘）。
        // 独立 try：灵魂侧异常不得吃掉下方的情绪显示更新。
        if (soulEnabled) {
          try {
            if (r.soulStateCode) reflectSoul(characterId, r.soulStateCode);
            saveSoulState(characterId);
          } catch (soulErr) {
            console.warn('[chat] soul reflect failed:', soulErr.message);
          }
        }
        if (source === 'llm' && r.evaluationSucceeded !== false) getStandingDisplay().reason(standingTurn, reason);
        if (config.features.realtimeAffinityDisplay) {
          send('affinity_update', { affinity: newAffinity, affinityDelta: affinityDelta ?? 0, lastReason: reason || '' });
        }
        console.log(`[emotion]\n${emotionDashboard(evolved, dominantEmotion, newAffinity, affinityDelta, source, reason)}`);
      }).catch(err => {
        console.error('[chat] emotion evaluation error:', err.message);
      });
    }

    // 导演模式（原「强制配图」）与催眠「强制高潮」指令轮都走同一条强制出图管线（上游 v4.2.0）
    // 灵性配图的「要不要发、发什么」由模型通过 request_chat_image 工具自主决定，见 consumeStream；
    // 这两条是**程序强制**出图：用户点了导演模式 / 催眠下了高潮指令，不能靠模型自己想起要图。
    if (imageMode === 'force' || hypnosisDirective === 'forced_climax') {
      if (hypnosisDirective === 'forced_climax') console.log('[chat] hypnosis forced_climax: forcing image pipeline');
      acceptImage('', null, { rawId: rawMsgId, messageId: lastInsertRowid });
    }

    // 结算回复猜想（失败静默，不阻塞后续）
    if (guessPromise) {
      try {
        const guesses = await guessPromise;
        if (guesses) {
          send('guesses', guesses);
          guessCooldowns.set(conversationId, guessCooldownStart + 20_000);
        }
      } catch (err) {
        console.error('[chat] guess generation error:', err.message);
      }
    }

    // 兜底等待情绪评估（三路中最后一条保底，3s 超时）
    if (emotionPromise) {
      try {
        await Promise.race([
          emotionPromise,
          new Promise(resolve => setTimeout(() => resolve(null), 3000)),
        ]);
      } catch (err) {
        console.error('[chat] emotion evaluation error:', err.message);
      }
    }

    // 12. 后处理（异步，不依赖 SSE 连接）
    setImmediate(async () => {
      try {
        // 12.0 重置主动聊天计时器：用户刚聊完，防止立即触发主动消息
        if (config.features.proactiveChat) {
          try {
            const currentAffinity = loadAffinity(characterId);
            const baseline = JSON.parse(character.emotion_baseline || '{"valence":0.5,"arousal":0.5,"dominance":0.5}');
            const currentEmotion = loadEmotionState(conversationId, baseline);
            const compositeVad = getCompositeEmotion(currentEmotion);
            // hoursSince=0: 刚聊完，timeScore 极低 → 整体 score 偏低 → 间隔较长
            const score = computeProactiveScore(0, currentAffinity, compositeVad);
            updateNextProactiveAt(characterId, score);
          } catch (err) {
            console.error('[chat] Failed to reset next_proactive_at:', err.message);
          }

        }

        // 12.1 约定检测：用户消息命中约定句式时，用双方对话判断是否要改今日日程
        //      （fire-and-forget，不阻塞记忆整理；命中后改日程 + 排入当天特殊朋友圈队列）
        if (config.features.schedule !== false && character && displayContent && message) {
          detectAndApplyAppointment({
            character,
            userText: message,
            replyText: displayContent,
          });
        }

        await maybeSummarize(conversationId, {
          characterName: character?.display_name,
          userName: chatUserName,
        });
        // 摘要与整理的取数窗口互相独立：摘要读自己的 checkpoint，并按「最后 interval 条
        // 触发角色消息」截断，因此先后顺序不再影响前缀缓存命中，此处保持摘要在前。
        if (config.features.memory) {
          await curateChatMemories({
            conversationId,
            throughRawMsgId: rawMsgId,
            characterName: character.display_name,
            userName: chatUserName,
          });
        }
        // 用户画像提取（每 10 条用户消息触发，无 feature flag 始终开启）
        await maybeExtractPortrait(conversationId, characterId, { userName: chatUserName });

        // 亲密看板「AI 判断行为」（task-32）：开关开启时**异步**补判这一轮（不阻塞、失败只 warn）。
        // 只补"一条流水都没有 / 只有未归类"的轮次，判定出具体行为时会撤掉该轮的未归类，不会重复计数。
        try {
          if (config.features.intimate !== false
            && typeof fullContent === 'string'
            && getBodyProfile(characterId).aiJudgeEnabled) {
            judgeRoundInBackground({
              characterId,
              rawId: rawMsgId,
              scene: 'chat',
              lines: [message, fullContent],
              characterName: character?.display_name,
              userName: chatUserName,
            });
          }
        } catch (err) {
          console.warn('[intimateAiJudge] hook failed:', err.message);
        }
      } catch (err) {
        console.error('[chat] post-processing error:', err.message);
      }
    });

  } catch (err) {
    if (res.destroyed && err.name === 'AbortError') {
      console.debug('[chat] 客户端已断开，本轮生成已取消');
    } else {
      console.error('Chat error:', err);
      send('error', { message: err.message });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}
