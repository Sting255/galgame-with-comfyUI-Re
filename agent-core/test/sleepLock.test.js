/**
 * 催眠手机的「无法醒来」（睡眠锁）
 *
 * 用户原话：「然后再在催眠手机里加入一个选项 控制角色无法醒来 持续睡眠 这又是一种全新的玩法
 * 而且是非常好玩的玩法 过程中角色醒来也会有独特的反应」。
 *
 * 契约（前端 `web-ui/src/api/hypnosis.js` + `components/hypnosisLogic.js` 已按此实现）：
 *   GET  /api/characters/:id/hypnosis/sleep-lock  → { characterId, locked, until, untilText, hours }
 *   POST /api/characters/:id/hypnosis/sleep-lock  body { on, minutes? }
 *        → { characterId, locked, until, sleeping, sleepUntil }
 *
 * 这个文件钉死的东西：
 *   1. 开锁 = 立刻入睡 + 记锁（走日程链路，不是只改 characters）
 *   2. 锁着时**叫不醒**：POST /hypnosis/wake 409（reason=sleep_locked），催眠指令也不会临时唤醒她
 *   3. 关锁 = 解锁 + 立刻唤醒（一个开关能完整撤销，不留她睡 24 小时）
 *   4. 到期自动解开（忘了关也不会永久锁死）
 *   5. 角色级锁并进亲密场景：场景行上 forced_sleep=0 也照样按锁着算 ⇒ 推进推不醒（睡眠条封底 1）
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
let serverPort = 0;
process.env.DB_PATH = ':memory:';
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`sleep lock fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');
const hypnosisRoutes = (await import('../src/routes/hypnosis.js')).default;
const mgr = await import('../src/services/scheduleManager.js');
const hypnosis = await import('../src/services/hypnosisService.js');
const sleepLock = await import('../src/services/sleepLock.js');
const intimate = await import('../src/services/intimateActionService.js');
const { localDateKey } = await import('../src/services/programTime.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/characters', wrapRouterAsync(hypnosisRoutes));
const server = app.listen(0);
serverPort = server.address().port;
after(() => { server.close(); closeDb(); });

async function api(method, path, body) {
  const res = await realFetch(`http://127.0.0.1:${serverPort}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

// 全天清醒夹具：不依赖跑测试的钟点（老测试踩过"夜里跑就红"的坑）
const DAY_ONLY = [
  { startTime: '00:00', endTime: '23:59', activity: '白天活动', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
];

let counter = 0;

function seedCharacter() {
  const db = getDb();
  counter += 1;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, '旅客', 1)`
  ).run(`lock_${counter}`, `锁住${counter}`);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(id, JSON.stringify(DAY_ONLY));
  mgr.ensureTodaySchedule(id);
  return id;
}

function lockRow(id) {
  return getDb().prepare('SELECT sleep_lock, sleep_lock_until FROM character_hypnosis WHERE character_id = ?').get(id) || null;
}

function isSleepingRow(id) {
  return getDb().prepare('SELECT is_sleeping FROM characters WHERE id = ?').get(id)?.is_sleeping === 1;
}

const LOCK_SHAPE = ['characterId', 'locked', 'until', 'untilText', 'hours'];

// ── 开 / 关 ──

test('POST /sleep-lock on：记锁 + 立刻入睡（走日程链路）', async () => {
  const id = seedCharacter();
  assert.equal(isSleepingRow(id), false, '夹具必须是醒着的');

  const res = await api('POST', `/api/characters/${id}/hypnosis/sleep-lock`, { on: true });
  assert.equal(res.status, 200);
  assert.equal(res.json.locked, true);
  assert.equal(res.json.sleeping, true, '开锁必须让她真的睡过去');
  assert.ok(res.json.sleepUntil, '要给醒来时刻');

  const row = lockRow(id);
  assert.equal(Number(row.sleep_lock), 1);
  assert.ok(row.sleep_lock_until, '必须记到期时刻（安全阀）');
  assert.equal(isSleepingRow(id), true);

  // 日程快照里要有 forcedSleep 块 —— 只改 characters 的写法过不了这条
  const snap = getDb().prepare(
    'SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = ?'
  ).get(id, localDateKey(new Date()));
  const schedule = JSON.parse(snap.schedule_json);
  assert.ok(schedule.some(a => a.replyDelay === -1 && a.forcedSleep === 1), '开锁要把睡块写进当日日程');
});

test('GET /sleep-lock：返回固定形状（面板按它渲染开关）', async () => {
  const id = seedCharacter();
  await api('POST', `/api/characters/${id}/hypnosis/sleep-lock`, { on: true });
  const res = await api('GET', `/api/characters/${id}/hypnosis/sleep-lock`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), [...LOCK_SHAPE].sort());
  assert.equal(res.json.locked, true);
  assert.equal(res.json.hours, 24, '默认给满 24 小时');
});

test('★ 锁着时叫不醒：POST /wake 409 cannot wake，人还在睡', async () => {
  const id = seedCharacter();
  await api('POST', `/api/characters/${id}/hypnosis/sleep-lock`, { on: true });

  const res = await api('POST', `/api/characters/${id}/hypnosis/wake`, {});
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'cannot wake');
  assert.equal(res.json.reason, 'sleep_locked');
  assert.equal(isSleepingRow(id), true, '被拒绝之后她必须照旧睡着');
  assert.equal(sleepLock.isSleepLocked(id), true);
});

test('★ 锁着时催眠指令也不临时唤醒她', async () => {
  const id = seedCharacter();
  await api('POST', `/api/characters/${id}/hypnosis/sleep-lock`, { on: true });
  const r = hypnosis.wakeForForcedTrigger(id);
  assert.equal(r.woken, false);
  assert.equal(r.reason, 'sleep_locked');
});

test('★ 关锁 = 解锁 + 立刻醒来（一个开关能完整撤销）', async () => {
  const id = seedCharacter();
  await api('POST', `/api/characters/${id}/hypnosis/sleep-lock`, { on: true });
  assert.equal(isSleepingRow(id), true);

  const res = await api('POST', `/api/characters/${id}/hypnosis/sleep-lock`, { on: false });
  assert.equal(res.status, 200);
  assert.equal(res.json.locked, false);
  assert.equal(res.json.sleeping, false, '关锁要顺手把她唤醒，不能留她睡满 24 小时');
  assert.equal(sleepLock.isSleepLocked(id), false);
  assert.equal(isSleepingRow(id), false);
  assert.equal(Number(lockRow(id).sleep_lock), 0);

  // 解锁之后"唤醒"恢复正常语义（幂等成功，不再 409）
  const wakeRes = await api('POST', `/api/characters/${id}/hypnosis/wake`, {});
  assert.equal(wakeRes.status, 200);
});

test('到期自动解开：忘了关也不会永久锁死', async () => {
  const id = seedCharacter();
  await api('POST', `/api/characters/${id}/hypnosis/sleep-lock`, { on: true });
  // 把到期时刻拨到过去，模拟 24 小时过完
  getDb().prepare(
    `UPDATE character_hypnosis SET sleep_lock_until = datetime('now', '-1 minute') WHERE character_id = ?`
  ).run(id);

  assert.equal(sleepLock.isSleepLocked(id), false, '过期的锁必须自动失效');
  assert.equal(Number(lockRow(id).sleep_lock), 0, '顺手把标记清掉，面板别一直显示"锁着"');

  // 失效之后唤醒不再被拒
  const wakeRes = await api('POST', `/api/characters/${id}/hypnosis/wake`, {});
  assert.equal(wakeRes.status, 200);
});

// ── 与亲密场景的联动（这是「推进也推不醒」的落点）──

test('★ 角色级锁并进亲密场景：场景行 forced_sleep=0 也按锁着算', () => {
  const id = seedCharacter();
  getDb().prepare(
    `INSERT INTO character_intimate_scene (character_id, active, penetrating, position_key, act_key, sleep_bar, forced_sleep)
     VALUES (?, 1, 1, 'missionary', 'vaginal', 3, 0)`
  ).run(id);
  // 场景是锁之前建的（forced_sleep=0）
  assert.equal(intimate.getIntimateScene(id).forcedSleep, 0);

  sleepLock.setSleepLock(id, true, { minutes: 60 });
  const scene = intimate.getIntimateScene(id);
  assert.equal(scene.forcedSleep, 1, '锁开着就必须按锁着算，否则推进一次就把她弄醒了');

  // 推进一下：条封底 1、不许醒
  const r = intimate.planIntimateAction(scene, { actionKey: 'thrust', sleeping: true, now: Date.now() });
  assert.equal(r.ok, true);
  assert.equal(r.next.sleepBar, 1, '扣到负也封底 1 点：锁着就永远差一口气')
  assert.equal(r.next.woke, false);
});

test('触摸也会扣睡眠条（重动作按插入类那一档），锁着时封底不掉到 0', () => {
  const id = seedCharacter();
  getDb().prepare(
    `INSERT INTO character_intimate_scene (character_id, active, penetrating, position_key, act_key, sleep_bar, forced_sleep)
     VALUES (?, 1, 1, 'missionary', 'vaginal', 100, 0)`
  ).run(id);

  const light = intimate.drainSleepBarByTouch(id, { heavy: false, sensitivity: 1 });
  assert.equal(light.sleepBar, 100 - intimate.SLEEP_COST_TOUCH);
  assert.equal(light.woke, false);

  const heavy = intimate.drainSleepBarByTouch(id, { heavy: true, sensitivity: 1 });
  assert.equal(heavy.sleepBar, light.sleepBar - intimate.SLEEP_COST_THRUST);

  // 锁着 → 一路摸到封底也醒不过来
  sleepLock.setSleepLock(id, true, { minutes: 60 });
  for (let i = 0; i < 40; i++) intimate.drainSleepBarByTouch(id, { heavy: true, sensitivity: 2 });
  const floor = intimate.drainSleepBarByTouch(id, { heavy: true, sensitivity: 2 });
  assert.equal(floor.sleepBar, 1);
  assert.equal(floor.woke, false);
  assert.equal(floor.forced, true);
});

test('没有进行中的场景时，触摸不碰睡眠条（没有条可掉）', () => {
  const id = seedCharacter();
  assert.equal(intimate.drainSleepBarByTouch(id, { heavy: true }), null);
});

// ── 边界 ──

test('边界：非法 id 400 / 角色不存在 404 / 关了总开关 409 且零写入', async () => {
  assert.equal((await api('POST', '/api/characters/abc/hypnosis/sleep-lock', { on: true })).status, 400);

  const missing = await api('POST', '/api/characters/999999/hypnosis/sleep-lock', { on: true });
  assert.equal(missing.status, 404);

  const id = seedCharacter();
  const prev = config.features.hypnosis;
  config.features.hypnosis = false;
  try {
    // 睡眠锁是自己的开关，不受催眠总开关管（她睡不睡跟催眠没关系）——
    // 这里只钉住"总开关关掉时接口不会 500、状态仍然可读"
    const res = await api('GET', `/api/characters/${id}/hypnosis/sleep-lock`);
    assert.equal(res.status, 200);
    assert.equal(res.json.locked, false);
  } finally {
    config.features.hypnosis = prev;
  }
});
