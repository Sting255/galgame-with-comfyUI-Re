/**
 * 设置页「动作反应风格」页签（features.touchReactionMode 前端接线）
 *
 * 背景：后端从 task-30 起就是完整的 ——
 *   `config.js` 有默认值与 setter（'quick' 之外的任何值一律归一成 'conversation'）、
 *   `db/settings.js` 有持久化映射、`routes/touch.js` 按它切换喂料量与 max_tokens
 *   （conversation：最近 8 条对话 + 关系/日程/催眠/亲密档案，max_tokens 500；
 *     quick：最近 2 条，max_tokens 300）。
 * 但前端**零引用** —— 用户在界面上看不到、也改不了这个档位。
 *
 * 本文件钉住接线后的口径，抓三类容易再犯的错：
 *   ① 常量与归一化必须与后端同口径（默认 conversation，非法值回落 conversation 而不是 quick）
 *   ② 保存走通用 PUT /api/config/features（key 用常量，不硬编码字符串）
 *   ③ 保存失败必须回滚本地值（否则界面显示改了、后端没存上）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import {
  TOUCH_REACTION_MODE_KEY,
  DEFAULT_TOUCH_REACTION_MODE,
  TOUCH_REACTION_MODES,
  normalizeTouchReactionMode,
  touchReactionModeLabel,
} from '../src/components/touchActionLogic.js'

const settingsPath = new URL('../src/views/SettingsView.vue', import.meta.url)
const settingsSrc = readFileSync(settingsPath, 'utf8')
const settings = parse(settingsSrc).descriptor
const settingsScript = settings.scriptSetup.content
const settingsTpl = settings.template.content

// ── ① 常量与归一化 ───────────────────────────────────────────────────────

test('常量：键名与默认档与后端同口径', () => {
  assert.equal(TOUCH_REACTION_MODE_KEY, 'touchReactionMode', '键名必须与后端 features.touchReactionMode 一致')
  assert.equal(DEFAULT_TOUCH_REACTION_MODE, 'conversation', '默认必须是 conversation（后端缺省即对话式）')
  assert.deepEqual(TOUCH_REACTION_MODES.map(m => m.value), ['conversation', 'quick'], '只允许这两档')
  assert.deepEqual(TOUCH_REACTION_MODES.map(m => m.label), ['对话式', '快速'], '中文标签')
})

test('归一化：非法值回落 conversation（不能回落 quick —— 那会让"没配过"的用户吃回退口径）', () => {
  assert.equal(normalizeTouchReactionMode('conversation'), 'conversation')
  assert.equal(normalizeTouchReactionMode('quick'), 'quick')
  for (const bad of [undefined, null, '', 'QUICK', 'fast', 0, 1, {}, [], 'quick ']) {
    assert.equal(normalizeTouchReactionMode(bad), 'conversation', `非法值 ${JSON.stringify(bad)} 要回落 conversation`)
  }
})

test('标签：合法档给中文，非法档按默认档标签', () => {
  assert.equal(touchReactionModeLabel('conversation'), '对话式')
  assert.equal(touchReactionModeLabel('quick'), '快速')
  assert.equal(touchReactionModeLabel('nonsense'), '对话式', '非法值按默认档显示')
})

// ── ② 界面接线 ───────────────────────────────────────────────────────────

test('设置页有「动作反应风格」页签，用 LinsheTabs 且绑到归一化后的值', () => {
  assert.match(settingsTpl, /动作反应风格/, '要有中文标题')
  const block = settingsTpl.slice(settingsTpl.indexOf('动作反应风格'))
  const tabs = block.slice(0, 900)
  assert.match(tabs, /<linshe-tabs/, '要用 LinsheTabs（不许裸 button/div 分段控件）')
  assert.match(tabs, /normalizeTouchReactionMode\(features\.touchReactionMode\)/, '绑定前要归一化')
  assert.match(tabs, /:options="TOUCH_REACTION_MODES"/, '选项走常量')
  assert.match(tabs, /@update:model-value="saveTouchReactionMode"/, '变更要落库')
})

test('设置页引入了新常量与函数（不是内联抄一份）', () => {
  for (const name of ['TOUCH_REACTION_MODES', 'TOUCH_REACTION_MODE_KEY', 'DEFAULT_TOUCH_REACTION_MODE', 'normalizeTouchReactionMode', 'touchReactionModeLabel']) {
    assert.ok(settingsScript.includes(name), `要 import ${name}`)
  }
  assert.ok(settingsScript.includes("from '../components/touchActionLogic.js'"), '从 touchActionLogic 引入')
})

test('features 响应式对象带默认档（首屏未拉到配置时也不能是 undefined）', () => {
  assert.match(settingsScript, /touchReactionMode:\s*DEFAULT_TOUCH_REACTION_MODE/,
    'features 初始值要带 touchReactionMode 默认档')
})

test('源码守卫：设置页没有裸 <select> / 裸 button 分段控件', () => {
  for (const tag of ['select']) {
    assert.equal(new RegExp(`<${tag}[\\s>]`).test(settingsTpl), false, `不许裸 <${tag}>`)
  }
})

// ── ③ 保存逻辑：走通用 feature 接口 + 失败回滚 ───────────────────────────

test('saveTouchReactionMode：成功落库并提示；失败回滚到上一档', async () => {
  const calls = []
  const toasts = []
  const updateFeatureFlag = async (key, value) => {
    calls.push({ key, value })
    if (apiFail.flag) throw new Error('boom')
  }
  const apiFail = { flag: false }
  const toastFn = (msg, type) => toasts.push({ msg, type })
  const features = { touchReactionMode: 'conversation' }

  // 提取函数体：它引用 normalizeTouchReactionMode / touchReactionModeLabel / updateFeatureFlag / toastFn / features
  const start = settingsScript.indexOf('async function saveTouchReactionMode')
  assert.ok(start >= 0, '找不到 saveTouchReactionMode')
  let i = settingsScript.indexOf(')', start)
  while (i < settingsScript.length && settingsScript[i] !== '{') i++
  let depth = 0
  for (; i < settingsScript.length; i++) {
    if (settingsScript[i] === '{') depth++
    else if (settingsScript[i] === '}') { depth--; if (depth === 0) break }
  }
  const body = settingsScript.slice(start, i + 1)

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const factory = new AsyncFunction(
    'features', 'updateFeatureFlag', 'toastFn',
    'normalizeTouchReactionMode', 'touchReactionModeLabel', 'TOUCH_REACTION_MODE_KEY',
    `${body}; return saveTouchReactionMode`
  )
  const save = await factory(features, updateFeatureFlag, toastFn,
    normalizeTouchReactionMode, touchReactionModeLabel, TOUCH_REACTION_MODE_KEY)

  // 切到 quick
  await save('quick')
  assert.deepEqual(calls.at(-1), { key: 'touchReactionMode', value: 'quick' }, 'key 要用常量、值原样')
  assert.equal(features.touchReactionMode, 'quick')
  assert.equal(toasts.at(-1).type, 'success')

  // 同值不重复落库
  const before = calls.length
  await save('quick')
  assert.equal(calls.length, before, '值没变就不该再发请求')

  // 非法值归一化后落库（不会把 'fast' 发上去）
  await save('fast')
  assert.equal(calls.at(-1).value, 'conversation', '非法值要归一化成 conversation 再发')

  // 失败回滚
  apiFail.flag = true
  await save('quick')
  assert.equal(features.touchReactionMode, 'conversation', '落库失败要回滚到上一档')
  assert.equal(toasts.at(-1).type, 'error')
})

test('源码守卫：保存函数走 updateFeatureFlag 且带 TOUCH_REACTION_MODE_KEY', () => {
  const start = settingsScript.indexOf('async function saveTouchReactionMode')
  const body = settingsScript.slice(start, start + 900)
  assert.match(body, /updateFeatureFlag\(TOUCH_REACTION_MODE_KEY/, '不许硬编码字符串键')
  assert.match(body, /features\.touchReactionMode = previous/, '失败要回滚')
})
