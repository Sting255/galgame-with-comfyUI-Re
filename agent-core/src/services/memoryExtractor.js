import { getDb } from '../db/index.js';
import { chatSync } from '../llm/llm-client.js';
import { hybridSearch } from './memorySearch.js';
import { applyMemoryActions, getCheckpoint, setCheckpoint, validateMemoryAction } from './memory/memoryRepository.js';
import { isMemoryV3Enabled } from './memory/memoryConfig.js';
// 灵魂引擎（上游 v3.9.0 合并）：ImpressionDepth → curation 条数上限
import { soulCurationLimit } from './soulEngine.js';
import { buildAnalysisUserContent, buildChatLogLines, buildSharedAnalysisSystemPrompt, wrapChatLogBlock } from './chatLogPrompt.js';
// 待整理消息的时间戳是后端无时区 UTC 串 ⇒ 一律走收口解析（本仓铁律 2：不许绕过 parseSqlUtc）
import { parseSqlUtc } from './programTime.js';

const conversationQueues = new Map();
export const CURATE_EVERY_N_MESSAGES = 20; // 每 20 句整理一次长期记忆（2026-10-31 从 40 下调：让它更早进向量，原文窗口就能压短）

/**
 * 整理点的第二条触发条件（2026-10-17 新增，修「整理点停滞」）
 *
 * ## 修的是什么
 *
 * 原来只有一条触发条件：待整理消息 **≥ 40 条**。不足 40 条时 `curateNow` 直接提前返回、
 * **checkpoint 原地不动**（状态仍是 idle、不报错），于是：
 *   · 慢速会话（一天几句）的整理点可以**长期趴着不动**，记忆一直滞后；
 *   · 会话在攒够 40 条之前就停了的话，那段尾巴**永远不会被整理** ⇒ 记忆永久缺失。
 * 这在旧口径下还会把摘要窗口撑爆（`docs/memory-upgrade-progress.md` §「摘要窗口回退」实测
 * `group_2` 摘要点 6912 / 整理点 5677，一次摘要吞掉 1000+ 原始 id、24480 token）。
 * 摘要窗口已改成与整理互相独立，危害解除，但**整理点本身仍在停滞** —— 本条修它。
 *
 * ## 口径：攒够 **或** 积压超时都整理
 *
 *   · 待整理 ≥ `CURATE_EVERY_N_MESSAGES`(40) ⇒ 立刻整理（原行为，不变）；
 *   · 否则若「最老的一条待整理消息已积压 ≥ `CURATE_MAX_PENDING_MINUTES`」**且**
 *     待整理条数 ≥ `CURATE_MIN_PENDING_MESSAGES` ⇒ 也整理。
 *
 * ## 为什么是 6 小时 / 8 条（成本边界，别随手改）
 *
 * `curateNow` 只在**有新的 assistant 回复/群聊轮次**时被调用（`routes/chat.js`、
 * `groupChatEngine`），所以超时路径不会自己空转：
 *   · 活跃会话 40 条很快就攒够 ⇒ 走原路径，**零额外调用**；
 *   · 慢速会话：消息到了先不整理（age 还小），6 小时后再来一条才触发 ⇒ 一天最多多几次调用；
 *   · 8 条下限是防「两三句寒暄搁了 6 小时」也白花一次整理调用（它只会推迟、不会丢数据：
 *     没被整理的窗口下次照样一起进去）。
 *
 * ⚠️ 判定是**纯函数** `decideCuration`，群聊预检（`groupChatEngine.maybeExtractGroupMemory`）
 * 必须共用它 —— 否则群聊会在预检处提前 `break`，永远走不到这里的超时路径（等于没修）。
 */
export const CURATE_MAX_PENDING_MINUTES = 6 * 60;
/** 超时路径的最小条数下限（见上面「为什么是 6 小时 / 8 条」） */
export const CURATE_MIN_PENDING_MESSAGES = 8;

/**
 * 本次要不要真的整理（纯函数，便于测试与群聊预检复用）。
 *
 * @param {object} opts
 * @param {number} opts.count      待整理条数（raw_messages 条数）
 * @param {string} [opts.oldestAt] 最老那条待整理消息的 created_at（后端无时区 UTC 串）
 * @param {number} [opts.now]      当前时刻（毫秒，默认 Date.now()；测试可注入）
 * @returns {{ curate: boolean, reason: 'empty'|'threshold'|'timeout'|'too_few'|'accumulating', ageMinutes: number|null }}
 */
