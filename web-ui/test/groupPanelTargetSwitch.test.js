/**
 * 群聊「换目标 ⇒ 两个面板自动关掉」的守卫（2026-10-18 新增）
 *
 * ## 这条为什么原来只能挂 SKIP
 * `e2e/check-group-panels.mjs` 的 ⑦ 长期 SKIP，脚本自己写明了原因（照抄）：
 *   「要验"面板会自动关"，前提是面板正开着；而面板一开，它自己的 LinsheModal 遮罩就压在
 *     下面那排图标上 ⇒ 点不到 ✋ / 换人按钮（Playwright 会一直重试到超时）」
 * 也就是说**结构上驱动不到**，不是"懒得测"。
 *
 * ## 为什么不能就这么算了
 * 面板里的 `characterId` 是**打开那一刻锁定**的（见 GroupChatView 里 `panelTargetId` 的注释）。
 * 换了目标却让面板继续开着 ⇒ "看着是 A 的面板、动作实际落在 B 身上"，
 * 用户以为自己在跟 A 互动 —— 是那种只有玩到一半才发现的错。所以必须有东西钉住它。
 *
 * ## 解法（照本仓惯例：把逻辑抽成纯函数再测）
 * 口径抽到 `src/components/groupPanelLogic.js` 的 `panelStateOnTargetChange`，
 * 视图只负责把返回值铺到 ref 上。本文件钉三件事：
 *   ① 换了目标 ⇒ 返回"全关 + 清空"的完整状态（**每个字段都要关到**，漏一个就是残留错人）；
 *   ② 目标没变 ⇒ 返回 null（否则"点开面板时被无关重渲染关掉"）；
 *   ③ 视图真的用了这个纯函数（源码级接线守卫）—— 只测纯函数会漏掉"函数写对了但没人调"。
 *
 * ⚠️ ③ 必须先剥注释：本文件与视图里都有解释文字，会提到这些符号名，不剥会自己判自己绿。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  panelStateOnTargetChange,
  EMPTY_GROUP_PANEL_STATE,
} from '../src/components/groupPanelLogic.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const VIEW = path.join(here, '..', 'src', 'views', 'GroupChatView.vue')
const viewSrc = fs.readFileSync(VIEW, 'utf8')

/** 剥注释：`/* … *\/`、`<!-- … -->`、行首 `// …` */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('① 换了目标 ⇒ 全部关掉并清空（四个字段一个都不能漏）', () => {
  const state = panelStateOnTargetChange({ prevTargetId: 1, nextTargetId: 2 })
  assert.ok(state, '换了人必须返回状态（不能是 null）')
  assert.equal(state.showToyPanel, false, '玩具面板要关')
  assert.equal(state.showIntimatePanel, false, '推进面板要关')
  assert.deepEqual(state.groupWornToys, [], '上一个人的玩具角标要清掉（否则挂在错误的人身上）')
  assert.deepEqual(state.groupToyOptions, [], '上一个人的可选项要清掉')
  // 与"初始空状态"同口径 —— 将来加字段时，两边一起变，避免漏关
  assert.deepEqual(state, { ...EMPTY_GROUP_PANEL_STATE })
})

test('② 目标没变 ⇒ 返回 null（不能白关一次，否则点开面板会被无关重渲染关掉）', () => {
  assert.equal(panelStateOnTargetChange({ prevTargetId: 2, nextTargetId: 2 }), null, '同一个 id 不该触发关闭')
  assert.equal(panelStateOnTargetChange({ prevTargetId: null, nextTargetId: null }), null, '都没选时也不该触发')
})

test('③ 形态差异按"同一个目标"处理（id 是数字还是字符串都算同一个人）', () => {
  assert.equal(panelStateOnTargetChange({ prevTargetId: 2, nextTargetId: '2' }), null,
    '2 与 "2" 是同一个人 ⇒ 不该关面板（否则接口回字符串就会误关）')
  assert.ok(panelStateOnTargetChange({ prevTargetId: 2, nextTargetId: '3' }), '不同的人必须关')
})

test('④ 从有到无、从无到有都算"变了"（换群导致目标被清空也要收面板）', () => {
  for (const [prev, next] of [[1, null], [null, 1], [1, ''], ['', 1], [1, undefined], [undefined, 1]]) {
    const state = panelStateOnTargetChange({ prevTargetId: prev, nextTargetId: next })
    assert.ok(state, `${JSON.stringify(prev)} → ${JSON.stringify(next)} 应当算作目标变化`)
    assert.equal(state.showToyPanel, false)
    assert.equal(state.showIntimatePanel, false)
  }
})

test('⑤ 接线守卫：GroupChatView 必须真的调用这个纯函数（别只写对函数却没人用）', () => {
  const code = stripComments(viewSrc)
  assert.match(code, /panelStateOnTargetChange\s*\(/,
    'GroupChatView 必须调用 panelStateOnTargetChange（只测纯函数会漏掉"没人调"）')
  assert.match(code, /import\s*\{[^}]*panelStateOnTargetChange[^}]*\}\s*from\s*['"][^'"]*groupPanelLogic/,
    '必须从 groupPanelLogic 导入它')
})
