/**
 * 重写兜底（reroll）的过渡提示「重新组织语言中…」（2026-10-15 补）
 *
 * 背景：`features.antiRepetitionReroll` 打开后，检测到车轱辘话时后端会**重新生成一遍**
 * （多花一次模型调用、几秒），成功则发 `replace_last_assistant` 换掉已上屏的气泡。
 * 之前这段等待期**前端没有任何提示** ⇒ 用户以为刚才那段就是最终答案，然后文字突然被换掉。
 *
 * 补法：后端在真正开始重写前发 `reroll_start`、结束（成功或失败）发 `reroll_end`；
 * 前端 chat store 维护 `rerolling` 标志，ChatView 显示「重新组织语言中…」。
 *
 * 本文件钉住四类容易再犯的错：
 *   ① 后端两个事件都要发（失败路径也要发 reroll_end，否则标记永远不撤）
 *   ② 标记要有兜底清理（response_end / dialogue_saved / 新一轮 / 切角色）
 *   ③ 前端必须真的渲染提示（不能只存标志不显示）
 *   ④ 提示不能写成"报错"口吻（重写失败时原输出保留，用户不该看到错误）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const chatRoute = readFileSync(new URL('../../agent-core/src/routes/chat.js', import.meta.url), 'utf8')
const chatStore = readFileSync(new URL('../src/stores/chat.js', import.meta.url), 'utf8')
const chatView = readFileSync(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')

// ── ① 后端：两个事件都要发 ───────────────────────────────────────────────

test('后端在真正重写前发 reroll_start', () => {
  const startIdx = chatRoute.indexOf("send('reroll_start'")
  const consumeIdx = chatRoute.indexOf('await consumeStream(rerollMsgs, upstreamAbort.signal)')
  assert.ok(startIdx > 0, '要有 reroll_start 事件')
  assert.ok(consumeIdx > 0, '找不到重写的 consumeStream')
  assert.ok(startIdx < consumeIdx, 'reroll_start 必须在真正重写之前发（之后发就没意义了）')
})

test('后端重写成功与失败都发 reroll_end（否则标记永远不撤）', () => {
  const okIdx = chatRoute.indexOf("send('reroll_end', { ok: true })")
  const failIdx = chatRoute.indexOf("send('reroll_end', { ok: false })")
  assert.ok(okIdx > 0, '成功路径要发 reroll_end ok:true')
  assert.ok(failIdx > 0, '失败路径也要发 reroll_end ok:false —— 标记必须撤掉')
  assert.ok(failIdx < okIdx, '失败分支（catch）在前，成功的在替换事件之后')
})

test('顺序守卫：reroll_end(true) 必须在 replace_last_assistant **之后**', () => {
  // 先发 reroll_end 会让前端提前撤掉「重新组织语言中…」⇒「提示没了、文字还是旧的」空窗
  const replaceIdx = chatRoute.indexOf("send(replacement.event, replacement.data)")
  const endIdx = chatRoute.indexOf("send('reroll_end', { ok: true })")
  assert.ok(replaceIdx > 0, '找不到替换事件的发送点')
  assert.ok(endIdx > 0, '找不到 reroll_end(true)')
  assert.ok(replaceIdx < endIdx, '撤提示必须在替换事件之后（血的顺序：反了就有空窗）')
})

test('顺序守卫：reroll_start 在真正重写之前、在替换事件之前', () => {
  const startIdx = chatRoute.indexOf("send('reroll_start'")
  const consumeIdx = chatRoute.indexOf('await consumeStream(rerollMsgs, upstreamAbort.signal)')
  const replaceIdx = chatRoute.indexOf("send(replacement.event, replacement.data)")
  assert.ok(startIdx < consumeIdx, 'reroll_start 要在真正重写之前')
  assert.ok(consumeIdx < replaceIdx, '重写在替换事件之前')
})

test('源码守卫：reroll_end 在 catch 里（失败时原输出保留，标记要撤）', () => {
  const catchIdx = chatRoute.indexOf('reroll failed, keeping original output')
  const endIdx = chatRoute.indexOf("send('reroll_end', { ok: false })")
  assert.ok(catchIdx > 0 && endIdx > 0)
  // reroll_end(false) 应出现在该 catch 块内（前后 400 字符范围内）
  assert.ok(Math.abs(endIdx - catchIdx) < 500, 'reroll_end(false) 应在失败分支里')
})

// ── ② 前端 store：标志与兜底清理 ─────────────────────────────────────────

test('store 有 rerolling 标志，两个事件分别置真/置假', () => {
  assert.match(chatStore, /const rerolling = ref\(false\)/, '要有 rerolling 状态')
  const startBranch = chatStore.slice(chatStore.indexOf("if (lastEvent === 'reroll_start')"))
  assert.match(startBranch.slice(0, 120), /rerolling\.value = true/, 'reroll_start 置真')
  const endBranch = chatStore.slice(chatStore.indexOf("if (lastEvent === 'reroll_end')"))
  assert.match(endBranch.slice(0, 120), /rerolling\.value = false/, 'reroll_end 置假')
})

test('store 导出 rerolling（视图才能用）', () => {
  const ret = chatStore.slice(chatStore.indexOf('return { characters, activeCharId'))
  assert.match(ret.slice(0, 700), /rerolling,/, '要出现在 return 里')
})

test('兜底清理：本轮结束（response_end / dialogue_saved）也要清掉标记', () => {
  const idx = chatStore.indexOf("if (lastEvent === 'dialogue_saved' || lastEvent === 'response_end') rerolling.value = false")
  assert.ok(idx > 0, '本轮结束时要有兜底清理（防后端异常/断流残留）')
})

test('兜底清理：发新消息与切角色都要清掉标记', () => {
  // 发新消息
  const sendIdx = chatStore.indexOf('rerolling.value = false  // 新一轮开始')
  assert.ok(sendIdx > 0, '发新消息时要清（上一轮的标记与本轮无关）')
  // 切角色
  const switchIdx = chatStore.indexOf('rerolling.value = false        // 切角色时清掉重写过渡态')
  assert.ok(switchIdx > 0, '切角色时要清')
})

// ── ③ 视图：真的渲染提示 ─────────────────────────────────────────────────

test('ChatView 渲染「重新组织语言中…」，且绑到 chat.rerolling', () => {
  assert.match(chatView, /重新组织语言中…/, '要有提示文案')
  const idx = chatView.indexOf('重新组织语言中…')
  const block = chatView.slice(Math.max(0, idx - 700), idx)
  assert.match(block, /v-if="chat\.rerolling"/, '要按 rerolling 显示')
  assert.match(block, /role="status"/, '要用 status 角色（无障碍）')
})

test('提示是过渡态口吻，不是报错口吻', () => {
  const idx = chatView.indexOf('reroll-status')
  const block = chatView.slice(idx, idx + 900)
  assert.equal(/失败|错误|出错/.test(block), false, '过渡提示里不能出现"失败/错误"字样')
  assert.match(block, /reroll-status/, '要有独立 class（便于与记忆回想条区分样式）')
})

test('提示复用记忆回想条的过渡动画（保持视觉一致）', () => {
  const idx = chatView.indexOf('reroll-status')
  const block = chatView.slice(Math.max(0, idx - 400), idx + 200)
  assert.match(block, /recall-status/, '复用 .recall-status 的既有皮肤，不另造一套')
  assert.match(block, /Transition name="guesses-fade"/, '复用既有过渡动画')
})
