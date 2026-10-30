/**
 * 出刊的坏 JSON 重试（2026-10-17 新建，对应全项目复查 §三-2 的 P1）
 *
 * ## 修的是什么
 *
 * LLM 偶发输出「字符串里含未转义引号 / 裸换行」的坏 JSON（实测 `cn:glm-5.3-flash` 约 1/6 概率，
 * 报 `Expected ',' or '}' after property value`）。上游在 `mediaAvatarDesigner` /
 * `characterReactionPackService` 都有 2 次重试，mediaService 里却**只有 feed 路径**补过
 * （2026-10-14 合并期），另外三种历史形态仍是单发 + 直接 `JSON.parse`：
 *
 *   · `generateWeeklyIssue`（周刊）
 *   · `generatePosterIssue`（海报）
 *   · `generatePortalIssue`（门户）
 *   · `generatePortalSection`（门户板块正文，用户点开才走）
 *
 * ⇒ 老库里这些形态的媒体，手动刷新 / 自动补刊会**偶发静默失败** —— 正是当初给 feed 补重试
 * 要根治的同款问题。
 *
 * ## 修法（收口，不是抄三遍）
 *
 * 四条路径统一走 `generateIssueJson`：第 1 次原参数；解析失败时往对话尾部追加一句
 * 「上次不是合法 JSON」重问一次（temperature 降档）；两次都不行才抛带原因的 Error。
 *
 * ## 本文件钉什么
 *
 *   ① 坏 JSON 第 1 次 ⇒ **自动重试并成功**（四条路径各一条）；
 *   ② 第 2 次提示里必须含转义要求（模型得知道上次错在哪）；
 *   ③ 两次都坏 ⇒ 抛出**带原因**的错误（不许静默吞掉）；
 *   ④ 收口：mediaService 里 `await chatSync` 只剩助手内部那一处（再出现第二处就是缺陷）；
 *   ⑤ 正常 JSON 只调 1 次（别为容错白花一次调用 —— 额度是用户的）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DB_PATH = ':memory:';

// ── 假上游：可编程返回「坏 JSON」或「好 JSON」，并记录每次请求 ──
const responses = [];   // 每项：字符串（原样当 content 回）或对象（JSON.stringify 后回）
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push(JSON.parse(options.body));
  assert.ok(responses.length, `unexpected LLM request: ${url}`);
  const next = responses.shift();
  const content = typeof next === 'string' ? next : JSON.stringify(next);
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  }), { headers: { 'content-type': 'application/json' } });
};
await import('openai/shims/web');

const { getDb, closeDb } = await import('../src/db/index.js');
const { config } = await import('../src/config.js');
const { addClient, removeClient } = await import('../src/services/unifiedStreamBus.js');
const {
  createOutlet, generateMediaBatch, generatePortalSection, listPosts,
} = await import('../src/services/mediaService.js');

config.llm.freeEgg = false;
config.llm._baseURL = 'https://media-retry-test.invalid/v1';
config.llm._apiKey = 'test-only';
config.llm._model = 'stub-model';

after(async () => {
  await new Promise(resolve => setTimeout(resolve, 20));
  closeDb();
});

/** 模型真实会写出来的坏 JSON：某个字符串值里有没转义的引号 */
const BAD_JSON = '{"issue":1,"title":"她说"你好"就走了","lead":"导语","sections":['
  + '{"key":"a","name":"栏目A","lead":"导语A","image_prompt":""},'
  + '{"key":"b","name":"栏目B","lead":"导语B","image_prompt":""},'
  + '{"key":"c","name":"栏目C","lead":"导语C","image_prompt":""},'
  + '{"key":"d","name":"栏目D","lead":"导语D","image_prompt":""}]}';

/**
 * feed 形态的坏 JSON（同一类病：字符串里裸引号 + 末尾截断）。
 * 【2026-10-18 C4 合并修正】原来 feed 那条测试误用了上面的**门户**形态 BAD_JSON：
 * 那是「业务校验失败」（feed 的 normalize 要 posts[].image_prompt），
 * 而上游 v3.9.1 的契约是**业务校验失败立即失败、不重试**（见 mediaOutputFormat.test.js）。
 * 要测「解析失败才重试」就必须用 feed 自己的坏 JSON，否则测的是另一条路径。
 */
const BAD_JSON_FEED = '{"posts":[{"board_index":0,"title":"她说你好就走了","content":"正文",'
  + '"tags":["tag"],"author_type":"anonymous","author_name":"匿名","likes":1,"views":2,"comments":[]';

