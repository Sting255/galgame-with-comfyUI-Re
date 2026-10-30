/**
 * 催眠手机·群聊批量「命令她用玩具」（force_toy 的群聊入口）
 *
 * 背景：私聊面板 §⑤ 一直有「命令她用玩具」，后端 `hypnosisService` 的
 * `HYPNOSIS_COMMANDS` 也早就含 `force_toy`（编码 `force_toy|<toyKey>|<intensity>[|<mode>][|<curve>]`），
 * 但群聊批量区只有催眠/唤醒/只唤醒意志/强制高潮四个按钮 ⇒ **群聊里点不到**。
 *
 * 本文件钉住补上后的口径，抓四类容易再犯的错：
 *   ① 玩具清单必须按「选中的人」分别取（每人解锁情况不同），不是取一个人的
 *   ② 强度必须按**该件玩具自己的上限**夹取（振动棒 ≠ 跳蛋）
 *   ③ 批量前必须确认「每个人都真的能用这件玩具」——否则会出现半成功的怪状态
 *   ④ 可选段（mode / curve）留空时**不能**塞进请求体（后端要保持与旧形态逐字一致）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import {
  GROUP_FORCE_TOY_ACTION,
  toyOptionsFromResponse,
  intensityOptionsFor,
  buildForceToyCommand,
  canBatchForceToy,
} from '../src/components/hypnosisLogic.js'

const panelPath = new URL('../src/components/HypnosisPhoneGroupPanel.vue', import.meta.url)
const panelSrc = readFileSync(panelPath, 'utf8')
const panel = parse(panelSrc).descriptor
const panelScript = panel.scriptSetup.content
const panelTpl = panel.template.content

// ── ① 玩具清单归一化 ─────────────────────────────────────────────────────

test('toyOptionsFromResponse：开关关着 → 空清单（不显示这一区）', () => {
  assert.deepEqual(toyOptionsFromResponse({ unlocked: false, available: [{ toyKey: 'vibe_egg' }] }), [],
    'unlocked 不是 true 时一件都不给（与私聊 toysView.visible 同口径）')
  assert.deepEqual(toyOptionsFromResponse(null), [], 'null 不崩')
  assert.deepEqual(toyOptionsFromResponse({}), [], '缺字段不崩')
})

test('toyOptionsFromResponse：取 available 的 toyKey / 中文名 / 上限', () => {
  const res = {
    unlocked: true,
    available: [
      { toyKey: 'vibe_egg', label: '跳蛋', maxIntensity: 4 },
      { toyKey: 'wand', maxIntensity: 6 },          // 没给 label → 走 labelOf 兜底
      { label: '没有 key 的脏数据' },                 // 脏数据要被过滤
    ],
  }
  const out = toyOptionsFromResponse(res, { labelOf: k => (k === 'wand' ? '按摩棒' : '') })
  assert.deepEqual(out.map(o => o.value), ['vibe_egg', 'wand'], '没有 toyKey 的条目要过滤掉')
  assert.equal(out[0].label, '跳蛋', '后端给了 label 就用后端的')
  assert.equal(out[1].label, '按摩棒', '没给 label 走 labelOf')
  assert.equal(out[1].maxIntensity, 6, '上限要带上（强度选项按它生成）')
})

test('toyOptionsFromResponse：labelOf 也没有时回落 toyKey（不显示 undefined）', () => {
  const out = toyOptionsFromResponse({ unlocked: true, available: [{ toyKey: 'x_toy' }] })
  assert.equal(out[0].label, 'x_toy')
})

// ── ② 强度选项按该件玩具的上限 ───────────────────────────────────────────

test('intensityOptionsFor：按上限生成 0..max，上限那档标注「上限」', () => {
  const opts = intensityOptionsFor(3)
  assert.deepEqual(opts.map(o => o.value), [0, 1, 2, 3])
  assert.equal(opts.at(-1).label, '强度 3（上限）')
  assert.equal(opts[0].label, '强度 0')
})

test('intensityOptionsFor：上限 0 / 非法值 → 只给「无强度（象征物）」', () => {
  for (const bad of [0, -1, null, undefined, NaN, 'abc']) {
    const opts = intensityOptionsFor(bad)
    assert.deepEqual(opts, [{ label: '无强度（象征物）', value: 0 }], `${bad} 要回落象征物档`)
  }
})

// ── ③ 指令组装：可选段留空不发 ───────────────────────────────────────────

test('buildForceToyCommand：只给玩具与强度时，body 里不该出现 mode / curve', () => {
  const cmd = buildForceToyCommand({ toyKey: 'vibe_egg', intensity: 3 })
  assert.deepEqual(cmd, { toyKey: 'vibe_egg', intensity: 3 },
    '空 mode/curve 不能进 body —— 后端 parseForceToyDirective 要看到旧形态才保持逐字一致')
})

test('buildForceToyCommand：给了 mode / curve 才带上（只给 curve 时中间留空由后端处理）', () => {
  assert.deepEqual(
    buildForceToyCommand({ toyKey: 'vibe_egg', intensity: 2, mode: 'pulse' }),
    { toyKey: 'vibe_egg', intensity: 2, mode: 'pulse' }
  )
  assert.deepEqual(
    buildForceToyCommand({ toyKey: 'vibe_egg', intensity: 2, curve: 'wave' }),
    { toyKey: 'vibe_egg', intensity: 2, curve: 'wave' }
  )
  assert.deepEqual(
    buildForceToyCommand({ toyKey: 'vibe_egg', intensity: 2, mode: 'pulse', curve: 'wave' }),
    { toyKey: 'vibe_egg', intensity: 2, mode: 'pulse', curve: 'wave' }
  )
  // 空串 / 纯空白视为没给
  assert.deepEqual(buildForceToyCommand({ toyKey: 'vibe_egg', intensity: 1, mode: '  ', curve: '' }),
    { toyKey: 'vibe_egg', intensity: 1 })
})

test('buildForceToyCommand：没选玩具给 null（调用方直接不发，而不是发个空 key）', () => {
  assert.equal(buildForceToyCommand({ toyKey: '', intensity: 3 }), null)
  assert.equal(buildForceToyCommand({ toyKey: '   ' }), null)
  assert.equal(buildForceToyCommand({}), null)
  assert.equal(buildForceToyCommand(), null)
})

test('buildForceToyCommand：强度非法值按 0（不让 NaN 进请求体）', () => {
  assert.equal(buildForceToyCommand({ toyKey: 'k', intensity: 'abc' }).intensity, 0)
  assert.equal(buildForceToyCommand({ toyKey: 'k', intensity: -5 }).intensity, 0)
  assert.equal(buildForceToyCommand({ toyKey: 'k', intensity: null }).intensity, 0)
})

// ── ④ 批量前的一致性检查 ─────────────────────────────────────────────────

test('canBatchForceToy：所有人都能用这件玩具才放行', () => {
  const all = [['a', 'b'], ['b', 'a'], ['a']]
  assert.deepEqual(canBatchForceToy(all, 'a'), { ok: true, reason: '' })
})

test('canBatchForceToy：有人没有 → 拒绝并说清有几个人没有（避免半成功）', () => {
  const some = [['a', 'b'], ['b'], ['a']]   // 第 2 个人没有 a
  const res = canBatchForceToy(some, 'a')
  assert.equal(res.ok, false)
  assert.match(res.reason, /1 人没有这件玩具/, '要说清人数')
  assert.match(res.reason, /换一件|只选有的人/, '要给出可行做法')
})

test('canBatchForceToy：一个都没有 / 没选玩具 / 没选人 各有各的话', () => {
  assert.match(canBatchForceToy([['b'], ['c']], 'a').reason, /都没有这件玩具/)
  assert.match(canBatchForceToy([['a']], '').reason, /先选一件玩具/)
  assert.match(canBatchForceToy([], 'a').reason, /先选人/)
  assert.match(canBatchForceToy(null, 'a').reason, /先选人/)
})

// ── ⑤ 界面接线 ───────────────────────────────────────────────────────────

test('批量区有「命令她们戴上」按钮，且用 Linshe 组件', () => {
  assert.match(panelTpl, /命令她们戴上/, '按钮文案')
  assert.match(panelTpl, /@click="runForceToyBatch"/, '点了要跑批量函数')
  assert.match(panelTpl, /:loading="busyKey === GROUP_FORCE_TOY_ACTION\.key"/, 'loading 走 busyKey（与其它批量按钮同口径）')
  // 四个下拉都用 LinsheSelect
  const selects = panelTpl.match(/<linshe-select/g) || []
  assert.ok(selects.length >= 4, `玩具/强度/模式/曲线四个下拉都要用 LinsheSelect，实际 ${selects.length} 个`)
  for (const tag of ['select', 'input']) {
    assert.equal(new RegExp(`<${tag}[\\s>]`).test(panelTpl), false, `不许裸 <${tag}>`)
  }
})

test('这一区只在批量模式（选多人）显示', () => {
  // 玩具区整段必须挂 v-if="toySection.visible"，且标题在它里面
  const idx = panelTpl.indexOf('<section v-if="toySection.visible"')
  assert.ok(idx > 0, '找不到挂 toySection.visible 的玩具区 section')
  const section = panelTpl.slice(idx, idx + 1400)
  assert.match(section, /命令她用玩具/, '标题要在这一区里')
  assert.match(panelScript, /visible = options\.length > 0 && selectedIds\.value\.length > 1/,
    '批量模式才显示（选 1 人走完整单人面板，那边已经有这颗按钮）')
})

test('玩具清单按选中的人分别取（不是只取第一个人的）', () => {
  const body = panelScript.slice(panelScript.indexOf('async function loadGroupToys'))
  assert.match(body.slice(0, 900), /targets\.map\(async m =>/, '要对每个选中的人各取一次')
  assert.match(body.slice(0, 900), /fetchToys\(m\.id\)/, '每人一次 fetchToys')
  assert.match(body.slice(0, 900), /perMember\[Number\(m\.id\)\]/, '结果按人存进 perMember')
})

test('换玩具后强度回落到该件玩具的上限', () => {
  const body = panelScript.slice(panelScript.indexOf('watch(toyKey'))
  assert.match(body.slice(0, 300), /maxIntensityOf\(toyKey\.value\)/, '换玩具要按新上限夹强度')
})

test('选人变化时重新取玩具清单（清单必须跟着选中的人走）', () => {
  const idx = panelScript.indexOf("watch(() => selectedIds.value.join(','),")
  assert.ok(idx > 0, '要有「选中人变化」的 watch')
  const body = panelScript.slice(idx, idx + 400)
  assert.match(body, /options: \[\]/, '换人时先清空旧清单（避免显示别人有的玩具）')
  assert.match(body, /loadGroupToys\(\)/, '选多人时重新取')
})

test('批量下指令前先做一致性检查，不通过就提示且不发请求', () => {
  const body = panelScript.slice(panelScript.indexOf('async function runForceToyBatch'))
  const head = body.slice(0, 1200)
  assert.match(head, /canBatchForceToy\(/, '要检查每个人是否都有这件玩具')
  assert.match(head, /if \(!check\.ok\) return notify\(check\.reason, 'error'\)/, '不通过就提示并返回')
  assert.match(head, /commandCharacter\(m\.id, 'force_toy', cmd\)/, '通过后逐人下 force_toy')
  assert.match(head, /summarizeBatch\(/, '结果按既有批量汇总口径')
})

test('常量：动作 key 与文案（组件与测试共用一份）', () => {
  assert.equal(GROUP_FORCE_TOY_ACTION.key, 'forceToy')
  assert.equal(GROUP_FORCE_TOY_ACTION.label, '命令她用玩具')
  assert.equal(GROUP_FORCE_TOY_ACTION.variant, 'secondary')
})
