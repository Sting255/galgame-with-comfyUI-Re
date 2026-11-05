/**
 * 群聊真实服务验收：选成员后打开工具，检查作用对象和玩具操作接线。
 * 默认程序 UI 回归使用 web-ui/test/chatTools.browser.test.js（隔离 Vite + 合成桩）。
 * 本脚本会调用真实服务并操作功能，仅在已授权联调时对专用合成测试环境运行。
 * 用 GROUP_PANEL_CHECK_BASE 或 PANEL_CHECK_BASE 指定服务；启动方式见 docs/testing.md。
 * 工具入口按 .chat-action-toolbar + aria-label 定位，状态读 aria-expanded；
 * 目标列表为 #touch-target-list，选中对象显示在工具栏的「选择互动对象」按钮中。
 */
import { chromium } from 'playwright'

// 目标地址可覆盖：红测 / 多份包并行时要指向别的端口。
// 两个变量名都收：GROUP_PANEL_CHECK_BASE 是本文件专用，PANEL_CHECK_BASE 与 check-panels.mjs 保持同名口径。
const BASE = process.env.GROUP_PANEL_CHECK_BASE || process.env.PANEL_CHECK_BASE || 'http://127.0.0.1:3199'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
/**
 * 明确区分"没测到"和"测了没过" —— 任务要求不许为了让输出好看而放宽断言，
 * 反过来也一样：**驱动不到**（比如按钮被面板遮罩挡住）不能算成功能坏了，但必须显式列出来。
 * SKIP 不计入 PASS/FAIL，只在末尾单独列一段。
 */
const skips = []
const skip = (name, why) => { skips.push({ name, why }); console.log(`SKIP  ${name} — ${why}`) }

const pageErrors = []      // pageerror：一条都不许有
const consoleErrors = []   // console.error 原文（下面要分类）
const badResponses = []    // status >= 400 的响应（带资源类型）
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('response', (res) => {
  if (res.status() < 400) return
  const req = res.request()
  badResponses.push({ url: res.url().replace(BASE, ''), status: res.status(), type: req.resourceType() || '(未知)' })
})

/**
 * ⑨ 的判据（2026-10-02 与上级对齐口径）
 *
 * 规则：
 *   · `pageerror` —— **一条都不许有**；
 *   · `console.error` —— 只有「`Failed to load resource` 且对应响应是 `image`」允许；
 *   · 其余一律 FAIL：尤其 `script` / `stylesheet` / `font` / `xhr` / `fetch` 的失败，
 *     以及任何**非资源类**的 JS 报错（例如真机那个 `ReferenceError: onBeforeUnmount is not defined`
 *     —— 它让整个面板挂不出来，必须照旧红）。
 *
 * **为什么允许图片 404**：用户库里有 **606 条死图引用**（`/images/**`，清一色 `ComfyUI_temp_*`，
 * 文件真的没了）。前端已经做了坏图兜底（`web-ui/src/imageFallback.js`：缺图不再显示碎图、默认隐藏）
 * ⇒ **页面观感已经修好**；但浏览器仍会为那次 404 记一条 console error —— 兜底挡不住它，这是浏览器行为，
 * 不是产品缺陷。本仓 `e2e/check-assets.mjs` 同一口径：404 里不许出现 `.js/.css/.woff2`，图片 404 允许。
 *
 * **为什么按"资源类型"判、不猜文本**：`Failed to load resource` 的文本里**没有 URL**（Chromium 如此），
 * 字符串匹配分不清那是图片还是脚本 ⇒ 只能靠 `response` 事件记下的类型来对齐条数：
 *   允许的条数上限 = 图片类坏响应的条数；
 * 只要出现**任何非图片**的坏响应，或类型拿不到（按"不允许"处理，宁可红），就直接 FAIL。
 */
