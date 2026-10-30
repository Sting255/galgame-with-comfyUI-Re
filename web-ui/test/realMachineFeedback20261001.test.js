/**
 * 2026-10-01 真机反馈三条的回归守卫（都来自用户实机日志 / 口述）
 *
 *   ①「窗口确实可以浮动了，但是打开就关不了」
 *      —— 动作面板浮窗的 ✕ 点不动。真因：`.touch-header` 整块是拖动把手，
 *      `onDragStart` 里**无条件** `setPointerCapture` 到头部；指针被头部捕获后，
 *      pointerup 被重定向到头部，浏览器随后把 click 派发到「pointerdown 目标与 pointerup
 *      目标的最近公共祖先」＝头部，于是头部里的 ✕ /「对 XXX」永远收不到 click。
 *   ②「玩具也一点就报错」
 *      —— `POST /api/characters/:id/toys/:key/equip` 400
 *      `Unexpected token '"', ""{\"intensity\":1}"" is not valid JSON`。
 *      真因：api 层三个玩具函数自己 `JSON.stringify`，而 `request()` 基元**还会再 stringify 一次**。
 *   ③「手机端的群聊设置不能滚动；电脑的也是只有群成员那里能划」
 *      —— `.gc-drawer` 是 `overflow: hidden` 的定高 flex 列，唯一的滚动容器是 `.gc-member-edit`；
 *      内容一超视口，底部的「撤回上一轮 / 解散群聊 / 保存」就被裁到视口外点不到。
 *
 * 这一组断言的是**契约**（不许再退回旧写法），不是实现细节；真机点击由 e2e/run-e2e.mjs 覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

const read = p => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8')

const apiSrc = read('api/index.js')
const actRaw = read('components/TouchActionPanel.vue')
const act = parseSfc(actRaw).descriptor

/**
 * 断言前先剥掉注释 —— 这一轮的修复注释里**逐字写了**旧写法（`setPointerCapture` / `overflow:hidden`），
 * 不剥的话「注释里提到旧写法」会被误判成「代码里还是旧写法」。
 */
const stripJsComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const stripCssComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 从 api/index.js 里截出某个具名导出函数的源码段（到下一个顶层 export 为止） */
function fnSource(src, name) {
  const start = src.indexOf(`export function ${name}(`)
  if (start < 0) return ''
  const rest = src.slice(start)
  const next = rest.indexOf('\nexport ', 1)
  return next > 0 ? rest.slice(0, next) : rest
}