export function decideCuration({ count, oldestAt = null, now = Date.now() } = {}) {
  const n = Number(count) || 0;
  if (n <= 0) return { curate: false, reason: 'empty', ageMinutes: null };
  // 时间戳取不到 / 解析不出来 ⇒ 按"刚积压"算（保守：宁可继续攒，也不因脏数据提前烧一次调用）
  const oldest = oldestAt ? parseSqlUtc(oldestAt) : null;
  const ageMinutes = oldest ? Math.max(0, Math.round((Number(now) - oldest.getTime()) / 60000)) : 0;
  if (n >= CURATE_EVERY_N_MESSAGES) return { curate: true, reason: 'threshold', ageMinutes };
  if (n < CURATE_MIN_PENDING_MESSAGES) return { curate: false, reason: 'too_few', ageMinutes };
  if (ageMinutes >= CURATE_MAX_PENDING_MINUTES) return { curate: true, reason: 'timeout', ageMinutes };
  return { curate: false, reason: 'accumulating', ageMinutes };
}

// 输出预算：v3 一条记忆实测约 250~350 token，旧的 3000 会在写到第 8 条时被 max_tokens 砍断，
// 输出变成半截 JSON（Unterminated string）→ 解析失败 → 整理反复重试、checkpoint 不前进。
const CURATION_MAX_TOKENS = 6000;
/** prompt 里声明的条数必须与 parseMemoryActions 的截断保持一致：模型多写的部分会被静默丢掉 */
export const CURATION_MAX_ACTIONS = 12;
const CURATION_COMPACT_ACTIONS = 4; // 输出被截断后重发时压小的条数
const CURATION_MAIBOT_ACTIONS = 5; // 不落库的 maibot 路径只取判断句，输出预算 1800

/**
 * 本轮 curation 条数上限：灵魂系统开启时由 ImpressionDepth 决定，否则用硬上限。
 * 无论灵魂给多少，都不超过 CURATION_MAX_ACTIONS（输出预算与 slice 都按它对齐）。
 */
function resolveCurationLimit(conversationId) {
  const match = /^char_(\d+)/.exec(String(conversationId || ''));
  if (!match) return CURATION_MAX_ACTIONS;
  const limit = soulCurationLimit(match[1]);
  if (!limit) return CURATION_MAX_ACTIONS;
  return Math.min(CURATION_MAX_ACTIONS, Math.max(1, limit));
}

export function curateChatMemories(options) {
  const key = options.conversationId;
  const previous = conversationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => curateNow(options));
  const tracked = current.finally(() => {
    if (conversationQueues.get(key) === tracked) conversationQueues.delete(key);
  });
  conversationQueues.set(key, tracked);
  return tracked;
}

export function selectMemorySourceRows(db, conversationId, { afterRawId = 0, throughRawId }) {
  return db.prepare(`
    SELECT id, role, content, created_at FROM raw_messages
    WHERE conversation_id = ? AND id > ? AND id <= ?
    ORDER BY id ASC
  `).all(conversationId, afterRawId, throughRawId);
}

