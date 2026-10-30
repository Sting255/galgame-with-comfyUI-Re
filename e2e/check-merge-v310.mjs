/**
 * v3.10.0 合并收尾 · 自动化浏览器验收（2026-10-19）
 *
 * 只验**本轮新接上的 UI 入口在真实页面里点得开、状态对**：
 *   A 酒馆页工具栏（搜索框 / 计数 / 空态）
 *   B 立绘管理卡片 → 弹窗
 *   C SillyTavern 预设入口 → 弹窗
 *   D 世界观弹窗里的「管理SillyTavern世界书」→ 弹窗
 *   E 日报弹窗：报尾「重新生成今日日报」+ 缺图占位的「重新生成配图」
 *   F 私聊 galgame 进场（ChatModeSwitch → ?mode=galgame → .gal-stage）
 *   G 全程零 console error / pageerror
 *
 * 纪律：
 *   · 真实库只读 —— `VACUUM INTO` 出一致性快照到 %TEMP%，后端只连副本；
 *   · 图片目录也隔离（IMAGES_DIR → %TEMP%），别把测试图落进用户的 data/images；
 *   · **不点会花钱的按钮**（重新生成日报会真调 LLM、重新生成配图会真调 ComfyUI）——
 *     只断言它们"在该在的地方、该藏的时候藏"；
 *   · 截图与日志写 %TEMP%\e2e-shots-v310\，不进仓库。
 *
 * 跑法：node e2e/check-merge-v310.mjs
 * 环境变量：PORT（默认 3212）/ SHOTS / KEEP_DB=1 保留副本库
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const NODE = path.join(REPO, 'runtime', 'nodejs', 'node.exe')
const AGENT_CORE = path.join(REPO, 'agent-core')
const REAL_DB = path.join(AGENT_CORE, 'data', 'agent.db')
const require = createRequire(path.join(AGENT_CORE, 'package.json'))
const BetterSqlite3 = require('better-sqlite3')

const PORT = Number(process.env.PORT || 3212)
const BASE = 'http://127.0.0.1:' + PORT
const WORK = path.join(os.tmpdir(), 'e2e-v310')
const DB = path.join(WORK, 'copy.db')
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'e2e-shots-v310')
const IMAGES = path.join(WORK, 'images')

const results = []
const consoleErrors = []
const resourceErrors = []
const pageErrors = []
const record = (id, title, ok, detail = '') => {
  results.push({ id, title, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${title}${detail ? ' — ' + detail : ''}`)
}
const info = (id, title, detail) => { results.push({ id, title, ok: true, detail, info: true }); console.log(`INFO  [${id}] ${title} — ${detail}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

function snapshotDb() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  mkdirSync(IMAGES, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  const src = new BetterSqlite3(REAL_DB, { readonly: true })
  try { src.exec(`VACUUM INTO '${DB.replace(/'/g, "''")}'`) } finally { src.close() }
  const check = new BetterSqlite3(DB, { readonly: true })
  try {
    const rows = check.pragma('integrity_check')
    const ok = Array.isArray(rows) && rows.length === 1 && rows[0].integrity_check === 'ok'
    if (!ok) throw new Error('副本 integrity_check 不是 ok: ' + JSON.stringify(rows).slice(0, 200))
  } finally { check.close() }
}

/**
 * 给副本库里第一个角色塞一套「工装」场景立绘（只写副本 + 隔离图片目录）。
 * 为什么要：场景切换胶囊按设计只显示**有图**的场景，新库/空库一个都没有 ⇒
 * 「上传本场景」入口无从出现。这里造一张最小的可测数据，别去改真实库。
 */
