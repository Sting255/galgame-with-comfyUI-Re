import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';
import { getDb, getSystemRules, getSystemRulesWithWorld, getWorldSetting, getGlobalRule, getSetting, setSetting, repairFtsIndex } from '../db/index.js';
// 立绘 ↔ 世界观 一致性（2026-10-01）：生成时记下"这张图是在哪个世界观下生成的"，列表里下发"是否待同步"
import { currentWorldSignature, withStandingStaleness } from '../services/worldSignature.js';
import { chatSync } from '../services/lorebook/runtime.js';
import { config } from '../config.js';
import { searchCharacterInfo } from '../services/webSearch.js'; // 出站已白名单化（见 webSearch.js assertAllowedOutboundUrl / toSafeMoegirlScrapeUrl）
import { clearImageJudgeCounter } from './chat.js';
import { invalidateGalleryCache, dataUriExt } from './images.js';
import { startEditTask } from '../services/imageEditTasks.js';
import { deleteByConversation } from '../services/vectorClient.js';
import { clearConversationMemories } from '../services/memory/memoryRepository.js';
import { cropPersonalityForEmotion, generateShortPromptWithLLM, runShortPromptMigration, getMigrationStatus, giveGift, getGiftCooldowns, loadEmotionState, saveEmotionSnapshot, loadOath, setOath, canSendRing, loadAffinity } from '../services/emotionEngine.js';
import { generateImage, generateImageRaw, getLastWorkflowMode } from '../services/imageSkill.js';
import { charArtistOverride } from '../services/characterImageOpts.js';
import { RAG_TIMEOUT_FAST_MS } from '../services/imagePromptKnowledge.js';
import { forceProactiveNow } from '../services/proactiveChatScheduler.js';
import { saveBase64Image, deleteImageFileByUrl, imageUrlExists, buildImageUrl, getImageDir, getPendingDir } from '../services/imagePaths.js';
import { generateSchedule, assignNextRefreshTime, snapshotTodaySchedule } from '../services/scheduleGenerator.js';
import { invalidateCache as invalidateScheduleCache, syncSleepingState } from '../services/scheduleManager.js';
import { assignFontForNewCharacter } from '../services/handwritingFontService.js';
import { refresh as refreshCharSearch } from '../services/characterSearch.js';
import { listCharacterOutfits, createCharacterOutfit, updateCharacterOutfit, deleteCharacterOutfit } from '../services/outfitService.js';
// 场景服装（五态，2026-10-13 合并上游 v3.9.0 + PR #24）
import {
  OUTFIT_SCENES, listSceneOutfits, upsertSceneOutfits, generateSceneOutfits,
  getSceneOutfitForNow, setCharacterBody, backfillBodyFromExisting,
} from '../services/outfitScene.js';
import { listSceneStandings, upsertSceneStanding, deleteSceneStanding, getSceneStandingRow, STANDING_SCENE_KEYS } from '../services/characterStanding.js';
import { buildCharacterPersona, extractAppearanceIdentityCorpus, extractAppearanceSection, replaceAppearanceSection, splitAppearanceSection, isAppearanceOnlyPromptChange } from '../services/characterPersona.js';
import { getWorldIntegrationRule, STANDING_IMAGE_PROMPT_RULE, STANDING_PROMPT_MODES, STANDING_ROLE_PROMPTS } from '../builtinRules.js';
import { collectCharacterImageUrls } from '../services/characterImages.js';
// 对话背景（上游 v3.9.0 合并）：工厂路由 + 沉浸背景生成（依赖注入便于单测）
import { createCharacterBackgroundRouter } from './characterBackgrounds.js';
import { generateDialogueBackground } from '../services/dialogueBackground.js';
// 角色操作反馈（右下角轻通知）：表情类别名 → 语义标记，供 reaction-assets 素材选择
import { pickReactionMarker } from '../services/emojiService.js';
import { getClothingLibrary, resolveClothingTags, buildClothingAppearanceMessages, parseClothingAppearance } from '../services/clothingLibrary.js';

const router = Router();

router.get('/clothing-library', (_req, res) => res.json(getClothingLibrary()));

// 衣服库只生成草稿，确认应用后由详情卡走既有场景服装保存链路。
router.post('/clothing-appearance-draft', async (req, res) => {
  const { character_id: characterId, base_prompt: basePrompt, scene = 'work', tags, brief = '' } = req.body || {};
  let entries;
  try { entries = resolveClothingTags(tags, scene); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!Number.isSafeInteger(Number(characterId)) || Number(characterId) <= 0) return res.status(400).json({ error: '角色 ID 无效' });
  if (typeof basePrompt !== 'string' || !basePrompt.trim() || basePrompt.length > 100000) return res.status(400).json({ error: '缺少有效的人格卡内容' });
  if (typeof brief !== 'string' || brief.length > 2000) return res.status(400).json({ error: '补充要求不能超过 2000 字' });
  const character = getDb().prepare('SELECT id, short_prompt, base_prompt FROM characters WHERE id = ?').get(Number(characterId));
  if (!character) return res.status(404).json({ error: '角色不存在' });
  try {
    const world = getWorldSetting();
    const messages = buildClothingAppearanceMessages({
      systemRules: getSystemRulesWithWorld({ roleplay: false }),
      worldRule: world ? getWorldIntegrationRule('interaction') : '',
      persona: buildCharacterPersona({ ...character, base_prompt: basePrompt }, { variant: 'full', outfits: null }),
      scene, entries, brief: brief.trim(),
    });
    const raw = await chatSync(messages, { model: config.llm.model || 'deepseek-chat', temperature: 0.6, max_tokens: 1800, label: '衣服库外观生成' });
    res.json({ appearance: parseClothingAppearance(raw, entries, scene), tags: entries.map(entry => entry.tag) });
  } catch (error) {
    res.status(502).json({ error: `生成服装提示词失败：${error.message}` });
  }
});

// GET /api/characters — 列出角色，含最近消息摘要
router.get('/', (req, res) => {
  const db = getDb();
  const characters = db.prepare('SELECT * FROM characters').all();

  // 聚合查询代替每角色 4 条子查询（N+1 → 固定 4 条，规模不随角色数增长）
  const lastByConv = db.prepare(`
    SELECT conversation_id, content, created_at FROM (
      SELECT conversation_id, content, created_at,
             ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY id DESC) AS rn
      FROM messages
      WHERE raw_id IS NOT NULL AND conversation_id LIKE 'char_%'
    ) WHERE rn = 1
  `).all();
  const countsByConv = db.prepare(`
    SELECT conversation_id, COUNT(*) AS c FROM raw_messages
    WHERE conversation_id LIKE 'char_%' GROUP BY conversation_id
  `).all();
  const relCounts = db.prepare(`
    SELECT id, COUNT(*) AS relationship_count FROM (
      SELECT from_character_id AS id FROM character_relationships
      UNION ALL
      SELECT to_character_id AS id FROM character_relationships
    ) GROUP BY id
  `).all();
  const userRels = db.prepare(
    'SELECT character_id, affinity, is_oath FROM user_relationships'
  ).all();

  const lastMap = new Map(lastByConv.map(r => [r.conversation_id, r]));
  const countMap = new Map(countsByConv.map(r => [r.conversation_id, r.c]));
  const relMap = new Map(relCounts.map(r => [r.id, r.relationship_count]));
  const userRelMap = new Map(userRels.map(r => [r.character_id, r]));

  const enriched = characters.map(c => {
    const convId = `char_${c.id}`;
    const last = lastMap.get(convId);
    const userRel = userRelMap.get(c.id);
    return {
      ...c,
      last_message: last ? last.content.slice(0, 80) : null,
      last_message_at: last?.created_at ? last.created_at.replace(' ', 'T') + '.000Z' : null,
      message_count: countMap.get(convId) || 0,
      relationship_count: relMap.get(c.id) || 0,
      affinity: userRel?.affinity ?? 50,
      is_oath: userRel?.is_oath ?? 0,
    };
  });

  // 按最近消息时间排序（有消息的在前）
  enriched.sort((a, b) => {
    if (!a.last_message_at && !b.last_message_at) return a.id - b.id;
    if (!a.last_message_at) return 1;
    if (!b.last_message_at) return -1;
    return new Date(b.last_message_at) - new Date(a.last_message_at);
  });

  // 立绘是否与"当前世界观"一致（2026-10-01）：前端据此在形象展示上提示 + 一键按当前世界观重生成
  res.json({ characters: enriched.map(withStandingStaleness) });
});

