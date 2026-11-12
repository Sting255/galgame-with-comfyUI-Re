/**
 * 日程生成器
 *
 * 基于角色人格 + 职业生成每日时间表（schedule template）。
 * LLM 输出完整 24 小时日程，共同活动与睡眠拆分可以增加条数。
 *
 * 生成时机：
 *   - 角色创建时：立即生成 + 分配随机刷新时间
 *   - 整轮到期 / 手动全员重置：scheduleBatch 先串行规划居室，再生成个人草稿并统一发布
 *   - 手动强制：API POST /api/schedule/:id/regenerate
 */

import { getDb, getWorldSetting, getSystemRules } from '../db/index.js';
// 场景服装（2026-10-13 合并上游 + PR #24）：日程生成时拼「着装标注」层 + 生成后校验修复
import { chatSync } from './lorebook/runtime.js';
import { config } from '../config.js';
import { getProgramDateKey, toSqlUtc } from './programTime.js';
import { getWorldIntegrationRule } from '../builtinRules.js';
// 奇遇时长预留（上游 v3.9.0）：写完当天日程快照后，把进行中的事件开场活动重新钉回去。
// 本地从 v3.6.2 起漏了这条接线（2026-10-14 补）。
import { reapplyActiveEventSchedule, reserveEventTime } from './eventSchedule.js';
import { buildOutfitAnnotateLayer, buildOutfitAnnotation, ensureOutfitAnnotations } from './outfitScene.js';
import { publishedCohabitationContext } from '../db/cohabitationRepository.js';
import { applySharedActivities, assertCompleteDay, intervals } from './cohabitationSchedule.js';
import { persistIndividualSchedule, refreshResidenceDailySleep } from './cohabitationPersistence.js';
import { enterSingleSchedule } from './scheduleGenerationLock.js';
import { invalidateCache, syncSleepingState } from './scheduleManager.js';
import { isCompleteJsonText } from '../llm/llm-client.js';

/**
 * 截取角色人格 prompt：从开头到 "##你的外观" 之前
 */
function cropPersonaForSchedule(basePrompt) {
  if (!basePrompt) return '一个普通角色，没有特殊设定';
  const idx = basePrompt.search(/##\s*你的外观/);
  return idx > -1 ? basePrompt.slice(0, idx).trim() : basePrompt.slice(0, 800);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean);
  if (typeof tags === 'string') {
    const trimmed = tags.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) || typeof parsed === 'string') return normalizeTags(parsed);
    } catch {}
    return trimmed.split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 为角色生成日程模板
 * @param {object} character - { id, display_name, base_prompt }
 * @returns {Promise<{schedule_json: string, version: number}>}
 */
