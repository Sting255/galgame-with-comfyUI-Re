/**
 * 全站巡游（2026-10-19）：逐页打开 + 关键弹窗，查「页面能不能渲染、有没有报错」。
 *
 * 与 run-e2e.mjs 的分工：
 *   · run-e2e.mjs 深挖功能链路（触摸 / 玩具 / 催眠 / 奇遇 / 日报……），一轮十几分钟；
 *   · 这个脚本只做**覆盖面**：每条路由都进一次、断言主内容出现、收集 console/pageerror，
 *     并对几个大页面点开主要弹窗（设置 / 记忆 / 破限 / 酒馆 / 媒体 / 图库 / 信箱 / 背包 / 日程）。
 *
 * 纪律与 run-e2e 一致：真实库只读（VACUUM 副本）、图片目录隔离、不点会花钱的按钮。
 * 真机时把 LLM / ComfyUI 地址用环境变量传进来（脚本只读它们，不写 .env）：
 *   $env:COMFYUI_URL='http://127.0.0.1:8189'; node e2e/full-tour.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const NODE = path.join(REPO, 'runtime', 'nodejs', 'node.exe')
const AC = path.join(REPO, 'agent-core')
const REAL_DB = path.join(AC, 'data', 'agent.db')
const require = createRequire(path.join(AC, 'package.json'))
const BetterSqlite3 = require('better-sqlite3')

const PORT = Number(process.env.TOUR_PORT || 3214)
const BASE = `http://127.0.0.1:${PORT}`
const WORK = path.join(os.tmpdir(), 'e2e-tour')
const DB = path.join(WORK, 'copy.db')
const IMAGES = path.join(WORK, 'images')
const SHOTS = process.env.TOUR_SHOTS || path.join(os.tmpdir(), 'e2e-tour-shots')

const results = []
const consoleErrors = []
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
    if (!(Array.isArray(rows) && rows[0]?.integrity_check === 'ok')) throw new Error('副本 integrity_check 失败')
  } finally { check.close() }
}

let backend = null
function startBackend() {
  const child = spawn(NODE, ['app.js'], {
    cwd: AC,
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
  await sleep(800)
}
async function waitForServer(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.status < 500) return true } catch { /* retry */ }
    await sleep(500)
  }
  return false
}

const IGNORABLE = [
  /Failed to load resource/i,
  /net::ERR_ABORTED/i,
  /github\.com\/.*403/i,
  /favicon/i,
  /AudioContext/i,
]
const isIgnorable = text => IGNORABLE.some(re => re.test(text))

async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(200)
  }
  const closer = page.locator('.linshe-modal-overlay .modal-close, .modal-overlay .modal-close').first()
  if (await closer.count() > 0) await closer.click({ force: true }).catch(() => {})
  await sleep(300)
}

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }) } catch { /* ignore */ }
}

const ROUTES = [
  { hash: '/chat', name: 'chat', expect: null },
  { hash: '/moments', name: 'moments', expect: '朋友圈' },
  { hash: '/events', name: 'events', expect: '奇遇' },
  { hash: '/media', name: 'media', expect: '媒体' },
  { hash: '/schedule', name: 'schedule', expect: '日程' },
  { hash: '/gallery', name: 'gallery', expect: '相册' },
  { hash: '/tavern', name: 'tavern', expect: '酒馆' },
  { hash: '/mailbox', name: 'mailbox', expect: '信箱' },
  { hash: '/backpack', name: 'backpack', expect: '背包' },
  { hash: '/settings', name: 'settings', expect: '系统参数' },
  { hash: '/settings/memory', name: 'memory-settings', expect: '聊天记忆' },
  { hash: '/settings/jailbreak', name: 'jailbreak', expect: '破限规则集' },
  { hash: '/settings/maibot', name: 'maibot', expect: 'MaiBot' },
]