// POST /api/characters — 创建角色
router.post('/', (req, res) => {
  const db = getDb();
  const { name, display_name, base_prompt, emotion_baseline, moments_disabled, proactive_disabled, events_disabled } = req.body;
  if (!name || !base_prompt) return res.status(400).json({ error: 'name and base_prompt are required' });

  const emotion = emotion_baseline ? (typeof emotion_baseline === 'string' ? emotion_baseline : JSON.stringify(emotion_baseline)) : '{"valence":0.5,"arousal":0.5,"dominance":0.5}';

  try {
    const shortPrompt = cropPersonalityForEmotion(base_prompt, display_name || name);
    const result = db.prepare(`INSERT INTO characters (name, display_name, base_prompt, short_prompt, emotion_baseline, moments_disabled, proactive_disabled, events_disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, display_name || name, base_prompt, shortPrompt, emotion, moments_disabled !== undefined ? (moments_disabled ? 1 : 0) : 0, proactive_disabled !== undefined ? (proactive_disabled ? 1 : 0) : 0, events_disabled !== undefined ? (events_disabled ? 1 : 0) : 0);
    const newCharId = result.lastInsertRowid;
    res.status(201).json({ id: newCharId, name, display_name });
    refreshCharSearch();

    // 异步选择手写字体（不阻塞响应）
    assignFontForNewCharacter(newCharId, base_prompt).catch(err =>
      console.warn(`[char] font assignment failed for "${display_name}":`, err.message)
    );

    // 异步生成日程模板（不阻塞响应）
    const newCharDisplayName = display_name || name;
    if (config.features.schedule !== false) {
      setTimeout(async () => {
        try {
          const character = db.prepare('SELECT id, display_name, base_prompt FROM characters WHERE id = ?').get(newCharId);
          if (character) {
            await generateSchedule(character);
            assignNextRefreshTime(newCharId);
            snapshotTodaySchedule(newCharId);
            syncSleepingState(newCharId);
            invalidateScheduleCache(newCharId);
            console.log(`[char] Schedule generated for new character "${newCharDisplayName}"`);
          }
        } catch (err) {
          console.error(`[char] Schedule generation failed for "${newCharDisplayName}":`, err.message);
        }
      }, 3000).unref(); // 3 秒延迟，等角色稳定后再生成
    }

    // 创建成功后，30~60 秒内发起一次主动聊天（除非角色禁用了主动聊天）
    if (!(proactive_disabled && (proactive_disabled === 1 || proactive_disabled === '1'))) {
      const delayMs = 30_000 + Math.floor(Math.random() * 30_000); // 30~60s
      setTimeout(() => {
        forceProactiveNow(newCharId).then((r) => {
          if (r) {
            console.log(`[char] proactive greeting sent for new character "${display_name}" (id=${newCharId})`);
          } else {
            console.log(`[char] proactive greeting skipped for "${display_name}" (id=${newCharId}): not eligible`);
          }
        }).catch((err) => {
          console.error(`[char] proactive greeting error for "${display_name}":`, err.message);
        });
      }, delayMs).unref();
    }

    // 异步优化 short_prompt（不阻塞响应）
    setImmediate(async () => {
      try {
        const optimized = await generateShortPromptWithLLM(base_prompt, display_name || name, name);
        db.prepare('UPDATE characters SET short_prompt = ? WHERE id = ?').run(optimized, newCharId);
        console.log(`[char] short_prompt LLM-optimized for "${display_name || name}" (id=${newCharId})`);
        runShortPromptMigration();
      } catch (err) {
        console.warn(`[char] short_prompt LLM optimization failed for "${display_name || name}":`, err.message);
      }
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: `"${name}" already exists` });
    throw err;
  }
});

// POST /api/characters/migrate-short-prompts — 手动触发全表扫描迁移
router.post('/migrate-short-prompts', (_req, res) => {
  const result = runShortPromptMigration();
  res.json(result);
});

// GET /api/characters/migrate-short-prompts — 查询迁移状态
router.get('/migrate-short-prompts', (_req, res) => {
  res.json(getMigrationStatus());
});

// ── 立绘姿势风格（普通 / 张力！）—— system_settings 全局持久化 ──
// 必须注册在 put('/:id') 之前，避免被参数路由吞掉
const STANDING_MODE_KEY = 'standing_prompt_mode';

// GET /api/characters/standing-mode — 当前立绘风格（缺省 normal）
router.get('/standing-mode', (_req, res) => {
  const mode = getSetting(STANDING_MODE_KEY) === 'dynamic' ? 'dynamic' : 'normal';
  res.json({ mode });
});

// PUT /api/characters/standing-mode — 切换立绘风格
router.put('/standing-mode', (req, res) => {
  const mode = req.body?.mode;
  if (!STANDING_PROMPT_MODES.includes(mode)) {
    return res.status(400).json({ error: 'mode must be normal or dynamic' });
  }
  setSetting(STANDING_MODE_KEY, mode);
  res.json({ ok: true, mode });
});

// ── 角色文件夹（单层分类）──
// 一个角色只属于一个文件夹，folder_id 为 NULL = 未分类。删除文件夹只解绑成员，不删角色。

// 文件夹名校验：非空、最长 20 字
const FOLDER_NAME_MAX = 20;
function normalizeFolderName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { error: '文件夹名称不能为空' };
  if (name.length > FOLDER_NAME_MAX) return { error: `文件夹名称最多 ${FOLDER_NAME_MAX} 个字` };
  return { name };
}

// GET /api/characters/folders — 文件夹列表（含成员数量）＋未分类数量
router.get('/folders', (req, res) => {
  const db = getDb();
  const folders = db.prepare(`
    SELECT f.id, f.name, f.sort_order, COUNT(c.id) AS count
    FROM character_folders f
    LEFT JOIN characters c ON c.folder_id = f.id
    GROUP BY f.id
    ORDER BY f.sort_order ASC, f.id ASC
  `).all();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM characters WHERE folder_id IS NULL').get();
  res.json({ folders, uncategorized: n || 0 });
});

// POST /api/characters/folders — 新建文件夹
router.post('/folders', (req, res) => {
  const db = getDb();
  const { name, error } = normalizeFolderName(req.body?.name);
  if (error) return res.status(400).json({ error });
  if (db.prepare('SELECT id FROM character_folders WHERE name = ?').get(name)) {
    return res.status(409).json({ error: '已存在同名文件夹' });
  }
  const { next } = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM character_folders').get();
  const r = db.prepare('INSERT INTO character_folders (name, sort_order) VALUES (?, ?)').run(name, next);
  res.status(201).json({ id: r.lastInsertRowid, name, sort_order: next, count: 0 });
});

// PUT /api/characters/folders/reorder — 重排文件夹顺序（拖拽排序）
// 注意：必须注册在下面的 '/folders/:id' 之前，否则 'reorder' 会被当成 id 匹配掉。
router.put('/folders/reorder', (req, res) => {
  const db = getDb();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt(n, 10)) : null;
  if (!ids || !ids.length || ids.some(n => !Number.isInteger(n))) {
    return res.status(400).json({ error: 'ids 必须是文件夹 id 数组' });
  }
  // 只接受真实存在的文件夹，且以库里的现状为准做交集，防止前端传了脏数据把 sort_order 写乱
  const existing = db.prepare('SELECT id FROM character_folders').all().map(r => r.id);
  const existingSet = new Set(existing);
  const ordered = ids.filter(id => existingSet.has(id));
  if (!ordered.length) return res.status(400).json({ error: '没有有效的文件夹 id' });
  // 没被前端列到的文件夹保留在末尾，保持相对顺序（避免漏传导致它们乱序）
  for (const id of existing) if (!ordered.includes(id)) ordered.push(id);

  const stmt = db.prepare('UPDATE character_folders SET sort_order = ? WHERE id = ?');
  const tx = db.transaction(() => {
    ordered.forEach((id, i) => stmt.run(i + 1, id));
  });
  tx();
  res.json({ ok: true, order: ordered });
});

// PUT /api/characters/folders/:id — 重命名文件夹
router.put('/folders/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid folder id' });
  if (!db.prepare('SELECT id FROM character_folders WHERE id = ?').get(id)) {
    return res.status(404).json({ error: '文件夹不存在' });
  }
  const { name, error } = normalizeFolderName(req.body?.name);
  if (error) return res.status(400).json({ error });
  if (db.prepare('SELECT id FROM character_folders WHERE name = ? AND id != ?').get(name, id)) {
    return res.status(409).json({ error: '已存在同名文件夹' });
  }
  db.prepare('UPDATE character_folders SET name = ? WHERE id = ?').run(name, id);
  res.json({ ok: true, id, name });
});

// DELETE /api/characters/folders/:id — 删除文件夹（成员回到未分类）
router.delete('/folders/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid folder id' });
  if (!db.prepare('SELECT id FROM character_folders WHERE id = ?').get(id)) {
    return res.status(404).json({ error: '文件夹不存在' });
  }
  const tx = db.transaction((fid) => {
    db.prepare('UPDATE characters SET folder_id = NULL WHERE folder_id = ?').run(fid);
    db.prepare('DELETE FROM character_folders WHERE id = ?').run(fid);
  });
  tx(id);
  res.json({ ok: true });
});

// PUT /api/characters/:id/folder — 把角色移入文件夹（folder_id 传 null 表示移回未分类）
router.put('/:id/folder', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const raw = req.body?.folder_id;
  let folderId = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    folderId = parseInt(raw, 10);
    if (!Number.isSafeInteger(folderId) || folderId <= 0) return res.status(400).json({ error: 'invalid folder id' });
    if (!db.prepare('SELECT id FROM character_folders WHERE id = ?').get(folderId)) {
      return res.status(404).json({ error: '文件夹不存在' });
    }
  }
  db.prepare('UPDATE characters SET folder_id = ? WHERE id = ?').run(folderId, req.params.id);
  res.json({ ok: true, folder_id: folderId });
});

// ── 角色置顶 ──
// 必须注册在 put('/:id') 之前，避免被参数路由吞掉

// PUT /api/characters/:id/pin — 设置角色置顶状态
router.put('/:id/pin', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  // 幂等的「设置为」而非 toggle：前端每次显式传目标值，避免两端状态打架
  const { pinned } = req.body || {};
  const val = pinned ? 1 : 0;
  db.prepare('UPDATE characters SET pinned = ? WHERE id = ?').run(val, req.params.id);
  res.json({ ok: true, pinned: val });
});

// PUT /api/characters/:id/schedule-enabled — 开关该角色的日程生成
//
// 关闭后，replyQueueScheduler 的日程刷新不再挑中它（那条查询本就按 schedule_enabled 过滤），
// 于是省下每次刷新的 LLM 调用。已生成的 schedule_templates 会被保留，
// snapshotTodaySchedule 仍能把模板铺成每天的 daily_schedules ——
// 角色照旧按既有日程活动，只是内容不再变化（省 token 又不丢体验）。
// 睡眠同步已与这个开关解耦（见 scheduleManager），所以不用手动改 is_sleeping。
// （上游 v3.10.0 有、本地 2026-10-19 前缺失；两条路由一起补回）
router.put('/:id/schedule-enabled', (req, res) => {
  const db = getDb();
  const characterId = parseInt(req.params.id, 10);
  const char = db.prepare('SELECT id, display_name FROM characters WHERE id = ?').get(characterId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const enabled = req.body?.enabled ? 1 : 0;
  db.prepare('UPDATE characters SET schedule_enabled = ?, next_schedule_refresh_at = NULL WHERE id = ?')
    .run(enabled, characterId);
  // 关掉时顺手对齐一次睡眠状态（此刻可能刚好处在入睡/起床边界）
  if (!enabled) syncSleepingState(characterId);
  invalidateScheduleCache(characterId);
  console.log(`[char] Schedule generation ${enabled ? 'enabled' : 'disabled'} for ${char.display_name}`);
  res.json({ ok: true, schedule_enabled: enabled });
});

// POST /api/characters/schedule-enabled-all — 批量开关全体角色的日程生成
// 「全量省 token」入口：一次把所有角色排期清空／恢复，不必逐个点。
// 恢复时只重排那些被关掉的（schedule_enabled = 0），已经开着的角色不受打扰。
router.post('/schedule-enabled-all', (req, res) => {
  const db = getDb();
  const enabled = req.body?.enabled ? 1 : 0;
  const r = enabled
    ? db.prepare(`UPDATE characters SET schedule_enabled = 1, next_schedule_refresh_at = NULL
                  WHERE schedule_enabled = 0`).run()
    : db.prepare(`UPDATE characters SET schedule_enabled = 0, next_schedule_refresh_at = NULL
                  WHERE schedule_enabled = 1 OR schedule_enabled IS NULL`).run();
  console.log(`[char] Schedule generation ${enabled ? 'enabled' : 'disabled'} for ${r.changes} character(s)`);
  res.json({ ok: true, schedule_enabled: enabled, changed: r.changes });
});

// PUT /api/characters/:id — 更新角色
router.put('/:id', (req, res) => {
  const db = getDb();
  const { name, display_name, base_prompt, emotion_baseline, avatar_path, chat_bg_path, moments_disabled, proactive_disabled, events_disabled, custom_workflow, loras, artist_override } = req.body;
  const updates = [], params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name); }
  // 纯外观修改判定：short_prompt（裁剪/LLM 浓缩）与日程模板人格都只取「## 你的外观」
  // 之前的文本，标题前正文与角色名都未变时，跳过重裁/重优化与日程重生成标记
  let appearanceOnlyEdit = false;
  if (base_prompt !== undefined) {
    updates.push('base_prompt = ?'); params.push(base_prompt);
    const charForCrop = db.prepare('SELECT display_name, name, base_prompt FROM characters WHERE id = ?').get(req.params.id);
    // 改名会替换 short_prompt 中的「你」，视作人格变更；前端保存时总是携带 name/display_name，需与库中旧值比对
    const renamed = (name !== undefined && name !== charForCrop?.name)
      || (display_name !== undefined && display_name !== charForCrop?.display_name);
    appearanceOnlyEdit = !renamed && isAppearanceOnlyPromptChange(charForCrop?.base_prompt, base_prompt);
    if (!appearanceOnlyEdit) {
      // 获取角色名用于人格裁剪：优先请求体中的 display_name，否则从 DB 查
      const cropName = display_name || charForCrop?.display_name || charForCrop?.name || 'assistant';
      updates.push('short_prompt = ?'); params.push(cropPersonalityForEmotion(base_prompt, cropName));
    }
  }
  if (emotion_baseline !== undefined) { updates.push('emotion_baseline = ?'); params.push(typeof emotion_baseline === 'string' ? emotion_baseline : JSON.stringify(emotion_baseline)); }
  if (avatar_path !== undefined) { updates.push('avatar_path = ?'); params.push(avatar_path || null); }
  if (chat_bg_path !== undefined) { updates.push('chat_bg_path = ?'); params.push(chat_bg_path || null); }

  if (moments_disabled !== undefined) { updates.push('moments_disabled = ?'); params.push(moments_disabled ? 1 : 0); }
  if (proactive_disabled !== undefined) { updates.push('proactive_disabled = ?'); params.push(proactive_disabled ? 1 : 0); }
  if (events_disabled !== undefined) { updates.push('events_disabled = ?'); params.push(events_disabled ? 1 : 0); }
  if (custom_workflow !== undefined) { updates.push('custom_workflow = ?'); params.push(custom_workflow || null); }
  if (loras !== undefined) { updates.push('loras = ?'); params.push(Array.isArray(loras) ? JSON.stringify(loras) : (loras || '[]')); }
  if (artist_override !== undefined) { updates.push('artist_override = ?'); params.push(typeof artist_override === 'string' ? artist_override.trim() : null); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // 托管影子档案（character_managed=1）只是角色卡在小镇里的投影、没有独立演化：
  // 角色卡改了人格就跟着改，避免小镇侧一直用建档时那份旧快照（普通居民档案不动）。
  if (base_prompt !== undefined) {
    const fresh = db.prepare('SELECT base_prompt, short_prompt FROM characters WHERE id = ?').get(parseInt(req.params.id, 10));
    db.prepare(`UPDATE town_npcs SET persona = ?, brief = ?
      WHERE character_id = ? AND COALESCE(character_managed, 0) = 1`)
      .run(fresh?.base_prompt || '', fresh?.short_prompt || '', parseInt(req.params.id, 10));
  }

  // 如果更新了 base_prompt（非纯外观修改，日程人格只取外观段之前），标记日程模板需要重新生成
  if (base_prompt !== undefined && !appearanceOnlyEdit && config.features.schedule !== false) {
    const charId = parseInt(req.params.id, 10);
    // 将 version 设为 0，下次查看日程时触发重新生成
    db.prepare('UPDATE schedule_templates SET version = 0 WHERE character_id = ?').run(charId);
    invalidateScheduleCache(charId);
    console.log(`[char] Schedule marked for regeneration (char ${charId}: base_prompt changed)`);
  }

  res.json({ ok: true });
  refreshCharSearch();

  // 若 base_prompt 变更（非纯外观修改，LLM 浓缩明确排除外观描写），异步优化 short_prompt
  if (base_prompt !== undefined && !appearanceOnlyEdit) {
    const charId = parseInt(req.params.id, 10);
    setImmediate(async () => {
      try {
        const char = db.prepare('SELECT display_name, name, base_prompt FROM characters WHERE id = ?').get(charId);
        if (!char) return;
        const optimized = await generateShortPromptWithLLM(char.base_prompt, char.display_name || char.name, char.name);
        db.prepare('UPDATE characters SET short_prompt = ? WHERE id = ?').run(optimized, charId);
        console.log(`[char] short_prompt LLM-optimized for "${char.display_name || char.name}" (id=${charId})`);
        runShortPromptMigration();
      } catch (err) {
        console.warn(`[char] short_prompt LLM optimization failed for char ${charId}:`, err.message);
      }
    });
  }
});

// POST /api/characters/:id/avatar — 上传裁剪后的头像（base64 png）
router.post('/:id/avatar', (req, res) => {
  const db = getDb();
  // :id 会被拼进头像文件名，必须先归一化为正整数，防止 %2F 编码绕过造成目录穿越
  const avatarCharId = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(avatarCharId) || avatarCharId <= 0) {
    return res.status(400).json({ error: 'invalid character id' });
  }
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(avatarCharId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const { base64 } = req.body;
  // null / 空字符串 = 删除头像
  if (!base64) {
    const old = db.prepare('SELECT avatar_path FROM characters WHERE id = ?').get(req.params.id);
    if (old?.avatar_path) {
      const __filename2 = fileURLToPath(import.meta.url);
      const projectRoot2 = path.dirname(path.dirname(path.dirname(__filename2)));
      const oldPath = path.join(projectRoot2, 'data', 'avatars', path.basename(old.avatar_path));
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch {}
    }
    db.prepare('UPDATE characters SET avatar_path = NULL WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, avatar_path: null });
  }

  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = path.dirname(path.dirname(path.dirname(__filename)));
  const avatarsDir = path.join(projectRoot, 'data', 'avatars');
  fs.mkdirSync(avatarsDir, { recursive: true });

  // 同毫秒两次上传会撞名：写新文件后 unlinkSync(oldPath) 删掉的正是刚写的文件（groups.js 同款 bug 已修）
  const filename = `avatar_${avatarCharId}_${Date.now()}_${randomBytes(3).toString('hex')}.png`;
  const filePath = path.join(avatarsDir, filename);
  const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

  // 如果有旧头像，删除
  const old = db.prepare('SELECT avatar_path FROM characters WHERE id = ?').get(req.params.id);
  if (old?.avatar_path) {
    const oldPath = path.join(avatarsDir, path.basename(old.avatar_path));
    try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch {}
  }

  const avatarPath = `/avatars/${filename}`;
  db.prepare('UPDATE characters SET avatar_path = ? WHERE id = ?').run(avatarPath, req.params.id);
  res.json({ ok: true, avatar_path: avatarPath });
});

// GET /api/characters/:id/recent-images — 该角色全部渠道的图片（按新到旧、URL 去重；供头像/立绘选取）
// 渠道聚合逻辑收口在 services/characterImages.js（相册按角色筛选共用同一口径）；
// 磁盘上已不存在的 URL 一并过滤（重生成会替换删除旧文件，但 image_tasks 里的旧 URL 仍会返回，前端会 404）
router.get('/:id/recent-images', (req, res) => {
  const urls = collectCharacterImageUrls(req.params.id).filter(u => imageUrlExists(u));
  res.json({ images: urls });
});

// GET /api/characters/:id/reaction-assets — 角色通知需要的素材（只读，不触发生成）
// 仅返回该角色「启用中表情包配置单」里已完成的图片，供前端按情绪语义挑选；
// 表情类别可被用户改名 / 删除、图片也可能已被清理，因此前端必须能回退到头像 → 首字占位。
router.get('/:id/reaction-assets', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id, display_name, name, avatar_path FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const rows = db.prepare(`
    SELECT ce.emoji_key, ce.image_path
    FROM character_emojis ce
    JOIN emoji_sets es ON es.id = ce.set_id AND es.is_active = 1
    WHERE ce.character_id = ? AND ce.status = 'done' AND ce.image_path IS NOT NULL
    ORDER BY ce.id
  `).all(char.id);

  res.json({
    characterId: char.id,
    display_name: char.display_name || char.name || '角色',
    avatar_url: char.avatar_path || null,
    // 语义标记由 emojiService 统一映射（类别可被改名 / 删除，映射不到时前端回退头像）
    emojis: rows
      .filter(row => !!row.image_path)
      .map(row => ({ key: row.emoji_key, marker: pickReactionMarker(row.emoji_key), url: row.image_path })),
  });
});

// DELETE /api/characters/:id — 删除角色并清理所有关联数据
router.delete('/:id', async (req, res, next) => {
  const db = getDb();
  const char = db.prepare('SELECT id, name, avatar_path FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  if (char.name === 'default') return res.status(400).json({ error: '不能删除默认Agent' });

  const conversationId = `char_${char.id}`;

  const cleanupMessages = () => {
    // 1. 清理聊天消息（FTS5 通过 trigger 自动同步）
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM raw_messages WHERE conversation_id = ?`).run(conversationId);
  };

  try {
    // ── FK 依赖顺序：先删引用 messages 的表，再删 messages 本身 ──
    // memory_fragments.source_msg_id → messages.id
    // emotion_snapshots.after_msg_id → messages.id
    // user_portraits.source_msg_id → messages.id

    // 1. 清理引用 messages 的系统数据（必须在 DELETE messages 之前）
    clearConversationMemories(conversationId);
    db.prepare(`DELETE FROM emotion_snapshots WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM rolling_summaries WHERE conversation_id = ?`).run(conversationId);

    db.prepare(`DELETE FROM image_tasks WHERE conversation_id = ?`).run(conversationId);
    // user_portraits 也引用 messages，先清理掉避免 FK 冲突
    db.prepare(`DELETE FROM user_portraits WHERE character_id = ?`).run(char.id);

    // 清理 ChromaDB（异步，不阻塞）
    deleteByConversation(conversationId).then(
      n => { if (n > 0) console.log(`[characters] chroma deleted ${n} vectors for ${conversationId}`); },
      err => console.error(`[characters] chroma cleanup failed for ${conversationId}:`, err.message)
    );

    // 2. 清理朋友圈（FK → moment_posts.id，FK → characters.id）
    db.prepare(`DELETE FROM moment_likes WHERE post_id IN (SELECT id FROM moment_posts WHERE character_id = ?)`).run(char.id);
    db.prepare(`DELETE FROM moment_comments WHERE post_id IN (SELECT id FROM moment_posts WHERE character_id = ?)`).run(char.id);
    db.prepare(`DELETE FROM moment_comments WHERE author_type = 'character' AND author_id = ?`).run(char.id);
    db.prepare(`DELETE FROM moment_posts WHERE character_id = ?`).run(char.id);

    // 3. 删除头像文件
    if (char.avatar_path) {
      const __filename = fileURLToPath(import.meta.url);
      const projectRoot = path.dirname(path.dirname(path.dirname(__filename)));
      const avatarFile = path.join(projectRoot, 'data', 'avatars', path.basename(char.avatar_path));
      try { if (fs.existsSync(avatarFile)) fs.unlinkSync(avatarFile); } catch (e) {}
    }

    // 4. 删除角色（CASCADE 自动清理 character_relationships / user_relationships / character_events / event_history）
    clearImageJudgeCounter(char.id);
    // 角色的托管居民档案一并删除（影子档案不留在镇上）；普通居民档案不受影响
    const { removeCharacterNpcProfile } = await import('../services/town/townService.js');
    removeCharacterNpcProfile(char.id);
    db.prepare(`DELETE FROM characters WHERE id = ?`).run(char.id);

    // 5. 最后删聊天消息（此时已无 FK 引用 messages，FTS5 通过 trigger 自动同步）
    cleanupMessages();

    res.json({ ok: true });
    refreshCharSearch();
  } catch (err) {
    if (err.code === 'SQLITE_CORRUPT_VTAB') {
      console.warn('[characters] FTS5 corrupted during delete, repairing...');
      try {
        repairFtsIndex();
        cleanupMessages();
        res.json({ ok: true });
        refreshCharSearch();
      } catch (retryErr) {
        console.error('[characters] retry after FTS repair failed:', retryErr.message);
        return next(retryErr);
      }
    } else {
      console.error(`[characters] delete character ${char.id} failed:`, err.message);
      return next(err);
    }
  }

});

