/**
 * 亲密推进动作的**独立每日配额**（2026-10-15 补）
 *
 * 背景：性爱动作的「立刻反馈」要求每一下都过一次模型（`routes/intimateActions.js` ⑤，
 * 一次 500 token 的小调用）—— 连点推进 / 开自动插送时这是唯一真的花钱的地方。
 * 之前只有两个刹车，都不合适：`features.touchInstant=false` 是触摸系统的总开关（管不到性爱动作，
 * 一关全哑）；触摸的 `touch_instant_daily_limit` 是触摸自己的账（混用会互相吃额度）。
 *
 * 覆盖：
 *   1. 默认 200 次/天；0 = 不限制（remaining=null、exhausted 恒 false）；
 *   2. 非法值：PUT /api/config/intimate-action-quota 的 -1 / 1.5 / 字符串 / 缺失 → 400；
 *      GET /api/config 顶层多一个 intimateActionQuota 对象，PUT 返回同一形状；
 *   3. 额度用完：**一次模型都不调**，状态照常推进 + mode='implicit' + quotaExhausted=true + notice 是人话；
 *   4. 计数落 system_settings（按本地日期，一行 { date, used }）：同一天的计数在**关库重开**后仍在；
 *      跨天自动归零；
 *   5. 真要点模型之前才扣（解析失败也扣过一次，与 touch / aiJudge 同口径）；
 *   6. GET /api/intimate-actions/:id/state 回带 quota（面板据此显示"今天还能点几下"）。
 *
 * 环境约定：DB_PATH 指向 mkdtemp 出来的临时文件库（真实库 agent.db 不在访问范围）；
 * 先设环境变量再动态 import；LLM 用可注入的假调用，fetch 只挡非本机地址。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-intimate-quota-'));
const DB_PATH = path.join(TMP, 'agent.db');
process.env.DB_PATH = DB_PATH;
process.env.LOG_TO_FILE = 'false';
// 只挡**非本机**地址（与 test/setup.mjs 同口径）：本机 127.0.0.1 是给下面起的验证服务用的。
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const text = String(url);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(text)) return realFetch(url, opts);
  throw new Error(`intimate quota fixture forbids network: ${text}`);
};

const { config } = await import('../src/config.js');
config.dbPath = DB_PATH;
const { getDb, closeDb } = await import('../src/db/index.js');
const quota = await import('../src/services/intimateActionQuota.js');
const configRoutes = (await import('../src/routes/config.js')).default;
const intimateActionsRoutes = (await import('../src/routes/intimateActions.js')).default;
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');

const app = express();
app.use(express.json());
app.use('/api/config', wrapRouterAsync(configRoutes));
// 挂载路径与 app.js 一致：亲密推进在 /api/intimate-actions（不在 /api/characters 下）
app.use('/api/intimate-actions', wrapRouterAsync(intimateActionsRoutes));

const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { closeDb(); } catch { /* 已关 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

const get = async (url) => {
  const res = await fetch(`${BASE}${url}`);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};
const put = async (url, payload) => {
  const res = await fetch(`${BASE}${url}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

/** 清掉配额计数与上限设置（每个绝对值的用例先调它） */
function resetQuotaRows() {
  const db = getDb();
  db.prepare('DELETE FROM system_settings WHERE setting_key IN (?, ?)').run(
    quota.INTIMATE_ACTION_QUOTA_SETTING_KEY,
    quota.INTIMATE_ACTION_LIMIT_SETTING_KEY
  );
  quota.__resetIntimateActionQuotaForTest();
}