// 同一角色的自动刷新、手动刷新与补发任务共享正在执行的生成（上游 v4.2.0：宿舍整轮流水线要求串行）。
const pendingSchedules = new Map();
const MAX_GENERATION_ATTEMPTS = 5; // 首次生成 + 最多4次纠错重试
export function generateSchedule(character, direction, options = {}) {
  const key = options.persist === false ? `detached:${character.id}` : character.id;
  if (pendingSchedules.has(key)) return pendingSchedules.get(key);
  const release = options.persist === false ? () => {} : enterSingleSchedule(key);
  const pending = generateScheduleImpl(character, direction, options).finally(() => { pendingSchedules.delete(key); release(); });
  pendingSchedules.set(key, pending);
  return pending;
}
async function generateScheduleImpl(character, direction, options = {}) {
  const db = getDb();
  const cohabitation = options.cohabitation || (options.persist === false && !options.resident ? { room: null, events: [] } : publishedCohabitationContext(db, character.id));
  const worldSetting = getWorldSetting();
  const persona = cropPersonaForSchedule(character.base_prompt);

  // ── 舞台：破限词 + 世界观 ──
  const jailbreak = getSystemRules({ roleplay: false });
  const stageContent = [jailbreak, worldSetting].filter(Boolean).join('\n\n');

  // ── 世界观穿透指令（参照朋友圈生成）──
  const worldIntegrationNote = worldSetting
    ? getWorldIntegrationRule('schedule')
    : null;

  // ── 角色人格（裁剪到外观之前）──
  const personaMsg = `${persona}

以上人格只用于辨认角色的性格、说话习惯与气质。<world_setting>是最高优先级：人格中的身份、职业、组织、地点与经历属于角色原设，一律作废，不得沿用进日程；日程中的职业、地点、活动与作息必须由当前<world_setting>重新定义，日程编排必须和<world_setting>有强相关。`;

  // ── 日程生成指令 ──
  const scheduleInst = `你是一个日程编排助手。在<world_setting>的影响下生成职业，基于角色的职业和人格，生成该角色典型一天的完整日程。

## 职业驱动原则
角色的职业是日程的核心骨架。所有主要活动必须围绕职业展开。职业决定了角色一天中大部分时间的去向和活动类型，<world_setting>决定了在这种情况下职业的表现形式。
- 学生→上课、自习、社团、考试
- 上班族→通勤、会议、午休、加班
- 偶像→排练、录音、演出、粉丝互动
- 店主→开店、进货、接待客人、打烊
- 自由职业→在家工作、外出取材、交稿截止日
- 其他职业同理类推

## 睡眠时间（硬约束，违反视为格式错误）

**主睡眠块必须整体落在 21:00 – 09:30 这个窗口内；起床时间最晚 09:30，最晚不得晚于 10:00。**

- 白天是这个世界共同活动的时间（上课、上班、社团、街上的事）。任何人白天躺着睡觉，整座城就会显得假。
- 所以**禁止**「凌晨 3 点睡到中午 11-12 点」「下午 2-4 点起床」这类作息——
  哪怕角色是游戏宅、夜猫子、NEET、夜班工作者，也必须在 09:30 前起床（现实里他们也是补几小时就起）。
- 允许的多样性（都在窗口内，够用了）：

- 早睡早起型→21:00-22:00 睡，05:00-06:00 起（运动员、晨练、老派作息）
- 标准型→23:00-00:00 睡，07:00 起
- 夜猫子·轻度→00:00-01:00 睡，08:00-09:00 起（游戏宅、同人画师、自由职业）
- 夜猫子·重度→01:00-02:30 睡，09:00-09:30 起（深夜主播、重度网瘾；**上限就是 09:30**）
- 碎片化睡眠→夜里睡 4-5 小时 + **白天只用「小憩」**（见下），不许用长块

睡眠 block 的 replyDelay 必须是 -1。主睡眠总时长 5-9 小时。

**白天小憩（不是主睡，且是例外）**：真的需要白天补觉时，只能写**不超过 40 分钟**的短块，且落在 12:00–15:00 之间，replyDelay=-1。

⚠️ **小憩是例外，不是中午的默认安排**：同一个角色一天最多一次；多数角色中午在吃饭、自习、社团、值班、跑腿、闲逛或补功课。
不要让所有角色都选择「午间小憩」，也不要用「趴在桌上眯一会」这类通用说法——从角色自己的职业、性格和手头的事出发安排中午。

**关键原则**：
1. 睡眠类型要贴人格与职业（懒散的人晚睡晚起、军武角色作息严格），但**都受上面的窗口约束**
2. 不要为了"显得多样"就让人中午起床——那是这轮明确禁止的写法

## replyDelay 规则（非常重要）
- 正常活动都是 replyDelay=0（即时回复）
- 只有睡觉 replyDelay=-1

## 共同生活安排（提供时执行）
如果后文提供本轮已确认的共同活动，必须完整保留每件活动的起止时间、地点和参与者，睡眠避开这些时间；其余时间独立安排。
如果提供居室，通常在该居室睡眠：location逐字使用居室名称，并增加sleepAtHome:true；外宿或异地补觉使用实际地点和sleepAtHome:false。保持自己的作息，睡眠描述只写自身状态，不提前写独自或与谁同睡；系统在所有人完成后统一按睡眠交集拆分。
带居室的睡眠条目完整示例：{"startTime":"23:00","endTime":"07:00","activity":"就寝","location":"输入中的居室原名","replyDelay":-1,"tags":["睡眠"],"description":"放松肩膀躺进柔软被褥，伴着窗外渐渐安静的夜色沉入安稳的睡眠。","sleepAtHome":true}。sleepAtHome必须为布尔值，不能用字符串；location必须替换为实际地点。

## 输出格式
输出一个 JSON 对象，外层 key 为 "activities"，值为活动数组。通常8~15个活动，可按共同活动和实际作息增减，不设条数硬上限；按时间顺序覆盖完整24小时。
**绝对不允许出现时间空档**：上一个活动的 endTime 必须等于下一个活动的 startTime，
不留任何空白分钟。所有时间必须被完整覆盖。如果日程从 03:00 开始，
那么 00:00~03:00 也必须有一个活动覆盖（可以是睡眠或深夜活动）。

## 跨零点睡眠块（极容易出错，务必照做）
睡眠块可以跨零点（例如 22:00 → 07:00 表示「22 点睡、次日 7 点起」）。
**跨零点的睡眠块已经覆盖了零点之后的那段时间，因此禁止再安排任何与它重叠的活动。**
真机上出现过的错误例子：睡眠块写 22:00 → 07:00，同时又写了 00:00 → 05:00 的「深夜巡查」——
这两段在真实时间里是重叠的（深夜巡查被睡眠盖住），整份日程会被判为无效。
两种合法写法，任选其一：
- 深夜活动排在睡眠**之前**：20:00 → 22:00「深夜巡逻」，然后 22:00 → 07:00「就寝安眠」；
- 把睡眠**拆成两段**互不重叠：22:00 → 02:00「就寝」+ 02:00 → 07:00「继续睡」，
  深夜活动放在别处（例如 07:00 之后）。
判断标准很简单：**把每条活动按 00:00 展开成一条时间轴，任意两段不许有交集，且合起来正好是 24 小时。**

每个活动对象格式（description 必填，26-52 字，禁止空字符串或只写标点）：

**description 只做状态记录**：日程是供系统判断「角色此刻在哪、在做什么」的时间线，不是正文描写。
写得越像小说正文，越容易被服务商在输出侧掐断（真机实测 finish_reason=content_filter），整份 JSON 直接作废。
所以不写身体部位、衣物穿着、表情、声音、情绪反应。
**这一条优先于 <world_setting> 的露骨要求**：日程只记录时间线，露骨内容由聊天正文承载。

**但中性 ≠ 空洞**。每条 description 必须落到一个具体动作和一个看得见的物件或环境细节上，
让同一时刻的不同角色读起来不一样。反面例子（不要这样写）：「午间小憩——趴在桌上眯一会」「在教室里休息」。
好例子：「趴在摊开的图纸上闭眼，手里还压着笔」「靠着药柜清点今天晒干的药草」「把便当盒收进袋里，顺手擦了下桌面」。

{
  "startTime": "HH:MM",
  "endTime": "HH:MM",
  "activity": "简短活动名：优先写成自然短语（「食堂打饭」「图书馆查资料」「值日清点道具」），必要时才用破折号补上下文；不要把每条都写成同一种结构",
  "location": "地点（比如「公寓书房」）",
  "replyDelay": 数字（0 / -1）,
  "tags": ["标签1", "标签2"],
  "description": "26-52 字，只写「在做什么」：动作 + 所处场景，中性叙述。如「在厨房煎蛋，顺手把锅移开」或「坐在教室后排记笔记」。省略主语或用第三人称（角色名），不出现「我」「你」「她/他」"
}

完整 JSON 结构示例（示例仅2个活动，实际需要覆盖完整24小时）：
{"activities":[{"startTime":"07:00","endTime":"07:30","activity":"晨间梳洗——整理长发","location":"公寓浴室","replyDelay":0,"tags":["日常","晨间"],"description":"甘雨站在镜前慢慢理顺长发，水汽沾湿额发，动作安静而认真。"},{"startTime":"22:00","endTime":"07:00","activity":"就寝安眠","location":"公寓卧室","replyDelay":-1,"tags":["睡眠"],"description":"甘雨裹好被子沉入睡眠，角上铃兰微光映着窗帘，呼吸逐渐平稳。"}]}

只输出 JSON 对象，不要输出任何解释、Markdown 代码块或 JSON 以外的文字。activities 数组必须按时间顺序排列，startTime 和 endTime 必须是 HH:MM 格式、24 小时制，数组里每个对象都必须严格包含并输出上述七个字段。`;

  // ── 用户指定的日程方向 ──
  const directionMsg = direction ? `## 用户指定的日程方向
**请按照以下方向来影响角色今日日程的编排：

${direction}**

**注意：以上是用户指定的日程"方向"或"主题"，这就是严格的指令。所有日程编排以用户的意愿为准，可以想象理由，适当破坏角色原有的角色设定，自然地融入这个方向的元素。**` : null;

  // ── 场景服装标注层（2026-10-13 合并上游 + PR #24）──
  // 只有该角色配了场景服装（≥2 套）时才拼；没配的角色日程生成保持原样（零影响）。
  // 这段要求模型为「换装的那一刻」额外输出 outfit 字段，供 outfitScene.getSceneOutfitForNow 按日程选装。
  // ⚠ 必须在 triggerContent 声明**之后**再用它（TDZ：本仓踩过"引用后声明变量整块静默全废"）。
  // options.outfits：系统角色（天使）自带衣柜，直接用传入的那几套；
  // options.persist === false：旁路生成不落库，也就不需要按角色查库里的场景服装。
  const outfitLayer = Array.isArray(options.outfits)
    ? buildOutfitAnnotation(options.outfits.filter(outfit => outfit.description))
    : options.persist === false ? null : buildOutfitAnnotateLayer(character.id);

  // ── 组装多层 system（前三层为跨角色共享前缀，提高 LLM 缓存命中率）──
  const msgs = [];
  // msgs[0]: 舞台（破限词 + 世界观）
  if (stageContent) msgs.push({ role: 'system', content: stageContent });
  // msgs[1]: 世界观穿透指令
  if (worldIntegrationNote) msgs.push({ role: 'system', content: worldIntegrationNote });
  // msgs[2]: 核心生成指令（第三层 system，缓存友好）
  msgs.push({ role: 'system', content: scheduleInst });
  // msgs[3]: 角色人格（随角色变化，不影响前缀缓存）
  msgs.push({ role: 'system', content: personaMsg });
  // msgs[3.5]: 着装标注（默认服饰加至少一套已配置换装；仅有默认时不加）
  //   放在这里而非 scheduleInst：scheduleInst 是跨角色共享常量（吃 LLM 前缀缓存），
  //   服装列表每个角色都不同，塞进去会让缓存全部失效。
  if (cohabitation.room || cohabitation.events.length) {
    msgs.push({ role: 'system', content: `【本轮已确定的共同生活安排】\n${JSON.stringify(cohabitation)}` });
  }
  // msgs[4]: 触发消息（融合用户指定的日程方向）
  let triggerContent = worldSetting
    ? `请遵循<world_setting>来安排日程，角色设定如果和<world_setting>有冲突，则以<world_setting>最高优先级，角色设定会因为<world_setting>改变,日程内容必须体现<world_setting>的设定。

请为 ${character.display_name} 生成完整的今日日程安排。`
    : `请为 ${character.display_name} 生成完整的今日日程安排。`;
  if (directionMsg) triggerContent += `

${directionMsg}`;
  // 场景服装标注层接在用户方向之后（同为"本轮附加要求"），没有则不追加（逐字节不变）
  if (outfitLayer) triggerContent += `

${outfitLayer}`;
  // 格式要求放最后（2026-10-22）：system 里那份规范在长 prompt 中会被模型忽略，
  // 实测首轮几乎必定写成 Markdown。贴在紧邻生成点的 user 消息末尾后，首轮成功率明显提高。
  triggerContent += `

${SCHEDULE_FORMAT_TAIL}`;
  msgs.push({ role: 'user', content: triggerContent });

  let rawResult = '';
  let validationError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptMsgs = msgs.map(m => ({ ...m }));
    if (attempt > 0) {
      attemptMsgs.push({
        role: 'user',
        content: `上次输出是完整合法 JSON，但没有通过日程领域校验：${validationError}。`
          + '请保持同一角色与世界观，修正这些领域问题后重新输出完整日程 JSON；'
          + '仍须按前述完整示例输出所有字段，不要解释、Markdown 或 JSON 以外的文字。',
      });
    }

    // 传输、截断、审核中断与续写均由公共 chatSync 收口。到这里仍失败时不再包一层整轮重问。
    const chatResult = await (options.chat || chatSync)(attemptMsgs, {
      temperature: attempt === 0 ? 0.5 : 0.45,
      // 2026-10-01：2048 → 4096。真机复现实测：14~16 段的日程输出就已经到 1500+ tokens、
      // 原文 5000+ 字符；话多的角色（纳西妲/风瑾）会顶到 2048 上限**被截断**。
      // 注意：这个值实际会被 applyOutputTokenLimit 用设置页的全局额度覆盖，这里只是兜底声明。
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      label: `schedule-gen:${character.display_name}${attempt > 0 ? ':domain-retry' : ''}`,
      // returnMeta 只用于日志；是否完整以公共客户端最终 content 为准，不能机械相信历史 finish_reason。
      returnMeta: true,
      ...(config.features.scheduleDisableThinking
        ? { thinking: { type: 'disabled' }, forceDisableThinking: true }
        : options.thinking ? { thinking: options.thinking } : {}),
      lorebook:{personaTexts:[personaMsg],staticTexts:[scheduleInst],characterName:character.display_name,
        cacheBoundary: { index: msgs.findIndex(m => m.content === personaMsg), offset: personaMsg.length },
        history: [{ role: 'user', content: `${JSON.stringify(cohabitation)}\n${triggerContent}` }] },
    });
    rawResult = typeof chatResult === 'string' ? chatResult : (chatResult?.content || '');
    const finishReason = chatResult && typeof chatResult === 'object' ? chatResult.finishReason : null;

    // 只按公共客户端最终内容的严格完整性分类。finish_reason 仅留在错误证据里，
    // 不因曾经 length 而拒绝一段已被公共续写补全的合法 JSON。
    if (!isCompleteJsonText(rawResult)) {
      const message = `日程输出经公共续写后仍不是完整 JSON（finish_reason=${finishReason ?? '未知'}，共 ${String(rawResult).length} 字符）`;
      console.warn(`[scheduleGen] ${character.display_name} ${message}`);
      dumpScheduleRaw(rawResult, character.display_name, message);
      throw new Error(message);
    }

    let schedule;
    try {
      const diagnostics = [];
      schedule = parseAndValidateSchedule(rawResult, character.display_name, diagnostics);
      if (!schedule) {
        throw new Error(diagnostics[0] || '日程字段、时间或完整24小时覆盖不符合要求');
      }
      // 批次的新提案在全部草稿完成后统一协调；已发布约定仍在此严格校验。
      const enforced = options.persist === false && options.deferSharedActivities
        ? cohabitation.events.filter(e => options.lockedSharedEventIds?.includes(e.sharedEventId)) : cohabitation.events;
      schedule = applySharedActivities(schedule, enforced, character.id);
      if (cohabitation.room) schedule = schedule.map(a => a.replyDelay === -1 ? { ...a, residence: cohabitation.room } : a);
      assertCompleteDay(schedule);
    } catch (err) {
      validationError = err?.message || '日程领域校验失败';
      if (attempt === 0) {
        console.warn(`[scheduleGen] ${character.display_name} 首次领域校验失败，允许一次领域修正：${validationError}`);
        continue;
      }
      console.error(`[scheduleGen] ${character.display_name} 领域修正后仍失败：${validationError}`);
      throw err;
    }

    // 着装标注校验 + 一次专注修复（仅当该角色配了场景服装）。
    // 提示词已要求「出门/回家必须标」，但 LLM 有波动：同一角色两次生成可能一次给 6 个换装点、
    // 一次只给 3 个 —— 漏标会让角色穿着居家服在街上活动。只压提示词不够，加这道确定性兜底。
    if (outfitLayer) {
      try {
        const r = await ensureOutfitAnnotations(schedule, character.id);
        schedule = r.schedule;
      } catch (err) {
        console.warn(`[scheduleGen] 着装标注修复失败（不影响日程生成）: ${err.message}`);
      }
    }
    const json = JSON.stringify(schedule);
    // 系统角色（天使）复用生成与校验，但由自己的存储负责，不混入普通居民表。
    if (options.persist === false) return { schedule_json: json, version: 1 };
    const saved = persistIndividualSchedule(db, character, schedule, cohabitation.room);
    const manager = await import('./scheduleManager.js');
    for (const id of saved.changed) { manager.invalidateCache(id); manager.syncSleepingState(id); }
    return { schedule_json: JSON.stringify(saved.schedule), version: db.prepare('SELECT version FROM schedule_templates WHERE character_id=?').get(character.id).version };
  }

  throw new Error(`Failed to generate valid schedule for ${character.display_name} after one domain correction`);
}