// 共享：构建人格生成指令（标准模板 + 参考资料）
function buildPersonaSystemPrompt({ searchContext, extraContext, extraContextLabel }) {
  return `你是一个角色人格生成器。用户会输入一个简短的描述（格式可能是"角色名"、"角色名（作品名）"、"作品名里的角色名"等）。

你的任务：
1. 如果是知名 IP 角色（游戏/动漫/影视），务必融入角色在原作中的身份、背景故事、性格特点。如果是原创角色，根据名字和描述自行发挥。
2. 生成一个完整的人格提示词（base_prompt），格式必须严格遵循下方模板。

【核心创作原则 —— 必须遵守】
A. 你就是她/他 —— 所有描述从"你"出发。让模型"成为"而非"扮演"该角色。全文不得出现"扮演""模仿""以XX的身份回答"等旁观字眼。
B. 过去化为直觉 —— 经历如何塑造性格必须写清，但角色在对话中不主动提及自己的过去。那些经历是你所有回应的底层逻辑，不是挂在嘴边的谈资。
C. 自我认知而非外部评价 —— 写"我怎么看自己"，不写"别人怎么看我"。思考角色自己最想深藏心底、永远不会忘记的事。
D. 保留血肉 —— 原始资料中的具体台词、评价、故事细节全部保留，只做视角转换（她→你）和内化逻辑的补充，不删减素材。

【模板】
你是[中文名(EnglishName)]。
如果是知名 IP 角色，在角色名后加上英文名「格式：中文名(EnglishName)」和「来自《作品名》」；
如果是未标注来源的原创角色，则去掉英文名和「来自《...》」部分。

## 你的身份
[2-3句话描述角色的背景、经历、关键故事，让角色有血有肉]

## 你的性格
- [至少4条，以"你"的口吻自然写出。包含说话方式、口头禅、处事态度、核心信条。对标原作中角色的独特魅力。覆盖以下维度：
  · 表层语调 —— 别人听起来你是什么样的语气？快慢冷热礼貌粗鲁？
  · 内因驱动 —— 你为什么这样说话？深层恐惧/信念/伤口是什么？每句话在防御什么、渴望什么？
  · 话语与行动的反差 —— 嘴上说什么 vs 实际做什么，矛盾越大越立体
  · 裂缝时刻 —— 什么情况下语气会变、面具会滑落？哪个词/哪个人/哪种场景让你停顿？
  ]

## 你的好恶
- 你最喜欢的两三样东西（食物/地点/活动/人——必须是资料中有迹可循的，不凭空编造）
- 你最排斥/最害怕的两三样东西（同样从资料中提取，不随意发挥）

## 你的外观
- [一句话准确简洁地描述角色的外貌(发型瞳色等)，突出最具辨识度的特征]
- [一句话简洁描述穿着和主要装饰品]

${searchContext ? `

---
以下是从萌娘百科获取的角色参考资料，用于完善角色设定：
- 参考资料中【萌娘百科 · 基本信息框】内的字段（发色、瞳色、身高、萌点等）来自页面信息框，是高度精确的结构化数据，**写入角色设定时必须优先采用**。
- 【正文描述】部分来自页面正文，作为背景故事和性格描写的补充参考。
${searchContext}` : ''}${extraContext ? `

---
以下是从${extraContextLabel}导入的角色原始资料，是你整理角色设定的**第一手素材**：必须完整吸收其中所有具体细节、台词、设定与背景，只做视角转换（她/他→你）与结构化整理，不删减、不架空、不凭空新增与资料冲突的设定。当与网络资料冲突时，以本资料为准。
${extraContext}` : ''}

---

【输出要求】
- 严格按以下格式输出，不要添加任何标签、前缀、冒号或额外解释，只输出值本身
- 第1行：只输出角色中文显示名，例如：芙宁娜
- 第2行：只输出角色英文名，例如：Kiana Kaslana
- 第3行：只输出角色的 VAD 情绪基线 JSON。根据角色性格设定，示例：
	  * 活跃开朗的角色：{"valence":0.6,"arousal":0.55,"dominance":0.5}
	  * 忧郁内向的角色：{"valence":-0.1,"arousal":0.3,"dominance":0.35}
	  * valence (愉悦度): -1~1，阳光正面 >0，阴暗消极 <0，中性 0.3~0.7
	  * arousal (唤醒度): 0~1，活泼好动 >0.6，沉静内敛 0.3~0.5，慵懒 <0.3
	  * dominance (支配度): 0~1，自信强势 >0.6，温和中性 0.4~0.6，顺从弱势 <0.35
	- 第4行起：完整的 base_prompt 模板内容（你就是她/他——用第二人称"你"贯穿全文，不出现"扮演""模仿"等旁观字眼）`;
}