/** 造一个成年角色档案（本模块只服务成年档案，字段与既有 intimate 测试同口径） */
function seedCharacter(id = 1) {
  const db = getDb();
  db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  db.prepare(
    `INSERT INTO characters (id, name, display_name, base_prompt, short_prompt)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, `quota_char_${id}`, `推进配额${id}`, '你是她。', '她是她。');
  return id;
}

// ── ① 归一化与默认值 ─────────────────────────────────────────────────────

test('normalizeIntimateActionDailyLimit：0 与正整数合法，其余 null（与 aiJudge 逐字同口径）', () => {
  assert.equal(quota.normalizeIntimateActionDailyLimit(0), 0);
  assert.equal(quota.normalizeIntimateActionDailyLimit('200'), 200);
  assert.equal(quota.normalizeIntimateActionDailyLimit(7), 7);
  for (const bad of [-1, 1.5, 'abc', '', null, undefined, true, {}, [], '  ']) {
    assert.equal(quota.normalizeIntimateActionDailyLimit(bad), null, `${JSON.stringify(bad)} 应判非法`);
  }
});

test('默认上限 200；0 = 不限制（remaining=null、exhausted 恒 false）', () => {
  resetQuotaRows();
  const status = quota.getIntimateActionQuotaStatus();
  assert.equal(status.dailyLimit, quota.DEFAULT_INTIMATE_ACTION_DAILY_LIMIT);
  assert.equal(status.dailyLimit, 200, '默认 200 次/天');
  assert.equal(status.usedToday, 0);
  assert.equal(status.remaining, 200);
  assert.equal(status.unlimited, false);
  assert.equal(status.exhausted, false);

  const unlimited = quota.buildIntimateActionQuotaStatus(0, 99999);
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.remaining, null, '不限制时剩余次数没有意义，如实给 null');
  assert.equal(unlimited.exhausted, false, '不限制时永远不耗尽');
});

// ── ② 接口：GET 顶层对象 + PUT 校验 ─────────────────────────────────────

test('GET /api/config 顶层带 intimateActionQuota（与 aiJudge 同形状）', async () => {
  resetQuotaRows();
  const { status, body } = await get('/api/config');
  assert.equal(status, 200);
  assert.ok(body.intimateActionQuota, '顶层要有 intimateActionQuota');
  for (const key of ['dailyLimit', 'usedToday', 'remaining', 'unlimited']) {
    assert.ok(key in body.intimateActionQuota, `缺字段 ${key}`);
  }
  assert.equal(body.intimateActionQuota.dailyLimit, 200);
});

test('PUT /api/config/intimate-action-quota：合法值落库，非法值 400', async () => {
  resetQuotaRows();
  const ok = await put('/api/config/intimate-action-quota', { dailyLimit: 5 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.dailyLimit, 5);
  assert.equal(ok.body.intimateActionQuota.dailyLimit, 5, '既嵌在 intimateActionQuota 下');
  assert.equal(quota.getIntimateActionDailyLimit(), 5, '真落库');

  for (const bad of [-1, 1.5, '10', null, undefined, true, {}]) {
    const res = await put('/api/config/intimate-action-quota', { dailyLimit: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} 应 400`);
  }
  const missing = await put('/api/config/intimate-action-quota', {});
  assert.equal(missing.status, 400, '缺字段应 400');

  // 0 = 不限制，是合法值
  const zero = await put('/api/config/intimate-action-quota', { dailyLimit: 0 });
  assert.equal(zero.status, 200);
  assert.equal(zero.body.unlimited, true);
  resetQuotaRows();
});

// ── ③ 计数：落库、跨天归零、关库重开仍在 ─────────────────────────────────

test('计数落 system_settings：同一天关库重开后仍在；跨天自动归零', async () => {
  resetQuotaRows();
  await put('/api/config/intimate-action-quota', { dailyLimit: 10 });

  quota.consumeIntimateActionQuota();
  quota.consumeIntimateActionQuota();
  assert.equal(quota.getIntimateActionUsedToday(), 2);

  // 关库重开（模拟重启）：计数应从库里读回来
  const { closeDb: close, getDb: reopen } = await import('../src/db/index.js');
  close();
  reopen();
  quota.__resetIntimateActionQuotaForTest();   // 清内存兜底，只剩库里的值
  assert.equal(quota.getIntimateActionUsedToday(), 2, '重启后计数不重置');

  // 跨天：把计数行的日期改成昨天 → 今天读回来是 0
  getDb().prepare('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?')
    .run(JSON.stringify({ date: '2000-01-01', used: 7 }), quota.INTIMATE_ACTION_QUOTA_SETTING_KEY);
  quota.__resetIntimateActionQuotaForTest();
  assert.equal(quota.getIntimateActionUsedToday(), 0, '跨天自动归零');
  resetQuotaRows();
});

test('consume 到上限后 exhausted=true、remaining=0', () => {
  resetQuotaRows();
  quota.setIntimateActionDailyLimit(3);
  assert.equal(quota.getIntimateActionQuotaStatus().remaining, 3);
  quota.consumeIntimateActionQuota();
  quota.consumeIntimateActionQuota();
  const third = quota.consumeIntimateActionQuota();
  assert.equal(third.usedToday, 3);
  assert.equal(third.remaining, 0);
  assert.equal(third.exhausted, true);
  resetQuotaRows();
});

// ── ④ 路由：额度用完不调模型、状态照常推进 ───────────────────────────────

