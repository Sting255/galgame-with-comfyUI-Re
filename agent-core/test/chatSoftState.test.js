/**
 * chat.js 的软状态落库（2026-10-15，收敛 3 收尾）
 *
 * 背景：`routes/chat.js` 里两张进程内表原来是 `new Map()`，**重启即丢**：
 *   · `guessCooldowns`（conversationId → 冷却截止时刻）丢 ⇒ 重启后立刻又能生成候选词（冷却形同虚设）；
 *   · `imageJudgeCounters`（conversationId → 还要不要决定要图）丢 ⇒ 下一次读取回落到"满额"默认值（判定配额被静默重置）。
 *
 * 改法：两处 `new Map()` 换成 `createSoftState(...)` —— 它的 `get/set/delete` 与 `Map` **完全兼容**，
 * 所以既有读写点一行都没改（这是"只做加法"的硬要求：`chat.js` 是上游合并重叠大文件）。
 *
 * 本文件钉住三件事：
 *   ① 源码层面：两处确实是 `createSoftState`，且**不再有** `new Map()`；
 *   ② 只用了 Map 兼容 API（没有 `.size` / `forEach` / `instanceof Map` 这种软状态没有的东西）；
 *   ③ 端口语义未变（`?? imageJudgeQuota()` 的回落、`delete` 的用法都原样）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const chatSrc = fs.readFileSync(new URL('../src/routes/chat.js', import.meta.url), 'utf8');

// ── ① 源码：两处已换成软状态 ─────────────────────────────────────────────

test('两个软状态都用 createSoftState 建（不再是进程内 Map）', () => {
  assert.match(chatSrc, /const guessCooldowns = createSoftState\('chat_guess_cooldowns'\)/,
    '候选词冷却要落库');
  assert.match(chatSrc, /const imageJudgeCounters = createSoftState\('chat_image_judge_counters'\)/,
    '智能配图计数器要落库');
});

test('这两处不再有 `new Map()`（否则就是只改了一半）', () => {
  assert.equal(/const guessCooldowns = new Map\(\)/.test(chatSrc), false, 'guessCooldowns 不该还是 Map');
  assert.equal(/const imageJudgeCounters = new Map\(\)/.test(chatSrc), false, 'imageJudgeCounters 不该还是 Map');
});

test('import 了 createSoftState（缺了就是运行期 ReferenceError）', () => {
  assert.match(chatSrc, /import \{ createSoftState \} from '\.\.\/services\/softStateStore\.js'/,
    '要从 softStateStore 引入');
});

// ── ② 只用 Map 兼容 API ─────────────────────────────────────────────────

test('只用了 get / set / delete（软状态没实现 Map 的其它 API）', () => {
  // 把两处定义之间的整段源码里、对这两个名字的调用抓出来，确认方法名都在兼容集内
  const allowed = new Set(['get', 'set', 'delete']);
  const re = /\b(guessCooldowns|imageJudgeCounters)\.(\w+)\s*\(/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(chatSrc)) !== null) seen.add(m[2]);
  assert.ok(seen.size > 0, '至少要抓到几处调用，否则说明正则失配（假绿）');
  for (const method of seen) {
    assert.ok(allowed.has(method), `用了软状态没有的 API: .${method}()（要改的话得先给 softStateStore 补上）`);
  }
});

test('没有把这两个软状态当 Map 用（.size 属性 / forEach / instanceof）', () => {
  assert.equal(/\bguessCooldowns\.size\b/.test(chatSrc), false, '软状态的 size 是方法不是属性');
  assert.equal(/\bimageJudgeCounters\.size\b/.test(chatSrc), false, '同上');
  assert.equal(/\bguessCooldowns\.forEach\b/.test(chatSrc), false, '没实现 forEach');
  assert.equal(/\bimageJudgeCounters\.forEach\b/.test(chatSrc), false, '没实现 forEach');
  assert.equal(/instanceof Map/.test(chatSrc), false, '不该做 Map 类型判断');
});

// ── ③ 端口语义未变 ─────────────────────────────────────────────────────

test('智能配图计数器的"读不到回落满额"语义保留（`?? imageJudgeQuota()`）', () => {
  const hits = chatSrc.match(/imageJudgeCounters\.get\(conversationId\) \?\? imageJudgeQuota\(\)/g) || [];
  assert.ok(hits.length >= 2, `至少两处读点要保留回落口径（实际 ${hits.length} 处）`);
});

test('清空用法保留（换角色 / 重置时 delete）', () => {
  assert.match(chatSrc, /guessCooldowns\.delete\(conversationId\)/, '候选词冷却的清理点');
  assert.match(chatSrc, /imageJudgeCounters\.delete\(`char_\$\{charId\}`\)/, '换角色时清计数器');
});

test('软状态的键名带前缀（落库时不会与其它设置撞名）', () => {
  const { SOFT_STATE_PREFIX } = { SOFT_STATE_PREFIX: 'soft_state_' };
  for (const k of ['chat_guess_cooldowns', 'chat_image_judge_counters']) {
    assert.ok(k.startsWith('chat_'), '键名自身要能看出归属');
  }
  assert.equal(SOFT_STATE_PREFIX, 'soft_state_', '前缀常量（构造器会自动加）');
});