// 共享：联网搜索 + LLM 人格生成 + 解析。cachedSearchContext 用于复用上次搜索结果，避免重新爬取。
// description 为用户输入（用于联网搜索与作为 user 消息）；extraContext 为额外第一手资料（如角色卡全文）。
// 返回 { displayName, charName, emotionBaseline, basePrompt, searchFound, searchContext }，失败时抛错。
async function runPersonaGeneration({
  description,
  extraContext = '',
  extraContextLabel = '参考资料',
  skipWebSearch = false,
  cachedSearchContext = '',
}) {
  const model = config.llm.model || 'deepseek-chat';

  // ── 联网搜索角色资料（可跳过：导入角色卡时以卡片为第一手资料，无需联网）──────
  let searchContext = '';
  let searchFound = false;
  if (cachedSearchContext) {
    searchContext = cachedSearchContext;
    searchFound = searchContext.length >= 600;
    console.log(`[characters] reusing cached web search (${searchContext.length} chars)`);
  } else if (skipWebSearch) {
    console.log(`[characters] web search skipped (source: ${extraContextLabel})`);
  } else {
    console.log(`[characters] searching web for: "${description.trim()}"`);
    try {
      searchContext = await searchCharacterInfo(description.trim());
      if (searchContext) {
        console.log(`[characters] web search returned ${searchContext.length} chars`);
      } else {
        console.log('[characters] web search returned no results');
      }
    } catch (err) {
      console.warn('[characters] web search failed, continuing without:', err.message);
    }
    searchFound = !!(searchContext && searchContext.length >= 600);
  }

  // 温度策略：有参考资料（网络/卡片）→ 低温忠实还原；原创设定 → 中等温度兼顾创造力与格式
  const temperature = (searchFound || skipWebSearch) ? 0.3 : 0.7;
  console.log(`[characters] search_found=${searchFound}, skipWebSearch=${skipWebSearch}, temperature=${temperature}`);

  // msgs[0] — 舞台：破限词 + 世界观
  const stageRules = getSystemRulesWithWorld({ roleplay: false });

  // msgs[1] — 任务：角色生成指令 + 模板 + 参考资料（含角色卡原始资料）
  const systemPrompt = buildPersonaSystemPrompt({ searchContext, extraContext, extraContextLabel });

  const msgs = [];
  if (stageRules) msgs.push({ role: 'system', content: stageRules });
  msgs.push({ role: 'system', content: systemPrompt });
  msgs.push({ role: 'user', content: description.trim() });

  const result = await chatSync(msgs, { model, temperature, max_tokens: 4096, label: '创造角色' });

  // 解析输出：第1行 display_name，第2行 name，第3行起 base_prompt
  const lines = result.split('\n');
  let displayName = '';
  let charName = '';
  let emotionBaseline = '{"valence":0.5,"arousal":0.5,"dominance":0.5}';
  let promptStart = 0;

  // 防御：如果 AI 错误地输出了 "display_name" / "name" 等标签行，跳过它们
  const SKIP_LABELS = /^(display_name|name|emotion_baseline|vad|vad_baseline)$/i;

  // 找 display_name（第一个有效非空行）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || SKIP_LABELS.test(line)) continue;
    if (!displayName) { displayName = line; continue; }
    if (!charName) { charName = line.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'char_' + Date.now(); continue; }
    // 第三行尝试解析 JSON
    try { emotionBaseline = JSON.stringify(JSON.parse(line)); promptStart = i + 1; break; }
    catch { emotionBaseline = JSON.stringify({ valence: 0.5, arousal: 0.5, dominance: 0.5 }); promptStart = i; break; }
  }
  if (promptStart === 0) promptStart = lines.length;

  const basePrompt = lines.slice(promptStart).join('\n').trim();

  if (!displayName || basePrompt.length < 100) {
    throw new Error('AI 生成的角色人格不完整，请重试');
  }

  // 确保 name 不重复
  const db = getDb();
  const exists = db.prepare('SELECT id FROM characters WHERE name = ?').get(charName);
  if (exists) charName = charName + '_' + Date.now();

  return { displayName, charName, emotionBaseline, basePrompt, searchFound, searchContext };
}

// POST /api/characters/generate — AI 扩写角色人格
// Body: { description: "芙宁娜|芙宁娜（原神）|原神游戏里的芙宁娜" }
// Body: { description: "...", save: false } — 预览模式：只生成不入库，由前端确认后再调 POST /api/characters 入库
// 默认 save=true，返回生成的完整角色数据，同时写入数据库
router.post('/generate', async (req, res) => {
  const { description, save, searchContext: cachedSearchContext = '' } = req.body;
  const shouldSave = save !== false; // 默认 true，显式传 false 才跳过入库
  if (!description || typeof description !== 'string' || description.trim().length < 2) {
    return res.status(400).json({ error: 'description 太短，至少需要角色名称' });
  }
  if (typeof cachedSearchContext !== 'string') {
    return res.status(400).json({ error: 'searchContext 必须是字符串' });
  }

  try {
    const { displayName, charName, emotionBaseline, basePrompt, searchFound, searchContext } = await runPersonaGeneration({
      description,
      cachedSearchContext,
    });

    const db = getDb();

    if (shouldSave) {
      // 直接写入数据库
      const insertResult = db.prepare(
        `INSERT INTO characters (name, display_name, base_prompt, short_prompt, emotion_baseline, moments_disabled) VALUES (?, ?, ?, ?, ?, 0)`
      ).run(charName, displayName, basePrompt, cropPersonalityForEmotion(basePrompt, displayName), emotionBaseline);

      const generatedCharId = insertResult.lastInsertRowid;

      console.log(`[characters] AI-generated: "${displayName}" (${charName}) — saved`);

      // 异步选择手写字体
      assignFontForNewCharacter(generatedCharId, basePrompt).catch(err =>
        console.warn(`[characters] font assignment failed for "${displayName}":`, err.message)
      );

      res.status(201).json({
        id: generatedCharId,
        name: charName,
        display_name: displayName,
        base_prompt: basePrompt,
        emotion_baseline: emotionBaseline,
        search_found: searchFound,
        search_context: searchContext,
      });
      refreshCharSearch();

      // 异步优化 short_prompt（不阻塞响应）
      setImmediate(async () => {
        try {
          const optimized = await generateShortPromptWithLLM(basePrompt, displayName, charName);
          db.prepare('UPDATE characters SET short_prompt = ? WHERE id = ?').run(optimized, generatedCharId);
          console.log(`[characters] short_prompt LLM-optimized for "${displayName}" (id=${generatedCharId})`);
          runShortPromptMigration();
        } catch (err) {
          console.warn(`[characters] short_prompt LLM optimization failed for "${displayName}":`, err.message);
        }
      });

      // 异步生成日程
      if (config.features.schedule !== false) {
        setTimeout(async () => {
          try {
            const char = db.prepare('SELECT id, display_name, base_prompt FROM characters WHERE id = ?').get(generatedCharId);
            if (char) {
              await generateSchedule(char);
              assignNextRefreshTime(generatedCharId);
              snapshotTodaySchedule(generatedCharId);
              syncSleepingState(generatedCharId);
              invalidateScheduleCache(generatedCharId);
              console.log(`[characters] Schedule generated for AI character "${displayName}"`);
            }
          } catch (err) {
            console.error(`[characters] Schedule generation failed for "${displayName}":`, err.message);
          }
        }, 3000).unref();
      }
    } else {
      // 预览模式：不入库，返回生成数据
      console.log(`[characters] AI-generated preview: "${displayName}" (${charName}) — not saved`);
      res.json({
        name: charName,
        display_name: displayName,
        base_prompt: basePrompt,
        emotion_baseline: emotionBaseline,
        search_found: searchFound,
        search_context: searchContext,
      });
    }
  } catch (err) {
    console.error('[characters] generate failed:', err.message);
    res.status(500).json({ error: '生成失败: ' + err.message });
  }
});

// ── 酒馆角色卡导入 ──────────────────────────────────────────
// 从 PNG 文件中提取 chara 文本块（tEXt / zTXt / iTXt），返回角色卡 JSON 对象
function extractCardFromPng(buffer) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIG)) {
    throw new Error('不是有效的 PNG 文件');
  }
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) break;
    const chunk = buffer.subarray(dataStart, dataEnd);

    if (type === 'tEXt' || type === 'zTXt') {
      const nul = chunk.indexOf(0);
      if (nul !== -1) {
        const keyword = chunk.subarray(0, nul).toString('latin1');
        if (keyword === 'chara') {
          let text;
          if (type === 'tEXt') {
            text = chunk.subarray(nul + 1).toString('latin1');
          } else {
            // zTXt：1 字节压缩方式（0=zlib），其后为压缩数据
            const compMethod = chunk[nul + 1];
            if (compMethod !== 0) throw new Error('不支持的 zTXt 压缩方式');
            text = zlib.inflateSync(chunk.subarray(nul + 2)).toString('latin1');
          }
          // chara 文本为 base64 编码的 JSON
          return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
        }
      }
    } else if (type === 'iTXt') {
      const nul = chunk.indexOf(0);
      if (nul !== -1) {
        const keyword = chunk.subarray(0, nul).toString('utf8');
        if (keyword === 'chara') {
          let rest = chunk.subarray(nul + 1);
          const compFlag = rest[0];
          rest = rest.subarray(2); // 跳过压缩标志 + 压缩方式
          const nul2 = rest.indexOf(0); // 语言标签结尾
          if (nul2 !== -1) {
            rest = rest.subarray(nul2 + 1);
            const nul3 = rest.indexOf(0); // 翻译关键词结尾
            if (nul3 !== -1) {
              let textBytes = rest.subarray(nul3 + 1);
              if (compFlag === 1) textBytes = zlib.inflateSync(textBytes);
              return JSON.parse(textBytes.toString('utf8'));
            }
          }
        }
      }
    }
    offset = dataEnd + 4; // 跳过 CRC
  }
  throw new Error('PNG 中未找到角色卡数据（chara 文本块）');
}

// 把酒馆角色卡（V1 顶层字段 / V2 data 字段）的全部数据整理成供人格生成器消化的原始资料文本
function cardToContextText(card) {
  const src = (card && card.data && typeof card.data === 'object') ? card.data : card;
  if (!src || typeof src !== 'object') throw new Error('角色卡格式无效');
  const out = [];
  const push = (label, v) => {
    if (v != null && String(v).trim()) out.push(`【${label}】\n${String(v).trim()}`);
  };
  push('名称', src.name || (card && card.name));
  push('描述/设定', src.description);
  push('性格', src.personality);
  push('情境', src.scenario);
  push('开场白', src.first_mes);
  push('对话示例', src.mes_example);
  push('创作者备注', src.creator_notes);
  push('系统提示词', src.system_prompt);
  push('后记/附言', src.post_history_instructions);
  if (Array.isArray(src.tags) && src.tags.length) {
    push('标签', src.tags.map(t => String(t)).filter(Boolean).join('、'));
  }
  if (Array.isArray(src.alternate_greetings) && src.alternate_greetings.length) {
    out.push(`【备用开场白】\n${src.alternate_greetings.map((g, i) => `#${i + 1}:\n${String(g).trim()}`).join('\n\n')}`);
  }
  push('创造者', src.creator);
  push('角色版本', src.character_version);
  return out.join('\n\n');
}

// POST /api/characters/import-card — 导入酒馆角色卡（PNG 内嵌 chara 块 / JSON 卡）
// 解析后把角色卡全部资料交给邻舍自己的人格生成器整理一遍，返回预览数据（不入库，由前端确认招募）
// Body: { data: <base64 或 dataURL>, mimetype?, filename? }
router.post('/import-card', async (req, res) => {
  try {
    const { data, mimetype, filename } = req.body;
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: '缺少文件数据' });
    }
    const base64 = data.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) return res.status(400).json({ error: '文件为空' });

    const looksJson = (mimetype && mimetype.includes('json'))
      || (filename && /\.json$/i.test(filename))
      || buf[0] === 0x7B; // '{'

    let card;
    if (looksJson) {
      try {
        card = JSON.parse(buf.toString('utf8'));
      } catch {
        return res.status(400).json({ error: '角色卡 JSON 解析失败：文件不是有效的角色卡 JSON' });
      }
    } else {
      card = extractCardFromPng(buf);
    }

    const src = (card && card.data && typeof card.data === 'object') ? card.data : card;
    const cardName = String(src.name || (card && card.name) || '').trim();
    if (!cardName) return res.status(400).json({ error: '角色卡缺少 name 字段' });

    const extraContext = cardToContextText(card);
    console.log(`[characters] importing card "${cardName}" (${extraContext.length} chars) → persona generator`);

    // 用邻舍自己的人格生成器整理一遍：角色卡全文作为第一手资料，联网搜索作为补充
    const { displayName, charName, emotionBaseline, basePrompt, searchFound } = await runPersonaGeneration({
      description: cardName,
      extraContext,
      extraContextLabel: '角色卡',
      skipWebSearch: true,
    });

    console.log(`[characters] card organized by generator: "${displayName}" (${charName}) — not saved`);
    res.json({
      name: charName,
      display_name: displayName,
      base_prompt: basePrompt,
      emotion_baseline: emotionBaseline,
      search_found: searchFound,
      source: 'card',
    });
  } catch (err) {
    console.error('[characters] import-card failed:', err.message);
    const isClientError = /角色卡|PNG|JSON|name 字段|格式|文件/.test(err.message);
    res.status(isClientError ? 400 : 500).json({ error: '角色卡导入失败: ' + err.message });
  }
});