/**
 * LLM 原始输出的**带标记截断预览**（2026-10-01）。
 *
 * 为什么必须加：日志取证发现后端把 LLM 返回体**静默截断到约 320 字符、且不加任何标记**，
 * 于是"成功"的样本和"失败"的样本看起来停在同一位置（都停在一个词中间），
 * 三月七的日程生成失败**因此完全无法从日志判断根因**。
 * 现在任何一次校验失败都会打一条带「共 N 字符 / 已截断」的预览；
 * 需要看全文时设环境变量 `SCHEDULE_GEN_DUMP=1`。
 */
function scheduleRawPreview(raw, limit = 400) {
  const text = String(raw ?? '');
  const head = text.slice(0, limit).replace(/\s+/g, ' ');
  return text.length > limit ? `${head} …（共 ${text.length} 字符，已截断）` : head;
}

function dumpScheduleRaw(raw, displayName, reason) {
  console.warn(`[scheduleGen] ${displayName} ${reason}；原始输出预览：${scheduleRawPreview(raw)}`);
  if (process.env.SCHEDULE_GEN_DUMP === '1') {
    console.warn(`[scheduleGen] ${displayName} 原始输出全文（${String(raw ?? '').length} 字符）：\n${String(raw ?? '')}`);
  }
}

/** 分钟 → "HH:MM"（负数/超 1440 自动回绕） */
function minutesToHHMM(minutes) {
  const m = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

/**
 * 确定性修复：**睡眠块优先**，把被它盖住的非睡眠活动裁掉。
 *
 * 为什么需要（2026-10-01，有真机失败样本）：
 * 复现时抓到德丽莎的失败原文 —— 模型先排 `00:00→05:00「深夜学生宿舍巡查」`，
 * 又排了一个跨零点的睡眠块（如 `22:00→07:00「就寝安眠」`）。两段在真实时间里**重叠**
 * （深夜巡查整段被睡眠盖住），校验直接判死，只能靠"再来一次"碰运气 ——
 * 日志里 4 次失败有 3 次是这么被重试救回来的，剩下那次（三月七）连输两次就成了用户看到的失败。
 *
 * 这类冲突**有唯一合理解法**，不需要重掷骰子：
 *   · 睡眠是不可让位的（replyDelay=-1 段决定了她的作息与消息队列行为）；
 *   · 非睡眠段里与睡眠重叠的分钟**本来就已被睡眠覆盖**，删掉它不会造成任何时间空档
 *     ⇒ **覆盖不变性**：本函数只做"减法"，且减掉的每一分钟都仍在睡眠块里 ⇒ 24 小时覆盖必然保持。
 *   · 若一段被睡眠从中间切开（睡眠夹在它内部），会切成两段相邻的子段，时间上仍然首尾相接。
 * 返回新数组；没有冲突时返回原数组（**逐字节不变**，保证干净日程不受影响）。
 */
export function repairScheduleOverlaps(activities) {
  if (!Array.isArray(activities) || activities.length === 0) return activities;
  const sleepBlocks = activities.filter(a => a && a.replyDelay === -1);
  if (sleepBlocks.length === 0) return activities;

  // 睡眠占用位图（1440 分钟），跨零点段展开后取模
  const sleepMask = new Uint8Array(1440);
  for (const block of sleepBlocks) {
    let s = timeToMinutes(block.startTime);
    let e = timeToMinutes(block.endTime);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (e <= s) e += 1440;
    for (let m = s; m < e; m++) sleepMask[((m % 1440) + 1440) % 1440] = 1;
  }

  let changed = false;
  const out = [];
  for (const act of activities) {
    if (!act || act.replyDelay === -1) { out.push(act); continue; }
    let s = timeToMinutes(act.startTime);
    let e = timeToMinutes(act.endTime);
    if (!Number.isFinite(s) || !Number.isFinite(e)) { out.push(act); continue; }
    if (e <= s) e += 1440;
    const free = [];
    for (let m = s; m < e; m++) if (!sleepMask[((m % 1440) + 1440) % 1440]) free.push(m);
    if (free.length === e - s) { out.push(act); continue; }   // 完全没冲突

    changed = true;
    if (free.length === 0) continue;                           // 整段被睡眠盖住 → 丢弃
    // 连续段切分（被睡眠从中间切开时得到两段相邻子段）
    const runs = [];
    let runStart = free[0];
    let prev = free[0];
    for (let i = 1; i < free.length; i++) {
      if (free[i] === prev + 1) { prev = free[i]; continue; }
      runs.push([runStart, prev + 1]);
      runStart = free[i];
      prev = free[i];
    }
    runs.push([runStart, prev + 1]);
    for (const [rs, re] of runs) {
      out.push({ ...act, startTime: minutesToHHMM(rs), endTime: minutesToHHMM(re) });
    }
  }

  if (!changed) return activities;
  out.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  return out;
}

/** 首轮就把格式约束贴在最后一条 user 消息里：长 system 中间那份规范，模型经常读不到 */
const SCHEDULE_FORMAT_TAIL = `【输出格式 · 硬性要求】
只输出一个 JSON 对象，形如：
{"activities":[{"startTime":"07:00","endTime":"07:30","activity":"晨间梳洗","location":"公寓浴室","replyDelay":0,"tags":["日常"],"description":"在浴室洗脸，把毛巾挂回架子上。"}]}
8~15 条，按时间顺序覆盖完整 24 小时、上一条 endTime 等于下一条 startTime，不留空档；只有睡觉那条 replyDelay=-1，其余为 0；description 20~40 字且必须有内容。
description 只写动作与场景，中性叙述：不写身体部位、衣物穿着、表情、声音或情绪反应。**即使 <world_setting> 要求露骨描写，这里也不写**——日程是给系统看的时间线，露骨内容由聊天正文承载。
activity 和 location 也保持中性：写「深夜自习」「走廊巡逻」「晨间梳洗」，不要写任何性行为、体液、身体状态相关的名目。
不要标题、不要 Markdown、不要代码块围栏、不要任何解释或前后缀，第一个字符必须是 {。`;

/**
 * 解析并校验 LLM 输出的日程 JSON。
 *
 * 真正的实现是下面的 `validateScheduleInner`；本函数是**带失败回显的包装**：
 * 失败时统一补一条原始输出预览（具体原因仍由 inner 里各自的 warn 说明），
 * 这样"校验为什么没过"永远能从日志里看出来。
 */
export function parseAndValidateSchedule(raw, displayName, diagnostics = null) {
  const result = validateScheduleInner(raw, displayName, diagnostics);
  if (!result) dumpScheduleRaw(raw, displayName, '日程校验未通过（具体原因见上一条 warn）');
  return result;
}

function validateScheduleInner(raw, displayName, diagnostics = null) {
  const fail = (reason) => {
    if (Array.isArray(diagnostics)) diagnostics.push(reason);
    return null;
  };
  let activities;

  // 优先尝试完整 JSON 解析（兼容 json_object 模式的 {"activities":[...]} 和旧格式 [...]）
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    activities = Array.isArray(parsed) ? parsed : (parsed.activities || null);
  } catch {
    // fallback: 旧的正则提取 JSON 数组
  }

  // 正则回退：从文本中提取 JSON 数组
  if (!activities) {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn(`[scheduleGen] No JSON array found in response for ${displayName}`);
      return fail('输出必须是包含 activities 数组的完整 JSON');
    }
    try {
      activities = JSON.parse(jsonMatch[0]);
    } catch {
      console.warn(`[scheduleGen] JSON parse failed for ${displayName}`);
      return fail('输出必须是完整合法 JSON');
    }
  }

  if (!Array.isArray(activities) || activities.length === 0) {
    console.warn(`[scheduleGen] Too few activities (${activities?.length || 0}) for ${displayName}`);
    return fail('activities 必须是非空数组');
  }

  // 校验每个活动
  const required = ['startTime', 'endTime', 'activity', 'location', 'replyDelay', 'description'];
  // 24:00 是合法终点（表示当天结束），模型与手写日程都常用它；正规化后再校验，
  // 否则一条 24:00 结尾的完整日程会被整份判废（真机表现为「日日重生成」）。
  const hhmm = (value) => {
    const text = String(value || '').trim();
    return text === '24:00' ? '00:00' : text;
  };
  for (const act of activities) {
    if (act && typeof act === 'object') {
      if (act.endTime === '24:00') act.endTime = '00:00';
      else if (act.startTime === '24:00') act.startTime = '00:00';
      // 2026-11-06：可自动补的字段就地补，别为一条小瑕疵把整份日程判废重生成
      // （真机日志：银狼首轮非 JSON、天使「未覆盖完整一天」⇒ 一整轮 tokens 白花）。
      if (typeof act.replyDelay !== 'number' || !Number.isFinite(act.replyDelay)) {
        const sleeping = /睡|就寝|安眠|梦/.test(String(act.activity || ''));
        act.replyDelay = sleeping ? -1 : 0;
      }
      if ((!act.description || !String(act.description).trim()) && act.activity) {
        const place = act.location ? `，在${String(act.location).trim()}` : '';
        act.description = `${String(act.activity).trim()}${place}。`;
      }
    }
    if (!act || typeof act !== 'object' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm(act.startTime)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm(act.endTime))) {
      return fail('每条活动的 startTime / endTime 都必须是合法 HH:MM');
    }
    for (const key of required) {
      if (!(key in act)) {
        console.warn(`[scheduleGen] Missing key "${key}" in activity for ${displayName}`);
        return fail(`活动缺少必需字段 ${key}`);
      }
    }
    if (typeof act.description !== 'string' || !act.description.trim()) {
      console.warn(`[scheduleGen] Empty or invalid description in activity for ${displayName}: "${act.activity}"`);
      return fail('每条活动的 description 都必须是非空字符串');
    }
    if (typeof act.replyDelay !== 'number') {
      console.warn(`[scheduleGen] replyDelay is not a number for ${displayName}`);
      return fail('replyDelay 必须是数字');
    }
  }

  // 必须保留睡眠；具体长度和分段交给角色作息决定。
  const sleepingBlocks = activities.filter(a => a.replyDelay === -1);
  if (sleepingBlocks.length === 0) {
    console.warn(`[scheduleGen] No sleeping block found for ${displayName}`);
    return fail('必须保留至少一段睡眠活动，并令其 replyDelay 为 -1');
  }

  // 计算最长睡眠时长
  let maxSleepDuration = 0;
  for (const block of sleepingBlocks) {
    const duration = timeToMinutes(block.endTime) - timeToMinutes(block.startTime);
    const adjusted = duration < 0 ? duration + 24 * 60 : duration;
    if (adjusted > maxSleepDuration) maxSleepDuration = adjusted;
  }
  if (maxSleepDuration < 15) {
    console.warn(`[scheduleGen] Sleep too short (${maxSleepDuration}min) for ${displayName}, need ≥15min`);
    return fail('睡眠活动至少持续 15 分钟');
  }

  // 2026-11-03 用户：「角色还在大白天睡觉」—— 主睡眠块**不许压到白天**。
  // 原来提示词明着鼓励「凌晨 3-4 点睡、中午 11-12 点起」「下午 2-4 点起」，
  // 于是真机上出现「03:00–11:00 就寝安眠」，上午十点整座城有一半人在睡。
  // 现在硬性约束：主睡（≥3 小时那段）必须整体落在 21:00–09:30 窗口内，起床不晚于 10:00。
  // 校验不通过 → 返回 null → 上层按既有逻辑重试/重生成，旧模板也会因此被换掉。
  {
    const MAIN_SLEEP_MIN_MINUTES = 180;
    const DAY_SLEEP_START_OK = 21 * 60;   // 21:00 之后才允许开始长睡
    const DAY_SLEEP_END_LIMIT = 10 * 60;  // 10:00 前必须起床
    for (const block of sleepingBlocks) {
      const start = timeToMinutes(block.startTime);
      const end = timeToMinutes(block.endTime);
      const duration = (end - start + 24 * 60) % (24 * 60);
      if (duration < MAIN_SLEEP_MIN_MINUTES) continue; // 小憩不在此列
      // 「在床上」的判定：跨零点的长睡（start ≥ 21:00 或 end ≤ 10:00 都算合规窗口内的端点）
      const startsOk = start >= DAY_SLEEP_START_OK || start <= DAY_SLEEP_END_LIMIT;
      const endsOk = end <= DAY_SLEEP_END_LIMIT || end >= DAY_SLEEP_START_OK;
      // 主睡必须"跨过午夜"或完全在凌晨段：既没有跨零点、又落在白天 → 违规
      const crossesMidnight = start > end;
      const isDaytimeSleep = !crossesMidnight && start >= 6 * 60 && end > DAY_SLEEP_END_LIMIT;
      if (isDaytimeSleep || !startsOk || !endsOk) {
        console.warn(`[scheduleGen] 主睡眠块压到白天（${displayName}）：${block.startTime}–${block.endTime}`
          + `「${block.activity}」⇒ 必须落在 21:00–09:30 窗口内，返回 null 触发重生成`);
        return fail('主睡眠必须落在 21:00–09:30，且不得在白天长睡');
      }
    }
  }
  // 校验时间不重叠
  // 2026-10-01：先做**确定性修复**（睡眠块优先，裁掉与它重叠的非睡眠段），再判重叠。
  // 真机抓到的失败样本正是这一类（跨零点睡眠块 vs 深夜活动），修完覆盖不变、也不会再掷骰子。
  {
    const repaired = repairScheduleOverlaps(activities);
    if (repaired !== activities) {
      const before = activities.length;
      console.warn(`[scheduleGen] 修掉了与跨零点睡眠块重叠的时段（${displayName}）：${before} → ${repaired.length} 段`);
      activities = repaired;
    }
  }
  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      if (timeRangesOverlap(
        activities[i].startTime, activities[i].endTime,
        activities[j].startTime, activities[j].endTime
      )) {
        console.warn(`[scheduleGen] Overlapping activities for ${displayName}: "${activities[i].activity}" and "${activities[j].activity}"`);
        return fail('活动时间不能重叠');
      }
    }
  }

  // 校验 24 小时全覆盖（不允许时间空档）
  if (!checkFullDayCoverage(activities, displayName)) {
    return fail('活动必须按时间顺序无空档覆盖完整 24 小时');
  }

  // 80% 秒回兜底：理想情况下 prompt 已限定 replyDelay 只有 0 和 -1，但 LLM 可能不听话
  // 产生非 0 非 -1 的值。此兜底将超出的非秒回活动随机改回 0，确保不超过 20%
  const nonImmediate = activities.filter(a => a.replyDelay !== 0 && a.replyDelay !== -1);
  const totalCount = activities.length;
  const maxNonImmediate = Math.floor(totalCount * 0.2); // 最多 20%

  if (nonImmediate.length > maxNonImmediate) {
    // Shuffle non-immediate activities and convert excess to immediate
    const shuffled = [...nonImmediate].sort(() => Math.random() - 0.5);
    const toConvert = shuffled.slice(0, nonImmediate.length - maxNonImmediate);
    for (const act of toConvert) {
      act.replyDelay = 0;
    }
    console.log(`[scheduleGen] Converted ${toConvert.length} activities to immediate for 80% rule (${displayName})`);
  }

  // tags 允许规范化；description 已通过非空校验，只做 trim。
  for (const act of activities) {
    act.tags = normalizeTags(act.tags);
    act.description = String(act.description).trim();
  }

  return activities;
}