async function curateNow({ conversationId, throughRawMsgId, characterName = '', userName = '' }) {
  const db = getDb();
  const checkpoint = getCheckpoint(conversationId);
  if (throughRawMsgId <= checkpoint.last_raw_msg_id) return [];
  const messages = selectMemorySourceRows(db, conversationId, {
    afterRawId: checkpoint.last_raw_msg_id,
    throughRawId: throughRawMsgId,
  });
  if (!messages.some(item => item.role === 'user') || !messages.some(item => item.role === 'assistant')) return [];
  // 触发判定收口到 decideCuration（攒够 40 条 **或** 积压超时都整理，见该函数上方的长注释）。
  // 群聊预检必须共用同一个判定，否则它会在自己那层提前 break、永远走不到这里的超时路径。
  const decision = decideCuration({ count: messages.length, oldestAt: messages[0]?.created_at });
  if (!decision.curate) {
    console.log(`[memoryExtractor] skip curation: ${messages.length} 条（已积压 ${decision.ageMinutes ?? '?'} 分钟）`
      + `，未达 ${CURATE_EVERY_N_MESSAGES} 条阈值且未超时（${decision.reason}），继续累积`);
    return [];
  }
  if (decision.reason === 'timeout') {
    console.log(`[memoryExtractor] 整理点停滞超时：${messages.length} 条已积压 ${decision.ageMinutes} 分钟`
      + `（阈值 ${CURATE_MAX_PENDING_MINUTES} 分钟）⇒ 本次照常整理`);
  }

  const startId = messages[0].id;
  const endId = messages[messages.length - 1].id;
  const sourceMessageId = db.prepare(`SELECT id FROM messages WHERE conversation_id = ? AND raw_id = ? ORDER BY id LIMIT 1`).get(conversationId, startId)?.id || null;
  const transcript = buildChatLogLines(messages, { userName, characterName });
  // v3 事件时间：取窗口内最后一条 user 消息时间（服务端事实来源，不让 LLM 猜时间）
  const lastUserRow = [...messages].reverse().find(item => item.role === 'user');
  const eventTime = lastUserRow?.created_at || messages[messages.length - 1]?.created_at || null;
  const timeRange = messages[0]?.created_at && eventTime ? `${messages[0].created_at} ~ ${eventTime}` : '';
  setCheckpoint(conversationId, checkpoint.last_raw_msg_id, 'processing', null);

  try {
    const related = await hybridSearch(transcript, { conversationId, topK: 12, timeoutMs: 20000 });
    // 本轮 curation 条数上限（上游 v3.9.0 灵魂引擎合并）：灵魂开启时由 ImpressionDepth 决定，
    // 否则用硬上限。无论灵魂给多少，都不超过 CURATION_MAX_ACTIONS（输出预算与 slice 都按它对齐）。
    const curationLimit = resolveCurationLimit(conversationId);
    // 不带 response_format 发：部分渠道会给 json 模式额外注入 token，导致 prompt 前缀与
    // 对话摘要对不上、整段聊天记录掉命中（实测 18% vs 93%）。prompt 本身已强制严格 JSON。
    let requestMessages = buildCurationMessages({ transcript, related, timeRange, maxActions: curationLimit });
    let result = await chatSync(requestMessages, {
      temperature: 0.2,
      max_tokens: CURATION_MAX_TOKENS,
      label: '聊天记忆整理',
      returnMeta: true,
    });
    // 被 max_tokens 砍断时原样重发只会再砍一次（半截 JSON 用 json 模式也修不好），
    // 换成条数更少的精简指令重发：共享前缀（system + <chat_log>）没动，缓存照样命中。
    if (planCurationRecovery({ finishReason: result.finishReason }) === 'compact') {
      console.warn(`[memoryExtractor] 输出被 max_tokens(${CURATION_MAX_TOKENS}) 截断，改用精简指令重发: ${conversationId} raw ${startId}-${endId}`);
      requestMessages = buildCurationMessages({ transcript, related, timeRange, compact: true, maxActions: curationLimit });
      result = await chatSync(requestMessages, {
        temperature: 0.2,
        max_tokens: CURATION_MAX_TOKENS,
        label: '聊天记忆整理(截断重发)',
        returnMeta: true,
      });
    }
    let actions;
    try {
      actions = parseMemoryActions(result.content);
    } catch (parseError) {
      // 截断导致的半截 JSON 补发 json 模式也修不好，直接抛出，省掉一次全量未命中缓存的请求
      if (planCurationRecovery({ finishReason: result.finishReason, parseFailed: true }) !== 'json') {
        throw new Error(`输出连续被 max_tokens(${CURATION_MAX_TOKENS}) 截断，无法解析（记录正文 ${transcript.length} 字符）：${parseError.message}`);
      }
      console.warn(`[memoryExtractor] 输出非严格 JSON，改用 json 模式补发一次: ${parseError.message}`);
      const strict = await chatSync(requestMessages, {
        temperature: 0.2,
        max_tokens: CURATION_MAX_TOKENS,
        response_format: { type: 'json_object' },
        label: '聊天记忆整理(json回退)',
      });
      actions = parseMemoryActions(strict);
    }
    // 逐条筛查 + 逐条落库（真机 E2E 抓到的 `curation failed: judgment 不能为空`）：
    // 一条坏动作只丢它自己；不再让整批 curation 失败、checkpoint 原地打转。
    const plan = planMemoryActionApply(actions);
    if (plan.skipped.length > 0) {
      const byReason = plan.skipped.reduce((acc, item) => {
        acc[item.reason] = (acc[item.reason] || 0) + 1;
        return acc;
      }, {});
      console.warn(`[memoryExtractor] 记忆动作筛查: 可用 ${plan.applicable.length} 条 / 跳过 ${plan.skipped.length} 条 ${JSON.stringify(byReason)} | 首条=${JSON.stringify(plan.skipped[0].detail)}`);
    }
    const saved = [];
    let applySkipped = 0;
    for (const item of plan.applicable) {
      try {
        saved.push(...applyMemoryActions({
          conversationId, sourceRawStartId: startId, sourceRawEndId: endId, sourceMessageId, actions: [item], eventTime,
        }));
      } catch (err) {
        // 单条落库失败（例如引用的旧记忆已失效、敏感内容被拒）也只跳过它自己
        applySkipped += 1;
        console.warn('[memoryExtractor] 单条记忆动作落库失败，已跳过:', String(err.message).slice(0, 200));
      }
    }
    setCheckpoint(conversationId, endId, 'idle', null);
    console.log(`[memoryExtractor] curated ${saved.length} memories for ${conversationId}, raw ${startId}-${endId}` + (applySkipped > 0 ? `, skipped ${applySkipped}` : ''));
    return saved;
  } catch (error) {
    setCheckpoint(conversationId, checkpoint.last_raw_msg_id, 'failed', String(error.message).slice(0, 500));
    console.error('[memoryExtractor] curation failed:', error.message);
    return [];
  }
}