function evaluatePageErrors() {
  const RESOURCE_MSG = /Failed to load resource/i
  const resourceConsole = consoleErrors.filter((t) => RESOURCE_MSG.test(t))
  const otherConsole = consoleErrors.filter((t) => !RESOURCE_MSG.test(t))
  const imgBad = badResponses.filter((r) => r.type === 'image')
  const nonImageBad = badResponses.filter((r) => r.type !== 'image')   // '(未知)' 也会落在这里 ⇒ 宁可红
  const allowedImage = Math.min(resourceConsole.length, imgBad.length)
  const unmatchedResource = resourceConsole.length - allowedImage
  const ok = pageErrors.length === 0 && nonImageBad.length === 0 && otherConsole.length === 0 && unmatchedResource === 0
  const sample = (arr, n = 2) => arr.slice(0, n).join(' ; ')
  const parts = [
    `pageerror=${pageErrors.length}`,
    `产物类失败=${nonImageBad.length}${nonImageBad.length ? `（${sample(nonImageBad.map((r) => `${r.type} ${r.status} ${r.url}`))}）` : ''}`,
    `允许的图片 404×${allowedImage}`,
    `其它 console.error=${otherConsole.length}${otherConsole.length ? `（${sample(otherConsole.map((t) => t.slice(0, 60)))}）` : ''}`,
    `未匹配的资源失败=${unmatchedResource}`,
  ]
  if (pageErrors.length) parts.push(`pageerror 原文：${sample(pageErrors)}`)
  return { ok, detail: parts.join(' ｜ ') }
}

/** 角色级请求：玩具 / 推进 / 戴上等 —— 用来证明"作用在哪个成员身上" */
const roleReqs = []
page.on('request', (req) => {
  const u = req.url().replace(BASE, '')
  if (/\/api\/characters\/\d+\/toys/.test(u) || /\/api\/intimate-actions\/\d+/.test(u)) {
    roleReqs.push(`${req.method()} ${u}`)
  }
})
/** 从 URL 里抠角色 id（两种路径都覆盖） */
const idOf = (u) => {
  const m = /\/api\/(?:characters|intimate-actions)\/(\d+)/.exec(u)
  return m ? Number(m[1]) : null
}

async function dismissOverlays(p) {
  for (let i = 0; i < 3; i++) {
    if (await p.locator('.linshe-modal-overlay, .modal-overlay').count() === 0) return
    const closers = p.locator('.linshe-modal-close, [aria-label="关闭"], button:has-text("知道了"), button:has-text("关闭"), button:has-text("以后再说"), button:has-text("取消")')
    if (await closers.count() > 0) await closers.first().click({ timeout: 2000 }).catch(() => {})
    else await p.keyboard.press('Escape').catch(() => {})
    await p.waitForTimeout(600)
  }
}
async function topElementAt(p, loc) {
  const box = await loc.first().boundingBox().catch(() => null)
  if (!box) return '(取不到 boundingBox)'
  return await p.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    return el ? `${el.tagName}.${String(el.className || '').slice(0, 60)}` : 'null'
  }, [box.x + box.width / 2, box.y + box.height / 2]).catch(() => '(evaluate 失败)')
}
const toyOpen = (p) => p.locator('.modal-panel.linshe-modal, .toy-panel, .tp-panel').count()
const iaOpen = (p) => p.locator('.ia-panel[aria-label="亲密"]').count()
const toastAll = async (p) => (await p.locator('.live-toast-message').allInnerTexts().catch(() => [])).join(' | ')