function portalDraft(issue = 1) {
  return {
    issue, title: '重试回归报', lead: '本期导语',
    sections: ['a', 'b', 'c', 'd'].map(k => ({ key: `column${k}`, name: `栏目${k}`, lead: `导语${k}`, image_prompt: '' })),
  };
}

function weeklyDraft(volume = 1) {
  return {
    volume, kind: '周报', headline: '头条标题', intro: '导语',
    preface: ['前言一'], views: 100,
    columns: [{ name: '栏目一', items: [{ q: '问', answers: [{ speaker: '答者', text: '答' }] }] }],
  };
}

function posterDraft(issueNo = 1) {
  return {
    issueNo, bigTitle: '大标题', hotline: '热线', caption: ['说明'],
    bubbles: ['气泡'], panels: [], views: 100, image_prompt: '',
  };
}

function reset() {
  responses.length = 0;
  requests.length = 0;
}

/** 每次测试前清掉自动排期，避免 maybeAutoGenerate 串场（本文件只跑单次 generateMediaBatch） */
function onlyThisOutlet(outletId) {
  getDb().prepare('UPDATE media_outlets SET enabled = 0 WHERE id != ?').run(outletId);
  getDb().prepare('UPDATE media_outlets SET enabled = 1 WHERE id = ?').run(outletId);
  config.features.mediaAutoMinutes = 0;
}

/**
 * 历史形态（weekly / poster）直接插库。
 *
 * 为什么不能走 createOutlet：它的 `validateOutletLayout` 只放行 `feed` / `portal`
 * （「媒体类型必须为社交平台或数字报刊」）—— 这两种形态是**老库里已有的数据**，
 * 正是 §三-2 说的「老库里 weekly/poster/portal 形态的媒体，手动刷新仍会偶发静默失败」。
 * 测试要复现的正是老数据那条路，所以按老数据的形状插进去。
 */
function seedLegacyOutlet({ name, layout }) {
  const db = getDb();
  db.prepare('UPDATE media_outlets SET enabled = 0').run();
  const id = Number(db.prepare(
    'INSERT INTO media_outlets (name, tagline, prompt, icon, sort_order, enabled, layout) VALUES (?, ?, ?, ?, ?, 1, ?)',
  ).run(name, '老形态', '测试用提示词', '', 999, layout).lastInsertRowid);
  return { id, name, layout };
}

// ── ① 门户（用户点「刷新」最常走的形态） ───────────────────────────────────

test('门户出刊：第 1 次坏 JSON ⇒ 自动重试一次并成功落库', async () => {
  const outlet = createOutlet({ name: '重试·门户', prompt: 'test', layout: 'portal' });
  onlyThisOutlet(outlet.id);
  reset();
  responses.push(BAD_JSON, portalDraft(1));

  const result = await generateMediaBatch({ outletId: outlet.id });
  assert.equal(result.inserted, 1, '重试后必须成功出刊（旧实现这里直接抛）');
  assert.equal(requests.length, 2, '坏 JSON 必须触发第 2 次请求');
  const retry = requests[1].messages;
  assert.ok(
    retry.some(m => m.content.includes('不是合法 JSON')),
    '第 2 次请求要带「上次不是合法 JSON」的提示',
  );
  assert.ok(
    retry.some(m => m.content.includes('转义')),
    '提示里要写明转义要求（模型得知道上次错在哪）',
  );
  assert.ok(requests[1].temperature < requests[0].temperature, '重试要降温（0.9 → 0.7）');
});

test('门户出刊：两次都坏 ⇒ 抛出**带原因**的错误（不静默）', async () => {
  const outlet = createOutlet({ name: '重试·门户两次坏', prompt: 'test', layout: 'portal' });
  onlyThisOutlet(outlet.id);
  reset();
  responses.push(BAD_JSON, BAD_JSON);

  await assert.rejects(
    () => generateMediaBatch({ outletId: outlet.id }),
    (err) => {
      assert.match(err.message, /解析失败（已重试 1 次）/, '错误文案要写明重试过');
      assert.ok(err.message.length > 20, '要带上原因（不是空错误）');
      return true;
    },
  );
  assert.equal(requests.length, 2, '两次都坏就到此为止，不无限重试');
});

// ── ② 周刊 ────────────────────────────────────────────────────────────────

test('周刊出刊（老库形态）：第 1 次坏 JSON ⇒ 自动重试一次并成功落库', async () => {
  const outlet = seedLegacyOutlet({ name: '重试·周刊', layout: 'weekly' });
  reset();
  responses.push(BAD_JSON, weeklyDraft(1));

  const result = await generateMediaBatch({ outletId: outlet.id });
  assert.equal(result.inserted, 1, '重试后必须成功出刊');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.content.includes('不是合法 JSON')));
});