export function buildMemoryCurationPrompt({ transcript, related = [], timeRange = '', v3 = isMemoryV3Enabled(), compact = false, maxActions = CURATION_MAX_ACTIONS }) {
  const existing = related.length
    ? related.map(item => `- ${item.memory_id} | ${item.memory_type} | ${item.judgment} | tags=${JSON.stringify(item.tags)}`).join('\n')
    : '（无相关旧记忆）';
  // 条数上限：与 parseMemoryActions 的 slice 保持一致。输出预算有限，条数写多了会被 max_tokens 砍断，
  // 写超 slice 的部分又会被静默丢掉，所以直接在 prompt 里钉死上限。
  const actionBudget = compact
    ? `- 上一次输出超出长度上限被截断：这次最多输出 ${CURATION_COMPACT_ACTIONS} 条，字段从简（reasoning 一句、episodicNote/semanticNote 各一句、entities 最多 2 个、triple 可省略）`
    : `- 最多输出 ${maxActions} 条：按重要性排序只留最重要的 ${maxActions} 条，同一件事不要拆成多条`;
  const common = `你是聊天长期记忆整理器。只保存未来对话仍有价值、可独立理解的信息，不保存密码、密钥、一次性请求、泛化寒暄、角色固有设定或生图提示词。

记忆类型：
- knowledge：稳定事实、身份、偏好、关系或项目状态
- skill：能力、方法、工具使用经验
- emotion：稳定情绪偏好或与长期事件绑定的态度
- event：确实发生且未来仍需保持连续性的事件

动作约束：
- create：新记忆，sourceMemoryIds 必须为空
- update：替代一条旧记忆，sourceMemoryIds 必须正好 1 个
- merge：合并至少两条旧记忆，sourceMemoryIds 至少 2 个
- 没有值得记忆的信息时 memoryActions 返回 []
- 不得引用下面列表之外的 memoryId
${actionBudget}`;

  // v2 回滚分支：与历史 prompt 逐字兼容（含禁评分约束）
  const v2Format = `- 不输出 importance、confidence 或自由评分

每条 memory 格式：
{"memoryType":"knowledge|skill|emotion|event","subject":"user|character|relationship|assistant","judgment":"一句独立、清楚的判断句","reasoning":"只写支撑判断的对话依据","tags":["独立稳定词元"]}`;

  // v3 分支：MMS 多重表示（检索单元 keywords/perspectives/episodicNote + 注入单元 semanticNote）
  // + 实体/三元组抽取。新字段全部可选：模型偷懒不输出时落库自动降级为 v2 形态。
  const v3Format = `每条 memory 格式：
{"memoryType":"knowledge|skill|emotion|event","subject":"user|character|relationship|assistant","judgment":"一句独立、清楚的判断句","reasoning":"只写支撑判断的对话依据","tags":["独立稳定词元"],"keywords":["检索关键词"],"perspectives":["认知视角标签"],"episodicNote":"何时何地发生了什么","semanticNote":"可独立转述的事实句","importance":3,"entities":[{"name":"具体名词","role":"subject|object|mention"}],"triple":{"subject":"主体","predicate":"谓词","object":"客体"}}

扩展字段说明（全部可省略，宁可留空不要编造）：
- keywords：3~8 个，用户将来想问起这件事时最可能打的词；tags 是主题归类，keywords 是检索入口，两者可以不同
- perspectives：2~5 个认知视角标签，如：饮食习惯/童年/健康/工作/金钱/关系/旅行，让同一条记忆能从不同角度被想起
- episodicNote：情景信息（大约何时、在哪、发生了什么），event/emotion 类必写，只记事实不写评价
- semanticNote：把这条记忆提炼成一句可直接向他人转述的话，与 judgment 意思一致但更口语化；写不出就用空字符串
- importance：1（琐碎）~5（重大：重大事件、强烈偏好、重要关系节点）
- entities：具体的人名/地名/事物名；代词（她/他/我/你/它）和抽象概念不算；没有就给 []
- triple：仅当存在清晰的主谓宾事实（如 她-讨厌-香菜、他-承诺-周末看电影）才输出，谓词尽量是单个词；没有就省略整个 triple 字段`;

  // 顺序即缓存：<chat_log> 排在最前（与摘要共用同一段记录），指令随后，时间窗口/旧记忆这些变量后置
  const timeBlock = timeRange ? `\n<window_time>\n${timeRange}\n</window_time>\n` : '\n';
  const chatLogBlock = wrapChatLogBlock(transcript);
  const taskText = `${common}\n\n${v3 ? v3Format : v2Format}\n\n只返回严格 JSON：{"memoryActions":[{"action":"create|update|merge","sourceMemoryIds":[],"memory":{...}}]}\n${timeBlock}<related_memories>\n${existing}\n</related_memories>`;
  return buildAnalysisUserContent(chatLogBlock, taskText);
}

