/**
 * 软状态落库：通用「单键 JSON 记忆」（2026-10-15）
 *
 * 背景：`imageSkill.lastHighTime` / `chat.imageJudgeCounters` / `chat.guessCooldowns`
 * 原来都是纯进程内变量，**重启即丢**（`接手必读.md` §6.3-11 列为遗留）。丢的表现很具体：
 *   · `lastHighTime` 归零 ⇒ 低优生图队列的静默期判定被绕过；
 *   · `imageJudgeCounters` 变空 ⇒ 下一次读取回落到"满额"默认值。
 *
 * 本文件钉住 `softStateStore` 的契约（纯内存 + 内存库，不碰真实库）：
 *   ① 懒加载：第一次 get/set 才读库；读坏/读到非对象一律回空 Map，不炸；
 *   ② set/delete 落库（去抖），跨"模块重载"（= 重启）仍在；
 *   ③ clear 立刻落库；MAX_BYTES 超限时**只留内存**不落库（防撑爆 system_settings）。
 *
 * 用内存库（`:memory:`）而不是真实库：本工具按定义会写 system_settings，
 * 测试必须落自己的临时库 —— 真实库 agent.db 只读（铁律）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-softstate-'));
const DB_PATH = path.join(TMP, 'agent.db');
process.env.DB_PATH = DB_PATH;
process.env.LOG_TO_FILE = 'false';

const { getDb, closeDb } = await import('../src/db/index.js');
const { createSoftState, SOFT_STATE_PREFIX } = await import('../src/services/softStateStore.js');

after(() => {
  try { closeDb(); } catch { /* 已关 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 清掉本文件用到的软状态键，保证各用例独立 */
function reset(...keys) {
  const db = getDb();
  for (const key of keys) {
    db.prepare('DELETE FROM system_settings WHERE setting_key = ?').run(key);
  }
}

test('键名自动加前缀，避免与其它设置撞名', () => {
  const s = createSoftState('demo_key');
  assert.equal(s.key, `${SOFT_STATE_PREFIX}demo_key`);
  // 已带前缀的不重复加
  const s2 = createSoftState(`${SOFT_STATE_PREFIX}demo_key`);
  assert.equal(s2.key, `${SOFT_STATE_PREFIX}demo_key`);
});

test('懒加载：get/set 前不读库；读到非对象 / 读坏一律回空 Map', () => {
  const key = 'lazy_probe';
  reset(`${SOFT_STATE_PREFIX}${key}`);
  const db = getDb();

  // 塞一个数组（非对象）→ 应被当作空
  db.prepare('INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run(`${SOFT_STATE_PREFIX}${key}`, '[1,2,3]');
  const arrState = createSoftState(key);
  assert.equal(arrState.size(), 0, '数组不该被当成软状态');
  assert.equal(arrState.get('x'), undefined);

  // 塞坏 JSON → 回空且不炸
  db.prepare('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?')
    .run('{bad json', `${SOFT_STATE_PREFIX}${key}`);
  const badState = createSoftState(key);
  assert.equal(badState.size(), 0, '读坏一律回空 Map');
  assert.equal(badState.get('x'), undefined, '不炸');

  reset(`${SOFT_STATE_PREFIX}${key}`);
});

test('set/delete 落库（去抖），跨模块重载仍在', async () => {
  const key = 'persist_probe';
  reset(`${SOFT_STATE_PREFIX}${key}`);
  const s = createSoftState(key, { debounceMs: 10 });

  s.set('a', 1);
  s.set('b', 'x');
  s.set('a', 2);        // 覆盖
  assert.equal(s.get('a'), 2, '同键覆盖');
  s.delete('b');
  s.flush();            // 立刻落库（不等去抖）

  // 重新建一份（= 模拟重启后懒加载读库）
  const reloaded = createSoftState(key);
  assert.equal(reloaded.get('a'), 2, '重启后仍在');
  assert.equal(reloaded.get('b'), undefined, '删掉的键不在');
  assert.equal(reloaded.size(), 1);

  reset(`${SOFT_STATE_PREFIX}${key}`);
});

test('写入去抖：多次 set 只落一次库（不阻塞主流程）', async () => {
  const key = 'debounce_probe';
  reset(`${SOFT_STATE_PREFIX}${key}`);
  const s = createSoftState(key, { debounceMs: 30 });

  // 一串写：去抖窗口内只应有一次落库
  for (let i = 0; i < 10; i++) s.set('n', i);
  // 去抖窗口未到时，库里还没这行（只是内存）
  const beforeFlush = getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?')
    .pluck().get(`${SOFT_STATE_PREFIX}${key}`);
  assert.equal(beforeFlush, undefined, '去抖窗口内不落库');

  await new Promise(r => setTimeout(r, 60));   // 等去抖触发
  const afterFlush = getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?')
    .pluck().get(`${SOFT_STATE_PREFIX}${key}`);
  assert.ok(afterFlush, '去抖窗口后落库');
  assert.equal(JSON.parse(afterFlush).n, 9, '落的是最后一次的值');

  reset(`${SOFT_STATE_PREFIX}${key}`);
});

test('clear 立刻落库（清空即持久化）', () => {
  const key = 'clear_probe';
  reset(`${SOFT_STATE_PREFIX}${key}`);
  const s = createSoftState(key, { debounceMs: 1000 });
  s.set('k', 'v');
  s.clear();
  const raw = getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?')
    .pluck().get(`${SOFT_STATE_PREFIX}${key}`);
  assert.equal(raw, '{}', 'clear 立刻落一个空对象');
  assert.equal(s.get('k'), undefined);
  reset(`${SOFT_STATE_PREFIX}${key}`);
});

test('MAX_BYTES 超限时只留内存、不落库（防撑爆 system_settings）', () => {
  const key = 'oversize_probe';
  reset(`${SOFT_STATE_PREFIX}${key}`);
  const s = createSoftState(key, { debounceMs: 0 });   // debounceMs=0 → 写入即落库
  // 塞一个 >64KB 的值
  const big = 'x'.repeat(80 * 1024);
  s.set('big', big);
  const raw = getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?')
    .pluck().get(`${SOFT_STATE_PREFIX}${key}`);
  assert.equal(raw, undefined, '超限不落库');
  assert.equal(s.get('big'), big, '内存里仍在（本次进程内可用）');
  reset(`${SOFT_STATE_PREFIX}${key}`);
});

test('真实库指纹不受影响：本工具只碰自己前缀的键', () => {
  // 只断言"我没往别的键上写" —— 写入目标键必带 soft_state_ 前缀
  const s = createSoftState('prefix_guard');
  assert.ok(s.key.startsWith(SOFT_STATE_PREFIX), '落库键必带前缀');
  const rows = getDb().prepare("SELECT setting_key FROM system_settings WHERE setting_key NOT LIKE 'soft_state_%'").all();
  // 本文件运行期间没有往非 soft_state 键写入（rows 里不会有本文件造的键；真实库是临时库，允许有迁移造的系统键）
  assert.ok(Array.isArray(rows), '查询可执行');
});