function seedSceneStanding() {
  const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
  const standingDir = path.join(IMAGES, 'standing')
  mkdirSync(standingDir, { recursive: true })
  writeFileSync(path.join(standingDir, 'e2e_seed.png'), PNG_1PX)
  const db = new BetterSqlite3(DB)
  try {
    // 酒馆首卡不一定是 id 最小那个 ⇒ 给所有角色都塞一张，保证点开任意一张都有场景胶囊
    const chars = db.prepare('SELECT id FROM characters ORDER BY id LIMIT 50').all()
    if (!chars.length) return null
    const upsert = db.prepare(`INSERT INTO character_standings (character_id, scene, image_url, prompt_text)
      VALUES (?, 'work', '/images/standing/e2e_seed.png', 'e2e seed')
      ON CONFLICT(character_id, scene) DO UPDATE SET image_url = excluded.image_url, prompt_text = excluded.prompt_text`)
    for (const char of chars) upsert.run(char.id)
    return chars.length
  } finally { db.close() }
}

let backend = null
function startBackend() {
  const child = spawn(NODE, ['app.js'], {
    cwd: AGENT_CORE,
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), LOG_TO_FILE: 'false', IMAGES_DIR: IMAGES },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', d => logs.push(String(d)))
  child.stderr.on('data', d => logs.push(String(d)))
  backend = { child, logs }
}
async function stopBackend() {
  if (!backend) return
  const { child } = backend
  backend = null
  try { child.kill() } catch { /* 已退出 */ }
  await sleep(1000)
}
async function waitForServer(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return true
      last = 'status ' + res.status
    } catch (err) { last = err.message }
    await sleep(500)
  }
  throw new Error('后端没起来：' + last)
}

async function dismissOverlays(page) {
  for (let i = 0; i < 8; i++) {
    const overlays = page.locator('.confirm-overlay, .linshe-modal-overlay, .modal-overlay')
    const n = await overlays.count()
    if (n === 0) return
    // 关最上层：文案可能叠着，`nth(count-1)` + force 直接把点击派发给该按钮的处理函数，
    // 不受"被上层盖住"影响（按 DOM 顺序猜哪一层在最上面不可靠）
    const closes = page.locator('.confirm-overlay .confirm-btn, .linshe-modal-overlay [aria-label="关闭"], .modal-overlay [aria-label="关闭"], .linshe-modal-close, .modal-close')
    const c = await closes.count()
    if (c > 0) await closes.nth(c - 1).click({ force: true, timeout: 1500 }).catch(() => {})
    else await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(400)
  }
}

/** 页面加载后可能异步弹「更新说明」——给它一点时间，再关掉 */
async function waitAndDismiss(page, waitMs = 4000) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await page.locator('.linshe-modal-overlay, .modal-overlay').count() > 0) break
    await page.waitForTimeout(300)
  }
  await dismissOverlays(page)
}
const text = page => page.locator('body').innerText()

/**
 * 点得动就正常点；被遮罩/浮层挡住时先查明挡路的是谁，再清场重试，最后才 force。
 * force 不掩盖问题：命中被挡会记一条 INFO，写清"谁挡住了什么"。
 */
async function safeClick(page, locator, label) {
  try {
    await locator.click({ timeout: 5000 })
    return true
  } catch {
    const box = await locator.boundingBox().catch(() => null)
    const blocker = box
      ? await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y)
          return el ? `${el.tagName.toLowerCase()}.${String(el.className || '').split(/\s+/).slice(0, 3).join('.')}` : '(none)'
        }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }).catch(() => '(probe failed)')
      : '(no box)'
    info('CLICK', `${label} 被挡`, `blocker=${blocker}`)
    await dismissOverlays(page)
    await page.waitForTimeout(400)
    try {
      await locator.click({ timeout: 4000 })
      return true
    } catch {
      await locator.click({ force: true, timeout: 4000 }).catch(() => {})
      return false
    }
  }
}