// POST /api/characters/:id/gift — 向角色赠送礼物
// Body: { giftType: 'small' | 'large' | 'ring', giftLine?: string }
router.post('/:id/gift', async (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const { giftType, giftLine = '' } = req.body;
  if (!['small', 'large', 'ring'].includes(giftType)) {
    return res.status(400).json({ error: 'giftType must be "small", "large" or "ring"' });
  }
  if (typeof giftLine !== 'string') {
    return res.status(400).json({ error: 'giftLine must be a string' });
  }
  const normalizedGiftLine = giftLine.trim();
  if (normalizedGiftLine.length > 120) {
    return res.status(400).json({ error: '送出台词不能超过 120 个字符' });
  }

  try {
    const userName = config.user.nickname || '你';
    const result = await giveGift(char.id, giftType, char, userName, normalizedGiftLine);

    if (!result.success) {
      return res.status(409).json({
        error: result.message,
        cooldownRemaining: result.cooldownRemaining,
        cooldowns: getGiftCooldowns(),
      });
    }

    // 先写入文字消息，异步生图完成后补图片
    const conversationId = `char_${char.id}`;
    let userMsgId = null;
    if (normalizedGiftLine) {
      const userRawResult = db.prepare(
        `INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'user', ?)`
      ).run(conversationId, normalizedGiftLine);
      const userMsgResult = db.prepare(
        `INSERT INTO messages (conversation_id, raw_id, role, content, images, seq) VALUES (?, ?, 'user', ?, NULL, 0)`
      ).run(conversationId, userRawResult.lastInsertRowid, normalizedGiftLine);
      userMsgId = userMsgResult.lastInsertRowid;
    }
    const rawResult = db.prepare(
      `INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`
    ).run(conversationId, result.reaction);
    const msgResult = db.prepare(
      `INSERT INTO messages (conversation_id, raw_id, role, content, images, seq) VALUES (?, ?, 'assistant', ?, NULL, 0)`
    ).run(conversationId, rawResult.lastInsertRowid, result.reaction);
    const msgId = msgResult.lastInsertRowid;

    // 异步生图：不阻塞响应，完成后补图片到消息气泡
    if (result.imagePrompt) {
      const giftArtist = charArtistOverride(char);
      generateImage(result.imagePrompt, {
        promptScene: 'gift',
        disableRAG: true,
        ragTimeoutMs: RAG_TIMEOUT_FAST_MS,
        loras: _parseCharLoras(char.loras),
        ...(char.custom_workflow ? { customWorkflow: char.custom_workflow } : {}),
        ...(giftArtist !== null ? { artist: giftArtist } : {}),
        onProgress: (p) => {
          console.log(`[gift] image gen progress for ${char.display_name}:`, p.stage || p);
        }
      }).then(imgResult => {
        if (imgResult.success && imgResult.images.length > 0) {
          const img = imgResult.images[0];
          const filename = `gift_${Date.now()}_${img.filename || 'comfy.png'}`;
          const imageUrl = saveBase64Image('gifts', filename, img.base64);
          db.prepare(`INSERT INTO image_tasks (conversation_id, prompt_original, prompt_refined, status, output_paths, workflow_template, finished_at)
            VALUES (?, ?, ?, 'done', ?, ?, datetime('now'))`)
            .run(conversationId, result.imagePrompt, imgResult.promptRefined || result.imagePrompt, JSON.stringify([imageUrl]), getLastWorkflowMode());
          db.prepare(`UPDATE messages SET images = ? WHERE id = ?`)
            .run(JSON.stringify([imageUrl]), msgId);
          console.log(`[gift] image attached to msg #${msgId}: ${imageUrl}`);
        }
      }).catch(err => {
        console.error(`[gift] image gen failed for ${char.display_name}:`, err.message);
      });
    }

    // 保存情绪快照：让切角色后仍能恢复送礼的好感度和 reason
    const emotionBaseline = JSON.parse(char.emotion_baseline || '{"valence":0.5,"arousal":0.5,"dominance":0.5}');
    const emotionState = loadEmotionState(conversationId, emotionBaseline);
    const reasonMap = { small: '收到了一份小礼物', large: '收到了一份精心准备的礼物', ring: '这份心意，比想象中更让我开心……我会记住这一刻。' };
    saveEmotionSnapshot(conversationId, msgId, emotionState, 'joy', result.newAffinity, result.affinityDelta, reasonMap[giftType] || '收到了一份礼物');

    res.json({
      success: true,
      affinityDelta: result.affinityDelta,
      affinity: result.newAffinity,
      reaction: result.reaction,
      giftLine: normalizedGiftLine || null,
      userMsgId,
      msgId,
      cooldowns: getGiftCooldowns(),
      is_oath: giftType === 'ring' ? 1 : loadOath(char.id),
    });
  } catch (err) {
    console.error('[characters] gift failed:', err.message);
    res.status(500).json({ error: '送礼失败: ' + err.message });
  }
});

// DELETE /api/gift/cooldowns — 重置送礼冷却（临时调试用；chest 冷却同表，不在清理范围）
router.delete('/gift/cooldowns', (_req, res) => {
  const db = getDb();
  db.prepare(`DELETE FROM gift_history WHERE gift_type != 'chest'`).run();
  console.log('[gift] cooldown reset (global)');
  res.json({ ok: true, cooldowns: { small: 0, large: 0 } });
});

// GET /api/gift/cooldowns — 查询送礼冷却状态
router.get('/gift/cooldowns', (_req, res) => {
  res.json({ cooldowns: getGiftCooldowns() });
});

// DELETE /api/characters/:id/oath — 解除誓约关系
router.delete('/:id/oath', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id, display_name FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const oath = loadOath(char.id);
  if (!oath) {
    return res.status(409).json({ error: '该角色未缔结誓约' });
  }

  setOath(char.id, 0);
  console.log(`[oath] Oath removed for character ${char.display_name} (id=${char.id})`);
  res.json({ ok: true, is_oath: 0 });
});

// GET /api/characters/:id/oath — 查询誓约状态
router.get('/:id/oath', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const isOath = loadOath(char.id);
  const canSend = canSendRing(char.id);
  res.json({ is_oath: isOath, affinity: loadAffinity(char.id), canSendRing: canSend.canSend, reason: canSend.reason || null });
});

// POST /api/characters/:id/generate-avatar — AI 生成角色头像（脸部特写，表情跟随人格）
router.post('/:id/generate-avatar', async (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const imagePromptRule = getGlobalRule('image_prompt');
  const imageRuleContent = imagePromptRule?.rule_content || '';

  const systemPrompt = `你是专业的角色头像生成提示词助手。根据角色的人格设定，生成一张脸部特写头像的画面描述。

${imageRuleContent ? `【画面描述要求】\n${imageRuleContent}\n` : ''}

【头像生成额外要求】
- 画面内容必须是脸部特写（close-up portrait, face focus）
- 完全正面拍照，正常细节不用强调超清细节
- 光照必须完全平面、均匀（flat lighting, even lighting），不要在 prompt 中写 soft lighting / warm lighting 等任何光照描述。目标是无阴影、无高光的平面照明效果
- 完全脸部特写，重点在面部、发型、眼睛和表情
- 白色背景（simple background）
- 直接输出英文画面描述，不要任何格式包装或额外文字`;

const userMsg = `请根据以下角色设定，生成一张脸部特写头像的画面描述：

---角色设定---
${buildCharacterPersona(char, { variant: 'full', outfitScene: 'base' })}
---

要求：脸部特写，表情跟随人格但是表情幅度很小。`;

  try {
    const model = config.llm.model || 'deepseek-chat';
    console.log(`[generate-avatar] Step 1/2: generating prompt for character "${char.display_name}"...`);

    const llmResult = await chatSync([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ], { model, temperature: 0.6, max_tokens: 1024, label: '生成头像提示词' });

    // 提取 prompt：纯文本优先，JSON 格式向后兼容
    let promptText;
    let text = llmResult.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (text.length >= 5) {
      promptText = text;
    }
    // 兜底：如果 LLM 仍输出了 {"prompt":"..."} JSON 格式
    if (!promptText) {
      const jsonMatch = llmResult.match(/\{[\s\S]*"prompt"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          promptText = parsed.prompt;
        } catch {
          promptText = llmResult.trim();
        }
      } else {
        promptText = llmResult.trim();
      }
    }

    if (!promptText || promptText.length < 10) {
      return res.status(500).json({ error: 'LLM 生成的提示词不完整，请重试' });
    }

    // 去除 LLM 可能误输出的光照标签，替换为平面照明
    const lightingTerms = /\b(soft (lighting|light)|warm lighting|dramatic lighting|sunlight|moonlight|rim light|backlight|backlighting|volumetric lighting|lens flare|ray tracing|subsurface scattering)\b\s*,?\s*/gi;
    promptText = promptText.replace(lightingTerms, '');
    promptText = promptText.replace(/,\s*,/g, ',').replace(/^,\s*/, '').replace(/,\s*$/, '');
    if (!/\bflat lighting\b/i.test(promptText)) {
      promptText += ', flat lighting, even lighting, no shadows, front-lit';
    }

    console.log(`[generate-avatar] Prompt generated (${promptText.length} chars): "${promptText.slice(0, 80)}..."`);

    // Step 2: 调用 ComfyUI 生图（1024x1024）
    console.log(`[generate-avatar] Step 2/2: generating image at 1024x1024...`);
    const charLoras = _parseCharLoras(char.loras);
    const avatarArtist = charArtistOverride(char);
    const result = await generateImageRaw(promptText, {
      promptScene: 'avatar',
      disableRAG: true,
      ragTimeoutMs: RAG_TIMEOUT_FAST_MS,
      artist: avatarArtist !== null ? avatarArtist : config.comfyui.momentsArtist,
      width: 768,
      height: 768,
      loras: charLoras.length > 0 ? charLoras : undefined,
      ...(char.custom_workflow ? { customWorkflow: char.custom_workflow } : {}),
      onProgress: (p) => {
        if (p.stage) console.log(`[generate-avatar] ComfyUI: ${p.stage}`);
      },
    });

    if (result.success && result.images.length > 0) {
      const savedPaths = [];
      for (const img of result.images) {
        const ts = Date.now();
        const filename = `avatar_gen_${req.params.id}_${ts}_${img.filename || 'comfy.png'}`;
        const url = saveBase64Image('avatargen', filename, img.base64);
        savedPaths.push(url);
        img.url = url;
      }

      console.log(`[generate-avatar] Image saved to ${savedPaths.length} file(s): ${savedPaths.join(', ')}`);

      db.prepare(`INSERT INTO image_tasks (conversation_id, prompt_original, prompt_refined, status, output_paths, workflow_template, finished_at)
        VALUES (?, ?, ?, 'done', ?, ?, datetime('now'))`)
        .run(`char_${char.id}_avatar`, promptText, result.promptRefined || promptText, JSON.stringify(savedPaths), getLastWorkflowMode());

      // 使相册缓存失效
      invalidateGalleryCache();

      res.json({
        success: true,
        images: result.images,
        savedPaths,
        promptId: result.promptId,
        promptText,
      });
    } else {
      res.status(500).json({ error: result.error || '图像生成失败，请重试' });
    }
  } catch (err) {
    console.error('[generate-avatar] error:', err.message);
    res.status(500).json({ error: '生成失败: ' + err.message });
  }
});

// 对话背景（上游 v3.9.0 合并）：/chat-bg 与 /generate-chat-bg 收口到工厂路由。
// 工厂版向后兼容本地旧调用（target 缺省 = chat，空 base64 = 恢复默认），并新增
// galgame 槽位、上传格式校验、409 并发保护与 image_tasks 登记。
router.use(createCharacterBackgroundRouter({ getDb, saveBase64Image, deleteImageFileByUrl, invalidateGalleryCache, generateBackground: generateDialogueBackground }));

// ── 角色立绘（纯白背景全身立绘，1:2，人设卡 short_prompt + 外观注入） ──

/**
 * 组装立绘生成的多层 system 消息（对齐全库规范，同 itemService/libraryGenerator）：
 *   system0 = 破甲词 + 世界观（有世界观时拼接，否则仅破甲词，创作流程不带 roleplay）
 *   system1 = 立绘设计师角色（普通 / 张力！两档，STANDING_ROLE_PROMPTS 按 mode 取词）
 *   system2 = 立绘专用生图规则（只约束 IP 角色格式和英文 prompt 格式）
 *   system3 = 角色 short_prompt + 外观段（buildCharacterPersona short variant，「你」→角色名）
 * @param {object} char
 * @param {string} requirement - 用户额外立绘需求（可空）
 * @param {'normal'|'dynamic'} [mode='normal'] - 姿势风格档位
 */
function buildStandingMessages(char, requirement, mode = 'normal') {
  const worldSetting = getWorldSetting();
  const msgs = [
    { role: 'system', content: worldSetting
      ? getSystemRulesWithWorld({ roleplay: false })
      : getSystemRules({ roleplay: false }) },
    {
      role: 'system',
      content: STANDING_ROLE_PROMPTS[mode] || STANDING_ROLE_PROMPTS.normal,
    },
  ];
  if (worldSetting) msgs.push({ role: 'system', content: getWorldIntegrationRule('interaction') });
  msgs.push({ role: 'system', content: STANDING_IMAGE_PROMPT_RULE.rule_content });
  msgs.push({
    role: 'system',
    content: `【角色外观信息】\n${buildCharacterPersona(char, { variant: 'short', person: char.display_name })}`,
  });
  msgs.push({
    role: 'user',
    content: requirement
      ? `特别强调：用户指定了额外需求——“${requirement}”。请在<world_setting>下，结合用户需求，以用户需求为最高优先级，其他设计都需要先满足用户需求（与纯白背景、单人立绘、1:2 竖幅这些硬性要求不冲突的前提下），设计角色立绘并且以英文prompt输出。`
      : `请在<world_setting>下设计角色立绘并且以英文prompt输出，自由发挥立绘的姿势与镜头角度，充分展现角色的魅力。`,
  });
  return msgs;
}

