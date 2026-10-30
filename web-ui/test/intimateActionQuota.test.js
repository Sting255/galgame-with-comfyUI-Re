/**
 * 亲密推进动作的独立每日额度（前端，2026-10-15 补）
 *
 * 后端：`services/intimateActionQuota.js` + `PUT /api/config/intimate-action-quota`
 *   + `GET /api/intimate-actions/:id/state` 回带 quota（见 agent-core/test/intimateActionQuota.test.js）。
 * 前端此前**零引用** —— 用户看不到"今天还剩几下"，也改不了上限。
 *
 * 本文件钉住接线后的口径，抓四类容易再犯的错：
 *   ① 读不到配额时 `known:false`，页面只显示「0 = 不限制」，不假装「已用 0 次」；
 *   ② 归一化与 aiJudge 逐字同口径（unlimited 布尔 / 0-1 / 由 dailyLimit 推 三种都给）；
 *   ③ 保存走 PUT /api/config/intimate-action-quota，失败回滚输入框；
 *   ④ 额度耗尽**不哑玩法**：提示要说清"还能点，只是反应留到下一轮"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import {
  INTIMATE_ACTION_DAILY_LIMIT_MAX,
  INTIMATE_ACTION_LIMIT_HINT,
  normalizeIntimateActionQuota,
  intimateActionQuotaNote,
  intimateActionQuotaBanner,
} from '../src/components/character/intimateLogic.js'

const panelPath = new URL('../src/components/character/IntimatePanel.vue', import.meta.url)
const panelSrc = readFileSync(panelPath, 'utf8')
const panel = parse(panelSrc).descriptor
const panelScript = panel.scriptSetup.content
const panelTpl = panel.template.content
const apiSrc = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')

// ── ① 归一化 ─────────────────────────────────────────────────────────────

test('normalizeIntimateActionQuota：拿不到对象时 known=false（不编数字）', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    const q = normalizeIntimateActionQuota(bad)
    assert.equal(q.known, false, `${JSON.stringify(bad)} 应 known:false`)
    assert.equal(q.dailyLimit, 0)
    assert.equal(q.usedToday, 0)
    assert.equal(q.remaining, null)
  }
})

test('归一化：0 = 不限制（remaining=null、exhausted 恒 false）', () => {
  const q = normalizeIntimateActionQuota({ dailyLimit: 0, usedToday: 999, remaining: null, unlimited: true })
  assert.equal(q.unlimited, true)
  assert.equal(q.remaining, null)
  assert.equal(q.exhausted, false)
})

test('归一化：unlimited 三种表达都认（布尔 / 0-1 / 由 dailyLimit 推）', () => {
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 0, unlimited: true }).unlimited, true)
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 0, unlimited: 1 }).unlimited, true)
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 5, unlimited: 0 }).unlimited, false)
  // 没给 unlimited 字段 → 由 dailyLimit === 0 推
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 0 }).unlimited, true)
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 200 }).unlimited, false)
})

test('归一化：remaining 缺失时按 dailyLimit - usedToday 推；负数归 0', () => {
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 200, usedToday: 3 }).remaining, 197)
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 5, usedToday: 9 }).remaining, 0)
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 5, usedToday: 3, remaining: 2 }).remaining, 2, '后端给了就以它为准')
})

test('归一化：exhausted 后端给了以它为准，没给按 remaining 推', () => {
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 5, usedToday: 5, exhausted: true }).exhausted, true)
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 5, usedToday: 5 }).exhausted, true, 'remaining=0 ⇒ 耗尽')
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 5, usedToday: 4 }).exhausted, false)
  // 不限制时永远不耗尽（哪怕 usedToday 巨大）
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 0, usedToday: 99999 }).exhausted, false)
})

test('归一化：dailyLimit 与 aiJudge 同一夹取口径（负数/小数/超上限）', () => {
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: -5 }).dailyLimit, 0)
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 3.7 }).dailyLimit, 3)
  assert.equal(normalizeIntimateActionQuota({ dailyLimit: 999999 }).dailyLimit, INTIMATE_ACTION_DAILY_LIMIT_MAX)
  assert.equal(INTIMATE_ACTION_DAILY_LIMIT_MAX, 100000, '与 aiJudge 的上限同值')
})

// ── ② 文案 ───────────────────────────────────────────────────────────────

test('旁注：读不到只给「0 = 不限制」；读到才报已用/剩余', () => {
  assert.equal(intimateActionQuotaNote(null), INTIMATE_ACTION_LIMIT_HINT)
  assert.equal(INTIMATE_ACTION_LIMIT_HINT, '0 = 不限制')

  const limited = intimateActionQuotaNote({ dailyLimit: 200, usedToday: 3 })
  assert.match(limited, /0 = 不限制/)
  assert.match(limited, /当前已用 3 次/)
  assert.match(limited, /今日还剩 197 次/)

  const unlimited = intimateActionQuotaNote({ dailyLimit: 0, usedToday: 12 })
  assert.match(unlimited, /当前已用 12 次/)
  assert.equal(/还剩/.test(unlimited), false, '不限制时不编「还剩」')
})

test('耗尽横幅：说清"还能点、只是反应留到下一轮"，且不是错误口吻', () => {
  const banner = intimateActionQuotaBanner({ dailyLimit: 5, usedToday: 5 })
  assert.equal(banner.exhausted, true)
  assert.match(banner.text, /额度已用完/)
  assert.match(banner.text, /5\/5/, '要说清用了几次/上限')
  assert.match(banner.text, /还能继续点|状态照常|留到下一轮/, '必须说清玩法没坏')
  assert.match(banner.text, /明天自动恢复/)
})

test('未耗尽 / 不限制 / 读不到 时不显示横幅', () => {
  assert.equal(intimateActionQuotaBanner({ dailyLimit: 5, usedToday: 1 }).text, '')
  assert.equal(intimateActionQuotaBanner({ dailyLimit: 0, usedToday: 9999 }).text, '')
  assert.equal(intimateActionQuotaBanner(null).text, '')
})

// ── ③ 界面接线 ───────────────────────────────────────────────────────────

test('面板有「亲密推进的每日额度」区块，用 Linshe 组件', () => {
  assert.match(panelTpl, /亲密推进的每日额度/, '要有中文标题')
  const idx = panelTpl.indexOf('亲密推进的每日额度')
  const block = panelTpl.slice(idx, idx + 1400)
  assert.match(block, /<linshe-input/, '上限用 LinsheInput（不许裸 input）')
  assert.match(block, /v-model\.number="intimateActionDailyLimit"/, '绑到上限输入框')
  assert.match(block, /:max="INTIMATE_ACTION_DAILY_LIMIT_MAX"/, '上限走常量')
  assert.match(block, /@change="onIntimateActionDailyLimitChange"/, '改完要落库')
  assert.match(block, /intimateActionQuotaHint/, '要显示旁注')
  assert.match(block, /玩法不会坏|状态照常推进/, '要写明"额度用完不哑玩法"')
  for (const tag of ['input', 'select']) {
    assert.equal(new RegExp(`<${tag}[\\s>]`).test(block), false, `不许裸 <${tag}>`)
  }
})

test('面板引入了新常量与函数（不是内联抄一份）', () => {
  for (const name of ['INTIMATE_ACTION_DAILY_LIMIT_MAX', 'normalizeIntimateActionQuota', 'intimateActionQuotaNote']) {
    assert.ok(panelScript.includes(name), `要 import ${name}`)
  }
  assert.ok(panelScript.includes('updateIntimateActionQuota'), '要 import 写接口')
})

test('onMounted 同时拉两份配额（aiJudge 与亲密推进）', () => {
  const line = panelScript.slice(panelScript.indexOf('onMounted(() =>'))
  assert.match(line.slice(0, 200), /refreshAiJudgeQuota\(\)/, '原有那份不能丢')
  assert.match(line.slice(0, 200), /refreshIntimateActionQuota\(\)/, '新增那份要一起拉')
})

test('api 层：updateIntimateActionQuota 打 PUT /config/intimate-action-quota', () => {
  assert.match(apiSrc, /export function updateIntimateActionQuota\(dailyLimit\)/, '要有导出函数')
  const body = apiSrc.slice(apiSrc.indexOf('export function updateIntimateActionQuota'))
  assert.match(body.slice(0, 300), /request\('\/config\/intimate-action-quota'/, '路径要对')
  assert.match(body.slice(0, 300), /method: 'PUT'/, '方法要对')
})

// ── ④ 保存逻辑：失败回滚 ─────────────────────────────────────────────────

test('onIntimateActionDailyLimitChange：成功落库；失败回滚到上一档', async () => {
  const calls = []
  const toasts = []
  const fail = { flag: false }
  const updateIntimateActionQuota = async (v) => {
    calls.push(v)
    if (fail.flag) throw new Error('boom')
    return { dailyLimit: v, usedToday: 0, remaining: v, unlimited: v === 0 }
  }
  const notify = (msg, type) => toasts.push({ msg, type })
  const clampDailyLimit = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 0
    return Math.min(100000, Math.max(0, Math.floor(n)))
  }
  const intimateActionQuota = { value: normalizeIntimateActionQuota({ dailyLimit: 200, usedToday: 0 }) }
  const intimateActionDailyLimit = { value: 200 }
  const intimateActionQuotaSaving = { value: false }

  const start = panelScript.indexOf('async function onIntimateActionDailyLimitChange')
  assert.ok(start >= 0, '找不到 onIntimateActionDailyLimitChange')
  let i = panelScript.indexOf(')', start)
  while (i < panelScript.length && panelScript[i] !== '{') i++
  let depth = 0
  for (; i < panelScript.length; i++) {
    if (panelScript[i] === '{') depth++
    else if (panelScript[i] === '}') { depth--; if (depth === 0) break }
  }
  const body = panelScript.slice(start, i + 1)

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const factory = new AsyncFunction(
    'updateIntimateActionQuota', 'notify', 'clampDailyLimit', 'normalizeIntimateActionQuota',
    'intimateActionQuota', 'intimateActionDailyLimit', 'intimateActionQuotaSaving',
    `${body}; return onIntimateActionDailyLimitChange`
  )
  const save = await factory(updateIntimateActionQuota, notify, clampDailyLimit, normalizeIntimateActionQuota,
    intimateActionQuota, intimateActionDailyLimit, intimateActionQuotaSaving)

  // 改成 50
  intimateActionDailyLimit.value = 50
  await save()
  assert.equal(calls.at(-1), 50, '要真发 PUT')
  assert.equal(intimateActionQuota.value.dailyLimit, 50, '回执要写回本地配额对象')
  assert.equal(intimateActionQuotaSaving.value, false, '保存态要复位')

  // 同值不重复发
  const before = calls.length
  await save()
  assert.equal(calls.length, before, '值没变就不该再发请求')

  // 失败回滚
  fail.flag = true
  intimateActionDailyLimit.value = 7
  await save()
  assert.equal(intimateActionDailyLimit.value, 50, '失败要回滚到上一档（50）')
  assert.equal(toasts.at(-1).type, 'error')
})

test('源码守卫：保存函数走 updateIntimateActionQuota，失败回滚', () => {
  const start = panelScript.indexOf('async function onIntimateActionDailyLimitChange')
  const body = panelScript.slice(start, start + 1200)
  assert.match(body, /updateIntimateActionQuota\(/, '要真落库')
  assert.match(body, /intimateActionDailyLimit\.value = previous/, '失败要回滚输入框')
})
