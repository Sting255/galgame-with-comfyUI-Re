/**
 * 破限规则集编辑器纯逻辑单测（对应规划书 `规划-dsh-purge破限工具移植-20261015.md` 步骤 2.4）
 *
 * 逻辑抽在 `src/utils/jailbreakRuleDraft.js`，本文件直接 import 它跑。
 * 为什么抽模块：本仓没有组件挂载能力（无 @vue/test-utils / jsdom），
 * 而"范围勾选是集合运算""草稿 targets 是副本"这两条最容易出隐错，必须真有单测盯着。
 *
 * 另有几条源码守卫钉住 Vue 侧接线（只用 Linshe 组件、无裸控件、无 window.confirm）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import {
  pickRule, newDraft, copyToNewDraft, toggleTargetIn, setAllTargets,
  cancelPick, isBuiltinRule, draftByteLength,
} from '../src/utils/jailbreakRuleDraft.js'

const PRESETS = [
  { id: 'fiction-sandbox', name: '虚构沙盒（邻舍默认）', content: '', targets: ['chat', 'group', 'event', 'schedule', 'moment', 'diary', 'mailbox', 'media', 'town'], builtin: true },
  { id: 'unrestricted-execution', name: 'Unrestricted Execution（移植自 dsh-purge）', content: 'ALLOW_EXEC_CORE 正文', targets: ['chat', 'group', 'event', 'schedule', 'moment', 'diary', 'mailbox', 'media', 'town'], builtin: true },
  { id: 'custom-blank', name: '自定义空白模板', content: '', targets: ['chat', 'group', 'event', 'schedule', 'moment', 'diary', 'mailbox', 'media', 'town'], builtin: true },
]
const NINE = PRESETS[0].targets

// ── ① pickRule ────────────────────────────────────────────────────────────

test('pickRule：选中那套，草稿带上名字/正文/targets', () => {
  const { id, draft } = pickRule(PRESETS, 'unrestricted-execution')
  assert.equal(id, 'unrestricted-execution')
  assert.equal(draft.name, 'Unrestricted Execution（移植自 dsh-purge）')
  assert.equal(draft.content, 'ALLOW_EXEC_CORE 正文')
  assert.deepEqual(draft.targets, NINE)
})

test('pickRule：草稿的 targets 是副本 —— 改它不能污染 rules 里那条预置', () => {
  const { draft } = pickRule(PRESETS, 'fiction-sandbox')
  draft.targets.push('不该存在的目标')
  draft.name = '改坏了'
  assert.equal(PRESETS[0].targets.length, 9, '预置的 targets 不能被草稿改到')
  assert.equal(PRESETS[0].name, '虚构沙盒（邻舍默认）', '预置的 name 不能被草稿改到')
})

test('pickRule：id 不存在时草稿为 null（不崩）', () => {
  const { id, draft } = pickRule(PRESETS, '不存在的 id')
  assert.equal(id, '不存在的 id')
  assert.equal(draft, null)
})

test('pickRule：rules 不是数组也不崩', () => {
  assert.deepEqual(pickRule(undefined, 'x'), { id: 'x', draft: null })
  assert.deepEqual(pickRule(null, 'x'), { id: 'x', draft: null })
})

// ── ② newDraft / copyToNewDraft ───────────────────────────────────────────

test('newDraft：默认带上全部可选范围（不用手动勾九个）', () => {
  const { id, draft } = newDraft(['chat', 'group', 'event'])
  assert.equal(id, '', '新草稿没有 id（保存走 POST）')
  assert.equal(draft.id, '')
  assert.deepEqual(draft.targets, ['chat', 'group', 'event'])
})

test('newDraft：可选范围为空时 targets 也是空数组', () => {
  assert.deepEqual(newDraft([]).draft.targets, [])
  assert.deepEqual(newDraft(undefined).draft.targets, [])
})

test('copyToNewDraft：正文带着走、名字加「副本」、id 清空', () => {
  const src = { id: 'unrestricted-execution', name: 'Unrestricted Execution（移植自 dsh-purge）', content: 'ALLOW_EXEC_CORE 正文', targets: ['chat'] }
  const { id, draft } = copyToNewDraft(src)
  assert.equal(id, '', '副本也是新草稿（保存走 POST）')
  assert.equal(draft.id, '')
  assert.equal(draft.content, 'ALLOW_EXEC_CORE 正文', '正文要带过去')
  assert.equal(draft.name, 'Unrestricted Execution（移植自 dsh-purge）（副本）')
  assert.deepEqual(draft.targets, ['chat'])
})

test('copyToNewDraft：源草稿为空时有兜底名字，不产出 "undefined（副本）"', () => {
  const { draft } = copyToNewDraft(null)
  assert.equal(draft.name, '未命名规则集（副本）')
  assert.equal(draft.content, '')
  assert.deepEqual(draft.targets, [])
})

// ── ③ toggleTargetIn：集合运算（本文件最核心的一条）──────────────────────

test('toggleTargetIn：取消一个不影响其余八个', () => {
  const next = toggleTargetIn(NINE, 'chat', false)
  assert.equal(next.includes('chat'), false, 'chat 应被取消')
  assert.equal(next.length, 8, '其余八个必须还在 —— 这条是 E2E J6 的基石')
  // 入参不被改
  assert.equal(NINE.length, 9, '原数组不能被就地改')
})

test('toggleTargetIn：勾上已存在的目标不重复计数', () => {
  const next = toggleTargetIn(NINE, 'chat', true)
  assert.equal(next.filter(t => t === 'chat').length, 1)
  assert.equal(next.length, 9)
})

test('toggleTargetIn：全取消 → 空数组，不许回填成全集', () => {
  let cur = [...NINE]
  for (const key of NINE) cur = toggleTargetIn(cur, key, false)
  assert.deepEqual(cur, [], '空数组是合法表达（哪都不投递）')
})

test('toggleTargetIn：从空数组能一个个勾回来', () => {
  let cur = []
  cur = toggleTargetIn(cur, 'chat', true)
  cur = toggleTargetIn(cur, 'diary', true)
  assert.deepEqual(cur, ['chat', 'diary'])
})

test('toggleTargetIn：入参不是数组也不崩', () => {
  assert.deepEqual(toggleTargetIn(undefined, 'chat', true), ['chat'])
  assert.deepEqual(toggleTargetIn(null, 'chat', false), [])
})

// ── ④ setAllTargets / cancelPick / isBuiltinRule / draftByteLength ───────

test('setAllTargets：全选给全集副本，全不选给空数组', () => {
  const all = setAllTargets(['chat', 'group'], true)
  assert.deepEqual(all, ['chat', 'group'])
  all.push('改动了')
  assert.equal(PRESETS.length, 3, '不影响别处')
  assert.deepEqual(setAllTargets(['chat', 'group'], false), [])
})

test('cancelPick：新建态取消回到列表第一套；编辑态取消回到原选中套', () => {
  const a = cancelPick(PRESETS, true, '')
  assert.equal(a.id, 'fiction-sandbox', '新建取消后回到第一套')
  assert.equal(a.draft.name, '虚构沙盒（邻舍默认）')

  const b = cancelPick(PRESETS, false, 'custom-blank')
  assert.equal(b.id, 'custom-blank', '编辑取消后回到原选中套')
  assert.equal(b.draft.id, 'custom-blank')
})

test('cancelPick：列表为空时不崩', () => {
  assert.deepEqual(cancelPick([], true, ''), { id: '', draft: null })
})

test('isBuiltinRule：内置项为 true，自定义/不存在为 false', () => {
  assert.equal(isBuiltinRule(PRESETS, 'fiction-sandbox'), true)
  assert.equal(isBuiltinRule([...PRESETS, { id: 'mine', builtin: false }], 'mine'), false)
  assert.equal(isBuiltinRule(PRESETS, '不存在'), false)
  assert.equal(isBuiltinRule(undefined, 'x'), false)
})

test('draftByteLength：中文按 UTF-8 三字节算，不是 .length', () => {
  assert.equal(draftByteLength('abc'), 3)
  assert.equal(draftByteLength('中文'), 6, '两个汉字 = 6 字节')
  assert.equal(draftByteLength(''), 0)
  assert.equal(draftByteLength(null), 0)
  assert.equal(draftByteLength(undefined), 0)
})

// ── ⑤ 源码守卫：Vue 侧接线 ───────────────────────────────────────────────

const descriptor = parse(readFileSync(new URL('../src/views/JailbreakSettingsView.vue', import.meta.url), 'utf8')).descriptor
const script = descriptor.scriptSetup.content
const template = descriptor.template.content

test('页面只用 Linshe 组件，没有裸 button/input/select/textarea', () => {
  for (const tag of ['button', 'input', 'select', 'textarea']) {
    assert.equal(new RegExp(`<${tag}[\\s>]`).test(template), false, `不许裸 <${tag}>`)
  }
  const kebab = c => c.replace(/[A-Z]/g, m => '-' + m.toLowerCase()).replace(/^-/, '')
  for (const c of ['LinsheButton', 'LinsheInput', 'LinsheModal', 'LinsheSwitch']) {
    assert.ok(script.includes(`import ${c} from`), `必须引入 ${c}`)
    assert.ok(template.includes(`<${kebab(c)}`), `模板里要用 <${kebab(c)}>`)
  }
})

test('确认弹窗走 LinsheModal，不用 window.confirm/alert', () => {
  assert.ok(template.includes('<linshe-modal'), '确认弹窗必须用 LinsheModal')
  assert.equal(/window\.confirm|window\.alert/.test(script), false, '不许用浏览器原生确认框')
})

test('注入范围：按 availableTargets 渲染，且有全选/全不选', () => {
  assert.match(template, /v-for="key in availableTargets"/)
  assert.match(template, /全选/)
  assert.match(template, /全不选/)
})

test('内置项只读提示与「复制一份再改」入口都在模板里', () => {
  assert.match(template, /复制一份再改/, '内置项要提供「复制一份再改」')
  assert.match(template, /只能改名称与投递范围/, '要说明内置项只能改名称与范围')
  assert.match(template, /:disabled="draftBuiltin"/, '正文框要按 draftBuiltin 禁用')
})

test('组件确实调用了纯逻辑模块（不是又抄一份内联实现）', () => {
  for (const fn of ['pickRule', 'newDraft', 'copyToNewDraft', 'toggleTargetIn', 'isBuiltinRule', 'draftByteLength']) {
    assert.ok(script.includes(fn), `组件要用模块里的 ${fn}（单一真源，别在内联抄一份）`)
  }
  assert.ok(script.includes("from '../utils/jailbreakRuleDraft.js'"), '要 import 那个模块')
})