// POST /api/characters/:id/generate-standing — 生成角色立绘（LLM 出英文 prompt → ComfyUI 1:2 出图）
router.post('/:id/generate-standing', async (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const requirement = typeof req.body?.requirement === 'string' ? req.body.requirement.trim().slice(0, 500) : '';
  const mode = getSetting(STANDING_MODE_KEY) === 'dynamic' ? 'dynamic' : 'normal';

  try {
    const model = config.llm.model || 'deepseek-chat';
    console.log(`[generate-standing] Step 1/2: generating prompt for character "${char.display_name}" (mode: ${mode})${requirement ? ` (requirement: ${requirement.slice(0, 50)})` : ''}...`);

    const llmResult = await chatSync(buildStandingMessages(char, requirement, mode), {
      model,
      temperature: 0.7,
      max_tokens: 1024,
      label: '生成立绘提示词',
    });

    // 提取 prompt：剥掉代码围栏与引号包装，只留英文 prompt 正文
    const promptText = llmResult.trim()
      .replace(/^```(?:[a-z]+)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();

    if (!promptText || promptText.length < 10) {
      return res.status(500).json({ error: 'LLM 生成的提示词不完整，请重试' });
    }

    console.log(`[generate-standing] Prompt generated (${promptText.length} chars): "${promptText.slice(0, 80)}..."`);

    const url = await renderStandingImage(char, promptText);
    res.json({ ok: true, standing_url: url, promptText });
  } catch (err) {
    console.error('[generate-standing] error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : '生成失败: ' + err.message });
  }
});

/**
 * 立绘出图：朋友圈画师串口径（角色单独画师串优先），固定 1:2 竖幅 768x1536。
 * 只写暂存文件，不落库；落库由 commitStandingImage 或确认覆盖时执行。
 * @returns {Promise<{filename: string, promptRefined: string, sourceFilename: string}>}
 */
async function runStandingGeneration(char, promptText, { stageBase, onProgress }) {
  // 出图：朋友圈画师串口径（角色单独画师串优先），固定 1:2 竖幅 768x1536
  console.log(`[generate-standing] Step 2/2: generating image at 768x1536...`);
  const charLoras = _parseCharLoras(char.loras);
  const standingArtist = charArtistOverride(char);
  let lastStage = '';
  const result = await generateImageRaw(promptText, {
    // 立绘：全局 LoRA 按立绘场景过滤；工作流选择保持原样（不按场景走，沿用上次模式）
    scene: 'portrait',
    workflowScene: null,
    promptScene: 'avatar',
    priority: 'high',
    disableRAG: true,
    ragTimeoutMs: RAG_TIMEOUT_FAST_MS,
    artist: standingArtist !== null ? standingArtist : config.comfyui.momentsArtist,
    width: 768,
    height: 1536,
    loras: charLoras.length > 0 ? charLoras : undefined,
    ...(char.custom_workflow ? { customWorkflow: char.custom_workflow } : {}),
    onProgress: (p) => {
      // stage 只在切换时打印：WS 采样进度消息很密，逐条打印会刷屏
      if (p.stage && p.stage !== lastStage) {
        lastStage = p.stage;
        console.log(`[generate-standing] ComfyUI: ${p.stage}`);
      }
      if (onProgress) onProgress(p);
    },
  });

  if (!result.success || result.images.length === 0) {
    throw Object.assign(new Error(result.error || '图像生成失败，请重试'), { statusCode: 500 });
  }

  const img = result.images[0];
  const ext = dataUriExt(img.base64);
  fs.writeFileSync(stageBase + ext, Buffer.from(img.base64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  return {
    filename: path.basename(stageBase) + ext,
    promptRefined: result.promptRefined || promptText,
    sourceFilename: img.filename || 'comfy.png',
  };
}

/**
 * 确认落库：删旧立绘 → 暂存文件转正 → 更新 characters.standing_url → 记 image_tasks。
 * @returns {string} standing_url
 */
function commitStandingImage({ characterId, pendingPath, promptText, promptRefined, sourceFilename }) {
  // 旧立绘文件先清掉，再保存新图
  const db = getDb();
  const old = db.prepare('SELECT standing_url FROM characters WHERE id = ?').get(characterId);
  if (old?.standing_url) deleteImageFileByUrl(old.standing_url);

  const filename = `standing_${characterId}_${Date.now()}_${sourceFilename || 'comfy.png'}`;
  const destPath = path.join(getImageDir('standing'), filename);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.renameSync(pendingPath, destPath);
  const url = buildImageUrl('standing', filename);

  db.prepare('UPDATE characters SET standing_url = ?, standing_world_sig = ? WHERE id = ?')
    .run(url, currentWorldSignature(), characterId);

  console.log(`[generate-standing] Image saved: ${url}`);

  db.prepare(`INSERT INTO image_tasks (conversation_id, prompt_original, prompt_refined, status, output_paths, workflow_template, finished_at)
    VALUES (?, ?, ?, 'done', ?, ?, datetime('now'))`)
    .run(`char_${characterId}_standing`, promptText, promptRefined || promptText, JSON.stringify([url]), getLastWorkflowMode());

  invalidateGalleryCache();
  return url;
}

/**
 * 用给定英文 prompt 渲染立绘并直接落库（generate-standing / generate-standing-image 同步入口）。
 * @returns {Promise<string>} standing_url
 */
async function renderStandingImage(char, promptText) {
  const stageBase = path.join(getPendingDir(), `standing-${char.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.dirname(stageBase), { recursive: true });
  const staged = await runStandingGeneration(char, promptText, { stageBase });
  return commitStandingImage({
    characterId: char.id,
    pendingPath: path.join(getPendingDir(), staged.filename),
    promptText,
    promptRefined: staged.promptRefined,
    sourceFilename: staged.sourceFilename,
  });
}

/**
 * 渲染**某套场景服装**的立绘，写进 character_standings（不是 characters.standing_url）。
 *
 * 与 renderStandingImage 的区别：落点是场景立绘表，且 prompt 用「身体 + 该套服装」的
 * 组合文本（outfitScene.composeOutfitText 已算好 `text`）。没配该套服装时退回角色卡原外观。
 * @param {string} [explicitPrompt] 已算好的英文 prompt（「再次 Roll 图」直接复用，跳过组合文本）
 * @returns {Promise<string>} image_url
 */
async function renderSceneStanding(char, scene, composedText, explicitPrompt = '') {
  const promptText = String(explicitPrompt || composedText || '').trim() || String(char.base_prompt || '').trim();
  if (!promptText || promptText.length < 10) {
    throw Object.assign(new Error('该场景还没有可用的外观描述，请先填写'), { statusCode: 400 });
  }
  // 复用同一条出图链（朋友圈画师串口径 → ComfyUI 768x1536 → 图库）
  const stageBase = path.join(getPendingDir(), `scene-${char.id}-${scene}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.dirname(stageBase), { recursive: true });
  const staged = await runStandingGeneration(char, promptText, { stageBase });
  const filename = `scenestanding_${char.id}_${scene}_${Date.now()}_${staged.sourceFilename || 'comfy.png'}`;
  const finalPath = path.join(getImageDir('standing'), filename);
  fs.renameSync(path.join(getPendingDir(), staged.filename), finalPath);
  const url = buildImageUrl('standing', filename);
  const previous = getSceneStandingRow(char.id, scene);
  upsertSceneStanding(char.id, scene, { imageUrl: url, promptText });
  // 换图即清旧文件（上游 v3.10.0 口径）：否则 standing/ 里会堆一堆没人引用的孤儿
  if (previous?.image_url && previous.image_url !== url) {
    try { deleteImageFileByUrl(previous.image_url) } catch { /* 文件不在就当已清 */ }
  }
  getDb().prepare(
    // 列名是 prompt_original（不是 prompt）—— 2026-10-29 真机验收：写成 prompt 会让整条
    // 场景立绘生成在「图已出、落盘已完成」之后抛 500，前端表现为「生成失败」但图其实有了。
    `INSERT INTO image_tasks (conversation_id, prompt_original, prompt_refined, output_paths, status, created_at)
     VALUES (?, ?, ?, ?, 'done', CURRENT_TIMESTAMP)`
  ).run(`char_${char.id}_scene_standing_${scene}`, promptText, staged.promptRefined || promptText, JSON.stringify([url]));
  invalidateGalleryCache();
  console.log(`[scene-standing] ${char.display_name} 的「${scene}」立绘已生成：${url}`);
  return url;
}

// POST /api/characters/:id/generate-standing-image — 用已有英文 prompt 直接重出立绘（不重新请求 LLM）
router.post('/:id/generate-standing-image', async (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const promptText = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!promptText || promptText.length < 10) {
    return res.status(400).json({ error: '缺少有效的立绘提示词，请先生成提示词' });
  }

  try {
    const url = await renderStandingImage(char, promptText);
    res.json({ ok: true, standing_url: url, promptText });
  } catch (err) {
    console.error('[generate-standing-image] error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : '生成失败: ' + err.message });
  }
});

// POST /api/characters/:id/generate-standing-task — 带二次确认的立绘重出（后台出图 → 前后对比 → 确认后才覆盖旧立绘）
// 已有立绘时走这里：body.prompt 有效则直接复用（重新生成），否则用 LLM 出新 prompt
router.post('/:id/generate-standing-task', async (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const requirement = typeof req.body?.requirement === 'string' ? req.body.requirement.trim().slice(0, 500) : '';
  let promptText = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  try {
    if (promptText.length < 10) {
      const mode = getSetting(STANDING_MODE_KEY) === 'dynamic' ? 'dynamic' : 'normal';
      const model = config.llm.model || 'deepseek-chat';
      console.log(`[generate-standing-task] Step 1/2: generating prompt for character "${char.display_name}" (mode: ${mode})${requirement ? ` (requirement: ${requirement.slice(0, 50)})` : ''}...`);

      const llmResult = await chatSync(buildStandingMessages(char, requirement, mode), {
        model,
        temperature: 0.7,
        max_tokens: 1024,
        label: '生成立绘提示词',
      });

      promptText = llmResult.trim()
        .replace(/^```(?:[a-z]+)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim();

      if (!promptText || promptText.length < 10) {
        return res.status(500).json({ error: 'LLM 生成的提示词不完整，请重试' });
      }
      console.log(`[generate-standing-task] Prompt ready (${promptText.length} chars): "${promptText.slice(0, 80)}..."`);
    }

    const beforeUrl = char.standing_url ? String(char.standing_url).replace(/\?.*$/, '') : '';
    // run 与 finalize 共用上下文：promptRefined / sourceFilename 要等出图完成才知道
    const ctx = { characterId: char.id, promptText, promptRefined: null, sourceFilename: 'comfy.png' };

    const buildTask = (text) => startEditTask({
      action: 'standing',
      url: beforeUrl,
      meta: ctx,
      run: async ({ stageBase, onProgress }) => {
        const staged = await runStandingGeneration(char, text, { stageBase, onProgress });
        ctx.promptRefined = staged.promptRefined;
        ctx.sourceFilename = staged.sourceFilename;
        return { filename: staged.filename };
      },
      finalize: (task) => commitStandingImage({
        characterId: task.meta.characterId,
        pendingPath: task.pendingPath,
        promptText: task.meta.promptText,
        promptRefined: ctx.promptRefined,
        sourceFilename: ctx.sourceFilename,
      }),
      restart: () => buildTask(text),
    });

    const task = buildTask(promptText);
    res.status(202).json({ success: true, task_id: task.id, status: 'running', promptText });
  } catch (err) {
    console.error('[generate-standing-task] error:', err.message);
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: status === 500 ? '生成失败: ' + err.message : err.message });
  }
});

// POST /api/characters/:id/standing-upload — 上传本地图片作为立绘（base64 data URL，替换旧立绘并删旧文件）
router.post('/:id/standing-upload', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id, standing_url FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const { base64 } = req.body;
  const mimeMatch = typeof base64 === 'string' && base64.match(/^data:image\/(png|jpeg|webp);base64,/i);
  if (!mimeMatch) {
    return res.status(400).json({ error: '请上传 PNG / JPG / WEBP 图片' });
  }
  // 前端已限 6MB；这里拦一道解码后超限的（base64 约为原大小 4/3）
  if (base64.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: '图片过大，请压缩后再上传（不超过 6MB）' });
  }

  try {
    if (char.standing_url) deleteImageFileByUrl(char.standing_url);
    const ext = mimeMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : mimeMatch[1].toLowerCase();
    const filename = `standing_${char.id}_${Date.now()}_upload.${ext}`;
    const url = saveBase64Image('standing', filename, base64);
    // 用户手动上传的立绘：记当前世界观签名 = "以这张为准"（不该被当成待同步反复提示）
    db.prepare('UPDATE characters SET standing_url = ?, standing_world_sig = ? WHERE id = ?')
      .run(url, currentWorldSignature(), char.id);
    invalidateGalleryCache();
    res.json({ ok: true, standing_url: url });
  } catch (err) {
    console.error('[standing-upload] error:', err.message);
    res.status(500).json({ error: '保存立绘失败: ' + err.message });
  }
});

// DELETE /api/characters/:id/standing — 删除角色立绘（清库 + 删文件）
router.delete('/:id/standing', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT standing_url FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  if (char.standing_url) {
    deleteImageFileByUrl(char.standing_url);
    db.prepare('UPDATE characters SET standing_url = NULL WHERE id = ?').run(req.params.id);
    invalidateGalleryCache();
  }
  res.json({ ok: true });
});

// ── 修正外观（视觉 LLM 分析参考图 → 重写「## 你的外观」）──
// 只做分析不改库：返回新外观段与重组后的整卡 base_prompt，由前端回填人格卡文本框走既有保存链路