// ── 时间工具 ──

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * 校验日程活动是否完整覆盖 24 小时（1440 分钟），不允许有空档。
 * 将跨午夜活动拆分为两段，合并区间后检查是否恰好覆盖 [0, 1440)。
 * 允许 1 分钟的端点容差（LLM 偶尔输出 08:01 而非 08:00）。
 */
function checkFullDayCoverage(activities, displayName) {
  const intervals = [];

  for (const act of activities) {
    let s = timeToMinutes(act.startTime);
    let e = timeToMinutes(act.endTime);

    if (s === e) {
      console.warn(`[scheduleGen] Zero-duration activity for ${displayName}: "${act.activity}" ${act.startTime}-${act.endTime}`);
      return false;
    }

    if (e < s) {
      // 跨午夜：拆分为 [s, 1440) 和 [0, e)
      intervals.push([s, 1440]);
      if (e > 0) intervals.push([0, e]);
    } else {
      intervals.push([s, e]);
    }
  }

  // 按起点排序
  intervals.sort((a, b) => a[0] - b[0]);

  // 合并区间
  const merged = [];
  for (const [s, e] of intervals) {
    if (merged.length === 0) {
      merged.push([s, e]);
    } else {
      const last = merged[merged.length - 1];
      if (s <= last[1] + 1) {
        // 允许 1 分钟容差（如 01:00 和 01:01 视为连续）
        last[1] = Math.max(last[1], e);
      } else {
        // 发现空档
        const gapStart = last[1];
        const gapEnd = s;
        const gapMin = gapEnd - gapStart;
        console.warn(
          `[scheduleGen] Schedule gap detected for ${displayName}: ` +
          `${minutesToHhmm(gapStart)} ~ ${minutesToHhmm(gapEnd)} (${gapMin} min gap). ` +
          `After "${findActivityEndingAt(activities, gapStart)}", before "${findActivityStartingAt(activities, gapEnd)}"`
        );
        return false;
      }
    }
  }

  // 检查是否完整覆盖 [0, 1440)
  if (merged.length !== 1 || merged[0][0] > 1 || merged[0][1] < 1439) {
    const coverage = merged.map(([s, e]) => `${minutesToHhmm(s)}-${minutesToHhmm(e)}`).join(', ');
    const uncovered = [];
    if (merged.length === 0) {
      uncovered.push('00:00-24:00（完全无覆盖）');
    } else {
      if (merged[0][0] > 1) uncovered.push(`00:00-${minutesToHhmm(merged[0][0])}`);
      for (let i = 1; i < merged.length; i++) {
        if (merged[i][0] > merged[i - 1][1] + 1) {
          uncovered.push(`${minutesToHhmm(merged[i - 1][1])}-${minutesToHhmm(merged[i][0])}`);
        }
      }
      if (merged[merged.length - 1][1] < 1439) {
        uncovered.push(`${minutesToHhmm(merged[merged.length - 1][1])}-24:00`);
      }
    }
    console.warn(
      `[scheduleGen] Incomplete 24h coverage for ${displayName}: ` +
      `merged=[${coverage}], uncovered=[${uncovered.join(', ')}]`
    );
    return false;
  }

  return true;
}

