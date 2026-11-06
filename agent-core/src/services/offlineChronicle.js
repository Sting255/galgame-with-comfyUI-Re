/**
 * offlineChronicle.js —— 离线世界编年（2026-11-06）
 *
 * 用户关机期间世界无法运行，所以「离线期间发生了什么」只能在**回来时一次性补算**：
 *   心跳记录上次在线 → 启动时算真实时间差 → 按 6 小时切片 → 逐片串行生成（后一片读前一片的结局）
 *   → 写进世界时间轴与角色记忆 → 回来后角色能提起、日报能看到。
 *
 * 三条硬边界：
 *   1. 只认真实时间差，不碰程序时间（世界钟被手动推进时不与它打架）；
 *   2. 分片是**串行**的，前一片的结局是后一片的输入，所以补出来是一条因果线而不是各自随机；
 *   3. 全程 try/catch + 单实例锁 + source_id 幂等，失败只 warn，绝不阻塞启动与聊天。
 */
import { getDb, getWorldSetting } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { chatSync } from '../llm/llm-client.js';
import { extractFirstJson } from './jsonExtract.js';
import { recordWorldTimeline, recentWorldTimeline } from './worldTimeline.js';
import { applyMemoryActions } from './memory/memoryRepository.js';
import { config } from '../config.js';

const HEARTBEAT_KEY = 'runtime.last_seen_at';
const MIN_GAP_MS = 3 * 3600_000;      // 3 小时以内当作连续，不补
const CHUNK_MS = 6 * 3600_000;        // 每片 6 小时
const MAX_CHUNKS = 4;                 // 最多精细补 24 小时
const HEARTBEAT_THROTTLE_MS = 10 * 60_000;
const MAX_CHARACTERS = 6;

let lastWriteAt = 0;
let running = false;

/* ── 心跳 ── */

/** 任意 API 请求调用；10 分钟节流写一次 */
export function touchLastSeen(force = false) {
  const now = Date.now();
  if (!force && now - lastWriteAt < HEARTBEAT_THROTTLE_MS) return;
  lastWriteAt = now;
  try {
    setSetting(HEARTBEAT_KEY, new Date(now).toISOString());
  } catch (err) {
    console.warn('[offline] heartbeat write failed:', err?.message || err);
  }
}