const REFINE_APPEARANCE_SYSTEM_PROMPT = `你是角色外观修正助手。用户会提供一张角色参考图和该角色的身份信息，请仔细观察图中角色的外观，输出一段用于 AI 生图的外观描述。

【输出格式（严格遵守）】
输出以「角色名 (作品名)」开头，紧接着以 has ... / wearing ... 续写外观描述，一整段连贯英文。示例：

Cyrene (Honkai: Star Rail) has soft pastel pink hair in a fluffy shoulder-length bob with small white horn-like accessories, bright blue eyes, wearing a white off-shoulder corset-style bodice with intricate gold embroidery, a dark purple open-front coat with wide flowing sleeves featuring gold patterns and white floral accents, a large blue gem centerpiece at the chest connected with golden ornaments, a matching blue gem necklace, and a short white dress underneath.

【示例字段要求】
- 开头固定为「角色名 (作品名)」格式（半角括号，写法与示例一致）：角色名用英文名，作品名用作品的官方英文名，均从用户消息给定的身份信息转换而来，如 宵宫（Yoimiya），来自《原神》→ Yoimiya (Genshin Impact)
- 角色名之后直接以 has ... / wearing ... 续写，不要主语代词（she/he/they），不要再出现中文、「来自」或书名号
- 先写脸与发型（发型、发色、瞳色、五官特征、可选的体型），再写服装与饰品，全部以图中可见内容为准
- 只描述静态外观：不要表情、动作、姿势、场景、背景、画质与镜头描述
- 一段连贯英文，不要换行、不要中文、不要 markdown、列表、引号或任何解释，严格按示例格式输出`;

// POST /api/characters/refine-appearance-draft — 分析参考图并重写外观段
// 整卡文本由请求体传入（可以是待确认的草稿卡，不要求角色已入库）；
// 已入库角色由前端把当前编辑中的 base_prompt 传上来，保证与文本框所见一致。
// Body: { image: <dataURL png/jpeg/webp>, base_prompt, display_name } → { appearance, base_prompt, prompt_before, prompt_after }
router.post('/refine-appearance-draft', async (req, res) => {
  const image = typeof req.body?.image === 'string' ? req.body.image : '';
  const mimeMatch = image.match(/^data:image\/(png|jpeg|webp);base64,/i);
  if (!mimeMatch) {
    return res.status(400).json({ error: '请上传 PNG / JPG / WEBP 图片' });
  }
  // 前端已限 6MB；这里拦一道解码前超限的（base64 约为原大小 4/3，express.json 限 10mb）
  if (image.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: '图片过大，请压缩后再上传（不超过 6MB）' });
  }
  const basePrompt = typeof req.body?.base_prompt === 'string' ? req.body.base_prompt : '';
  if (!basePrompt.trim()) {
    return res.status(400).json({ error: '缺少人格卡内容，无法定位「## 你的外观」段落' });
  }
  const displayName = String(req.body?.display_name || '').trim() || '角色';

  try {
    // 语料只作为身份上下文传给模型（角色名/作品名的出处），由模型自行组织成「角色名 (作品名) has ...」的开头
    const corpus = extractAppearanceIdentityCorpus(basePrompt, displayName);
    const model = config.llm.model || 'deepseek-chat';
    console.log(`[refine-appearance] analyzing reference image for "${displayName}" (corpus: ${corpus.slice(0, 40)}...)`);

    const llmResult = await chatSync([
      // system0 — 破限词（创作自由，无 roleplay），与其他创作流程口径一致
      { role: 'system', content: getSystemRules({ roleplay: false }) },
      { role: 'system', content: REFINE_APPEARANCE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `角色「${displayName}」的参考图如下。角色的身份信息（用于生成开头的「角色名 (作品名)」）：${corpus}` },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ], { model, temperature: 0.3, max_tokens: 1024, label: '修正外观' });

    // 剥掉代码围栏与引号包装，压成单段
    let appearance = llmResult.trim()
      .replace(/^```(?:[a-z]+)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (appearance.length < 20) {
      return res.status(502).json({ error: '邻舍没能从图片中读出足够的外观信息，请换一张更清晰的图片重试' });
    }

    const newBasePrompt = replaceAppearanceSection(basePrompt, appearance);
    console.log(`[refine-appearance] appearance rewritten (${appearance.length} chars) for "${displayName}"`);

    // 附上外观段前后文：结果框可编辑，前端按 before + '## 你的外观\n' + 编辑后正文 + after 自行重组
    const { before, after } = splitAppearanceSection(basePrompt);
    res.json({ ok: true, appearance, base_prompt: newBasePrompt, prompt_before: before, prompt_after: after });
  } catch (err) {
    console.error('[refine-appearance] error:', err.message);
    const status = err?.status || err?.response?.status;
    const rawMsg = String(err?.message || '');
    // 中转站对「模型不支持图片输入」的报错措辞五花八门，常见就是 400/404 且 body 为空，
    // 关键词匹配不到 → 按状态码兜底识别，命中即提示更换视觉模型（原始报错留在括号里便于排查）
    if (status === 400 || status === 404 || /image|vision|multimodal|visual|image_url|content part/i.test(rawMsg)) {
      return res.status(500).json({
        error: `当前配置的 LLM API 不支持图片输入，请在设置中更换支持视觉（图片输入）的模型后重试（上游返回：${rawMsg || status}）`,
      });
    }
    res.status(500).json({ error: '修正外观失败: ' + rawMsg });
  }
});

// ── 修正外观·文字模式（按用户给的文字要点扩写外观描述）──
// 与图片模式并列的第二条入口：不想找参考图时，直接写几个词让邻舍补全细节。
// 文字扩写沿用既有参考图修正的外观描述格式。

const EXPAND_APPEARANCE_SYSTEM_PROMPT = `你是角色外观描述助手。用户会给你一段**简短的文字要点**（可能只是几个词、也可能是一两句），请结合后续提供的角色简述与默认外观，把它**扩写**成一段可直接用于 AI 生图的完整英文外观描述。

【最重要的原则：扩写，不是重写】
- 用户提到的**每一个元素都必须保留**：单品、颜色、材质、纹样、配饰、穿法、赤足与否……一个都不能丢，也不能换成别的东西。
- 你只负责**补全用户没说到的细节**（廓形、面料质感、层次、领口袖口、配饰质感、整体气质）。
- 用户没说的地方你才可以自由发挥；用户说了的地方一律以用户为准。
- 若用户写的是抽象气质（如「想更慵懒一点」），把它翻译成**可见的**服装细节，不要写成情绪或氛围描写。
- 未被用户要求修改的身体特征与标志性特征，沿用默认外观，不臆造缺失的身体特征。私服、居家服、睡衣按本次文字要点重新设计，不照搬默认服装或把与新要求冲突的单品混进来。

【外观描述格式（严格遵守）】
- 以「角色名 (作品名)」开头，紧接着以 has ... / wearing ... 续写外观描述，一整段连贯英文。
- 开头固定为「角色名 (作品名)」格式（半角括号）：角色名用英文名，作品名用作品的官方英文名，从本次给定的身份信息中提取、转换，如 宵宫（Yoimiya），来自《原神》→ Yoimiya (Genshin Impact)。不得照抄示例角色的身份。
- 角色名之后直接以 has ... / wearing ... 续写，不要主语代词（she/he/they），不要再出现中文、「来自」或书名号。
- 不描述五官，如果有必要才去描述发型否则发型不描述。
- 只描述静态外观：不要表情、动作、姿势、场景、背景、画质与镜头描述。
- 描述正文为一段连贯英文，不要换行、不要中文、不要 Markdown、列表、额外引号或任何解释，不附加英文标签串。

【输出示例：只展示格式，不套用示例角色的外观】
Cyrene (Honkai: Star Rail) has soft pastel pink hair in a fluffy shoulder-length bob with small white horn-like accessories, bright blue eyes, wearing a white off-shoulder corset-style bodice with intricate gold embroidery, a dark purple open-front coat with wide flowing sleeves featuring gold patterns and white floral accents, a large blue gem centerpiece at the chest connected with golden ornaments, a matching blue gem necklace, and a short white dress underneath.

【硬性要求】
- **第三人称、只描述静态外观**：除开头的角色姓名与作品名外，不写身份背景、职业、性格、动作、姿势、表情。
- 不要出现场景、背景、道具、光线、画质与镜头描述（那是生图环节另外加的）。
- 严格按示例格式只输出这段英文描述：不要解释、前言后语、引号、Markdown、JSON、标题或换行分点。`;

// POST /api/characters/expand-appearance-draft — 按文字要点扩写外观段
// 与 refine-appearance-draft 同一套「只出草稿不落库」的契约：
// 返回新外观段 + 前后文，由前端回填人格卡文本框走既有保存链路。
// Body: { brief, character_id?, base_prompt, display_name, scene_label } → { appearance, base_prompt, prompt_before, prompt_after }
router.post('/expand-appearance-draft', async (req, res) => {
  const brief = typeof req.body?.brief === 'string' ? req.body.brief.trim() : '';
  if (!brief) {
    return res.status(400).json({ error: '请先写下你想要的服装要点（几个词也可以）' });
  }
  if (brief.length > 2000) {
    return res.status(400).json({ error: '文字要点太长了，请精简到 2000 字以内' });
  }
  const basePrompt = typeof req.body?.base_prompt === 'string' ? req.body.base_prompt : '';
  if (!basePrompt.trim()) {
    return res.status(400).json({ error: '缺少人格卡内容，无法定位外观段落' });
  }
  const displayName = String(req.body?.display_name || '').trim() || '角色';
  const sceneLabel = String(req.body?.scene_label || '').trim();

  try {
    const model = config.llm.model || 'deepseek-chat';
    // 睡衣是唯一「脚上不该有东西」的场景：人睡觉时鞋袜早脱了。
    // 不点明的话模型会顺手写鞋或袜，生图就画出一双鞋 —— 实测 8 套睡衣里有 3 套完全没提脚部。
    const sceneLine = sceneLabel
      ? `这套是「${sceneLabel}」（${sceneLabel === '工装' ? '上班/出勤的常态形象' : sceneLabel === '私服' ? '上街、休闲外出' : sceneLabel === '居家' ? '在家里休息、做家务' : sceneLabel === '睡衣' ? '睡觉时穿的贴身衣物，不要设计成能穿出门的服装' : '该场景'}），整体要符合这个场合。`
        + (sceneLabel === '睡衣' ? '\n★ 睡衣必须**赤脚**：description 里要明确写出 barefoot（赤足）。画面里不要出现任何鞋类或袜类物体（shoes / boots / slippers / heels / socks / stockings），连「床边摆着一双没穿的拖鞋」也不要写——生图模型看到 slippers 就会画出来。' : '')
      : '';
    console.log(`[expand-appearance] expanding ${brief.length} chars for "${displayName}"${sceneLabel ? ` (scene: ${sceneLabel})` : ''}`);

    // basePrompt 可能包含当前私服/居家服/睡衣，只用于结果回填，绝不作为这些场景的生成上下文。
    // 已入库角色读取 short_prompt + 默认外观；未入库招募草稿只有默认外观。
    const characterId = req.body?.character_id;
    let character;
    if (characterId != null) {
      if (!Number.isSafeInteger(Number(characterId)) || Number(characterId) <= 0) {
        return res.status(400).json({ error: '角色 ID 无效' });
      }
      character = getDb().prepare('SELECT id, short_prompt, base_prompt FROM characters WHERE id = ?').get(Number(characterId));
      if (!character) return res.status(404).json({ error: '角色不存在' });
    } else {
      if (['私服', '居家', '居家服', '睡衣'].includes(sceneLabel)) {
        return res.status(400).json({ error: '缺少角色 ID，无法读取默认外观，请重新打开修正外观窗口' });
      }
      character = { base_prompt: basePrompt };
    }
    const corpus = extractAppearanceIdentityCorpus(character.base_prompt, displayName);
    // 【2026-10-18 C4 合并】这里要的是「角色简述」，不是生图人格拼接，所以**优先用库里那份 short_prompt**：
    // 上游 v3.9.1 的契约就是「已入库角色只读 short_prompt + 默认外观，绝不把整卡人格带进来」
    // （见 test/expandAppearanceDraft.test.js 的「不得出现完整人格」断言）。
    // 注意别改用 buildCharacterPersona({variant:'short'})：本地 2026-10-02 起它改成「从 base_prompt 现裁」，
    // 现裁结果会把「## 你的性格」整段一起带出来（那是给生图用的口径），在这个扩写场景属于多余上下文。
    // 只有 short_prompt 为空时才退回现裁（有总比没有好，与 characterPersona 的兜底一致）。
    const shortPrompt = String(character.short_prompt || '').trim();
    // 外观段 = 整卡里「## 你的外观」那一段（splitAppearanceSection 只给前后文，自己切中间）。
    const { before: _personaPart, after: _tailPart } = splitAppearanceSection(character.base_prompt);
    const appearanceOnly = character.base_prompt.slice(_personaPart.length, character.base_prompt.length - _tailPart.length);
    // 【2026-10-18 C4 合并】这里要的是「角色简述 + 默认外观」，不是生图人格拼接。
    // 上游 v3.9.1 的契约（test/expandAppearanceDraft.test.js）：上下文里**必须有** short_prompt 与外观段、
    // **不得**出现完整人格（「## 你的性格」那段）。所以别用 buildCharacterPersona({variant:'short'})：
    // 本地 2026-10-02 起它改成「从 base_prompt 现裁」（那是给生图用的口径），现裁会把「## 你的性格」整段带出来。
    // 没有 short_prompt（未入库招募草稿）时按上游口径退回显示名。
    const persona = [shortPrompt || displayName, appearanceOnly].filter(s => String(s || '').trim()).join('\n');
    const llmResult = await chatSync([
      // 静态前缀在前，角色与场景上下文在后，用户本次要求收尾。
      { role: 'system', content: getSystemRules({ roleplay: false }) },
      { role: 'system', content: EXPAND_APPEARANCE_SYSTEM_PROMPT },
      { role: 'system', content: `【本次角色身份】\n显示名：${displayName}\n姓名与作品信息：${corpus}\n\n【角色简述与默认外观】\n${persona}` },
      ...(sceneLine ? [{ role: 'system', content: `【本套场景约束】\n${sceneLine}` }] : []),
      {
        role: 'user',
        content: `用户想要的外观要点：\n${brief}\n\n请按规定格式输出一段完整外观描述。`,
      },
    ], { model, temperature: 0.75, max_tokens: 1024, label: '外观扩写' });

    // 与图片模式同一套清洗：剥代码围栏与引号，压成单段
    const appearance = String(llmResult || '').trim()
      .replace(/^```(?:[a-z]+)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (appearance.length < 15) {
      return res.status(502).json({ error: '扩写结果太短，可能被模型截断，请重试或把要点写详细一点' });
    }

    const newBasePrompt = replaceAppearanceSection(basePrompt, appearance);
    const { before, after } = splitAppearanceSection(basePrompt);
    console.log(`[expand-appearance] appearance expanded (${brief.length} → ${appearance.length} chars) for "${displayName}"`);
    res.json({ ok: true, appearance, base_prompt: newBasePrompt, prompt_before: before, prompt_after: after });
  } catch (err) {
    console.error('[expand-appearance] error:', err.message);
    res.status(500).json({ error: '外观扩写失败: ' + String(err?.message || err) });
  }
});

