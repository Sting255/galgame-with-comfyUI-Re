/**
 * 整理点停滞修复（2026-10-17 新建，对应全项目复查 §四4.2-④）
 *
 * ## 修的是什么
 *
 * 整理点只有一条触发条件：待整理 ≥ `CURATE_EVERY_N_MESSAGES`(20)。不足 20 条时
 * `curateNow` 直接提前返回、**checkpoint 原地不动**（状态仍是 idle、不报错）⇒
 *   · 慢速会话（一天几句）的整理点可以**长期趴着不动**，记忆一直滞后；
 *   · 会话在攒够 40 条之前就停了的话，那段尾巴**永远不会被整理** ⇒ 记忆永久缺失。
 *
 * 真机实证（`docs/memory-upgrade-progress.md` §「摘要窗口回退」）：
 * `group_2` 摘要点 6912 / 整理点 5677（整理点停在 2026-07-31）⇒ 一次摘要吞掉 1000+ 原始 id。
 *
 * ## 口径（本文件钉住）
 *
 * 「攒够 **或** 积压超时都整理」：
 *   · 待整理 ≥ 40 ⇒ 立刻整理（原行为，不变）；
 *   · 否则：积压 ≥ 6 小时 **且** 条数 ≥ 8 ⇒ 也整理；
 *   · 条数 < 8 ⇒ 继续攒（防"两三句寒暄搁了 6 小时"白花一次调用；只推迟不丢数据）。
 *
 * ## 为什么判定必须是纯函数且两处共用
 *
 * 群聊预检（`groupChatEngine.maybeExtractGroupMemory`）原来写死 `batchCount < 20` 就 `break`
 * ⇒ **永远走不到**超时路径。所以判定收口到 `decideCuration`，调用点不许再自己比数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`curation fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
config.features.memory = true;

const {
  decideCuration, CURATE_EVERY_N_MESSAGES, CURATE_MAX_PENDING_MINUTES, CURATE_MIN_PENDING_MESSAGES,
} = await import('../src/services/memoryExtractor.js');

/** 后端时间串是**无时区 UTC**（本仓铁律 2）⇒ 构造时也要按 UTC 写 */
const minutesAgo = (min, now) => new Date(now - min * 60000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
const NOW = Date.parse('2026-10-17T12:00:00Z');

// ── ① 攒够阈值：原行为不变 ────────────────────────────────────────────────

test('① 待整理达到 20 条 ⇒ 立刻整理（原行为不变，与积压时长无关）', () => {
  for (const age of [0, 30, 6 * 60, 72 * 60]) {
    const d = decideCuration({ count: CURATE_EVERY_N_MESSAGES, oldestAt: minutesAgo(age, NOW), now: NOW });
    assert.equal(d.curate, true, `达到阈值（${CURATE_EVERY_N_MESSAGES} 条，积压 ${age} 分钟）必须整理`);
    assert.equal(d.reason, 'threshold');
  }
  // 超过阈值当然也整理
  assert.equal(decideCuration({ count: 120, oldestAt: minutesAgo(1, NOW), now: NOW }).curate, true);
});

// ── ② 超时路径：本次修复的核心 ────────────────────────────────────────────

test('② 不足 20 条但积压 ≥ 6 小时且条数 ≥ 8 ⇒ **也整理**（修前这里永远不整理）', () => {
  const d = decideCuration({ count: 12, oldestAt: minutesAgo(CURATE_MAX_PENDING_MINUTES, NOW), now: NOW });
  assert.equal(d.curate, true, '积压刚好到 6 小时就要整理');
  assert.equal(d.reason, 'timeout');
  assert.equal(d.ageMinutes, CURATE_MAX_PENDING_MINUTES);

  const over = decideCuration({ count: 12, oldestAt: minutesAgo(CURATE_MAX_PENDING_MINUTES + 1, NOW), now: NOW });
  assert.equal(over.curate, true, '超过 6 小时当然也整理');
});

test('③ 积压够久但条数太少（< 8）⇒ 继续攒（不白花一次调用；只推迟不丢数据）', () => {
  const d = decideCuration({ count: CURATE_MIN_PENDING_MESSAGES - 1, oldestAt: minutesAgo(72 * 60, NOW), now: NOW });
  assert.equal(d.curate, false, '7 条搁了 3 天也不整理 —— 它只会等，不会丢');
  assert.equal(d.reason, 'too_few');

  const ok = decideCuration({ count: CURATE_MIN_PENDING_MESSAGES, oldestAt: minutesAgo(72 * 60, NOW), now: NOW });
  assert.equal(ok.curate, true, '刚好 8 条 + 超时 ⇒ 整理');
});

test('④ 不足阈值且未超时 ⇒ 继续累积（不打扰，等攒够或等超时）', () => {
  const d = decideCuration({ count: CURATE_EVERY_N_MESSAGES - 1, oldestAt: minutesAgo(30, NOW), now: NOW });
  assert.equal(d.curate, false);
  assert.equal(d.reason, 'accumulating');
  assert.equal(d.ageMinutes, 30);
});

// ── ⑤ 边界与脏数据 ────────────────────────────────────────────────────────

test('⑤ 边界：0 条 / 时间戳缺失 / 脏时间戳 都不崩，且保守（不因脏数据提前烧调用）', () => {
  assert.equal(decideCuration({ count: 0, oldestAt: minutesAgo(999, NOW), now: NOW }).reason, 'empty');
  assert.equal(decideCuration({ count: 0 }).curate, false);

  // 时间戳缺失 ⇒ 按"刚积压"算（age 0）⇒ 不足阈值时继续攒
  const noTime = decideCuration({ count: CURATE_EVERY_N_MESSAGES - 1, oldestAt: null, now: NOW });
  assert.equal(noTime.curate, false, '取不到时间就别提前整理');
  assert.equal(noTime.ageMinutes, 0);

  // 脏时间戳同样按 age 0（parseSqlUtc 返回 null）
  const badTime = decideCuration({ count: CURATE_EVERY_N_MESSAGES - 1, oldestAt: '不是时间', now: NOW });
  assert.equal(badTime.curate, false);

  // count 是字符串 / undefined 也要能算
  assert.equal(decideCuration({ count: '20', oldestAt: minutesAgo(1, NOW), now: NOW }).curate, true);
  assert.equal(decideCuration({ count: undefined, oldestAt: minutesAgo(1, NOW), now: NOW }).curate, false);
});

test('⑥ 时间戳按**无时区 UTC** 解析（不许当本地时间 —— 否则时区偏移会让判定差 8 小时）', () => {
  // 12:00 UTC 的那条消息，在 UTC 12:00 时 age 必须是 0，不是 8 小时（本机是 UTC+8）
  const d = decideCuration({ count: 20, oldestAt: '2026-10-17 12:00:00', now: NOW });
  assert.equal(d.ageMinutes, 0, '无时区串必须按 UTC 解析（走 parseSqlUtc）');
  const six = decideCuration({ count: 20, oldestAt: '2026-10-17 06:00:00', now: NOW });
  assert.equal(six.ageMinutes, CURATE_MAX_PENDING_MINUTES, '06:00 UTC → 12:00 UTC = 6 小时');
  assert.equal(six.curate, true);
});

// ── ⑦ 接线：两处共用同一判定，调用点不许自己比数字 ────────────────────────

test('⑦ 接线：整理器用 decideCuration 判定；群聊预检共用它（不许再写 batchCount < 阈值）', async () => {
  const extractor = await readFile(new URL('../src/services/memoryExtractor.js', import.meta.url), 'utf8');
  assert.ok(extractor.includes('const decision = decideCuration({ count: messages.length, oldestAt: messages[0]?.created_at })'),
    '整理器必须走 decideCuration');
  assert.equal(/if \(messages\.length < CURATE_EVERY_N_MESSAGES\) \{/.test(extractor), false,
    '旧的"不足 20 条直接返回"必须已被替换');

  const group = await readFile(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8');
  assert.ok(group.includes('decideCuration'), '群聊预检必须共用判定（否则它 break 在前面，超时路径永远走不到）');
  assert.equal(/if \(batchCount < CURATE_EVERY_N_MESSAGES\) \{/.test(group), false,
    '群聊预检不许再自己比数字');
  // 群聊要能拿到最老那条的时间（判定超时要用）
  assert.ok(/SELECT COUNT\(\*\) AS n, MIN\(created_at\) AS oldest/.test(group), '群聊预检要一并取最老时间戳');
});