// ── ① 动作面板浮窗：✕ 必须点得到 ─────────────────────────────────────────────
test('动作面板：拖动把手不许从头部按钮上抢指针（✕ 关不掉的真因）', () => {
  const script = stripJsComments(act.scriptSetup.content)
  const iStart = script.indexOf('function onDragStart')
  const iEnd = script.indexOf('function onDragEnd')
  assert.ok(iStart > 0 && iEnd > iStart, '要能定位到 onDragStart / onDragEnd')
  const onDragStart = script.slice(iStart, iEnd)

  assert.ok(/closest\(/.test(onDragStart), 'onDragStart 必须先判断按下的是不是头部里的交互元件')
  assert.ok(/button/.test(onDragStart), '判定选择器必须能命中 LinsheButton 渲染出的 <button class="ls-btn">')

  const iGuard = onDragStart.indexOf('closest(')
  const iCapture = onDragStart.indexOf('setPointerCapture')
  assert.ok(iCapture > 0, '拖动仍要捕获指针（触摸拖出面板才跟手）')
  assert.ok(iGuard > 0 && iGuard < iCapture, '守卫必须在 setPointerCapture **之前** return，否则捕获照抢')

  // 那一下必须是真的 return，而不是记个变量
  const guardLine = onDragStart.slice(iGuard, onDragStart.indexOf('\n', iGuard))
  assert.ok(/return/.test(guardLine), '命中交互元件要直接 return（不启动拖动、不抢指针）')
})

test('动作面板：✕ 走 LinsheButton + emit close，父组件两个页面都接住', () => {
  const tpl = act.template.content
  assert.ok(/aria-label="关闭动作面板"/.test(tpl), '✕ 的无障碍标签保持')
  assert.ok(/@click="requestClose"/.test(tpl), '✕ 要接到 requestClose')
  assert.ok(/emit\('close'\)/.test(act.scriptSetup.content), 'requestClose 要 emit close')
  assert.ok(/linshe-button/.test(tpl), '按钮继续用 Linshe 组件')

  for (const file of ['views/ChatView.vue', 'views/GroupChatView.vue']) {
    const d = parseSfc(read(file)).descriptor
    const tpl2 = d.template.content
    const i = tpl2.indexOf('<TouchActionPanel')
    assert.ok(i > 0, file + ' 应挂载 TouchActionPanel')
    const seg = tpl2.slice(i, tpl2.indexOf('/>', i) + 2)
    assert.ok(/:open="showTouchPanel"/.test(seg), file + ' 要受控显隐')
    assert.ok(/@close="showTouchPanel = false"/.test(seg), file + ' 必须处理 close（否则 ✕ 还是关不掉）')
  }
})

// ── ② 玩具三接口：body 传对象，别再自己 stringify ────────────────────────────
test('玩具三接口：body 必须是对象字面量（request() 基元负责 stringify）', () => {
  // 反向守卫：基元必须仍然自己 stringify —— 否则下面那条就站不住了
  assert.ok(/body: body !== undefined \? JSON\.stringify\(body\) : undefined/.test(apiSrc),
    'request() 基元负责 stringify，调用方一律传对象')

  for (const fn of ['equipToy', 'setToyIntensity', 'removeToy']) {
    const seg = fnSource(apiSrc, fn)
    assert.ok(seg.length > 40, fn + ' 应存在')
    assert.equal(/JSON\.stringify/.test(seg), false, fn + ' 的 body 不许自己 JSON.stringify（会双重编码 ⇒ 400）')
    assert.ok(/body:\s*\{/.test(seg), fn + ' 的 body 应是对象字面量')
  }
  // equipToy 的强度仍要能传默认值 1
  assert.ok(/\{\s*intensity = 1\s*\}\s*=\s*\{\}/.test(fnSource(apiSrc, 'equipToy')),
    'equipToy 强度默认 1 的契约不变')
})

test('request() 基元：4xx 取人话 message 再回落机器码 error；5xx 只取 error（不泄内部信息）', () => {
  const prim = apiSrc.slice(apiSrc.indexOf('async function request('), apiSrc.indexOf('return result'))
  assert.ok(prim.length > 200, '要能定位到 request() 基元')
  assert.ok(/res\.status\s*<\s*500\s*\?\s*\(?\s*result\.message\s*\|\|\s*result\.error/.test(prim),
    '4xx 必须优先 result.message —— 否则玩具门控被拒时 toast 出来的是 toy_gate_blocked 这种机器码')
  assert.ok(/:\s*result\.error/.test(prim), '5xx 分支只取 error（errorHandler 的 5xx message 可能含 SQL/路径）')
  assert.equal(/throw new Error\(result\.error \|\| result\.message/.test(prim), false, '不许退回旧顺序')
})

// ── ②b 玩具入口与背包清单（真机反馈的同一批） ────────────────────────────────
test('聊天页：冷启动/换角色就拉玩具状态（否则 🧸 入口根本不渲染）', () => {
  const chat = parseSfc(read('views/ChatView.vue')).descriptor
  const script = chat.scriptSetup.content
  const i = script.indexOf("watch(() => chat.activeCharId")
  assert.ok(i > 0, '要能定位到 activeCharId 的 watcher')
  const seg = script.slice(i, script.indexOf('}, { immediate: true })', i) + 24)
  assert.ok(/loadToys\(\)/.test(seg),
    'loadToys() 必须挂在「进页面 / 换角色」这条 watcher 上（原来只在点开 ✋ 时才算，冷启动看不到 🧸）')
  assert.ok(/\{ immediate: true \}/.test(seg), '要 immediate，否则首屏永远不拉')
  // 面板仍要受服务端 unlocked 门控
  assert.ok(/v-if="toysEnabled"/.test(chat.template.content), '未解锁仍不渲染入口')
})

test('聊天页：把服务端玩具清单（含逐件 gate）传给面板，别让它回落前端镜像', () => {
  const chat = parseSfc(read('views/ChatView.vue')).descriptor
  const script = chat.scriptSetup.content
  const tpl = chat.template.content
  assert.ok(/:toy-options="toyOptions"/.test(tpl), 'ToyPanel 要收到 toyOptions')
  assert.ok(/toyOptions\.value\s*=\s*Array\.isArray\(res\?\.available\)/.test(script),
    'toyOptions 要来自 GET /toys 的 available[]（带服务端 gate）')
  for (const guard of [/if \(!charId\)/, /catch \{/]) {
    assert.ok(guard.test(script), '取不到时要清空，别留着上一个角色的清单')
  }
  const d = parseSfc(read('components/ToyPanel.vue')).descriptor
  assert.ok(/props\.toyOptions\s*&&\s*props\.toyOptions\.length/.test(d.scriptSetup.content),
    'ToyPanel 侧仍保持「服务端给了就用」的优先级')
})

// ── ③ 群设置抽屉：本体就是滚动容器 ──────────────────────────────────────────
test('群设置抽屉：本体可滚（手机端能滚 / 桌面端底部按钮点得到）', () => {
  const raw = read('views/GroupChatView.vue')
  const d = parseSfc(raw).descriptor
  const css = stripCssComments(d.styles.map(s => s.content).join('\n'))

  const iDrawer = css.indexOf('.gc-drawer {')
  const iDrawerH3 = css.indexOf('.gc-drawer h3')
  assert.ok(iDrawer > 0 && iDrawerH3 > iDrawer, '要能定位到 .gc-drawer 规则')
  const drawer = css.slice(iDrawer, iDrawerH3)
  assert.ok(/overflow-y:\s*auto/.test(drawer), '.gc-drawer 必须 y 轴可滚')
  assert.equal(/[^-]overflow:\s*hidden/.test(drawer), false, '别再写回 overflow: hidden（底部按钮会被裁到点不到）')
  assert.ok(/overscroll-behavior:\s*contain/.test(drawer), '抽屉滚到底不要滚穿到页面')
  assert.ok(/safe-area-inset-bottom/.test(drawer), '移动端底部要留安全区，否则「保存」被手势条压住')

  const iMember = css.indexOf('.gc-member-field {')
  const iCheck = css.indexOf('.gc-member-check {')
  assert.ok(iMember > 0 && iCheck > iMember, '要能定位到 .gc-member-field / .gc-member-edit 规则')
  const member = css.slice(iMember, iCheck)
  assert.equal(/flex:\s*1;/.test(member), false, '群成员区不许再「吃掉全部剩余高度」（那样抽屉永远没得滚）')
  assert.ok(/max-height/.test(member), '成员网格要有高度上限')
  assert.ok(/overflow-y:\s*auto/.test(member), '成员网格自己仍要能滚（它是选择器）')

  // 模板侧：抽屉本体就是那个滚动层，别再套一层自己的滚动容器
  const tpl = d.template.content
  assert.ok(/class="gc-drawer-overlay"[\s\S]{0,200}class="gc-drawer"/.test(tpl), '结构保持：overlay > drawer')
  const compiled = compileTemplate({ source: tpl, filename: 'GroupChatView.vue', id: 'gc' })
  assert.deepEqual(compiled.errors, [], '模板要能编译')
})
