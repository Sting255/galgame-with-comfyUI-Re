/**
 * 朋友圈话题库「参与自动抽取」（checked）前端接线
 *
 * 后端 `moment_topics.checked` 一直是完整的（schema + CRUD 都支持，见 `agent-core/src/routes/library.js`
 * 的 `topicToApi` / `POST /topics` / `PUT /topics/:id`），但**前端把它整个丢了**：
 *   · `LibraryModal.vue` 的 `cleanPayload` 对话题库只回 `{name, desc}` ⇒ 保存时 checked 被抹掉
 *   · `LibraryItemCard.vue` 没有任何 checked 控件 ⇒ 用户看不到也改不了
 * 本文件钉住修复后的口径，抓三类真容易再犯的错：
 *   ① 后端给的是 0/1 整数，卡片上的 LinsheSwitch 要**布尔** —— 不做归一化会把 0 当 truthy 显示成「开」
 *   ② 保存 payload 必须带上 checked；`false` 要发 0（不能因为 `||` 兜底把 false 变成 1）
 *   ③ 卡片上就地切换失败要**回滚**（与其它开关同口径），不能留一个骗人的开关位置
 *
 * 本仓没有组件挂载能力（无 @vue/test-utils / jsdom），所以用「读源码 + 提取纯逻辑」的路子
 * （与 `settingsArtist.test.js` / `jailbreakSettings.test.js` 同风格）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'

const modalPath = new URL('../src/components/LibraryModal.vue', import.meta.url)
const cardPath = new URL('../src/components/LibraryItemCard.vue', import.meta.url)
const modal = parse(readFileSync(modalPath, 'utf8')).descriptor
const card = parse(readFileSync(cardPath, 'utf8')).descriptor
const modalScript = modal.scriptSetup.content
const modalTpl = modal.template.content
const cardScript = card.scriptSetup.content
const cardTpl = card.template.content

/** 从 script 里精确摘一个函数（从 `function 名字(` 到配对花括号），处理嵌套 {}。
 *  ⚠️ 必须把可能的 `async ` 前缀一起摘进来 —— 只从 `function` 开始切会丢掉 async，
 *  函数体里的 await 立刻变成语法错误（本文件第一版就栽在这）。 */