/**
 * 记忆整理的完整请求：共享 system 块 + 任务指令 + 聊天记录。
 * 与对话摘要共用同一份共享前缀，两个调用能互相吃对方写进前缀缓存的 system 块。
 */
export function buildCurationMessages(options = {}) {
  return [
    { role: 'system', content: buildSharedAnalysisSystemPrompt() },
    { role: 'user', content: buildMemoryCurationPrompt(options) },
  ];
}

/**
 * 记忆整理出问题后的补救动作（纯判断，便于单测）：
 * - compact：finish_reason=length，输出被 max_tokens 砍断，半截 JSON 用 json 模式补发也修不好，
 *   只能让模型少写几条、字段从简，重发一次
 * - json：纯格式问题（裹了 markdown、多写了说明），json 模式能让模型只吐 JSON
 * 返回 null 表示不需要补救。
 */
export function planCurationRecovery({ finishReason, parseFailed = false } = {}) {
  if (finishReason === 'length') return 'compact';
  return parseFailed ? 'json' : null;
}

export function parseMemoryActions(raw) {
  let text = String(raw || '').trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(text);
  const actions = parsed.memoryActions ?? parsed.actions ?? [];
  if (!Array.isArray(actions)) throw new Error('memoryActions 必须是数组');
  return actions.slice(0, CURATION_MAX_ACTIONS);
}

/**
 * 单条记忆动作的形态修复（纯函数）。
 *
 * 真机 E2E 抓到过既有故障：`[memoryExtractor] curation failed: judgment 不能为空`。
 * 根因有二，都在**模型输出的形态**上，不在业务逻辑：
 *   1. **扁平形态**：v3 的格式是 `{"action":"create","sourceMemoryIds":[],"memory":{...}}`，
 *      模型偶尔把 memory 里的字段（memoryType/judgment/tags…）直接写在 action 这一层，
 *      于是 `input.memory === undefined` → `normalizeMemory({})` → judgment 为空 → 抛错；
 *   2. **judgment 写空**：模型留了 `"judgment":""` 或者只写了 reasoning。
 * `applyMemoryActions` 是**整批先校验再开事务**（memoryRepository.js:143），所以上面任意一条
 * 都会让**整批 curation 失败**、checkpoint 原地不动、下一轮再烧一次 LLM 又同样失败。
 * 这里先把形态救回来（扁平 → 套回 memory、action 缺失按 sourceMemoryIds 数量推断），
 * 救不回来的交给 planMemoryActionApply 丢弃。
 *
 * @returns {{action:'create'|'update'|'merge', sourceMemoryIds:string[], memory:object}|null}
 */