async function main() {
  snapshotDb()
  // 场景胶囊的测试数据（只在副本库里造，真实库不动）
  const seededCharId = seedSceneStanding()
  if (seededCharId) console.log(`# 已给副本库角色 ${seededCharId} 造一套工装场景立绘`)
  startBackend()
  await waitForServer(BASE + '/api/config')

  const browser = await chromium.launch()
  // 1600 宽即可命中「桌面悬浮立绘面板」（SIDE_LAYOUT_MIN=1532）；1366 会走内联布局，
  // 内联面板里立绘舞台很长，B 组点舞台容易落在视口外（这不是产品 bug，是测试视口选错了）
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.on('pageerror', e => pageErrors.push(String(e.message || e)))
  const badResponses = []
  page.on('response', r => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url().replace(BASE, '')) })
  page.on('console', m => {
    if (m.type() !== 'error') return
    const t = m.text()
    // 资源加载失败（缺图 / GitHub API 403）不等于 JS 异常，单独记，别和真报错混一起
    if (/^Failed to load resource/i.test(t)) resourceErrors.push(t)
    else consoleErrors.push(t.slice(0, 240))
  })

  try {
    // ───────────────── A 酒馆页：工具栏 / 搜索 / 空态 ─────────────────
    await page.goto(BASE + '/#/tavern', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    // 首次访问会弹「更新说明」，它是异步出现的 —— 先等它出来再关，否则它会在后面挡住点击
    await waitAndDismiss(page, 6000)

    const cards = await page.locator('.char-card').count()
    record('A1', '酒馆页角色卡片渲染', cards > 0, `char-card=${cards}`)
    record('A2', '角色工具栏 + 搜索框存在', await page.locator('.char-toolbar .char-search-input').count() > 0)
    const label0 = (await text(page)).match(/角色 \((\d+)(?: \/ (\d+))?\)/)?.[0] || ''
    info('A3', '初始计数', label0 || '(未匹配到计数文案)')

    const input = page.locator('.char-search-input input, input.char-search-input').first()
    if (await input.count() === 0) throw new Error('找不到搜索输入框（.char-search-input）')
    await input.fill('zzz-不存在的角色-zzz')
    await page.waitForTimeout(600)
    const emptyCount = await page.locator('.char-empty').count()
    const bodyAfter = await text(page)
    record('A4', '搜不到时出现空态 + 文案', emptyCount > 0 && /没有找到「zzz-不存在的角色-zzz」/.test(bodyAfter),
      `empty=${emptyCount}`)
    record('A5', '空态计数变成 0 / N', /角色 \(0 \/ \d+\)/.test(bodyAfter), bodyAfter.match(/角色 \([^)]*\)/)?.[0] || '')

    await input.fill('')
    await page.waitForTimeout(600)
    record('A6', '清空搜索后恢复列表', await page.locator('.char-card').count() > 0 && await page.locator('.char-empty').count() === 0,
      `char-card=${await page.locator('.char-card').count()}`)

    // 用第一个角色的名字前缀搜，验证"命中一部分"时计数是 x / N
    const firstName = (await page.locator('.char-card .char-name, .char-card .char-card-name').first().innerText().catch(() => '')).trim()
    if (firstName) {
      await input.fill(firstName.slice(0, 2))
      await page.waitForTimeout(700)
      const after = await text(page)
      const hitLabel = after.match(/角色 \((\d+ \/ \d+|\d+)\)/)?.[0] || ''
      record('A7', '按名字搜索命中并更新计数', /角色 \(\d+ \/ \d+\)/.test(hitLabel) || /角色 \(\d+\)/.test(hitLabel), `${firstName} → ${hitLabel}`)
      await input.fill('')
      await page.waitForTimeout(500)
    } else info('A7', '跳过按名字搜索', '未取到第一个角色名')

    // ───────────────── B 立绘管理 ─────────────────
    const standingCard = page.locator('.standing-manage-card')
    record('B1', '立绘管理卡片存在', await standingCard.count() > 0)
    if (await standingCard.count() > 0) {
      await standingCard.first().click()
      await page.waitForTimeout(1800)
      record('B2', '立绘管理弹窗打开', await page.locator('.standing-manager').count() > 0,
        `panel=${await page.locator('.standing-manager').count()}`)
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(600)
      record('B3', 'Esc 关闭弹窗', await page.locator('.standing-manager').count() === 0)

      // B4~B6：场景立绘上传（2026-10-19 与上游统一的 /:id/standings/upload）
      // 场景胶囊在**详情弹窗的立绘面板**里（CharacterStandingPanel），不是上面那个立绘管理弹窗
      // 点角色名（不是卡片中心）：卡片内还有置顶/关系网按钮，点中心可能命中别的弹窗
      const charName = page.locator('.char-card-name').first()
      if (await charName.count() > 0) {
        await charName.click({ force: true })
        await page.waitForTimeout(2400)
      }
      // 场景胶囊是异步拉的（详情弹窗打开后 listSceneStandings 才回来）—— 轮询等它渲染完
      let chipCount = 0
      const chipDeadline = Date.now() + 6000
      while (Date.now() < chipDeadline) {
        chipCount = await page.locator('.scene-standing-chip').count()
        if (chipCount > 0) break
        await page.waitForTimeout(300)
      }
      const chipTexts = await page.locator('.scene-standing-chip').allInnerTexts().catch(() => [])
      info('B4', '详情弹窗里的场景胶囊', `count=${chipCount} texts=${chipTexts.join('/')}`)
      if (chipCount > 0) {
        const sceneChip = page.locator('.scene-standing-chip').first()
        await sceneChip.click({ force: true })
        await page.waitForTimeout(700)
        // 功能区默认收起：先点一下立绘舞台展开（面板的设计），否则按钮根本不渲染
        const stage = page.locator('.standing-stage').first()
        if (await stage.count() > 0) {
          await stage.click({ force: true })
          await page.waitForTimeout(700)
        }
        const uploadSceneBtn = page.locator('.standing-manage-btns button', { hasText: '上传本场景' }).first()
        record('B5', '选中场景后出现「上传本场景」', await uploadSceneBtn.count() > 0)
        if (await uploadSceneBtn.count() > 0) {
          const pngPath = path.join(WORK, 'e2e-standing.png')
          // 1×1 透明 PNG：够触发上传校验与落盘
          writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))
          // 面板现在有 max-height + 内部滚动（900px 高时按钮会落到一屏外）—— 先滚进视口再点
          await uploadSceneBtn.scrollIntoViewIfNeeded().catch(() => {})
          await page.waitForTimeout(200)
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
            uploadSceneBtn.click({ force: true }).catch(() => {}),
          ])
          info('B6a', 'filechooser', chooser ? '已接管' : '没触发')
          if (chooser) await chooser.setFiles(pngPath)
          await page.waitForTimeout(2600)
          const uploadedSrc = await page.locator('img').evaluateAll(imgs => imgs
            .map(img => img.getAttribute('src') || '')
            .filter(src => src.includes('/images/standing/') && src.includes('_upload')))
          record('B6', '上传后的场景图已换成新文件', uploadedSrc.length > 0, uploadedSrc[0] || '未找到 _upload 图')
        }
      }
      // 详情弹窗是 inline 变体、Esc 不一定关得掉；直接 reload 最干净（同一 URL 的 goto 不会重置 Vue 状态）
      await page.reload().catch(() => {})
      await page.waitForTimeout(2600)
      await dismissOverlays(page)
    }

    // ───────────────── C SillyTavern 预设入口 ─────────────────
    const presetEntry = page.locator('.relation-entry', { hasText: 'SillyTavern 预设' })
    record('C1', '预设入口卡片存在', await presetEntry.count() > 0, `count=${await presetEntry.count()}`)
    if (await presetEntry.count() > 0) {
      await presetEntry.first().click()
      await page.waitForTimeout(1800)
      const presetModal = await page.locator('.preset-status, .preset-modal-body').count()
      record('C2', '预设弹窗打开且渲染状态区', presetModal > 0, `nodes=${presetModal}`)
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(600)
    }

    // ───────────────── D 世界观 → 世界书 ─────────────────
    const worldEntry = page.locator('.relation-entry', { hasText: '世界观设置' })
    record('D1', '世界观入口存在', await worldEntry.count() > 0)
    if (await worldEntry.count() > 0) {
      await worldEntry.first().click()
      await page.waitForTimeout(1500)
      const lorebookBtn = page.getByText('管理SillyTavern世界书', { exact: false })
      const btnCount = await lorebookBtn.count()
      record('D2', '世界观弹窗里有世界书按钮', btnCount > 0, `count=${btnCount}`)
      if (btnCount > 0) {
        const disabled = await lorebookBtn.first().isDisabled().catch(() => null)
        info('D3', '世界书按钮可用性', `disabled=${disabled}（无选中世界观时应为 true）`)
        if (disabled === false) {
          await lorebookBtn.first().click()
          await page.waitForTimeout(2000)
          record('D4', '世界书弹窗打开', await page.locator('.lorebook-modal, .lorebook').count() > 0,
            `nodes=${await page.locator('.lorebook-modal, .lorebook').count()}`)
          await dismissOverlays(page)
        } else info('D4', '跳过世界书弹窗', '按钮 disabled（该副本库没有选中世界观）')
      }
      await dismissOverlays(page)
      // 关闭动画 0.3s；以"页面中心还挡不挡点击"为判据，比数 DOM 里残留的 overlay 更贴近用户感受
      await page.waitForTimeout(900)
      const stillBlocked = await page.evaluate(() => {
        const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
        return !!(el && el.closest('.linshe-modal-overlay, .modal-overlay, .confirm-overlay'))
      })
      const left = await page.locator('.linshe-modal-overlay, .modal-overlay').count()
      record('D5', '世界书/世界观弹窗能关掉（中心不再被弹窗挡住）', !stillBlocked, `残留节点=${left}`)
    }

    // ───────────────── E 日报弹窗 ─────────────────
    // 世界书/世界观两个弹窗叠着，强行点会被上层拦住 —— 直接刷新页面重置（同日 hash 的 goto 不会重新加载）
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    await waitAndDismiss(page, 6000)
    info('E0', '进日报前的遮罩状态', await page.evaluate(() => {
      const sel = '.confirm-overlay,.linshe-modal-overlay,.modal-overlay'
      return [...document.querySelectorAll(sel)].map(el => el.className).join(' | ') || '(无)'
    }).catch(() => '(probe failed)'))
    try {
    const paperEntry = page.locator('.relation-entry', { hasText: '邻舍日报' })
    record('E1', '日报入口存在', await paperEntry.count() > 0)
    if (await paperEntry.count() > 0) {
      await safeClick(page, paperEntry.first(), '日报入口')
      await page.waitForTimeout(2500)
      const opened = await page.locator('.np-paper, .np-overlay').count()
      record('E2', '日报弹窗打开', opened > 0, `nodes=${opened}`)
      if (opened > 0) {
        // 没有今天的期号时，弹窗会落在往期（.np-paper.is-past-view）—— 那时本来就没有「重印今日」区，
        // 别把数据相关当成缺陷；今天期存在才断言 E3/E4。
        const pastView = await page.locator('.np-paper.is-past-view').count()
        const colophon = await page.locator('.np-colophon-start').count()
        const regenAll = await page.getByText('重新生成今日日报', { exact: false }).count()
        if (pastView > 0 || colophon === 0) {
          info('E3', '当前没有今日期号（弹窗落在往期）', `pastView=${pastView} colophon=${colophon} regen=${regenAll}`)
        } else {
          record('E3', '报尾有「重新生成今日日报」区', colophon > 0, `nodes=${colophon}`)
          record('E4', '整版重印按钮在（今天视图）', regenAll > 0, `count=${regenAll}`)
        }
        const placeholders = await page.locator('.np-img-placeholder').count()
        const withBtn = await page.locator('.np-img-placeholder:has-text("重新生成配图")').count()
        // 世界异闻的补图按钮挂在 section 里（.np-world-regen），不在占位框内 ⇒ 用「占位框里有几个按钮」比。
        // 今天这期可能一张缺图都没有（数据相关）—— 0 占位也算通过，记 INFO 说明即可
        if (placeholders === 0) {
          info('E5', '今天这期没有缺图占位', 'withButton=0（该期配图齐全，无需补印）')
        } else {
          record('E5', '每个缺图占位都有「重新生成配图」', withBtn === placeholders,
            `placeholders=${placeholders} withButton=${withBtn}`)
        }
        // 历史期：按钮必须消失（只读回看）
        const older = page.locator('.np-nav, [class*="np-nav"], button:has-text("‹")')
        const olderCount = await older.count()
        info('E6', '期号导航节点', `count=${olderCount}`)
        if (olderCount > 0) {
          await older.first().click({ timeout: 3000 }).catch(() => {})
          await page.waitForTimeout(1800)
          const isPast = await page.locator('.np-paper.is-past-view').count() > 0
          const regenInPast = await page.getByText('重新生成今日日报', { exact: false }).count()
          if (isPast) record('E7', '回看历史期时整版重印按钮消失', regenInPast === 0, `count=${regenInPast}`)
          else info('E7', '跳过历史期检查', '没有更旧的期次')
        }
        await page.screenshot({ path: path.join(SHOTS, 'newspaper.png') }).catch(() => {})
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(800)
      }
    }
    } catch (err) {
      record('E9', '日报检查异常', false, String(err?.message || err).slice(0, 300))
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(500)
    }

    // ───────────────── F galgame 进场 ─────────────────
    const chars = await (await fetch(BASE + '/api/characters')).json().catch(() => ({}))
    const firstCharId = chars?.characters?.[0]?.id
    if (!firstCharId) throw new Error('副本库里没有角色，无法验 galgame 进场')
    await page.goto(`${BASE}/#/chat/${firstCharId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    await waitAndDismiss(page, 8000)
    info('F0', '私聊页遮罩状态', await page.evaluate(() => {
      const sel = '.linshe-modal-overlay,.modal-overlay'
      return [...document.querySelectorAll(sel)].map(el => el.className).join(' | ') || '(无)'
    }).catch(() => '(probe failed)'))
    const sw = page.locator('.chat-mode-switch .mode-switch-action')
    record('F1', '模式切换入口渲染', await sw.count() > 0)
    if (await sw.count() > 0) {
      // 真实用户路径：鼠标移过去 → 胶囊显现（pointer-events 才变 auto）→ 再点。
      // 这一步也顺带守住 `.chat-header` 的层叠顺序（曾因 backdrop-filter 把胶囊压在消息列表下面）。
      const box = await sw.first().boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(700)
      const pe = await page.evaluate(() => {
        const act = document.querySelector('.mode-switch-action')
        return act ? getComputedStyle(act).pointerEvents : '(none)'
      })
      record('F1b', '悬停后入口可接收点击', pe === 'auto', `pointer-events=${pe}`)
      await safeClick(page, sw.first(), '模式切换')
      await page.waitForFunction(() => location.hash.includes('mode=galgame'), { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(1600)
      const hash = await page.evaluate(() => location.hash)
      record('F2', '进入 galgame（URL ?mode=galgame）', hash.includes('mode=galgame'), hash)
      record('F3', 'galgame 舞台渲染', await page.locator('.gal-stage').count() > 0,
        `nodes=${await page.locator('.gal-stage').count()}`)
      await page.screenshot({ path: path.join(SHOTS, 'galgame.png') }).catch(() => {})
      // 退出：点舞台空白处或按 Esc，再断言 query 被清掉
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(300)
      await page.evaluate(() => { history.back() }).catch(() => {})
      await page.waitForTimeout(1500)
      const backHash = await page.evaluate(() => location.hash)
      info('F4', '退出后的 hash', backHash)
    }

    // ───────────────── H 设置页（本轮合并的 SettingsView）─────────────────
    await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2800)
    await waitAndDismiss(page, 6000)
    // 首屏可能是 DeepSeek 简易向导（guided）—— 先切到完整配置再断言
    const skipGuided = page.getByText('跳过 DeepSeek，使用其他接口', { exact: false }).first()
    if (await skipGuided.count() > 0) {
      await safeClick(page, skipGuided, '跳过 DeepSeek 简易设置')
      await page.waitForTimeout(900)
    }
    const settingsText = await text(page)
    record('H1', '设置页渲染出 LLM 卡片', /LLM API 设置/.test(settingsText))
    record('H2', '「最大输出 tokens」输入项在', /最大输出 tokens/.test(settingsText))
    // 设置页有很多数字输入与「保存」按钮 —— 必须**限定在 LLM 卡片内**找，否则会命中别的卡片
    const llmCard = page.locator('.card', { hasText: 'LLM API 设置' }).first()
    const tokenInput = llmCard.locator('input[type="number"]').first()
    const tokenValue = await tokenInput.inputValue().catch(() => '')
    record('H3', '输出额度有默认值（正整数）', /^\d+$/.test(tokenValue), `value=${tokenValue}`)

    // 接入方式：切到 Vertex 应出现服务账号输入，再切回 OpenAI 应消失
    const connSelect = llmCard.locator('.ls-select-wrapper', { hasText: 'OpenAI 兼容接口' }).first()
    const hasConn = await connSelect.count() > 0
    record('H4', '接入方式选择器在（默认 OpenAI 兼容）', hasConn)
    if (hasConn) {
      await connSelect.click()
      await page.waitForTimeout(400)
      const vertexOption = page.getByText('Google Vertex AI（服务账号）', { exact: false }).last()
      const optionCount = await vertexOption.count()
      record('H5', '下拉里有 Vertex 选项', optionCount > 0, `count=${optionCount}`)
      if (optionCount > 0) {
        await vertexOption.click()
        await page.waitForTimeout(600)
        const vertexArea = await page.locator('textarea[placeholder*="service_account"]').count()
        record('H6', '切到 Vertex 后出现服务账号输入 + 地区', vertexArea > 0 && /服务账号 JSON/.test(await text(page)),
          `textarea=${vertexArea}`)
        // 切回 OpenAI
        const backSelect = llmCard.locator('.ls-select-wrapper', { hasText: 'Google Vertex AI' }).first()
        if (await backSelect.count() > 0) {
          await backSelect.click()
          await page.waitForTimeout(400)
          await page.getByText('OpenAI 兼容接口（DeepSeek / 自定义）', { exact: false }).last().click()
          await page.waitForTimeout(600)
          record('H7', '切回 OpenAI 后 API Key 输入回来', /API Key/.test(await text(page)))
        } else info('H7', '跳过切回', '找不到 Vertex 选择器')
      }
    }

    // 输出额度清空 ⇒ 保存按钮禁用（非法值不许落库）
    if (await tokenInput.count() > 0) {
      await tokenInput.fill('')
      await page.waitForTimeout(400)
      const saveBtn = llmCard.getByRole('button', { name: '保存', exact: true }).first()
      const disabled = await saveBtn.isDisabled().catch(() => null)
      record('H8', '额度清空后保存按钮禁用', disabled === true, `disabled=${disabled}`)
      await tokenInput.fill('65536')
      await page.waitForTimeout(200)
    }

    // 工作流模式弹窗：自定义工作流卡片 + 下拉（workflow/ 里有两个生图工作流时应出现）
    const wfBtn = page.getByText('切换工作流模式', { exact: false }).first()
    if (await wfBtn.count() > 0) {
      await safeClick(page, wfBtn, '工作流模式按钮')
      await page.waitForTimeout(1000)
      record('H9', '工作流模式弹窗打开', await page.locator('.wf-mode-options').count() > 0,
        `options=${await page.locator('.wf-mode-option').count()}`)
      // 「自定义」卡片只在 workflow/ 目录里存在**非内置**工作流时出现；
      // 本仓库现在只有内置的两个（放大细化），所以这里通常是 INFO 而不是 FAIL
      const customCard = page.getByText('自定义', { exact: true }).first()
      const customCount = await customCard.count()
        ? await customCard.count()
        : await (async () => {
          const deadline = Date.now() + 6000
          while (Date.now() < deadline) {
            if (await page.getByText('自定义', { exact: true }).count() > 0) return 1
            await page.waitForTimeout(300)
          }
          return 0
        })()
      if (customCount > 0) {
        await safeClick(page, page.getByText('自定义', { exact: true }).first(), '自定义工作流卡片')
        await page.waitForTimeout(1100)
        // 下拉存在性看 DOM；placeholder 是属性不是文本，别拿 innerText 判
        const selectInBlock = page.locator('.wf-mode-custom .ls-select-wrapper').first()
        const selectCount = await selectInBlock.count()
        let builtinOptions = 0
        if (selectCount > 0) {
          await selectInBlock.click({ force: true }).catch(() => {})
          await page.waitForTimeout(600)
          builtinOptions = await page.getByText('（内置）', { exact: false }).count()
        }
        record('H10', '「自定义」下拉可选到内置工作流', selectCount > 0 && builtinOptions > 0,
          `select=${selectCount} 内置选项=${builtinOptions}`)
      } else {
        info('H10', '跳过自定义工作流下拉', 'workflow/ 列表为空')
      }
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(600)
    } else info('H9', '跳过工作流弹窗', '找不到 .wf-mode-btn')

    // ───────────────── I 相册多选删除（2026-10-20）─────────────────
    await page.goto(BASE + '/#/gallery', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2600)
    await waitAndDismiss(page, 6000)
    const galleryItems = page.locator('.gallery-item')
    const galleryBefore = await galleryItems.count()
    record('I1', '相册网格有图片', galleryBefore > 0, `count=${galleryBefore}`)
    const selectBtn = page.getByRole('button', { name: '选择', exact: true }).first()
    record('I2', '「选择」入口在', await selectBtn.count() > 0)
    if (galleryBefore > 0 && await selectBtn.count() > 0) {
      await safeClick(page, selectBtn, '选择')
      await page.waitForTimeout(500)
      await galleryItems.first().click({ force: true })
      await page.waitForTimeout(400)
      const delBtn = page.getByText(/删除选中（\d+）/, { exact: false }).first()
      const delText = await delBtn.innerText().catch(() => '')
      record('I3', '勾选一张后按钮显示「删除选中（1）」', /（1）/.test(delText), `text=${delText}`)
      if (/（1）/.test(delText)) {
        await safeClick(page, delBtn, '删除选中')
        await page.waitForTimeout(700)
        // 确认弹窗（App 的 confirm）
        const confirmOk = page.getByRole('button', { name: '删除', exact: true }).last()
        if (await confirmOk.count() > 0) await safeClick(page, confirmOk, '确认删除')
        await page.waitForTimeout(2000)
        const galleryAfter = await galleryItems.count()
        record('I4', '删除后网格少一张', galleryAfter === galleryBefore - 1, `${galleryBefore} → ${galleryAfter}`)
      }
    }

    // ───────────────── G 报错面 ─────────────────
    record('G1', '无页面未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    record('G2', '无 console error（Vue setup 异常会走这里）', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    // 资源 404/403 单列：副本库没有用户的图片文件、GitHub 版本接口限流都会命中，
    // 不是本轮 UI 的缺陷；但把 URL 打出来，真缺资源时一眼能看到
    info('G3', '资源加载失败（不算 JS 异常）', `${resourceErrors.length} 条 | ${badResponses.slice(0, 5).join(' , ') || '(无)'}`)
  } finally {
    await browser.close()
    await stopBackend()
    if (process.env.KEEP_DB !== '1') rmSync(WORK, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (err) {
  record('X1', '脚本异常', false, String(err?.stack || err).slice(0, 800))
} finally {
  const failed = results.filter(r => !r.ok)
  console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`)
  console.log(`截图：${SHOTS}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