try {
  // ── 群 id + 成员表（成员表用来核对"请求里的 id 是不是我点的那个人"）──
  let groupId = null
  let members = []
  const groupsResp = await page.request.get(`${BASE}/api/groups`).catch(() => null)
  if (groupsResp?.ok()) {
    const body = await groupsResp.json().catch(() => null)
    const list = Array.isArray(body) ? body : (body?.groups || body?.data || [])
    groupId = list?.[0]?.id ?? null
    members = list?.[0]?.members || []
  }
  record('⓪ 拿到群与成员表', groupId != null, `groupId=${groupId ?? '(无)'} members=${members.length}`)
  if (groupId == null) throw new Error('没有群可测：/api/groups 没返回群列表')

  // ── ① 群聊视图 ──
  await page.goto(`${BASE}/#/group/${groupId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2800)
  await dismissOverlays(page)
  const msgList = await page.locator('.msg-list-inner').count()
  const wrap = await page.locator('.touch-group-wrap').count()
  record('① 群聊视图打开', msgList > 0 && wrap > 0, `msg-list-inner=${msgList} touch-group-wrap=${wrap}`)

  // ── ② 三个入口 ──
  const hand = page.locator('.chat-action-toolbar [aria-label="动作"]')
  const toyBtn = page.locator('.chat-action-toolbar [aria-label="玩具"]')
  const iaBtn = page.locator('.chat-action-toolbar [aria-label="亲密"]')
  const targetBtn = page.locator('.chat-action-toolbar [aria-label="选择互动对象"]')
  record('② ✋ / 🧸 / ❤ 三个入口都在', (await hand.count()) > 0 && (await toyBtn.count()) > 0 && (await iaBtn.count()) > 0,
    `hand=${await hand.count()} toy=${await toyBtn.count()} ia=${await iaBtn.count()}`)
  record('② 未选目标时显示选择对象', /选择对象/.test(await targetBtn.innerText()), '工具栏有独立目标入口')

  // ── ③ 未选目标：先打开选人列表，不默认任何成员 ──
  const topBefore = await topElementAt(page, toyBtn)
  await toyBtn.first().click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(1200)
  record('③ 未选目标点 🧸 不打开面板', (await toyOpen(page)) === 0, `面板节点=${await toyOpen(page)}｜点击点最上层=${topBefore}`)
  record('③ 直接打开选人列表', await page.locator('#touch-target-list').isVisible(), '选择后继续原功能')
  record('③ 也**没有**偷偷默认成员 0', !(await page.locator('.modal-panel.linshe-modal').count()), '面板节点应为 0（没有回落到 members[0]）')

  // ── ④ 改点动作，选择成员后打开动作面板 ──
  let pickedName = ''
  let pickedId = null
  await hand.first().click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(1500)
  // 换人按钮靠 title 定位最稳（TouchActionPanel.vue 第 33 行）：
  //   有目标时 title=「更换动作对象」、没目标时「选择动作对象」、按钮文字是「对 XXX」/「对 谁？」
  const pickBtn = page.locator('[title="选择动作对象"], [title="更换动作对象"]').first()
  if (await pickBtn.count() > 0) { await pickBtn.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(900) }
  const listOk = (await page.locator('#touch-target-list').count()) > 0
  record('④ 「对谁」成员面板出现', listOk, `#touch-target-list=${await page.locator('#touch-target-list').count()}`)
  if (listOk) {
    const item = page.locator('#touch-target-list .mention-item').first()
    pickedName = (await item.innerText().catch(() => '')).trim().replace(/\s+/g, ' ')
    await item.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(1000)
    const title = await targetBtn.getAttribute('title').catch(() => '')
    pickedId = members.find((m) => String(m.display_name || '').trim() === pickedName)?.id ?? null
    record('④ 工具栏显示选中成员', title === pickedName, `点「${pickedName}」⇒ title=「${title}」｜成员 id=${pickedId ?? '(没匹配上)'}`)
  }

  // ── ⑤ 选中后点 🧸：打开 + 作用在那个人 + 「戴上」接线 ──
  if (pickedId != null) {
    roleReqs.length = 0
    await toyBtn.first().click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(2200)
    const opened = await toyOpen(page)
    record('⑤ 选中后 🧸 面板打开', opened > 0, `面板节点=${opened}｜点击点最上层=${await topElementAt(page, toyBtn)}`)
    const reqIds = [...new Set(roleReqs.map(idOf).filter(Boolean))]
    record('⑤ 面板请求的是**我点的那个人**', reqIds.length === 0 || reqIds.every((i) => i === pickedId),
      `请求=${roleReqs.slice(0, 3).join(' , ') || '(没抓到请求)'}｜期望 id=${pickedId}｜实际=${reqIds.join(',') || '-'}`)
    record('⑤ 入口选中且 aria-expanded 为 true', (await toyBtn.first().getAttribute('aria-expanded')) === 'true', `class=${await toyBtn.first().getAttribute('class')}`)

    // 「戴上」是 emit 给父组件做的（功能 Agent 自己没在浏览器里点过）—— 真点一次。
    // ⚠️ 两条收紧：
    //   1) 只看"有没有 POST 到 toys"会被面板自己的 `POST /toys/tick` 轮询骗过去（我第一版就是这样误判成 PASS）；
    //      现在必须见到 `…/<toyKey>/equip` 或那句「已给她戴上」的 toast。
    //   2) **门控没过的按钮点了也不会发请求**（ToyPanel.vue 132 行把 `gate.allowed === false` 写成 aria-disabled）
    //      ⇒ 必须挑"既没 disabled、也没 aria-disabled=true"的那个（例如项圈对 Lv3 就放行）。
    //      挑不到就如实说"全是门控拦着的"，不要算成接线断了。
    await page.locator('.toy-panel').getByRole('tab', { name: '背包', exact: true }).click()
    roleReqs.length = 0
    const anyBtn = page.locator('.toy-backpack-grid button')
    const equipBtn = page.locator('.toy-backpack-grid button:not([disabled]):not([aria-disabled="true"])').first()
    const equipCount = await equipBtn.count()
    if (equipCount > 0) {
      const equipLabel = (await equipBtn.innerText().catch(() => '')).trim().replace(/\s+/g, ' ')
      await equipBtn.click({ timeout: 4000 }).catch(() => {})
      await page.waitForTimeout(2500)
      const t = await toastAll(page)
      const equipReq = roleReqs.find((u) => /\/toys\/[^/]+\/equip/.test(u))
      record('⑤ 群里点「戴上」真的接上了（emit→父组件→接口）', Boolean(equipReq) || /已给她戴上|已经戴上了/.test(t),
        `点了「${equipLabel}」｜equip 请求=${equipReq || '(没抓到)'}｜其它 toys 请求=${roleReqs.filter((u) => !/equip/.test(u)).slice(0, 2).join(' , ') || '-'}｜toast=「${t || '(无)'}」`)
    } else {
      const total = await anyBtn.count()
      const reasons = (await page.locator('.toy-backpack-grid button').evaluateAll((els) => els.map((e) => e.getAttribute('title') || '').filter(Boolean))).slice(0, 3).join(' ; ')
      record('⑤ 群里点「戴上」真的接上了（emit→父组件→接口）', false,
        total === 0 ? '玩具背包里一个按钮都没有（选择器 .toy-backpack-grid button 落空 ⇒ 面板结构可能变了）'
          : `背包 ${total} 个按钮全部处于门控/已戴上状态，点哪个都不会发请求 ⇒ 这条**测不了**（门控文案：${reasons || '(无 title)'}）`)
    }
    await page.keyboard.press('Escape').catch(() => {})
    await page.locator('[aria-label="关闭"]').first().click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(800)
  } else {
    record('⑤ 选中后 🧸 面板打开', false, '上一步没拿到成员 id ⇒ 没往下跑')
  }

  // ── ⑥ ❤ 三步 ──
  roleReqs.length = 0
  await iaBtn.first().click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(2200)
  const iaCount = await iaOpen(page)
  record('⑥ 选中后 ❤ 面板打开', iaCount > 0, `ia-panel=${iaCount} chip=${await page.locator('.ia-chip').count()}｜点击点最上层=${await topElementAt(page, iaBtn)}`)
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000)
  record('⑥ 面板文案含推进动作', /继续抽插|加速抽插|换姿势|进入她/.test(bodyText), bodyText.match(/继续抽插|加速抽插|换姿势|进入她/)?.[0] || '(未命中)')
  const iaIds = [...new Set(roleReqs.map(idOf).filter(Boolean))]
  record('⑥ 推进面板请求的是**我点的那个人**', iaIds.length === 0 || iaIds.every((i) => i === pickedId),
    `请求=${roleReqs.slice(0, 3).join(' , ') || '(没抓到)'}｜期望 id=${pickedId}｜实际=${iaIds.join(',') || '-'}`)
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(700)

  // ── ⑦ 换目标 ⇒ 两个面板自动关掉 ──
  //    ⚠️ 这条**结构上就不好驱动**：要让"面板开着"才能验自动关，而面板一开，
  //    它自己的 LinsheModal 遮罩就压在下面那排图标上 ⇒ 点不到 ✋ / 换人按钮（Playwright 会一直重试到超时）。
  //    所以先探一下"✋ 的点击点最上层是谁"：被遮罩挡住就如实 SKIP，不硬算成功能坏了。
  if (await toyOpen(page) > 0) { await toyBtn.first().click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(900) }
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(500)
  await toyBtn.first().click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const openedBefore = await toyOpen(page)
  const handTop = await topElementAt(page, hand)
  if (!/BUTTON|SVG|PATH|SPAN/.test(String(handTop))) {
    // 2026-10-18：这条口径已抽成纯函数并由单测钉住（`web-ui/test/groupPanelTargetSwitch.test.js`，
    // 5 条：全关+清空 / 目标没变不关 / 数字与字符串同一人 / 有↔无都算变 / 视图真调了这个函数）。
    // 所以 SKIP 时**明确指向那条测试**，别再写成"建议人工点一次"——那样等于没有验收手段。
    skip('⑦ 换目标后面板自动关掉', `玩具面板开着时 ✋ 被挡住（点击点最上层=${handTop}）⇒ 这条在本脚本里驱动不到（面板的 LinsheModal 遮罩压住了触发换人的按钮）。`
      + '该行为已由 web-ui/test/groupPanelTargetSwitch.test.js 单测覆盖（纯函数 panelStateOnTargetChange）')
  } else {
    await hand.first().click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(1200)
    // 换人按钮的 title 会随"有没有目标"变（选择动作对象 / 更换动作对象）⇒ 两个都匹配。
    const pick2 = page.locator('[title="选择动作对象"], [title="更换动作对象"]').first()
    if (await pick2.count() > 0) { await pick2.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(900) }
    const items = page.locator('#touch-target-list .mention-item')
    const itemCount = await items.count()
    if (itemCount > 1) {
      await items.nth(1).click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(1400)
      const after = await toyOpen(page)
      const title = await toyBtn.first().getAttribute('title').catch(() => '')
      record('⑦ 换目标后面板自动关掉', openedBefore > 0 && after === 0, `换人前=${openedBefore} 换人后=${after}｜换后 title=「${title}」`)
    } else {
      skip('⑦ 换目标后面板自动关掉', `目标列表里只有 ${itemCount} 个成员 ⇒ 换不了人（换人按钮 count=${await pick2.count()}）`)
    }
  }

  // ── ⑧ 原有东西还在 ──
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(600)
  record('⑧ 动作快捷条与消息流仍在', (await page.locator('.touch-group-wrap').count()) > 0 && (await page.locator('.msg-list-inner').count()) > 0,
    `touch-group-wrap=${await page.locator('.touch-group-wrap').count()} msg-list-inner=${await page.locator('.msg-list-inner').count()}`)
} catch (err) {
  record('脚本异常', false, String(err?.message || err))
} finally {
  // ⑨ 见 evaluatePageErrors 的注释：图片 404 允许（606 条死引用 + 已做坏图兜底 + 与 check-assets 同口径），
  //    产物类失败与任何非资源类 JS 报错一律红。
  const errEval = evaluatePageErrors()
  record('⑨ 页面无 JS 报错（图片 404 例外）', errEval.ok, errEval.detail)
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}${skips.length ? `，SKIP ${skips.length}` : ''}`)
if (skips.length) console.log('未测到（不是"通过"）：\n  - ' + skips.map((s) => s.name + '：' + s.why).join('\n  - '))
if (failed.length) console.log('失败项：\n  - ' + failed.map((f) => f.name + (f.detail ? `（${f.detail}）` : '')).join('\n  - '))
process.exit(failed.length === 0 ? 0 : 1)