test('额度用完：一次模型都不调，但状态照常推进 + mode=implicit + 人话提示', async () => {
  resetQuotaRows();
  const id = seedCharacter(1);
  // 上限 1，且已用 1 ⇒ 立刻耗尽
  quota.setIntimateActionDailyLimit(1);
  quota.consumeIntimateActionQuota();

  // 路由内的 chatSync 是模块级 import，无法直接替换 ⇒ 用「真调模型会被 fetch 桩挡住」来证明没调：
  // 若真调了，反应不会是 implicit、也不会有 quotaExhausted 标记。
  const res = await fetch(`${BASE}/api/intimate-actions/${id}/enter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.allowed, true, '额度用完不哑玩法：这一下仍然允许');
  assert.equal(body.quotaExhausted, true, '要明确告诉前端是配额耗尽');
  assert.equal(body.mode, 'implicit', '走「省额度模式」同一个出口');
  assert.ok(body.quota, '要回带 quota');
  assert.equal(body.quota.exhausted, true);
  assert.equal(body.quota.usedToday, 1);
  assert.match(String(body.notice || ''), /额度已用完/, 'notice 要是人话');
  assert.match(String(body.notice || ''), /1\/1/, '要说清用了几次/上限');
  assert.equal(body.reaction, null, '没调模型 ⇒ 没有反应');
  resetQuotaRows();
});

test('未耗尽时走即时反应分支（不报 quotaExhausted）', async () => {
  resetQuotaRows();
  const id = seedCharacter(2);
  quota.setIntimateActionDailyLimit(10);
  const res = await fetch(`${BASE}/api/intimate-actions/${id}/enter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.allowed, true);
  assert.equal(body.quotaExhausted, undefined, '没耗尽时不该带这个标记');
  assert.notEqual(body.mode, 'implicit', '没耗尽时不该走省额度出口');
  resetQuotaRows();
});

// ── ⑤ GET state 回带 quota ───────────────────────────────────────────────

test('GET /api/intimate-actions/:id/state 回带 quota（面板据此显示剩余）', async () => {
  resetQuotaRows();
  const id = seedCharacter(3);
  quota.setIntimateActionDailyLimit(20);
  quota.consumeIntimateActionQuota();
  const { status, body } = await get(`/api/intimate-actions/${id}/state`);
  assert.equal(status, 200);
  assert.ok(body.quota, 'state 要带 quota');
  assert.equal(body.quota.dailyLimit, 20);
  assert.equal(body.quota.usedToday, 1);
  assert.equal(body.quota.remaining, 19);
  resetQuotaRows();
});

// ── ⑥ 源码守卫：扣额度的位置在真调模型之前 ───────────────────────────────

test('源码守卫：consume 在 chatSync 之前（解析失败也不白扣、耗尽时压根不扣）', () => {
  const src = fs.readFileSync(new URL('../src/routes/intimateActions.js', import.meta.url), 'utf8');
  const consumeIdx = src.indexOf('quotaAfter = consumeIntimateActionQuota()');
  const chatIdx = src.indexOf("label: 'intimate-action'");
  assert.ok(consumeIdx > 0, '要真的调用 consumeIntimateActionQuota');
  assert.ok(chatIdx > 0, '找不到即时反应的 chatSync 调用');
  assert.ok(consumeIdx < chatIdx, '扣额度必须在真正发模型请求之前');
  // 耗尽分支必须在扣额度之前（否则会白扣一次）
  const exhaustIdx = src.indexOf('if (quotaBefore.exhausted)');
  assert.ok(exhaustIdx > 0, '要有耗尽早退分支');
  assert.ok(exhaustIdx < consumeIdx, '耗尽早退必须在扣额度之前');
});

test('源码守卫：耗尽分支不哑玩法（allowed 仍为 true，走 implicit 出口）', () => {
  const src = fs.readFileSync(new URL('../src/routes/intimateActions.js', import.meta.url), 'utf8');
  const start = src.indexOf('if (quotaBefore.exhausted)');
  const block = src.slice(start, start + 1400);
  assert.match(block, /mode: 'implicit'/, '走省额度模式出口');
  assert.match(block, /quotaExhausted: true/, '要带标记');
  assert.match(block, /\.\.\.baseResponse/, '仍要回带 allowed:true 的 baseResponse（状态已推进）');
  assert.equal(/res\.status\(4/.test(block), false, '不能因为配额耗尽就报 4xx —— 那会让玩法看起来坏了');
});
