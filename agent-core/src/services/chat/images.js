import { getDb, getGlobalRule, getWorldSetting, stmt } from '../../db/index.js';
import { getSystemRulesWithWorld } from '../../db/worldRepository.js';
import { chatSync } from '../../llm/llm-client.js';
import { SHARED_IMAGE_PROMPT_RULE, buildSharedImageTask } from '../privateChatImagePrompt.js';
import { chatSync as chatWithLorebook } from '../lorebook/runtime.js';
import { config } from '../../config.js';
import { buildPositionImageTags, buildPositionPoseJson } from '../intimateActionService.js';
import { extractImagePromptResponse, requestNonEmptyImagePrompt, needsExplicitImageRewrite, EXPLICIT_REWRITE_INSTRUCTION } from '../imagePromptResponse.js';
import { generateImage, getLastWorkflowMode } from '../imageSkill.js';
import { charArtistOverride } from '../characterImageOpts.js';
import { buildCharacterPersona, buildImageCrossRefInfo, buildUserImageCrossRefInfo, IMAGE_CROSS_REF_OWNERSHIP_RULE, captureCharacterOutfitSnapshot } from '../characterPersona.js';
import { RAG_TIMEOUT_FAST_MS } from '../imagePromptKnowledge.js';
import { appendOathRing } from '../oathUtils.js';
import { SentenceSplitter } from '../../utils/sentenceSplitter.js';
import { invalidateGalleryCache } from '../galleryCache.js';
import { saveBase64Image } from '../imagePaths.js';
import { parseEmojiText, getCharacterEmojiMap } from '../emojiService.js';
import { getCurrentActivity, isTempWoken } from '../scheduleManager.js';
import { getLightNoteWithWeather } from '../timeLight.js';
import { JUDGE_PROMPT, getWorldIntegrationRule } from '../../builtinRules.js';
import { matchAll } from '../characterSearch.js';
import { getUserName, matchUser } from '../userSearch.js';
import { sleep, typingDelay, recordIntimateFromTail, recordIntimateTextFallback, stripTags, stripBracketActions, _parseLoras } from './shared.js';

// ── helpers ──