/** 读上次在线时间，带兜底：心跳缺失/异常时取最后一条消息或时间轴 */
export function readLastSeen() {
  try {
    const raw = getSetting(HEARTBEAT_KEY);
    const parsed = raw ? new Date(raw) : null;
    if (parsed && Number.isFinite(parsed.getTime()) && parsed.getTime() <= Date.now()) return parsed;
  } catch { /* 继续走兜底 */ }
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT MAX(t) AS t FROM (
        SELECT MAX(created_at) AS t FROM messages
        UNION ALL SELECT MAX(at) FROM world_timeline
      )
    `).get();
    const parsed = row?.t ? new Date(row.t) : null;
    if (parsed && Number.isFinite(parsed.getTime()) && parsed.getTime() <= Date.now()) return parsed;
  } catch { /* 忽略 */ }
  return null;
}

/* ── 分片 ── */

/**
 * 把离线区间切成若干片。
 * @returns {{shouldRun:boolean, chunks:Array<{index:number,from:Date,to:Date}>, tail:{from:Date,to:Date,days:number}|null, gapHours:number}}
 */
export function planOfflineChunks(now = new Date(), lastSeen = null, opts = {}) {
  const minGap = opts.minGapMs ?? MIN_GAP_MS;
  const chunkMs = opts.chunkMs ?? CHUNK_MS;
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS;
  const empty = { shouldRun: false, chunks: [], tail: null, gapHours: 0 };
  if (!(lastSeen instanceof Date) || !Number.isFinite(lastSeen.getTime())) return empty;
  const gapMs = now.getTime() - lastSeen.getTime();
  if (gapMs < minGap) return { ...empty, gapHours: +(gapMs / 3600_000).toFixed(1) };

  const chunks = [];
  let cursor = lastSeen.getTime();
  const hardEnd = lastSeen.getTime() + maxChunks * chunkMs;
  const end = Math.min(now.getTime(), hardEnd);
  while (cursor < end) {
    const to = Math.min(cursor + chunkMs, end);
    chunks.push({ index: chunks.length + 1, from: new Date(cursor), to: new Date(to) });
    cursor = to;
  }
  // 超过 24 小时：剩余部分合成一条概况
  const tail = cursor < now.getTime()
    ? { from: new Date(cursor), to: now, days: +((now.getTime() - cursor) / 86400_000).toFixed(1) }
    : null;
  return { shouldRun: true, chunks, tail, gapHours: +(gapMs / 3600_000).toFixed(1) };
}

/* ── 上下文 ── */

function loadCharacters(limit = MAX_CHARACTERS) {
  try {
    return getDb().prepare(`
      SELECT id, display_name, name, short_prompt, base_prompt
      FROM characters WHERE name != 'default'
      ORDER BY id ASC LIMIT ?
    `).all(limit) || [];
  } catch { return []; }
}

function buildTimelineDigest(limit = 10) {
  const rows = recentWorldTimeline(limit, { hours: 24 * 30 });
  if (!rows.length) return '（这段时间世界很安静，没有记录在案的大事）';
  return rows.map(row => `- ${String(row.at || '').slice(0, 16).replace('T', ' ')}｜${row.title}：${row.summary}`).join('\n');
}

function fmt(date) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 16);
}

/* ── 提示词 ── */

function buildChunkPrompt({ from, to, prevSummary, digest, characters, worldSetting, recentRows = [], prevLead = '' }) {
  const roster = characters.map(c => `- ${c.display_name}`).join('\n');
  // 反同质化（2026-11-06）：片间只传摘要会让每一片都长成"她一个人深夜做点什么"。
  // 最近几次的题材明确列出来，并且用关键词统计做一次确定性推动。
  const guardLines = [];
  if (prevLead) guardLines.push(`上一段的主角的「${prevLead}」，本片第一件事必须换一个人来做（不要还是她）。`);
  if (recentRows.length) {
    guardLines.push(`最近几次已经写过这些题材（不要再用同类结构、同类开场）：${recentRows.map(r => `「${r.title}」`).join('、')}`);
    const lonely = recentRows.filter(r => /独自|一个人|独处|孤独|单独|没人/.test(`${r.title}${r.summary || ''}`)).length;
    if (lonely >= 2) {
      guardLines.push('最近几段都是角色一个人待着做事：本片【必须】至少有一件事是两个人一起做的（可以是偶遇、帮忙、争执），并且换一个场所、换一个时间段。');
    }
  }
  const system = [
    '你在为一个架空世界补写「玩家不在时发生过什么」。这是事后编年：只补世界与角色自己的经历，不补玩家在场的事。',
    worldSetting ? `<world_setting>\n${worldSetting}\n</world_setting>` : '',
    `主要角色：\n${roster}`,
    '<已发生的事实（不得改写）>\n' + digest,
    prevSummary ? '<上一段的结尾>\n' + prevSummary : '',
    guardLines.length ? '<反重复要求>\n' + guardLines.join('\n') : '',
    '硬性约束：',
    '1. 只写这一段时间区间内发生的事；不写玩家出现或参与的情节；',
    '2. 不得与「已发生的事实」冲突，也不要重复已被记录的事件；',
    '3. 事件要具体、有场景、有结果（谁、在哪、发生了什么、后来怎样），不要写总结式空话；',
    '4. 角色心境要贴着该角色的性格与处境写，一句话，不要写成旁白。',
  ].filter(Boolean).join('\n\n');

  const user = [
    `时间区间：${fmt(from)} ～ ${fmt(to)}（当地时间，共 ${Math.round((to - from) / 3600_000)} 小时）`,
    '请按下面的 JSON 格式严格输出，不要任何解释或 JSON 以外的文字：',
    `{
  "period": "${fmt(from)} ～ ${fmt(to)}",
  "events": [
    { "title": "事件标题，15 字以内", "summary": "发生了什么：谁/在哪/做了什么/结果如何，60~120 字" },
    { "title": "第二件事的标题", "summary": "第二件事的具体经过，60~120 字" }
  ],
  "moods": [
    { "character": "角色显示名，必须是上面名单里的名字", "mood": "这段时间她的心境，一句话 30 字以内", "note": "具体缘由，40 字以内" }
  ]
}`,
    '要求：events 1~3 条；moods 只给这段区间里真的有经历的角色，0~3 条；没有角色经历就返回空数组。',
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/* ── 生成一片 ── */

async function generateChunk({ chunk, prevSummary, digest, characters, worldSetting, recentRows = [], prevLead = '' }) {
  const messages = buildChunkPrompt({ from: chunk.from, to: chunk.to, prevSummary, digest, characters, worldSetting, recentRows, prevLead });
  const raw = await chatSync(messages, { temperature: 0.95, max_tokens: 900, label: '离线编年', retries: 1 });
  // 注意：extractFirstJson 返回的是**字符串**（括号配平后的片段），还需要再 parse 一次
  const jsonText = extractFirstJson(raw || '');
  let data = null;
  if (jsonText) {
    try { data = JSON.parse(jsonText); } catch { data = null; }
  }
  if (!data) return null;
  const events = Array.isArray(data.events) ? data.events.filter(e => e && e.title).slice(0, 3) : [];
  const moods = Array.isArray(data.moods) ? data.moods.filter(m => m && m.character && m.mood).slice(0, 3) : [];
  if (!events.length && !moods.length) return null;
  // 本片主角（第一件事里出现的那位）：下一片要求换人，避免整晚都是同一个人的独处
  const firstText = `${events[0]?.title || ''}${events[0]?.summary || ''}`;
  const lead = characters.find(c => c.display_name && firstText.includes(c.display_name))?.display_name || '';
  return { events, moods, lead };
}

/* ── 记忆与落库 ── */

function writeCharacterMemory(character, { from, to, mood, note, events }) {
  try {
    const label = fmt(from) + '～' + fmt(to).slice(11);
    const eventText = events.map(e => `「${e.title}」${e.summary}`).join('；');
    const judgment = `那段时间（${label}，用户不在）${mood}${note ? `：${note}` : ''}${eventText ? `。当时发生的事：${eventText.slice(0, 120)}` : ''}`;
    applyMemoryActions({
      conversationId: `char_${character.id}`,
      sourceRawStartId: null,
      sourceRawEndId: null,
      sourceMessageId: null,
      dedupeKey: `offline:${character.id}:${fmt(from)}`,
      actions: [{
        action: 'create',
        memory: {
          memoryType: 'event',
          subject: 'character',
          judgment: judgment.slice(0, 300),
          reasoning: '关机期间由离线编年补记',
          tags: ['离线', '补记'],
        },
      }],
    });
  } catch (err) {
    console.warn(`[offline] memory write failed for ${character.display_name}:`, err?.message || err);
  }
}

/**
 * 补记发一条朋友圈（2026-11-06）：内容直接取补算结果，不再调模型、不配图。
 * - created_at 用本片结束时刻，让它在朋友圈时间线上落在正确的过去位置；
 * - god_delivery_key 做幂等（同一片重复补算不会多一条）；
 * - style='离线补记' 是给"缺图补印"逻辑的排除标记（这种帖子本来就没有图）。
 */
function publishOfflineMoment(character, { chunk, events = [], mood = null }) {
  try {
    const db = getDb();
    const key = `offline:${chunk.from.toISOString()}`;
    if (db.prepare('SELECT id FROM moment_posts WHERE god_delivery_key = ?').get(key)) return null;
    // 心境与事件之间要有句读，否则会读成"怀念，又觉得现在也还行 林晚在租住的公寓里…"
    const moodText = mood?.mood ? (/[。！？…」]$/.test(mood.mood) ? mood.mood : `${mood.mood}。`) : '';
    const text = [moodText, events[0]?.summary].filter(Boolean).join(' ').trim().slice(0, 120);
    if (!text) return null;
    const resolution = `${config.comfyui?.momentsWidth || 768}x${config.comfyui?.momentsHeight || 512}`;
    // style 是"画师串"字段，不能被标记占用 —— 补记帖子靠 god_delivery_key 的 offline: 前缀识别
    const id = db.prepare(`
      INSERT INTO moment_posts (character_id, content, prompt, style, resolution, status, god_delivery_key, created_at)
      VALUES (?, ?, '', '', ?, 'done', ?, ?)
    `).run(Number(character.id), text, resolution, key, chunk.to.toISOString()).lastInsertRowid;
    console.log(`[offline] moment published: ${character.display_name}「${text.slice(0, 20)}」`);
    return Number(id);
  } catch (err) {
    console.warn('[offline] moment publish failed:', err?.message || err);
    return null;
  }
}

function persistChunk(chunk, data, characters) {
  const title = data.events[0]?.title || '那段时间';
  const summary = data.events.map(e => `「${e.title}」${e.summary}`).join('；').slice(0, 200);
  recordWorldTimeline({
    kind: 'offline',
    title,
    summary,
    characterIds: characters.map(c => c.id),
    sourceId: `offline:${chunk.from.toISOString()}`,
    at: chunk.to.toISOString(),
  });
  const byName = new Map(characters.map(c => [c.display_name, c]));
  for (const mood of data.moods) {
    const character = byName.get(mood.character);
    if (!character) continue;
    writeCharacterMemory(character, { from: chunk.from, to: chunk.to, mood: mood.mood, note: mood.note, events: data.events });
  }
  // 发帖人必须和内容同一个人：title 点明主角，先认 title；没有再看正文里谁被提得最多。
  // （按数组顺序 find 会踩坑：正文里"周焰挂断林晚那通电话"会先命中林晚，判定错人。）
  const firstEvent = data.events[0] || {};
  const titleText = String(firstEvent.title || '');
  const summaryText = String(firstEvent.summary || '');
  const inTitle = characters.find(c => c.display_name && titleText.includes(c.display_name)) || null;
  const byCount = characters
    .map(c => ({ c, n: c.display_name ? Math.max(0, summaryText.split(c.display_name).length - 1) : 0 }))
    .filter(item => item.n > 0)
    .sort((a, b) => b.n - a.n)[0]?.c || null;
  const moodCharacters = data.moods.map(m => byName.get(m.character)).filter(Boolean);
  const rotated = characters[(Math.max(1, chunk.index) - 1) % characters.length];
  const moodOwner = inTitle || byCount || moodCharacters[0] || rotated;
  if (moodOwner) {
    // 心境只在确实属于她时才带上，避免"周焰的心里话配林晚的事"
    const ownerMood = data.moods.find(m => m.character === moodOwner.display_name) || null;
    publishOfflineMoment(moodOwner, { chunk, events: data.events, mood: ownerMood });
  }
}

/* ── 主流程 ── */

/**
 * 补算离线期间。启动后延迟调用，失败只 warn。
 * @returns {Promise<{ran:boolean, chunks:number, reason?:string}>}
 */
export async function runOfflineBackfill({ now = new Date(), lastSeen = undefined } = {}) {
  if (running) return { ran: false, chunks: 0, reason: 'already_running' };
  let plan;
  try {
    plan = planOfflineChunks(now, lastSeen === undefined ? readLastSeen() : lastSeen);
  } catch (err) {
    console.warn('[offline] plan failed:', err?.message || err);
    return { ran: false, chunks: 0, reason: 'plan_failed' };
  }
  if (!plan.shouldRun) {
    touchLastSeen(true);
    return { ran: false, chunks: 0, reason: 'below_threshold' };
  }

  running = true;
  try {
    const characters = loadCharacters();
    if (!characters.length) {
      console.warn('[offline] 没有可编年的角色，跳过');
      return { ran: false, chunks: 0, reason: 'no_characters' };
    }
    const worldSetting = (() => { try { return getWorldSetting() || ''; } catch { return ''; } })();
    const digest = buildTimelineDigest();
    // 最近 3 条用于反同质化（第一片之前就有历史时同样生效）
    const recentRows = recentWorldTimeline(3, { hours: 24 * 30 });
    console.log(`[offline] 开始补算：离线 ${plan.gapHours}h，${plan.chunks.length} 片${plan.tail ? ' + 1 条概况' : ''}`);

    let prevSummary = '';
    let prevLead = '';
    let written = 0;
    for (const chunk of plan.chunks) {
      try {
        const data = await generateChunk({ chunk, prevSummary, digest, characters, worldSetting, recentRows, prevLead });
        if (!data) { console.warn(`[offline] 第 ${chunk.index} 片没有可用输出，跳过`); continue; }
        persistChunk(chunk, data, characters);
        written += 1;
        prevSummary = data.events.map(e => `${e.title}：${e.summary}`).join('；').slice(0, 300);
        prevLead = data.lead || prevLead;
        // 本片也进反重复名单：否则同一次补算的 4 片之间会互相重复
        recentRows.unshift({ title: data.events[0]?.title || '', summary: data.events.map(e => e.summary).join('；') });
        if (recentRows.length > 5) recentRows.length = 5;
      } catch (err) {
        console.warn(`[offline] 第 ${chunk.index} 片生成失败:`, err?.message || err);
      }
      await new Promise(resolve => setTimeout(resolve, 1200));   // 片间留间隔，别打满
    }

    if (plan.tail) {
      try {
        const summary = `你不在的这段时间（约 ${plan.tail.days} 天）：${prevSummary || '世界照常运转，没什么特别的事'}`;
        recordWorldTimeline({
          kind: 'offline_summary',
          title: '这段时间的概况',
          summary,
          characterIds: characters.map(c => c.id),
          sourceId: `offline:summary:${plan.tail.from.toISOString().slice(0, 10)}`,
          at: plan.tail.to.toISOString(),
        });
        written += 1;
      } catch (err) {
        console.warn('[offline] 概况写入失败:', err?.message || err);
      }
    }

    touchLastSeen(true);
    setSetting('runtime.offline_backfilled_at', now.toISOString());
    console.log(`[offline] 补算完成：写入 ${written} 条`);
    return { ran: true, chunks: written };
  } catch (err) {
    console.warn('[offline] backfill failed:', err?.message || err);
    return { ran: false, chunks: 0, reason: 'failed' };
  } finally {
    running = false;
  }
}

/* ── 给聊天的提示块 ── */

const NOTICED_KEY = 'runtime.offline_notice_id';

/** 取一条还没被提过的离线记录（默认全局；传 scopeKey 可让私聊/各群各自提一次） */
export function takeOfflineNoticeFor(scopeKey = 'global') {
  try {
    const key = `${NOTICED_KEY}:${String(scopeKey || 'global')}`;
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const noticedId = Number(getSetting(key) || 0);
    const row = getDb().prepare(`
      SELECT id, title, summary, at FROM world_timeline
      WHERE kind IN ('offline','offline_summary') AND id > ? AND at >= ?
      ORDER BY id ASC LIMIT 1
    `).get(noticedId, since);
    if (!row) return '';
    setSetting(key, row.id);
    return `<offline_notice>\n用户离开过一段时间，这期间发生过：${row.title}——${row.summary}\n可以自然提起这件事（只说一次，不要复述整段，也不要说成用户在场时发生的）。\n</offline_notice>`;
  } catch {
    return '';
  }
}

/** 兼容旧调用：全局只提一次 */
export function takeOfflineNotice() {
  return takeOfflineNoticeFor('global');
}

/** 测试用：清掉锁与节流（仅供手动脚本） */
export function __resetOfflineStateForTest() {
  running = false;
  lastWriteAt = 0;
}

export const OFFLINE_HEARTBEAT_KEY = HEARTBEAT_KEY;
export const OFFLINE_NOTICED_KEY = NOTICED_KEY;