export function normalizeMemoryActionShape(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const rawMemory = entry.memory;
  const hasWrapped = rawMemory && typeof rawMemory === 'object' && !Array.isArray(rawMemory);
  // 扁平形态：把 action/sourceMemoryIds 之外的同级字段当成 memory 本体
  const flat = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'memory' || key === 'action' || key === 'sourceMemoryIds' || key === 'source_memory_ids') continue;
    flat[key] = value;
  }
  let memory = hasWrapped ? rawMemory : flat;
  if (!memory || Object.keys(memory).length === 0) return null;
  // 拼写变体：模型偶尔写 judgement（英式）；不归一的话同样会变成 "judgment 不能为空"
  if (!String(memory.judgment ?? '').trim() && String(memory.judgement ?? '').trim()) {
    memory = { ...memory, judgment: memory.judgement };
  }
  const sourceMemoryIds = [...new Set(
    (Array.isArray(entry.sourceMemoryIds) ? entry.sourceMemoryIds
      : Array.isArray(entry.source_memory_ids) ? entry.source_memory_ids : [])
      .map(String).map(s => s.trim()).filter(Boolean)
  )];
  let action = String(entry.action ?? '').trim().toLowerCase();
  if (!['create', 'update', 'merge'].includes(action)) {
    // 模型没写 action（或写歪了）时按引用条数推断：0 条 = 新记忆，1 条 = 替代，≥2 条 = 合并
    action = sourceMemoryIds.length === 0 ? 'create' : (sourceMemoryIds.length === 1 ? 'update' : 'merge');
  }
  return { action, sourceMemoryIds, memory };
}

/**
 * 逐条筛查"这批记忆动作里哪些能落库"（纯函数，单测可直接喂合成样本）。
 *
 * 与 memoryRepository 的整批校验互补：这里**逐条**过 `validateMemoryAction`，
 * 坏的那条只丢自己（记 reason），不连坐整批；幸存者由调用方逐条落库。
 * 这样"宁可少一条记忆，也不要整批 curation 失败"。
 *
 * @param {Array} actions 模型输出的原始 memoryActions
 * @param {{validate?:Function}} [options] 校验器（默认 memoryRepository.validateMemoryAction）
 * @returns {{applicable:Array<{action,sourceMemoryIds,memory}>, skipped:Array<{reason:string,detail:string}>}}
 */
export function planMemoryActionApply(actions, { validate = validateMemoryAction } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const applicable = [];
  const skipped = [];
  for (const entry of list) {
    const shape = normalizeMemoryActionShape(entry);
    if (!shape) {
      skipped.push({ reason: 'shape_unrecoverable', detail: JSON.stringify(entry ?? null).slice(0, 160) });
      continue;
    }
    try {
      const validated = validate(shape);
      applicable.push(validated);
    } catch (err) {
      const reason = /judgment 不能为空/.test(String(err?.message)) ? 'judgment_empty' : 'invalid';
      skipped.push({ reason, detail: String(err?.message || err).slice(0, 160) });
    }
  }
  return { applicable, skipped };
}

// 旧调用兼容；新代码应传 raw assistant id。

export async function curateAccumulatedMemory({ accumulatedText, characterName = '', userName = '用户' }) {
  // 不落库的记忆整理：把累积对话整理成判断句列表，用于 MaiBot 主聊天流注入。
  // 该路径只消费 judgment，强制 v2 精简格式，避免为不落库的扩展字段浪费输出 token。
  const raw = await chatSync(buildCurationMessages({ transcript: accumulatedText, related: [], v3: false, maxActions: CURATION_MAIBOT_ACTIONS }), {
    temperature: 0.2,
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    label: '聊天记忆整理',
  });
  const actions = parseMemoryActions(raw);
  const lines = actions
    .map((item) => {
      // 同样先修形态：扁平形态（字段写在 action 同级）在旧代码里会输出 '- [knowledge]' 这种空行
      const memory = normalizeMemoryActionShape(item)?.memory ?? {};
      const type = memory.memoryType ?? 'knowledge';
      const judgment = String(memory.judgment ?? '').trim();
      return judgment ? `- [${type}] ${judgment}` : '';
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : '';
}

export async function extractMemoryFragments(conversationId, _userMsgId, assistantRawMsgId, options = {}) {
  return curateChatMemories({ conversationId, throughRawMsgId: assistantRawMsgId, ...options });
}
