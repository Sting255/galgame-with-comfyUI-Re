/**
 * 朋友圈「点题」前端入口（LibraryModal 的「立即发送」）
 *
 * 背景：后端从合并轮起就完整支持点题 ——
 *   `POST /api/moments/generate { character_id, topic_id }` → `generateMomentPost(character, { manual:true, topicId })`
 *   （`routes/moments.js` L277~288；失效话题 404、非法参数 400，均已在合并轮真机实测过 4/4）。
 * 但前端一直缺入口：`api/index.js` 的 `generateMoment` 只发 `character_id`，
 * `LibraryModal` 也没有「立即发送」。于是后端能力在 UI 上够不着。
 *
 * 本文件钉住修复后的口径，抓四类容易再犯的错：
 *   ① api 层必须透传 topic_id，且不传时不能塞 `undefined` 进 body（老调用方行为不能变）
 *   ② store 的 generatePost 要把 topicId 一路带到 api
 *   ③ 卡片「立即发送」只在非编辑态且有 id 时出现（临时新增的空条目不能发）
 *   ④ 发送失败要把后端语义化拒绝码翻成人话（already_active_event / events_disabled / character_not_found）
 *
 * 本仓没有组件挂载能力（无 @vue/test-utils / jsdom），所以用「读源码 + 提取纯逻辑」的路子
 * （与 `libraryTopicChecked.test.js` / `jailbreakSettings.test.js` 同风格）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'

const modalPath = new URL('../src/components/LibraryModal.vue', import.meta.url)
const cardPath = new URL('../src/components/LibraryItemCard.vue', import.meta.url)
const apiPath = new URL('../src/api/index.js', import.meta.url)
const momentsStorePath = new URL('../src/stores/moments.js', import.meta.url)

const modal = parse(readFileSync(modalPath, 'utf8')).descriptor
const card = parse(readFileSync(cardPath, 'utf8')).descriptor
const modalScript = modal.scriptSetup.content
const modalTpl = modal.template.content
const cardScript = card.scriptSetup.content
const cardTpl = card.template.content
const apiSrc = readFileSync(apiPath, 'utf8')
const momentsStore = readFileSync(momentsStorePath, 'utf8')

/** 从 script 里精确摘一个函数（含 async 前缀，处理嵌套 {}）。 */
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

// ── ① api 层透传 topic_id ────────────────────────────────────────────────

test('api：generateMoment 接受并透传 topic_id', () => {
  assert.match(apiSrc, /export async function generateMoment\(characterId,\s*topicId\)/,
    '签名要收第二个参数 topicId')
  assert.match(apiSrc, /topic_id:\s*topicId/, 'body 里要带 topic_id')
})

test('api：不传 topicId 时 body 里不该出现 topic_id（JSON.stringify 会丢 undefined）', () => {
  // 复刻 api 的 body 组装口径：undefined 经 JSON.stringify 后消失，老调用方行为不变
  const build = topicId => JSON.stringify({ character_id: 1, topic_id: topicId })
  assert.equal(build(undefined), '{"character_id":1}', '不传时不能出现 topic_id 键')
  assert.equal(build(7), '{"character_id":1,"topic_id":7}', '传了要原样带上')
})

// ── ② store 一路带到 api ─────────────────────────────────────────────────

test('store：generatePost 把 topicId 交给 api', () => {
  assert.match(momentsStore, /async function generatePost\(characterId,\s*topicId\)/,
    'generatePost 要收 topicId')
  assert.match(momentsStore, /api\.generateMoment\(characterId,\s*topicId\)/,
    '要把它传给 api.generateMoment')
})

test('源码守卫：moments store 没有留下「只传 characterId」的老调用', () => {
  assert.equal(/api\.generateMoment\(characterId\)/.test(momentsStore), false,
    '不许再有只传一个参数的调用（点题会静默退化成随机抽题）')
})

// ── ③ 卡片按钮的出现条件 ─────────────────────────────────────────────────