// ── ③ 海报 ────────────────────────────────────────────────────────────────

test('海报出刊（老库形态）：第 1 次坏 JSON ⇒ 自动重试一次并成功落库', async () => {
  const outlet = seedLegacyOutlet({ name: '重试·海报', layout: 'poster' });
  reset();
  responses.push(BAD_JSON, posterDraft(1));

  const result = await generateMediaBatch({ outletId: outlet.id });
  assert.equal(result.inserted, 1, '重试后必须成功出刊');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.content.includes('不是合法 JSON')));
});

// ── ④ feed（2026-10-14 补过的那条，收口后行为不得回归） ────────────────────

test('feed 出刊：第 1 次坏 JSON ⇒ 仍自动重试一次并成功（收口后行为不变）', async () => {
  const outlet = createOutlet({
    name: '重试·feed', prompt: 'test', layout: 'feed',
    boards: [{ name: '板块一', prompt: '聊日常' }],
  });
  onlyThisOutlet(outlet.id);
  reset();
  const good = {
    posts: [{
      board_index: 0, title: '标题', content: '正文内容', tags: ['tag'],
      author_type: 'anonymous', author_name: '匿名', likes: 1, views: 2, comments: [],
      image_prompt: 'A quiet street corner in the afternoon light',
    }],
  };
  responses.push(BAD_JSON_FEED, good);

  const result = await generateMediaBatch({ outletId: outlet.id, count: 1, withCharacters: false });
  assert.equal(result.inserted, 1, '重试后必须成功出刊');
  // 只数「出刊 LLM」这两次：这条 good 带 image_prompt 才会触发出图，
  // 出图走的是另一个 fetch（若也计入就会变成 3，断言会误伤）。
  const llmCalls = requests.filter(r => Array.isArray(r.messages));
  assert.equal(llmCalls.length, 2);
  assert.ok(llmCalls[1].messages.some(m => m.content.includes('不是合法 JSON')));
});

// ── ⑤ 门户板块正文（用户点开才走） ────────────────────────────────────────

test('门户板块正文：第 1 次坏 JSON ⇒ 自动重试一次并成功', async () => {
  const outlet = createOutlet({ name: '重试·板块正文', prompt: 'test', layout: 'portal' });
  onlyThisOutlet(outlet.id);
  reset();
  responses.push(portalDraft(1));
  const { postId } = await generateMediaBatch({ outletId: outlet.id });

  reset();
  // 板块正文的块类型是 p / qa / rank / replies / caption（见 normalizeSectionBlocks）
  const goodBody = { blocks: [{ type: 'p', text: '正文一段' }] };
  responses.push(BAD_JSON, goodBody);
  const section = await generatePortalSection(postId, 'columna');
  assert.equal(section.ok, true, '重试后板块正文要生成成功');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(m => m.content.includes('不是合法 JSON')));
});

// ── ⑥ 正常路径只花一次调用（别为容错白花额度） ────────────────────────────

test('正常 JSON 只调 1 次模型（容错不许变成常态多花额度）', async () => {
  const outlet = createOutlet({ name: '重试·正常', prompt: 'test', layout: 'portal' });
  onlyThisOutlet(outlet.id);
  reset();
  responses.push(portalDraft(1));

  const result = await generateMediaBatch({ outletId: outlet.id });
  assert.equal(result.inserted, 1);
  assert.equal(requests.length, 1, '正常 JSON 不得触发重试');
  assert.equal(listPosts({ outletId: outlet.id }).total >= 0, true);
});

// ── ⑦ 收口：唯一实现 ──────────────────────────────────────────────────────

test('收口：mediaService 里 await chatSync 只剩 generateIssueJson 内部那一处', () => {
  const src = readFileSync(new URL('../src/services/mediaService.js', import.meta.url), 'utf8');
  const hits = src.match(/await chatSync\(/g) || [];
  assert.equal(hits.length, 1, `出刊的 LLM 调用必须只经 generateIssueJson（实测 ${hits.length} 处）`);
  assert.match(src, /async function generateIssueJson\(/, '要有收口助手');
  // 四条出刊路径都要走它
  const calls = src.match(/await generateIssueJson\(\{/g) || [];
  assert.equal(calls.length, 5, `门户/周刊/海报/feed/板块正文 五处都要走助手（实测 ${calls.length} 处）`);
});