function extractFn(script, name) {
  let start = script.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 function ${name}()`)
  if (script.slice(Math.max(0, start - 6), start) === 'async ') start -= 6
  let i = script.indexOf(')', start)
  while (i < script.length && script[i] !== '{') i++
  assert.ok(i < script.length, `${name} 没找到函数体`)
  let depth = 0
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++
    else if (script[i] === '}') { depth--; if (depth === 0) break }
  }
  assert.ok(i < script.length, `${name} 花括号没配对`)
  return script.slice(start, i + 1)
}

// ── ① 列表归一化：0/1 → 布尔 ─────────────────────────────────────────────

test('load()：话题库把后端 0/1 归一到布尔，老行缺字段按「参与」兜底', () => {
  // 复刻 load() 里那段映射（只取与 checked 有关的部分，避免把 api/toast 依赖搬进来）
  const map = rows => (rows || []).map(r => ({ ...r, checked: r.checked === undefined ? true : !!r.checked }))

  assert.deepEqual(map([{ id: 1, checked: 1 }])[0].checked, true)
  assert.deepEqual(map([{ id: 2, checked: 0 }])[0].checked, false, '0 必须是 false，不能被当 truthy 显示成「开」')
  assert.deepEqual(map([{ id: 3 }])[0].checked, true, '老行缺 checked 时按「参与」兜底（与后端 topicToApi 同口径）')
  assert.deepEqual(map(null), [], 'null 不崩')
  // 其它字段原样保留
  assert.equal(map([{ id: 4, name: '深夜emo', desc: 'd', checked: 1 }])[0].name, '深夜emo')
})

test('源码守卫：load() 里话题库确实走了那条归一化（不是直接赋值）', () => {
  assert.match(modalScript, /r\.checked === undefined \? true : !!r\.checked/, 'load() 必须有 0/1 → 布尔 的归一化')
  assert.ok(!/items\.value = isEvents\.value \? await api\.listEventTypes\(\) : await api\.listTopics\(\)/.test(modalScript),
    '不能再用「三元直接赋值」的老写法（那会把 0/1 原样塞给 LinsheSwitch）')
})

// ── ② 保存 payload 带上 checked ──────────────────────────────────────────

test('cleanPayload：话题库保存时必须带 checked，false 要发 0', () => {
  const isEvents = { value: false }
  const cleanPayload = new Function('isEvents', `${extractFn(modalScript, 'cleanPayload')}; return cleanPayload`)(isEvents)

  assert.deepEqual(cleanPayload({ name: 'a', desc: 'd', checked: true }), { name: 'a', desc: 'd', checked: 1 })
  assert.deepEqual(cleanPayload({ name: 'a', desc: 'd', checked: false }), { name: 'a', desc: 'd', checked: 0 },
    'checked=false 必须发 0 —— 用 `|| 1` 兜底会把 false 悄悄变成「参与」')
  // undefined 按 1（与后端 toBoolInt(body.checked, 1) 默认一致）
  assert.deepEqual(cleanPayload({ name: 'a', desc: 'd' }), { name: 'a', desc: 'd', checked: 1 })
})

test('cleanPayload：事件库不受影响（不带 checked）', () => {
  const isEvents = { value: true }
  const cleanPayload = new Function('isEvents', `${extractFn(modalScript, 'cleanPayload')}; return cleanPayload`)(isEvents)
  const out = cleanPayload({ key: 'k', name: 'n', durationMin: 60, urgency: 1, funFrom: ['x'], desc: 'd', checked: false })
  assert.equal('checked' in out, false, 'checked 只属话题库，事件库 payload 不该多这个字段')
  assert.equal(out.key, 'k')
})

// ── ③ 就地切换 + 失败回滚 ────────────────────────────────────────────────

test('toggleChecked：成功时按新值落库并提示；失败时把开关拨回去', async () => {
  const calls = []
  const toasts = []
  const api = {
    updateTopic: async (id, data) => { calls.push({ id, data }); if (api._fail) throw new Error('boom'); return { ok: true } },
    _fail: false,
  }
  const toastFn = (msg, type) => toasts.push({ msg, type })
  // 注意：源码里 toggleChecked 是 async，而 `new Function` 创建的函数体**不能含 await**
  // （会直接 SyntaxError：await is only valid in async functions）。
  // 正确做法是用 `AsyncFunction` 构造器（`Object.getPrototypeOf(async () => {}).constructor`），
  // 它允许函数体里出现 await。
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const factory = new AsyncFunction('api', 'toastFn', `
    ${extractFn(modalScript, 'toggleChecked')}
    return toggleChecked
  `)
  const toggleChecked = await factory(api, toastFn)

  // 成功：开 → 关
  const item = { id: 7, name: 'n', desc: 'd', checked: false }
  await toggleChecked(item)
  assert.deepEqual(calls.at(-1), { id: 7, data: { name: 'n', desc: 'd', checked: 0 } }, '关掉时发 checked: 0')
  assert.equal(toasts.at(-1).type, 'success')

  // 成功：关 → 开
  const item2 = { id: 8, name: 'n', desc: 'd', checked: true }
  await toggleChecked(item2)
  assert.deepEqual(calls.at(-1), { id: 8, data: { name: 'n', desc: 'd', checked: 1 } }, '打开时发 checked: 1')

  // 失败：回滚 + error toast
  api._fail = true
  const item3 = { id: 9, name: 'n', desc: 'd', checked: false }   // 用户刚把它关掉
  await toggleChecked(item3)
  assert.equal(item3.checked, true, '落库失败必须把开关拨回「开」—— 不能留一个骗人的关位置')
  assert.equal(toasts.at(-1).type, 'error')

  api._fail = false
  const item4 = { id: 10, name: 'n', desc: 'd', checked: true }  // 用户刚把它打开
  api._fail = true
  await toggleChecked(item4)
  assert.equal(item4.checked, false, '反向也要回滚（开 → 失败 → 回到关）')
})

test('源码守卫：toggleChecked 真的调用 updateTopic 且带 checked', () => {
  const src = extractFn(modalScript, 'toggleChecked')
  assert.match(src, /api\.updateTopic\(/, '必须真落库，不能只改内存')
  assert.match(src, /checked:\s*next/, 'payload 要带 checked')
  assert.match(src, /item\.checked = prev === 1/, '失败要回滚')
})

// ── ④ 卡片：控件在、只对话题库显示、只用 Linshe 组件 ────────────────────

test('卡片有「参与自动抽取」开关，且只在话题库显示（事件库不显示）', () => {
  const switches = cardTpl.match(/<linshe-switch/g) || []
  assert.ok(switches.length >= 2, `展示态与编辑态各要一个开关，实际 ${switches.length} 个`)
  // 两个开关都必须挂在 !isEvents 上（事件库没有 checked 概念）
  const guarded = cardTpl.match(/v-if="!isEvents"/g) || []
  assert.ok(guarded.length >= 2, `开关要按 !isEvents 门控，实际 ${guarded.length} 处`)
  assert.match(cardTpl, /参与自动抽取/, '要有中文标签')
  assert.match(cardTpl, /手动点题仍可用/, '要说明「手动点题不受限制」，否则用户以为关掉就彻底不能用了')
})

test('卡片只用 Linshe 组件，没有裸 input/select', () => {
  for (const tag of ['input', 'select']) {
    assert.equal(new RegExp(`<${tag}[\\s>]`).test(cardTpl), false, `不许裸 <${tag}>`)
  }
  assert.ok(cardScript.includes("import LinsheSwitch from './ui/LinsheSwitch.vue'"), '要引入 LinsheSwitch')
})

test('卡片把切换事件抛给父组件（不在卡片里直接调 api）', () => {
  assert.match(cardScript, /'toggle-checked'/, 'defineEmits 要声明 toggle-checked')
  assert.match(cardTpl, /@change="emit\('toggle-checked', item\)"/, '展示态开关要抛事件')
  assert.equal(/from '\.\.\/api/.test(cardScript), false, '卡片是展示组件，不该自己调 api')
})

test('父组件两处 LibraryItemCard 都接了 toggle-checked', () => {
  const bound = modalTpl.match(/@toggle-checked="toggleChecked"/g) || []
  assert.equal(bound.length, 2, `系统组与自定义组都要接，实际 ${bound.length} 处`)
})