/** 分钟数 → HH:MM */
function minutesToHhmm(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 查找结束于指定时间（容差 ±2 分钟）的活动名（用于日志） */
function findActivityEndingAt(activities, targetMin) {
  for (const act of activities) {
    const e = timeToMinutes(act.endTime);
    if (Math.abs(e - targetMin) <= 2) return act.activity;
    // 跨午夜情况
    if (e < timeToMinutes(act.startTime) && Math.abs(e + 1440 - targetMin) <= 2) return act.activity;
  }
  return '?';
}

/** 查找开始于指定时间（容差 ±2 分钟）的活动名（用于日志） */
function findActivityStartingAt(activities, targetMin) {
  for (const act of activities) {
    const s = timeToMinutes(act.startTime);
    if (Math.abs(s - targetMin) <= 2) return act.activity;
  }
  return '?';
}

/**
 * 判断两个时间段是否重叠（支持跨午夜）
 * 使用分钟表示法 + 标准化策略：将所有时间映射到 0~1440，
 * 如果 end < start 则 end += 1440；第二个区间同样处理。
 * 然后检查 [s1, e1) 和 [s2, e2) 是否重叠。
 */
function timeRangesOverlap(start1, end1, start2, end2) {
  let s1 = timeToMinutes(start1);
  let e1 = timeToMinutes(end1);
  let s2 = timeToMinutes(start2);
  let e2 = timeToMinutes(end2);

  // 跨午夜修正：end < start 表示跨天，将 end 标准化到同一线性时间轴
  if (e1 <= s1) e1 += 24 * 60;
  if (e2 <= s2) e2 += 24 * 60;

  // 标准区间重叠判断（不含端点接触）：s1 < e2 && s2 < e1
  // 如果 s1...s2 不在同一天，将 s2/e2 也偏移一天再做检查
  if (s1 < e2 && s2 < e1) return true;
  if (e1 > 24 * 60 && s1 < e2 + 24 * 60 && s2 + 24 * 60 < e1) return true;
  if (e2 > 24 * 60 && s1 + 24 * 60 < e2 && s2 < e1 + 24 * 60) return true;

  return false;
}

/**
 * 为角色设置分散式刷新时间（生成 template 后调用）
 * 按 config.features.scheduleRefreshDays（天）排期：
 * 第 N 天的 00:00~04:00 之间随机时刻（N=1 即明天凌晨）
 */
export function assignNextRefreshTime(characterId) {
  const db = getDb();
  // 补齐单个角色沿用全局周期，不改变其他人的下次刷新。
  const cycle = db.prepare('SELECT next_refresh_at FROM schedule_refresh_cycle WHERE id=1').get();
  if (cycle?.next_refresh_at) {
    db.prepare('UPDATE characters SET next_schedule_refresh_at=? WHERE id=?').run(cycle.next_refresh_at, characterId);
    return new Date(cycle.next_refresh_at.replace(' ', 'T') + 'Z');
  }
  const now = new Date();
  const refreshDays = Math.max(1, Math.min(3, config.features.scheduleRefreshDays || 1));
  // 第 refreshDays 天的 00:00（refreshDays=1 → 明天 00:00）
  const target = new Date(now);
  target.setDate(target.getDate() + refreshDays);
  target.setHours(0, 0, 0, 0);
  const randomOffset = Math.floor(Math.random() * 4 * 60 * 60 * 1000); // 0~4h in ms
  const refreshAt = new Date(target.getTime() + randomOffset);

  db.prepare('UPDATE characters SET next_schedule_refresh_at = ? WHERE id = ?')
    .run(toSqlUtc(refreshAt), characterId);

  console.log(`[scheduleGen] Next refresh for char ${characterId}: ${refreshAt.toISOString()}`);
  return refreshAt;
}

/**
 * 为角色创建当天的 daily_schedules 快照（从 template 派生）
 * 「当天」= **程序日期**（推进程序时间之后，快照落在世界钟的那一天；偏移为 0 时即真实今天）
 */
export function snapshotTodaySchedule(characterId) {
  const db = getDb();
  const template = db.prepare('SELECT schedule_json FROM schedule_templates WHERE character_id = ?').get(characterId);
  if (!template) return null;

  const today = getProgramDateKey();
  // 上游 v4.2.0：重排时保留当天已被手动编辑/奇遇占用的活动
  const old = db.prepare('SELECT schedule_json FROM daily_schedules WHERE character_id=? AND schedule_date=?').get(characterId, today);
  let daily = JSON.parse(template.schedule_json);
  if (old) for (const fixed of JSON.parse(old.schedule_json).filter(a => a.edited)) {
    for (const [s, e] of intervals(fixed)) daily = reserveEventTime(daily, fixed, s, e);
  }

  db.prepare(`
    INSERT OR REPLACE INTO daily_schedules (character_id, schedule_date, schedule_json)
    VALUES (?, ?, ?)
  `).run(characterId, today, JSON.stringify(daily));
  // 奇遇时长预留：新快照落地后，把进行中的事件开场活动重新钉回去（上游 v3.9.0）
  reapplyActiveEventSchedule(characterId, db);
  for (const id of refreshResidenceDailySleep(db, characterId)) { invalidateCache(id); syncSleepingState(id); }

  // 清理超过 2 天的旧快照（按程序日期算，跳天之后不会误删/漏删）
  db.prepare(
    `DELETE FROM daily_schedules WHERE character_id = ? AND schedule_date < date(?, '-2 days')`
  ).run(characterId, today);

  // 返回值必须是**重新钉回奇遇开场活动之后**的当日行（上游 v3.9.0 口径）。
  // 本地从 v3.6.2 起漏了这一步，返回的是 template 原始 JSON：
  // 事件占用 +5 分钟（或跨午夜延长）之后，调用方拿到的却是没被占用的旧日程 ——
  // 日程页/当前活动与库里真实快照不一致（2026-10-15 补）。
  // 取不到行时（理论不可能，上面刚 INSERT）回落 template，保持旧行为不炸。
  const row = db.prepare('SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?')
    .get(characterId, today);
  return row?.schedule_json ?? template.schedule_json;
}