function _parseCharLoras(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return [];
}

// ── 场景服装（五态：裸体/常服/私服/居家/睡衣，见 services/outfitScene.js）──
// ⚠ 路由顺序契约：**必须注册在 `/:id/outfits/:outfitId` 之前** ——
//   否则 Express 会把 "scene" 当成 :outfitId 匹配走，PUT outfits/scene 永远进不来
//   （2026-10-14 冒烟实测抓到：saved=undefined，正是参数路由抢跑）。
// 与下面的「角色专属外观」是两条独立通道：那边是道具变身（同时只一套、有 expires_at），
// 这边是日程驱动选装（五套并存、按日程+睡眠硬规则选一套）。

// GET /api/characters/:id/outfit-scenes — 该角色的场景服装（含五态骨架与 body 单一真源）
router.get('/:id/outfit-scenes', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const outfits = listSceneOutfits(char.id);
  // body 单一真源：五套共用一份，取任意一条非空的即可（写入时同步到所有行）
  const body = String(outfits.find(o => String(o.body || '').trim())?.body || '');
  res.json({ ok: true, scenes: OUTFIT_SCENES, body, outfits });
});

// GET /api/characters/:id/outfit-now — 此刻该穿哪套（调试/排查用：source 标 sleep/schedule/fallback）
router.get('/:id/outfit-now', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  res.json({ character_id: char.id, ...(getSceneOutfitForNow(char.id) || { outfit: null, scene: null, source: 'none' }) });
});

// POST /api/characters/:id/outfits/generate — 用 LLM 生成/补全场景外观
// Body: { save?: boolean, scenes?: string[], seeds?: [{scene,name,body,description}], baseAppearance?: string }
//   seeds = **已填好的分项**，作为反推锚点：本次只补未填的（新口径，替代固定「按工装推其余」）
router.post('/:id/outfits/generate', async (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id, display_name, base_prompt, short_prompt FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  try {
    // baseAppearance 是**必需**的（sceneOutfitPrompt 会校验：没有身体基准就无法保证五套是同一个人）。
    // 请求体没带就回落角色卡 base_prompt —— 前端老版本不带这个字段，不能让它们直接 400（2026-10-15）。
    const baseAppearance = String(req.body?.baseAppearance || char.base_prompt || '').trim();
    const outfits = await generateSceneOutfits(char, {
      baseAppearance,
      scenes: req.body?.scenes,
      seeds: req.body?.seeds,
    });
    const saved = req.body?.save === true ? upsertSceneOutfits(char.id, outfits) : null;
    res.json({ ok: true, outfits, saved });
  } catch (err) {
    res.status(400).json({ error: err.message || '外观生成失败' });
  }
});

// PUT /api/characters/:id/outfits/scene — 批量保存场景外观（供界面"编辑后保存"）
// Body: { body?: string, outfits: [{ scene, name, description }] }
//   body = 该角色的身体描述（单一真源，写入时同步到全部行）
router.put('/:id/outfits/scene', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const list = Array.isArray(req.body?.outfits) ? req.body.outfits : null;
  if (!list) return res.status(400).json({ error: 'outfits 必须是数组' });

  // 身体按钮（若前端带了 body 字段就整体写一遍，保证各套一致）
  const body = req.body?.body != null ? String(req.body.body).trim().slice(0, 2000) : null;

  // ⚠ 不再强制 description 非空 —— `nude` 之外也可能有"这套暂时没写衣服"的中间态；
  //   只要求 scene 合法 + name 非空（upsertSceneOutfits 内部还会按 SCENE_KEYS 过滤）
  const clean = list
    .map(o => ({
      scene: String(o?.scene || '').trim(),
      name: String(o?.name || '').trim().slice(0, 60),
      description: String(o?.description || '').trim().slice(0, 1200),
      ...(body != null ? { body } : (o?.body != null ? { body: String(o.body).trim().slice(0, 2000) } : {})),
    }))
    .filter(o => o.scene && o.name);
  if (!clean.length) return res.status(400).json({ error: '没有有效的服装条目' });

  const saved = upsertSceneOutfits(char.id, clean);
  if (body != null) setCharacterBody(char.id, body);
  // 老数据回填：这个角色以前只填了 4 态、没有 body ⇒ 以已填分项为锚反推一份身体真源
  const backfilled = backfillBodyFromExisting(char.id, {
    baseAppearance: String(db.prepare('SELECT base_prompt FROM characters WHERE id = ?').get(char.id)?.base_prompt || ''),
  });
  res.json({ ok: true, saved, backfilled, outfits: listSceneOutfits(char.id) });
});

// ── 场景立绘（五套形象，详情页左右切换；与场景服装是"图"与"文字"两条线）──
//
// **API 与上游 v3.10.0 统一（2026-10-19）**：规范路径是 `/:id/standings…`
//   GET    /:id/standings            五套场景立绘（work 槽以 characters.standing_url 兜底）
//   POST   /:id/standings/generate   生成某场景 Body: { scene, requirement?, prompt? }
//   POST   /:id/standings/upload     上传某场景 Body: { scene, base64 }
//   DELETE /:id/standings/:scene     清掉某场景的**显式**立绘
// 旧的 `/scene-standings…` 三个路径保留为**兼容别名**（同一批 handler），前端已切到新路径。

/** 场景名归一化：不合法返回 ''（调用方统一回 400） */
function normalizeStandingScene(raw) {
  const scene = String(raw || '').trim();
  return STANDING_SCENE_KEYS.includes(scene) ? scene : '';
}

function respondStandingList(res, charId) {
  res.json({ ok: true, scenes: OUTFIT_SCENES, standings: listSceneStandings(charId) });
}

// GET /api/characters/:id/standings
router.get('/:id/standings', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  respondStandingList(res, char.id);
});

/** 生成场景立绘（规范路径与旧路径共用） */
async function generateSceneStanding(req, res) {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const scene = normalizeStandingScene(req.body?.scene ?? req.params?.scene);
  if (!scene) return res.status(400).json({ error: '无效的场景，可选：' + STANDING_SCENE_KEYS.join(' / ') });
  const hit = listSceneOutfits(char.id).find(o => o.scene === scene);
  // 没配该套服装时仍允许出图（用角色卡原外观），但 nude 必须有显式配置才允许
  if (scene === 'nude' && !hit) return res.status(400).json({ error: '还没配置「裸体」这套外观' });
  // prompt 给全了就直接出图（「再次 Roll 图」），否则用该场景的组合文本
  const explicitPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  try {
    const url = await renderSceneStanding(char, scene, hit?.text || '', explicitPrompt);
    res.json({
      ok: true,
      scene,
      image_url: url,
      prompt_text: explicitPrompt,
      standings: listSceneStandings(char.id),
    });
  } catch (err) {
    console.error('[scene-standing] error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : '生成失败: ' + err.message });
  }
}

// POST /api/characters/:id/standings/generate
router.post('/:id/standings/generate', generateSceneStanding);

// POST /api/characters/:id/standings/upload — 上传某场景立绘 Body: { scene, base64 }
router.post('/:id/standings/upload', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const scene = normalizeStandingScene(req.body?.scene);
  if (!scene) return res.status(400).json({ error: '无效的场景，可选：' + STANDING_SCENE_KEYS.join(' / ') });

  const { base64 } = req.body || {};
  const mimeMatch = typeof base64 === 'string' && base64.match(/^data:image\/(png|jpeg|webp);base64,/i);
  if (!mimeMatch) return res.status(400).json({ error: '请上传 PNG / JPG / WEBP 图片' });
  if (base64.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: '图片过大，请压缩后再上传（不超过 6MB）' });
  }

  try {
    const previous = getSceneStandingRow(char.id, scene);
    const ext = mimeMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : mimeMatch[1].toLowerCase();
    const url = saveBase64Image('standing', `standing_${char.id}_${scene}_${Date.now()}_upload.${ext}`, base64);
    upsertSceneStanding(char.id, scene, { imageUrl: url, promptText: previous?.prompt_text || '' });
    if (previous?.image_url && previous.image_url !== url) {
      try { deleteImageFileByUrl(previous.image_url) } catch { /* 文件不在就当已清 */ }
    }
    invalidateGalleryCache();
    res.json({ ok: true, scene, image_url: url, standings: listSceneStandings(char.id) });
  } catch (err) {
    console.error('[scene-standing-upload] error:', err.message);
    res.status(500).json({ error: '保存立绘失败: ' + err.message });
  }
});

/** 删除某场景的显式立绘（规范路径与旧路径共用） */
function deleteSceneStandingRoute(req, res) {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  const scene = normalizeStandingScene(req.params.scene);
  if (!scene) return res.status(400).json({ error: '未知的场景' });
  const row = getSceneStandingRow(char.id, scene);
  if (row?.image_url) { try { deleteImageFileByUrl(row.image_url); } catch { /* ignore */ } }
  deleteSceneStanding(char.id, scene);
  invalidateGalleryCache();
  res.json({ ok: true, scene, standings: listSceneStandings(char.id) });
}

// DELETE /api/characters/:id/standings/:scene
router.delete('/:id/standings/:scene', deleteSceneStandingRoute);

// ── 兼容别名：旧 `/scene-standings…`（前端已切新路径，保留给旧缓存包/脚本）──
router.get('/:id/scene-standings', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  respondStandingList(res, char.id);
});
router.post('/:id/scene-standings/:scene/generate', (req, res) => {
  req.body = { ...(req.body || {}), scene: req.params.scene };
  return generateSceneStanding(req, res);
});
router.delete('/:id/scene-standings/:scene', deleteSceneStandingRoute);

// ── 角色专属外观/形态（角色外观系统，生图注入见 services/characterPersona.js）──

// GET /api/characters/:id/outfits — 列出角色全部专属外观
router.get('/:id/outfits', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });
  res.json(listCharacterOutfits(char.id));
});

// POST /api/characters/:id/outfits — 新增专属外观 Body: { name, description }
router.post('/:id/outfits', (req, res) => {
  const db = getDb();
  const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(req.params.id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  if (!name) return res.status(400).json({ error: '外观名称不能为空' });
  if (!description) return res.status(400).json({ error: '外观描述不能为空' });
  if (name.length > 60 || description.length > 2000) {
    return res.status(400).json({ error: '名称不能超过 60 字，描述不能超过 2000 字' });
  }
  const outfit = createCharacterOutfit(char.id, { name, description });
  res.status(201).json(outfit);
});

// PUT /api/characters/:id/outfits/:outfitId — 更新专属外观 Body: { name?, description?, enabled? }
// enabled 置 1 时同角色其余外观自动取消启用（每角色同时只启用一套）
router.put('/:id/outfits/:outfitId', (req, res) => {
  const { name, description, enabled } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: '外观名称不能为空' });
  if (description !== undefined && !String(description).trim()) return res.status(400).json({ error: '外观描述不能为空' });
  const outfit = updateCharacterOutfit(req.params.id, req.params.outfitId, { name, description, enabled });
  if (!outfit) return res.status(404).json({ error: 'Outfit not found' });
  res.json(outfit);
});

// DELETE /api/characters/:id/outfits/:outfitId — 删除专属外观
router.delete('/:id/outfits/:outfitId', (req, res) => {
  const removed = deleteCharacterOutfit(req.params.id, req.params.outfitId);
  if (!removed) return res.status(404).json({ error: 'Outfit not found' });
  res.json({ success: true });
});

export default router;
