/**
 * 角色详情卡 → 亲密信息看板：入口必须真的渲染出面板（源码契约测试）
 *
 * 2026-11-01 真机踩到：点「看板」后详情卡整体消失、又没有面板顶上来，
 * 而且 `showIntimateModal` 除了 `visible` 变 false 之外没有任何界面能复位
 * ⇒ 详情卡再也打不开，只能刷新整个页面。
 *
 * 根因是入口只置了 flag：主面板的 v-if 里排除了 `showIntimateModal`，
 * 但模板里从来没有 `<IntimatePanel>`（组件 import 了却没用）。
 *
 * 钉住三件事：
 *   ① 要有 v-model 绑 showIntimateModal 的 linshe-modal
 *   ② 弹窗里要真的渲染 IntimatePanel，并把当前角色传进去
 *   ③ 弹窗要能关（关闭键复位 flag，否则又变成关不掉）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/components/ResidentCharacterDetailModal.vue', import.meta.url), 'utf8')

test('看板 entry 必须落地成一个真实弹窗，而不是只置 flag', () => {
  assert.match(SRC, /import IntimatePanel from '\.\/character\/IntimatePanel\.vue'/, 'IntimatePanel 要引入')
  assert.match(SRC, /<linshe-modal\s+v-model="showIntimateModal"/, '要有 v-model 绑 showIntimateModal 的弹窗')
  assert.match(SRC, /<IntimatePanel\s+v-if="character"\s+:character="character"/, '弹窗里要渲染 IntimatePanel 并传入当前角色')
  assert.match(SRC, /@click="showIntimateModal = false"/, '要有能复位 flag 的关闭键')
})

test('主面板排除的子弹窗必须都有对应渲染', () => {
  const overlayTag = SRC.match(/<div\s+v-if="visible[^"]*"\s+class="modal-overlay"/)
  assert.ok(overlayTag, '主面板 v-if 要能被识别')
  const flags = [...overlayTag[0].matchAll(/!([A-Za-z]+)/g)].map(m => m[1])
  assert.ok(flags.includes('showIntimateModal'), '主面板应当排除看板（避免双层遮罩）')
  // 去掉主面板那一行再找：排除了某个 flag，模板别处就必须真的用到它（v-model / :open / v-if 都算）
  const rest = SRC.replace(overlayTag[0], '')
  for (const flag of flags) {
    assert.ok(rest.includes(flag), `v-if 里排除了 ${flag}，但模板里没有任何地方渲染它 ⇒ 点了会整屏空白`)
  }
})

test('打开看板不改动主面板的 visible，关掉后详情卡能原样回来', () => {
  const openFn = SRC.slice(SRC.indexOf('function openIntimateModal()'), SRC.indexOf('// ── 外观/形态设置状态'))
  assert.ok(openFn.length > 0, '要能找到 openIntimateModal')
  assert.doesNotMatch(openFn, /emit\('close'\)/, '打开看板不能顺手关掉详情卡（否则关掉面板后卡也回不来）')
  assert.match(openFn, /showIntimateModal\.value = true/, '应当只翻 flag')
})