test('卡片：非编辑态且有 id 才显示「立即发送」', () => {
  const m = cardTpl.match(/<linshe-button v-if="([^"]+)"[^>]*@click="emit\('publish', item\)"/)
  assert.ok(m, '卡片上要有「立即发送」按钮并抛 publish 事件')
  assert.match(m[1], /!item\._editing/, '编辑态不显示')
  assert.match(m[1], /item\.id/, '还没入库的临时条目不能发（没有 id）')
  assert.match(cardTpl, /立即发送/, '按钮文案')
})

test('卡片：publishing 期间按钮禁用，避免重复点出两条', () => {
  const m = cardTpl.match(/<linshe-button v-if="!item\._editing && item\.id"[^>]*>/)
  assert.ok(m, '找不到「立即发送」按钮标签')
  assert.match(m[0], /:disabled="publishing"/, '发送中要禁用')
  assert.match(cardScript, /publishing:\s*\{\s*type:\s*Boolean/, 'publishing 要走 props 传进来')
  assert.match(cardScript, /'publish'/, 'defineEmits 要声明 publish')
})

// ── ④ 父组件的发送逻辑与错误翻译 ─────────────────────────────────────────

test('父组件：两个分组都接了 @publish，且传了 publishing', () => {
  const bound = modalTpl.match(/@publish="openPublish"/g) || []
  assert.equal(bound.length, 2, `系统组与自定义组都要接，实际 ${bound.length} 处`)
  const passing = modalTpl.match(/:publishing="publishing"/g) || []
  assert.equal(passing.length, 2, `两组都要把 publishing 传下去，实际 ${passing.length} 处`)
})

test('父组件：朋友圈走 generateMoment(characterId, item.id)，奇遇走 generateEvent(characterId, item.key)', async () => {
  const calls = []
  const api = {
    generateEvent: async (cid, key) => { calls.push(['event', cid, key]); return { id: 1 } },
    generateMoment: async (cid, topicId) => { calls.push(['moment', cid, topicId]); return { id: 2 } },
  }
  const toastFn = () => {}
  const emitted = []
  const emit = (name) => emitted.push(name)
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

  const factory = new AsyncFunction('api', 'toastFn', 'emit', 'isEvents', 'publishItem', 'publishCharacterId', 'publishing', 'publishOpen', 'charactersLoading', 'charactersError', `
    ${extractFn(modalScript, 'publishSelected')}
    return publishSelected
  `)

  // 朋友圈：话题库 → topic_id 传条目 id
  let isEvents = { value: false }
  let publishItem = { value: { id: 42, name: '深夜emo' } }
  let publishCharacterId = { value: 6 }
  let publishing = { value: false }
  let publishOpen = { value: true }
  let sel = await factory(api, toastFn, emit, isEvents, publishItem, publishCharacterId, publishing, publishOpen,
    { value: false }, { value: '' })
  await sel()
  assert.deepEqual(calls.at(-1), ['moment', 6, 42], '朋友圈要带话题 id')
  assert.equal(emitted.at(-1), 'published', '成功后要通知父视图刷新')
  assert.equal(publishOpen.value, false, '成功后关掉子弹窗')

  // 奇遇：事件库 → eventTypeKey 传条目 key
  isEvents = { value: true }
  publishItem = { value: { id: 9, key: 'campus_daily', name: '校园日常' } }
  publishCharacterId = { value: 3 }
  publishOpen = { value: true }
  sel = await factory(api, toastFn, emit, isEvents, publishItem, publishCharacterId, { value: false }, publishOpen,
    { value: false }, { value: '' })
  await sel()
  assert.deepEqual(calls.at(-1), ['event', 3, 'campus_daily'], '奇遇要带事件类型 key')
})

test('父组件：后端语义化拒绝码翻成人话', async () => {
  const toasts = []
  const toastFn = (msg, type) => toasts.push({ msg, type })
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const factory = new AsyncFunction('api', 'toastFn', 'emit', 'isEvents', 'publishItem', 'publishCharacterId', 'publishing', 'publishOpen', 'charactersLoading', 'charactersError', `
    ${extractFn(modalScript, 'publishSelected')}
    return publishSelected
  `)

  for (const [code, expectWord] of [
    ['already_active_event', '未结束的奇遇'],
    ['events_disabled', '奇遇功能尚未启用'],
    ['character_not_found', '角色已不存在'],
  ]) {
    const api = {
      generateEvent: async () => { throw new Error(code) },
      generateMoment: async () => { throw new Error(code) },
    }
    const sel = await factory(api, toastFn, () => {}, { value: true }, { value: { id: 1, key: 'k' } },
      { value: 2 }, { value: false }, { value: true }, { value: false }, { value: '' })
    await sel()
    assert.equal(toasts.at(-1).type, 'error', `${code} 要提示错误`)
    assert.match(toasts.at(-1).msg, new RegExp(expectWord), `${code} 要翻成含「${expectWord}」的人话`)
  }

  // 未登记的码原样透出（不吞信息）
  const api = { generateMoment: async () => { throw new Error('服务器打了个喷嚏') } }
  const sel = await factory(api, toastFn, () => {}, { value: false }, { value: { id: 1 } },
    { value: 2 }, { value: false }, { value: true }, { value: false }, { value: '' })
  await sel()
  assert.equal(toasts.at(-1).msg, '服务器打了个喷嚏')
})

test('父组件：发送中或未选角色时直接返回，不发请求', async () => {
  let called = 0
  const api = {
    generateMoment: async () => { called++; return {} },
    generateEvent: async () => { called++; return {} },
  }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const factory = new AsyncFunction('api', 'toastFn', 'emit', 'isEvents', 'publishItem', 'publishCharacterId', 'publishing', 'publishOpen', 'charactersLoading', 'charactersError', `
    ${extractFn(modalScript, 'publishSelected')}
    return publishSelected
  `)

  // 未选角色
  let sel = await factory(api, () => {}, () => {}, { value: false }, { value: { id: 1 } },
    { value: null }, { value: false }, { value: true }, { value: false }, { value: '' })
  await sel()
  assert.equal(called, 0, '没选角色不能发')

  // 正在发送中（连点两次）
  sel = await factory(api, () => {}, () => {}, { value: false }, { value: { id: 1 } },
    { value: 2 }, { value: true }, { value: true }, { value: false }, { value: '' })
  await sel()
  assert.equal(called, 0, '发送中不能再发（防重复发帖）')

  // 角色列表还在加载
  sel = await factory(api, () => {}, () => {}, { value: false }, { value: { id: 1 } },
    { value: 2 }, { value: false }, { value: true }, { value: true }, { value: '' })
  await sel()
  assert.equal(called, 0, '角色还没加载完不能发')
})

// ── ⑤ 只用 Linshe 组件 + 视图接线 ────────────────────────────────────────

test('子弹窗只用 Linshe 组件，没有裸 select/input', () => {
  for (const tag of ['input', 'select']) {
    assert.equal(new RegExp(`<${tag}[\\s>]`).test(modalTpl), false, `不许裸 <${tag}>`)
  }
  assert.ok(modalScript.includes("import LinsheSelect from './ui/LinsheSelect.vue'"), '要引入 LinsheSelect')
  assert.match(modalTpl, /<linshe-select/, '角色选择要用 LinsheSelect')
  assert.match(modalTpl, /<linshe-modal v-model="publishOpen" title="选择角色"/, '子弹窗要用 LinsheModal')
})

test('两个视图都把 published 接到各自 store 的刷新上', () => {
  const momentsView = readFileSync(new URL('../src/views/MomentsView.vue', import.meta.url), 'utf8')
  const eventsView = readFileSync(new URL('../src/views/EventsView.vue', import.meta.url), 'utf8')
  assert.match(momentsView, /<LibraryModal[^>]*@published="moments\.loadPosts\(\)"/, '朋友圈要刷新列表')
  assert.match(eventsView, /<LibraryModal[^>]*@published="store\.loadEvents\(\)"/, '奇遇要刷新列表')
})

test('父组件：关掉话题库时同步收起子弹窗（不残留上一个话题）', () => {
  const watchSrc = modalScript.slice(modalScript.indexOf('watch(() => props.modelValue'))
  assert.match(watchSrc.slice(0, 700), /publishOpen\.value = false/,
    'watch modelValue 的 else 分支要收起 publishOpen')
})