async function main() {
  snapshotDb()
  startBackend()
  const up = await waitForServer(`${BASE}/api/config`)
  if (!up) { console.log('后端没起来'); process.exit(2) }
  info('S1', '后端已启动（副本库 + 隔离图片目录）', BASE)

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', err => pageErrors.push(String(err.message || err)))
  page.on('console', msg => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (isIgnorable(text)) return
    consoleErrors.push(text)
  })

  // 预热：进一次首页关掉「更新说明」，后面每一页都不会被它挡
  await page.goto(`${BASE}/#/chat`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  await dismissOverlays(page)
  await sleep(500)

  for (const route of ROUTES) {
    const errorsBefore = consoleErrors.length + pageErrors.length
    await page.goto(`${BASE}/#${route.hash}`, { waitUntil: 'domcontentloaded' })
    await sleep(2600)
    await dismissOverlays(page)
    await sleep(400)
    const body = await page.locator('#app').innerText().catch(() => '')
    const rendered = body.trim().length > 30
    const hasExpect = route.expect ? body.includes(route.expect) : true
    const errorText = /加载失败|Failed to fetch|页面出错了|Cannot read propert/.test(body)
    const newErrors = consoleErrors.length + pageErrors.length - errorsBefore
    record(`R:${route.name}`, `路由 ${route.hash} 渲染正常`, rendered && hasExpect && !errorText,
      `chars=${body.trim().length}${route.expect ? ` 期望含「${route.expect}」=${hasExpect}` : ''}${errorText ? ' 出现错误文案' : ''}${newErrors ? ` 新增 console/pageerror=${newErrors}` : ''}`)
    await shot(page, `route-${route.name}`)
  }

  // 关键弹窗抽查（找不到入口记 INFO，不算失败 —— 入口可能随角色/数据变化）
  await page.goto(`${BASE}/#/tavern`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  await dismissOverlays(page)

  const modals = [
    { name: '日报', text: '今日日报', open: () => page.getByText('今日日报', { exact: false }).first() },
    { name: '世界观', text: '世界观', open: () => page.getByText('世界观', { exact: false }).first() },
    { name: 'SillyTavern 预设', text: 'SillyTavern 预设', open: () => page.locator('.relation-entry', { hasText: 'SillyTavern 预设' }).first() },
    { name: '立绘管理', text: '立绘管理', open: () => page.locator('.standing-manage-card').first() },
  ]
  for (const modal of modals) {
    const before = await page.locator('.linshe-modal-overlay, .modal-overlay').count()
    const loc = modal.open()
    const count = await loc.count().catch(() => 0)
    if (!count) { info(`M:${modal.name}`, '入口未找到', '跳过'); continue }
    await loc.click({ force: true }).catch(() => {})
    await sleep(1600)
    const after = await page.locator('.linshe-modal-overlay, .modal-overlay').count()
    record(`M:${modal.name}`, `打开「${modal.name}」`, after > before, `overlays ${before}→${after}`)
    await dismissOverlays(page)
    await sleep(600)
  }

  // 设置页：五张卡都在（LLM / 图像服务 / 工作流 / 界面 / 数据）
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
  await sleep(2600)
  await dismissOverlays(page)
  const settingsText = await page.locator('#app').innerText()
  for (const [id, keyword] of [['LLM', 'LLM API 设置'], ['图像', '图片生成服务'], ['工作流', '工作流'], ['界面', '主题'], ['数据', '数据']]) {
    record(`S:${id}`, `设置页含「${keyword}」`, settingsText.includes(keyword))
  }
  await shot(page, 'settings-full')

  const totalErrors = consoleErrors.length + pageErrors.length
  record('E1', '全程零 console error（忽略资源 404 / GitHub 403 / favicon）', totalErrors === 0,
    totalErrors ? JSON.stringify([...consoleErrors, ...pageErrors].slice(0, 5)) : '无')

  await browser.close()
  await stopBackend()

  const pass = results.filter(r => r.ok && !r.info).length
  const fail = results.filter(r => !r.ok).length
  console.log(`\n合计 ${results.length} 项，PASS ${pass}，FAIL ${fail}，INFO ${results.filter(r => r.info).length}`)
  console.log('截图：' + SHOTS)
  if (fail) process.exit(1)
}

main().catch(async err => {
  console.error('脚本异常:', err)
  await stopBackend()
  process.exit(2)
})