export function extractImageTags(content) {
  // 先尝试原始 ASCII 引号匹配
  const re = /\{"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"\}/i;
  const jsonMatch = content.match(re);
  if (jsonMatch) return { prompt: jsonMatch[1].replace(/\\"/g, '"').trim() };

  // 兜底：将智能弯引号规范化为 ASCII 引号后重试
  // LLM 偶尔会输出 " (U+201C) / " (U+201D) 等弯引号替代 "
  const normalized = content
    .replace(/[“”„‟＂]/g, '"')
    .replace(/[‘’‚‛＇]/g, "'");
  const retryMatch = normalized.match(re);
  if (retryMatch) return { prompt: retryMatch[1].replace(/\\"/g, '"').trim() };

  return { prompt: null };
}

export function hasNeedImage(content) {
  return /<needImage>/i.test(content);
}

export function getDefaultPrompt() {
  return `你是一个创意图像生成助手。用户会和你聊天，描述他们想生成的图像。
你可以帮助优化图像描述，使其更适合 AI 图像生成。
请用中文回复，语气友好而专业。`;
}

/**
 * 创建 pending 状态的 image_tasks 行，用于提前发送 generate_start
 * 让前端在 judge / needImage 二次 LLM 调用期间就显示遮罩层
 */
function createPreparingTask(conversationId) {
  const db = getDb();
  const result = stmt(`INSERT INTO image_tasks (conversation_id, prompt_original, prompt_refined, status) VALUES (?, '', '', 'pending')`)
    .run(conversationId);
  return result.lastInsertRowid;
}

function failPreparingTask(taskId, errorMessage) {
  if (taskId == null) return;
  getDb().prepare(`
    UPDATE image_tasks
    SET status = 'failed', error_message = ?, finished_at = datetime('now')
    WHERE id = ? AND status IN ('pending', 'running')
  `).run(errorMessage, taskId);
}

/**
 * 静默判断：给定最近对话，是否需要配一张图片增强表达
 * 极轻量 DeepSeek 调用（只需"是/否"），延迟通常 < 300ms
 */
async function judgeImageNeed(conversationId) {
  const db = getDb();
  // 直接从 raw_messages 取最后一条用户/Agent 完整消息，无需合并
  const lastUser = stmt(`
    SELECT content FROM raw_messages
    WHERE conversation_id = ? AND role = 'user'
    ORDER BY id DESC LIMIT 1
  `).get(conversationId);

  const lastAssistant = stmt(`
    SELECT content FROM raw_messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY id DESC LIMIT 1
  `).get(conversationId);

  if (!lastUser && !lastAssistant) return false;

  const parts = [];
  if (lastUser) parts.push(`用户: ${lastUser.content.slice(0, 400)}`);
  if (lastAssistant) parts.push(`Agent: ${lastAssistant.content.slice(0, 600)}`);
  const ctx = parts.join('\n');

  try {
    const result = await chatSync([
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: ctx },
    ], { temperature: 0, max_tokens: 5, label: '判断需要图片' });

    const verdict = result.trim().startsWith('是');
    console.log(`[chat] judgeImageNeed: ${verdict ? 'YES' : 'no'} (response: "${result.trim().slice(0, 20)}")`);
    return verdict;
  } catch (err) {
    console.error('[chat] judgeImageNeed error:', err.message);
    return false; // 失败时默认不生图（安全侧）
  }
}

export async function triggerImageGeneration(conversationId, prompt, assistantMsgId, taskId, send, crossRefCharIds = [], ragQuery = '', frozenCharacter = null, frozenCrossCharacters = null, frozenImageConfig = {}, { includeCharacter = true, outfitSnapshots = [] } = {}) {
  const db = getDb();

  // 查找角色 lora 设置
  let loraOpts = {};
  // 身份锚点来源：LLM 写的英文描述不一定带 `Name (Series)`，缺了模型就只能靠先验认人。
  // 主角色（本人入镜时）与交叉引用角色分别收集，最后按 id 去重一起交给 imageSkill。
  const identitySources = [];
  // 角色级负面词（2026-11-06）：只在「这张图里有该角色本人」时注入，规则跟随 includeCharacter
  let characterNegative = '';
  // 体位骨架（2026-11-15）：亲密场景里她此刻的体位必须进画面。
  // 此前这条链路从不传 poseJson，于是 imageSkill 的姿势注入会回落到设置页那张全局参考图 ——
  // 开关一开，聊天/亲密配图就全变成同一个姿势（真机："还是一样的骨架""根本不遵循"）。
  // 没有进行中的亲密场景时 buildPositionPoseJson 返回 null，行为与不传完全一致。
  let poseJson = '';
  // 体位英文标签：与骨架同源。骨架负责构图，标签负责让文字与构图说同一件事。
  let poseTags = '';
  try {
    const charId = parseInt(String(conversationId).replace(/^char_/, ''), 10);
    if (!Number.isNaN(charId)) {
      if (includeCharacter) {
        try {
          const poseRef = buildPositionPoseJson(charId);
          if (poseRef?.json) poseJson = poseRef.json;
          if (poseJson) poseTags = buildPositionImageTags(charId);
        } catch (err) {
          console.warn('[chat] 体位骨架跳过:', err?.message || err);
        }
      }
      const char = frozenCharacter || db.prepare('SELECT id, identity_anchor, custom_workflow, loras, artist_override, negative_prompt, base_prompt, short_prompt FROM characters WHERE id = ?').get(charId);
      if (char) {
        if (includeCharacter) identitySources.push(char);
        if (includeCharacter && typeof char.negative_prompt === 'string') characterNegative = char.negative_prompt;
        const loras = includeCharacter ? _parseLoras(char) : [];
        if (loras.length > 0 || (includeCharacter && char.custom_workflow) || charArtistOverride(char) !== null) {
          const opts = {};
          if (includeCharacter && char.custom_workflow) opts.customWorkflow = char.custom_workflow;
          if (loras.length > 0) opts.loras = loras;
          const charArtist = charArtistOverride(char);
          if (charArtist !== null) opts.artist = charArtist;
          loraOpts = opts;
          console.log(`[chat] Lora enabled for char ${charId}:${opts.customWorkflow ? ' custom=' + opts.customWorkflow : ''}${opts.loras ? ` ${opts.loras.length} lora(s) — ${opts.loras.map(l => l.path).join(', ')}` : ''}`);
        }
      }
    }
  } catch (e) {
    console.log('[chat] Failed to load lora settings:', e.message);
  }

  // 合并交叉引用角色 LoRA（去重，主角色优先）
  if (crossRefCharIds.length > 0) {
    const crossChars = frozenCrossCharacters || crossRefCharIds.map(id => db.prepare('SELECT id, identity_anchor, loras, artist_override FROM characters WHERE id = ?').get(id)).filter(Boolean);
    identitySources.push(...crossChars);
    const crossLoras = crossChars.flatMap(c => _parseLoras(c));
    if (crossLoras.length > 0) {
      const allLoras = [...(loraOpts.loras || []), ...crossLoras];
      const seen = new Set();
      loraOpts.loras = allLoras.filter(l => {
        if (seen.has(l.path)) return false;
        seen.add(l.path);
        return true;
      });
      console.log(`[chat] Cross-ref loras merged: +${crossLoras.length} from chars [${crossRefCharIds.join(',')}], total ${loraOpts.loras.length}`);
    }
    // 主角色未设置单独画师串时，回退到第一个设置了画师串的交叉引用角色
    if (loraOpts.artist === undefined) {
      const fallbackChar = crossChars.find(c => charArtistOverride(c) !== null);
      if (fallbackChar) loraOpts.artist = charArtistOverride(fallbackChar);
    }
  }

  try {
    // 身份锚点由 imageSkill._execute 统一前置（opts.identity），这里不再各自拼 tag；
    // 分享图 includeCharacter=false 时不传，锚点自然不注入。
    //
    // 体位标签前置（2026-11-15 真机实测）：有体位骨架时，LLM 写的画面文字里的身体几何
    // 常常和体位冲突（实测让它写「骑乘」，它写「仰躺」）。此时骨架会被文字压过去 ——
    // 同一骨架测出来的规律：中性文字+强度2.0 → 骨架生效但画面被压烂；文字一致+强度1.0 → 完美；
    // 冲突文字+标签**尾附** → 仍被文字带走；冲突文字+标签**前置** → 正确跟随。
    // 所以这里不指望模型写对，直接把体位标签顶到最前面，强度保持 1.0。
    const posedPrompt = poseTags ? `${poseTags}. ${prompt}` : prompt;
    const identity = [...new Map(
      identitySources
        .filter(character => Number(character?.id) > 0)
        .map(character => [Number(character.id), character]),
    ).values()];
    const result = await generateImage(posedPrompt, {
      scene: 'chat',
      ragQuery,
      ragTimeoutMs: RAG_TIMEOUT_FAST_MS,
      onProgress: (p) => {
        if (p.stage === 'retrying') {
          send('generate_retrying', { taskId, attempt: p.attempt, maxRetries: p.maxRetries });
        } else {
          send('generate_progress', { taskId, ...p });
        }
      },
      ...frozenImageConfig,
      ...loraOpts,
      characterNegative,
      // 体位骨架（2026-11-15）：有进行中的亲密场景时按她此刻的体位出图，
      // 并由此跳过设置页那张全局参考图（imageSkill 里 poseJson 优先）。
      ...(poseJson ? { poseJson } : {}),
      // 身份锚点：主角色仅本人入镜时加入；crossRef 按实际引用加入，imageSkill 统一逐个前置。
      ...(identity.length > 0 ? { identity } : {}),
      ...(outfitSnapshots.length ? { outfitSnapshots } : {}),
    });
    if (result.success && result.images.length > 0) {
      const urls = [];
      for (const img of result.images) {
        const ts = Date.now();
        const filename = `${ts}_${img.filename || 'comfy.png'}`;
        const url = saveBase64Image('chat', filename, img.base64);
        urls.push(url);
        img.url = url;
      }

      // 使相册缓存失效
      invalidateGalleryCache();

      // 更新消息：挂上图片 URL
      const existingImages = db.prepare(`SELECT images FROM messages WHERE id = ?`).get(assistantMsgId);
        let existingImageUrls = [];
        try { existingImageUrls = JSON.parse(existingImages?.images || '[]'); } catch {}
        const mergedImages = [...new Set([...(Array.isArray(existingImageUrls) ? existingImageUrls : []), ...urls])];
        const updateResult = db.prepare(`UPDATE messages SET images = ? WHERE id = ?`)
          .run(JSON.stringify(mergedImages), assistantMsgId);
        console.log(`[chat] images saved to message id=${assistantMsgId}, rows updated=${updateResult.changes}`);

      db.prepare(`UPDATE image_tasks SET status='done', prompt_refined=?, output_paths=?, workflow_template=?, finished_at=datetime('now') WHERE id=?`)
        .run(result.promptRefined || prompt, JSON.stringify(urls), result.wfMode, taskId);

      send('generate_done', { taskId, images: result.images, source: result.source });

    } else {
      throw new Error(result.error || 'No images generated');
    }
  } catch (err) {
    console.error('[chat] generate failed:', err.message);
    db.prepare(`UPDATE image_tasks SET status='failed', error_message=?, workflow_template=?, finished_at=datetime('now') WHERE id=?`)
      .run(err.message, getLastWorkflowMode(), taskId);
    send('generate_error', { taskId, error: err.message });
  }
}

/**
 * 构建生图描述请求的消息列表（破限词+画面规则置顶，人格在后）。
 * tool 为手机分享（来源与入镜标记决定构图），dialogue 为对话插画；始终使用受理时冻结的历史。
 */
export function buildImagePromptMessages(conversationId, character, source = { kind: 'dialogue' }, frozenHistory = null) {
  const db = getDb();
  const scene = source.kind === 'tool' ? source.scene : '';
  const isSharedImage = source.kind === 'tool';
  const isLivePhoto = isSharedImage && ['selfie', 'camera'].includes(source.image_source);
  const outfitSnapshotOptions = {
    outfitScene: isSharedImage && !isLivePhoto ? 'none' : 'current',
    ...((isSharedImage && !isLivePhoto) ? { outfits: null } : {}),
  };
  const primaryOutfitSnapshot = captureCharacterOutfitSnapshot(character || {}, outfitSnapshotOptions);

  // 1. 构建二次请求的消息列表（破限词+生图指令置顶，人格在后）
  const globalRules = getSystemRulesWithWorld({ roleplay: false });
  const world = getWorldSetting();
  // 整卡人格（统一入口，含生效外观注入）
  let personalityPrompt = buildCharacterPersona(character || {}, {
    variant: 'full', outfitSnapshot: primaryOutfitSnapshot,
  }) || getDefaultPrompt();
  const imagePromptRule = getGlobalRule('image_prompt');

  // 2. 加载最近 3 轮历史（生图任务只需锚点上下文，取太多稀释注意力）
  const history = frozenHistory || db.prepare(`
    SELECT role, content, prompt FROM raw_messages
    WHERE conversation_id = ? ORDER BY id DESC LIMIT 6
  `).all(conversationId).reverse();

  // 2.5 扫描历史消息中的交叉角色引用（用于生图 LoRA 合并 + LLM 上下文注入）
  const extractRealContent = (text) => {
    const idx = text.lastIndexOf('</dynamic_context>');
    return idx >= 0 ? text.slice(idx + '</dynamic_context>'.length).trim() : text;
  };
  const historyText = history.map(m => extractRealContent(m.content)).join('\n');
  const latestUser = extractRealContent(history.filter(m => m.role === 'user').pop()?.content || '');
  const scanText = isSharedImage ? scene : historyText + '\n' + latestUser + '\n' + scene;
  const crossMatches = matchAll(scanText, character.id);
  let crossRefCharIdsForImage = [];
  let crossRefImageMsgs = [];
  let crossOutfitSnapshots = [];
  const crossBlocks = [];
  if (crossMatches.length > 0) {
    const crossChars = crossMatches.map(m =>
      db.prepare('SELECT id, display_name, base_prompt, loras FROM characters WHERE id = ?').get(m.id)
    ).filter(Boolean);

    crossOutfitSnapshots = crossChars.map(c => captureCharacterOutfitSnapshot(c, outfitSnapshotOptions));
    crossBlocks.push(...crossChars.map((c, index) => `[${c.display_name}]\n${buildImageCrossRefInfo(c, { outfitSnapshot: crossOutfitSnapshots[index] })}`));

    crossRefCharIdsForImage = crossChars.map(c => c.id);
  }

  // 文本里提到用户本人时同样注入其资料（用户不是角色：没有 id、没有 LoRA）
  if (matchUser(scanText)) {
    crossBlocks.push(`[${getUserName()}]\n${buildUserImageCrossRefInfo()}`);
  }

  if (crossBlocks.length > 0) {
    crossRefImageMsgs.push({
      role: 'system',
      content: `【画面交叉参考】以下角色/用户的身份与外观信息必须体现在生成的画面中：\n\n${crossBlocks.join('\n\n')}\n\n${IMAGE_CROSS_REF_OWNERSHIP_RULE}`
    });
  }

  const formatGuide = isSharedImage ? SHARED_IMAGE_PROMPT_RULE : imagePromptRule?.rule_content || '';

  // 用户关系描述（供生图参考，体现角色与 user 的关系）
  let userRelationContent = '';
  const userRel = db.prepare(
    'SELECT relationship_text, is_oath FROM user_relationships WHERE character_id = ?'
  ).get(character.id);
  if (userRel && userRel.relationship_text) {
    userRelationContent = `\n\n【你和user的关系】你是user的${userRel.relationship_text}。在生成包含你和user的合照或互动场景时，请通过人物姿态、表情、距离等方式体现这层关系。`;
  }
  if (userRel && userRel.is_oath) {
    const ringUserName = config.user.nickname || 'user';
    personalityPrompt = appendOathRing(personalityPrompt, character.id, ringUserName, { isFirstPerson: true });
  }

  // ── 环境参考（Environment reference，置于 schedule 之前）──
  const weatherHint = (() => {
    if (isSharedImage && !isLivePhoto) return '';
    try {
      const note = getLightNoteWithWeather();
      return note ? `Environment reference：${note}。` : '';
    } catch { return ''; }
  })();

  // ── 日程/状态上下文（不含天气光线，避免与 Environment reference 重复）──
  const scheduleCtx = (() => {
    if (isSharedImage && !isLivePhoto) return '';
    try {
      const activity = getCurrentActivity(character.id);
      const tempWoken = isTempWoken(character.id);

      if (tempWoken) {
        const db = getDb();
        const wakeMode = db.prepare('SELECT wake_mode FROM characters WHERE id = ?').get(character.id)?.wake_mode;
        const userName = config.user.nickname || '用户';
        let wakeDesc;
        if (wakeMode === 'phone') {
          wakeDesc = `你被${userName}的电话吵醒了，脑袋昏沉沉的。半睁着眼，睡眼惺忪，手机屏幕亮着，正在打哈欠，靠在床上看着手机。`;
        } else if (wakeMode === 'door' || wakeMode === 'shake') {
          const userAppearance = config.user.appearance ? `（${config.user.appearance}）` : '';
          wakeDesc = `${userName}${userAppearance}紧急冲到你家把你叫醒了，你迷迷糊糊地睁开眼。${userName}用各种方式把你吵醒/摇醒了，你半坐在床上，穿着睡衣。**画面富有动感，动作激烈**`;
        } else {
          wakeDesc = `你刚被叫醒，脑袋还昏沉沉的。`;
        }
        const locStr = activity?.location ? `，正在【${activity.location}】附近` : '';
        return '【当前状态】' + wakeDesc + locStr;
      }

      if (!activity || !activity.activity || activity.activity === '自由时间') return '';
      return '【当前日程】你正在【' + activity.location + '】' + activity.activity + '。' + (activity.description ? activity.description + '。' : '');
    } catch { return ''; }
  })();

  // ── 画面规则 + 环境参考 + 日程上下文（去重：天气仅由 Environment reference 提供）──
  const userName = config.user.nickname || '用户';
  const lastTurnDialogue = (() => {
    const lastAssistantMsg = [...history].reverse().find(m => m.role === 'assistant');
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    const lines = [];
    if (lastUserMsg) lines.push(`${userName}: ${extractRealContent(lastUserMsg.content)}`);
    if (lastAssistantMsg) lines.push(`${character?.display_name || '角色'}: ${extractRealContent(lastAssistantMsg.content)}`);
    return lines.join('\n');
  })();
  const msgs = [
    // ── 首因效应：生图输出格式要求，最先一条 system 消息 ──
    { role: 'system', content: (globalRules ? globalRules + '\n\n' : '') + (isSharedImage
      ? `【当前画面生成规则·最高优先级】
【工具画面需求】是当前分享图片的唯一任务来源，图片来源、是否入镜与 scene 共同决定画面。
对话仅用于理解分享意图，不得据此另起剧情画面。当前状态只为当场拍摄提供不冲突的可选背景，不约束相册旧照或收藏图片。`
      : `【当前画面生成规则·最高优先级】
【最后一轮对话】是当前配图的唯一任务来源，必须先独立判断它实际要求描述变化完成后的最终状态。
【上一次画面环境描述】仅是可选的连续性参考，不是当前画面的默认模板，也不代表其中任何环境、构图或人物状态需要继续保留。
先根据最后一轮对话完整确定当前画面，再检查上一次画面；只有与当前意图明确相关、没有冲突且确有连续性价值的细节才可保留。无法确定是否需要保留时，一律不保留。
最后一轮对话直接或间接产生任何变化时，必须采用变化完成后的最终状态，彻底舍弃被替换的旧状态；禁止把新旧画面折中、叠加或并列描述。`) },
    ...(world ? [{ role: 'system', content: getWorldIntegrationRule('photo') }] : []),
    ...(formatGuide ? [{ role: 'system', content: formatGuide }] : []),
    // 用户资料与生效外观属于动态材料。
    ...(() => {
      const hasUserInfo = config.user.nickname || config.user.gender || config.user.appearance || config.user.persona;
      if (!hasUserInfo) return [];
      const u = config.user;
      const userName = u.nickname || '用户';
      const parts = [];
      parts.push(`对话中另一个人是"${userName}"`);
      if (u.gender) parts.push(`**性别：${u.gender}**（这是不可变更的事实，不受角色关系或场景影响）`);
      if (u.appearance) parts.push(`外观特征：${u.appearance}`);
      if (u.persona) parts.push(`其他说明：${u.persona}`);
      return [{
        role: 'system',
        content: `【对话对象】${parts.join('。')}。当你生成关于${userName}的图片（例如合照，互动的场景）的时候，需要严格遵循以上${userName}的特征，尤其是性别和外观。${userRelationContent}`
      }];
    })(),
    // ── 画面规则 + 环境参考（天气/光线/日程已整合到规则提示词中）──
    ...([weatherHint, scheduleCtx].filter(Boolean).length ? [{ role: 'system', content: [weatherHint, scheduleCtx].filter(Boolean).join('\n\n') }] : []),
    // ── 人格（让 prompt 内容贴合角色）──
    { role: 'system', content: personalityPrompt },
    // ── 交叉角色生图上下文（在历史上下文之前，确保最后一个 system 聚焦对话）──
    ...crossRefImageMsgs,
    // ── 对话上下文（仅历史背景；最后一轮对话放入最终 user 消息）──
    // 同时剥离历史 prompt JSON 避免 token 浪费，并提取最近一轮 prompt 作为【上一次画面描述】
    ...(() => {
	    // 移除消息中任意位置的 {"prompt":"..."} JSON 块（支持弯引号变体，不锚定 $）
	    const stripPrompt = (content) => {
	      return content.replace(/\s*\{["'“”「」]?prompt["'“”「」]?\s*:\s*"[^]*?"\s*\}/g, '').trim();
	    };
      const extractPrompt = (content) => {
        // 提取完整的 {"prompt":"..."} JSON 块（保留格式头，用于【上一次画面描述】）
        const allMatches = [...content.matchAll(/\{["'“”「」]?prompt["'“”「」]?\s*:\s*"([^]*?)"\s*\}/g)];
        if (allMatches.length === 0) return null;
        return allMatches[allMatches.length - 1][0].trim();
      };

      const lastAssistantMsg = [...history].reverse().find(m => m.role === 'assistant');
      const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
      const excludeSet = new Set([lastAssistantMsg, lastUserMsg].filter(Boolean));
      const filteredHistory = history.filter(m => !excludeSet.has(m));

      // 从历史 assistant 消息中提取最近一轮的 prompt，同时剥离所有 prompt JSON
      let lastScenePrompt = null;
      const cleanedHistory = filteredHistory.map(m => {
        const cleaned = stripPrompt(m.content);
        if (m.role === 'assistant') {
          const extracted = m.prompt ? JSON.stringify({ prompt: m.prompt }) : extractPrompt(m.content);
          if (extracted) lastScenePrompt = extracted;  // 持续覆盖，最终保留最新一轮
        }
        return { ...m, content: cleaned };
      });

      if (cleanedHistory.length === 0) return [];

      const contextBlock = {
        role: 'system',
        content: '【对话上下文】\n' + cleanedHistory.map(m => {
          const userName = config.user.nickname || '用户';
          const label = m.role === 'user' ? userName : (character?.display_name || '角色');
          return `${label}: ${m.content}`;
        }).join('\n\n')
        };

      // 如果存在上一轮画面，将它与历史对话合并为同一条 system 消息。
      if (lastScenePrompt && !isSharedImage) {
        contextBlock.content = `【上一次画面环境描述·仅供参考环境】：
下面是上一张图片的描述，不是本轮必须继承的状态。不要复述或照搬它。只有当【最后一轮对话】明确延续同一画面时，才选择性保留未被改变的必要细节；如果最后一轮能够独立构成新画面，或没有明确要求延续，则忽略下面的全部内容：
${lastScenePrompt}

${contextBlock.content}`;
      }
      return [contextBlock];
    })(),
    { role: 'user', content: isSharedImage
      ? `${lastTurnDialogue ? `【最后一轮对话·仅供理解分享意图】\n${lastTurnDialogue}\n\n` : ''}${buildSharedImageTask(source, character.display_name, userName)}`
      : `${lastTurnDialogue ? `【最后一轮对话】\n${lastTurnDialogue}\n\n` : ''}【当前任务】\n直接输出英文画面描述来描述【最后一轮对话】对应的配图。仅当最后一轮对话对应的画面需要出现${userName}时，才描述并使用${userName}的外观；否则不要让${userName}出现在画面中，也不要描述其特征。不要任何格式包装或额外文字。` },
  ];

  const stableIndex = (world ? 1 : 0) + (formatGuide ? 1 : 0);
  return { msgs, crossRefCharIdsForImage, crossOutfitSnapshots, outfitSnapshot: primaryOutfitSnapshot, personalityPrompt, lastTurnDialogue,
    imageSource: isSharedImage ? { image_source: source.image_source, include_self: source.include_self } : undefined,
    includeCharacter: isSharedImage ? source.include_self : true,
    ragQuery: isSharedImage ? scene : lastTurnDialogue,
    lorebook: { personaTexts: [personalityPrompt], staticTexts: msgs.slice(0, stableIndex + 1).map(m => m.content), cacheBoundary: { index: stableIndex, offset: msgs[stableIndex].content.length }, history, characterName: character.display_name } };
}

/**
 * 回复猜想：根据最近对话预测用户接下来最可能回复的两句话
 * 独立轻量 LLM 调用（~200 tokens），不影响主回复质量
 */
const dialogueGuessCache = new Map();

async function requestImagePromptText(msgs, { character, lastTurnDialogue, emptyLabel = 'image prompt' } = {}) {
  const call = (extra = []) => chatWithLorebook(extra.length ? [...msgs, ...extra] : msgs, {
    temperature: 0.7,
    label: '生图',
    // 上游 v3.10.0：生图描述走世界书（角色人格作为 personaTexts 匹配锚点）。
    // 本地没有上游那个 personalityPrompt 变量——人格已在 buildImagePromptMessages
    // 里进 msgs，这里只传 characterName 让世界书的角色过滤/宏能定位到当前角色。
    lorebook: { characterName: character?.display_name },
  });

  const first = await requestNonEmptyImagePrompt(
    () => call(),
    { emptyRetries: 1, onEmpty: () => console.warn(`[chat] ${emptyLabel} returned empty content, retrying once...`) }
  );
  if (!needsExplicitImageRewrite(lastTurnDialogue, extractImagePromptResponse(first) || '')) return first;

  console.warn(`[chat] ${emptyLabel}: prompt looks softened (explicit dialogue → tame prompt) → rewriting once`);
  try {
    const rewritten = await call([EXPLICIT_REWRITE_INSTRUCTION]);
    if (String(rewritten || '').trim()) return rewritten;
  } catch (err) {
    console.warn(`[chat] ${emptyLabel}: explicit rewrite failed (${err.message}), keeping first result`);
  }
  return first;
}

/** 请求生图描述 LLM，返回原始输出（planner 并行预生成也走这里） */
export async function requestImagePromptContent(conversationId, character, planSceneHint = '') {
  const imageContext = buildImagePromptMessages(conversationId, character, planSceneHint);
  const content = await requestImagePromptText(imageContext.msgs, {
    character, lastTurnDialogue: imageContext.lastTurnDialogue, emptyLabel: 'image prompt',
  });
  return {
    content,
    outfitSnapshots: [imageContext.outfitSnapshot, ...(imageContext.crossOutfitSnapshots || [])].filter(Boolean),
  };
}

async function handleNeedImageFlow(conversationId, character, send, preExistingTaskId = null, planSceneHint = '', presetContentPromise = null) {
  const db = getDb();
  console.log('[chat] needImage detected, requesting prompt from model (compact)...');
  const emojiMap = getCharacterEmojiMap(character.id, db);

  const imageContext = buildImagePromptMessages(conversationId, character, planSceneHint);
  const { msgs, crossRefCharIdsForImage, crossOutfitSnapshots, outfitSnapshot, lastTurnDialogue } = imageContext;
  let outfitSnapshots = [outfitSnapshot, ...(crossOutfitSnapshots || [])].filter(Boolean);

  // 3. 静默请求模型生成 prompt（不流式，避免前端气泡混乱）
  //    presetContentPromise：planner 阶段已与回复流并行预生成的结果，直接取用，省去回复完成后的串行等待
  let fullContent = '';
  try {
    if (presetContentPromise) {
      const planned = await presetContentPromise;
      fullContent = typeof planned === 'string' ? planned : planned?.content || '';
      if (Array.isArray(planned?.outfitSnapshots)) outfitSnapshots = planned.outfitSnapshots;
      console.log(`[chat] planned image prompt (pre-generated): ${fullContent.slice(0, 80)}...`);
    } else {
      fullContent = await requestImagePromptText(msgs, {
        character,
        lastTurnDialogue,
        emptyLabel: 'needImage follow-up',
      });
      console.log(`[chat] needImage follow-up response: ${fullContent.slice(0, 80)}...`);
    }
  } catch (err) {
    console.error('[chat] needImage follow-up error:', err.message);
    failPreparingTask(preExistingTaskId, `生图请求失败: ${err.message}`);
    send('generate_error', { taskId: preExistingTaskId, error: '生图请求失败' });
    return;
  }

  // 4. 先验证 prompt，再写入 raw_messages/messages，避免空 assistant 消息。
  let prompt = extractImagePromptResponse(fullContent);
  // 体位标签统一在 triggerImageGeneration 里**前置**到 prompt 最前面（2026-11-15 真机实测：
  // 尾附压不住文字里冲突的身体几何，前置才压得住）。这里不再拼，避免同一串标签出现两遍。
  if (!prompt) {
    console.warn('[chat] needImage: failed to extract prompt, raw:', fullContent.slice(0, 120));
    failPreparingTask(preExistingTaskId, '模型未返回图像描述');
    send('generate_error', { taskId: preExistingTaskId, error: '模型未返回图像描述' });
    return;
  }
  const tags = { prompt };

  let displayContent = stripTags(fullContent);
  // 独立生图调用的输出全是 prompt 文本，不展示为对话气泡
  if (tags.prompt) displayContent = '';

  let assistantRawId;
  let assistantMsgId;
  let merged = false;  // 是否拼回上一条（不新建 message）

  if (!displayContent && tags.prompt) {
    // 模型只输出纯 JSON，无正文 → 优先拼回上一条 raw_messages
    const prevRaw = stmt(`SELECT id, prompt FROM raw_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`)
      .get(conversationId);
    const prevMsg = stmt(`SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`)
      .get(conversationId);

    if (prevRaw && !prevRaw.prompt) {
      // 上一条无 prompt → UPDATE raw.prompt + content 拼入 JSON，图片挂到上一条 message
      const promptJson = JSON.stringify({ prompt: tags.prompt });
      stmt(`UPDATE raw_messages SET prompt = ?, content = content || ? WHERE id = ?`).run(tags.prompt, promptJson, prevRaw.id);
      assistantRawId = prevRaw.id;
      assistantMsgId = prevMsg?.id;
      merged = true;
      console.log(`[chat] needImage: merged prompt into raw=${prevRaw.id}, msg=${assistantMsgId}`);
    } else {
      // 上一条已有 prompt → 兜底：新写 raw，后端组装 {"prompt":"..."} 格式
      const promptJson = JSON.stringify({ prompt: tags.prompt });
      const rawContent = `(图片) ${promptJson}`;
      const rawResult = stmt(`INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, 'assistant', ?, ?)`)
        .run(conversationId, rawContent, tags.prompt);
      assistantRawId = rawResult.lastInsertRowid;
      console.log(`[chat] needImage: prev raw already has prompt, saved as new raw id=${assistantRawId}`);
    }
  } else {
    // 正常：有正文（无论有无 prompt）→ 经 SentenceSplitter 分句
    if (displayContent) {
      const splitter = new SentenceSplitter();
      const { segments: feedSegs } = splitter.feed(displayContent);
      const { segments: flushSegs } = splitter.flushAll();
      const allSegments = [...feedSegs, ...flushSegs]
        .map(s => stripBracketActions(s).trim())
        .filter(Boolean);

      for (const segText of allSegments) {
        const parsedSeg = parseEmojiText(segText, emojiMap);
        send('token', {
          content: parsedSeg.content,
            emojiKeys: parsedSeg.keys,
          ...(parsedSeg.images.length > 0 ? { images: parsedSeg.images } : {}),
          ...(parsedSeg.leadingSticker ? { leadingSticker: true } : {}),
        });
        send('bubble_break', {});
        await sleep(typingDelay(segText));
      }
      // 更新 displayContent 为清洗后的分段文本，供下方 messages 表写入
      displayContent = allSegments.join('\n\n');
    }
    const promptJson = tags.prompt ? JSON.stringify({ prompt: tags.prompt }) : '';
    const rawContent = tags.prompt
      ? `(图片) ${promptJson}`
      : fullContent.replace(/<needImage>/gi, '').trim();
    const rawResult = stmt(`INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, 'assistant', ?, ?)`)
      .run(conversationId, rawContent, tags.prompt || null);
    assistantRawId = rawResult.lastInsertRowid;
  }

  // 保存 messages（展示用）—— merge 路径不新建 message
  if (!merged) {
    // 按句子分段保存（与主流程一致）
    const segments = (displayContent || '').split('\n\n').filter(Boolean);
    if (segments.length > 0) {
      for (let i = 0; i < segments.length; i++) {
        // 循环里的插入：提到循环外会更好，但那要改 saveSegments 的批量事务语义；
        // 这里先用语句缓存拿到同一份收益（同一 SQL 只编译一次，跨轮也复用）。
        const msgResult = stmt(`INSERT INTO messages (conversation_id, raw_id, role, content, seq) VALUES (?, ?, 'assistant', ?, ?)`)
          .run(conversationId, assistantRawId, segments[i], i);
        if (i === segments.length - 1) {
          assistantMsgId = msgResult.lastInsertRowid;
        }
        send('msg_saved', { id: msgResult.lastInsertRowid, role: 'assistant', created_at: new Date().toISOString() });
      }
    } else {
      const msgResult = stmt(`INSERT INTO messages (conversation_id, raw_id, role, content, seq) VALUES (?, ?, 'assistant', ?, 0)`)
        .run(conversationId, assistantRawId, displayContent || '');
      assistantMsgId = msgResult.lastInsertRowid;
      send('msg_saved', { id: assistantMsgId, role: 'assistant', created_at: new Date().toISOString() });
    }
  }
  console.log(`[chat] needImage: msgId=${assistantMsgId}, rawId=${assistantRawId}, merged=${merged}, hasPrompt=${!!tags.prompt}`);

  // 亲密看板：needImage 路径同样记账。这里放在"所有落库分支之后、触发生图之前"，
  // 三个分支（合并回上一条 / 新建 raw / 有正文分支）共用这一个入口；合并情况下
  // 尾部读到的是被合并的那条 raw，rawId 与它一致，重算幂等。
  // 没有 prompt 的轮次走正文兜底（拿 assistantRawId 读回正文，命中成人内容记一笔「未归类」）。
  if (tags.prompt && character) recordIntimateFromTail(character.id, conversationId);
  else if (character && assistantRawId) recordIntimateTextFallback(character.id, Number(assistantRawId));

  // 5. 触发生图
  if (tags.prompt) {
    let genTaskId;
    if (preExistingTaskId) {
      // 使用预先创建的 task，更新 prompt 和状态
      stmt(`UPDATE image_tasks SET prompt_original=?, prompt_refined=?, status='running' WHERE id=?`)
        .run(tags.prompt, tags.prompt, preExistingTaskId);
      genTaskId = preExistingTaskId;
      // generate_start 已经在 judge/needImage 判定时发送，不再重复
    } else {
      const taskResult = stmt(`INSERT INTO image_tasks (conversation_id, prompt_original, prompt_refined, status) VALUES (?, ?, ?, 'running')`)
        .run(conversationId, tags.prompt, tags.prompt);
      genTaskId = taskResult.lastInsertRowid;
      send('generate_start', { taskId: genTaskId, prompt: tags.prompt });
    }
    // 上游 v3.10.0：把「请求生图助手时捕获的最后一轮对话」透传给图片 RAG，
    // 而不是让下游去读已经拼入英文 prompt 的历史。
    await triggerImageGeneration(conversationId, tags.prompt, assistantMsgId, genTaskId, send, crossRefCharIdsForImage, lastTurnDialogue,
      null, null, {}, { outfitSnapshots });
  } else {
    console.log('[chat] needImage follow-up: no prompt tags found, falling back');
    send('generate_error', { taskId: preExistingTaskId, error: '模型未返回图像描述' });
  }
}
