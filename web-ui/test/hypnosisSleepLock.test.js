/**
 * 催眠手机 · 「无法醒来」（睡眠锁）的纯逻辑单测
 *
 * 用户原话：「再在催眠手机里加入一个选项 控制角色无法醒来 持续睡眠 这又是一种全新的玩法」。
 *
 * 本文件只测不依赖 Vue 的纯函数与请求形状：
 *   1. 状态归一化（camelCase / snake_case / 嵌套 / 0-1）；
 *   2. 面板文案：锁着时要说"锁到几点"，锁着但没在睡要说清楚（否则用户以为开关没生效）；
 *   3. 接口 URL 与 body 形状（关的时候不带 minutes）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { getSleepLock, setSleepLock } from '../src/api/hypnosis.js'
import { SLEEP_LOCK_NOTE, normalizeSleepLock, sleepLockViewModel } from '../src/components/hypnosisLogic.js'

// ── 1. 归一化 ──

test('normalizeSleepLock：camelCase / snake_case / 嵌套都认', () => {
  const camel = normalizeSleepLock({ locked: true, until: '2026-11-04 02:00:00', hours: 24 })
  assert.equal(camel.locked, true)
  assert.equal(camel.until, '2026-11-04 02:00:00')
  assert.equal(camel.hours, 24)

  const snake = normalizeSleepLock({ sleep_lock: 1, sleep_lock_until: '2026-11-04 02:00:00' })
  assert.equal(snake.locked, true, '老接口可能给 0/1 的 sleep_lock')

  const nested = normalizeSleepLock({ sleepLock: { locked: true, until: '2026-11-04 02:00:00' } })
  assert.equal(nested.locked, true, '嵌套形状（挂在别的状态里）也要认')
})

test('normalizeSleepLock：空值 / 垃圾值一律"没锁"（不能假报锁着）', () => {
  for (const raw of [null, undefined, {}, 'lock', 0, { locked: false }]) {
    assert.equal(normalizeSleepLock(raw).locked, false, `${JSON.stringify(raw)} 应当判成没锁`)
  }
})

test('normalizeSleepLock：hours 非法时回落到 24', () => {
  assert.equal(normalizeSleepLock({ locked: true, hours: 0 }).hours, 24)
  assert.equal(normalizeSleepLock({ locked: true, hours: 'abc' }).hours, 24)
  assert.equal(normalizeSleepLock({ locked: true, hours: 6 }).hours, 6)
})

// ── 2. 面板文案 ──

test('睡眠锁视图：锁着时给出"锁到几点"', () => {
  const view = sleepLockViewModel({ locked: true, until: '2026-11-04 02:00:00', hours: 24 }, { isSleeping: true })
  assert.equal(view.locked, true)
  assert.match(view.note, /锁到/, '面板必须看得见锁到什么时候')
  assert.equal(view.onText, '锁着')
  assert.equal(view.offText, '能醒')
})

test('★ 锁着但没在睡要说清楚（否则用户以为开关没生效）', () => {
  const view = sleepLockViewModel({ locked: true, until: '2026-11-04 02:00:00' }, { isSleeping: false })
  assert.match(view.note, /没在睡/)
})

test('没锁时不给任何提示文本', () => {
  const view = sleepLockViewModel({ locked: false }, { isSleeping: false })
  assert.equal(view.note, '')
  assert.equal(view.locked, false)
})

test('说明文案要点明三件事：叫不醒、关掉＝放开她、最长 24 小时', () => {
  assert.match(SLEEP_LOCK_NOTE, /叫不醒/)
  assert.match(SLEEP_LOCK_NOTE, /关掉/)
  assert.match(SLEEP_LOCK_NOTE, /24 小时/)
})

// ── 3. 接口形状 ──

test('getSleepLock：GET 到 sleep-lock 路径', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body })
    return { ok: true, status: 200, json: async () => ({ characterId: 7, locked: false }) }
  }
  try {
    await getSleepLock(7)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/characters\/7\/hypnosis\/sleep-lock/)
  assert.equal(calls[0].method, 'GET')
})

test('setSleepLock：开带 minutes、关不带 minutes', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body })
    return { ok: true, status: 200, json: async () => ({ characterId: 7, locked: true }) }
  }
  try {
    await setSleepLock(7, true, { minutes: 120 })
    await setSleepLock(7, false)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(calls.length, 2)
  const on = JSON.parse(calls[0].body)
  assert.equal(on.on, true)
  assert.equal(on.minutes, 120)
  const off = JSON.parse(calls[1].body)
  assert.equal(off.on, false)
  assert.equal('minutes' in off, false, '关的时候不该带时长（后端会忽略，但别让人误会）')
})
