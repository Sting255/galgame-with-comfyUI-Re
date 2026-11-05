import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createAccessControl } from '../../agent-core/src/server/accessControl.js'

test('设备连接：真实 HTTP 配对、错误反馈、刷新保持与双主题窄屏', {
  skip: !process.env.PLAYWRIGHT_MODULE, timeout: 90000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
  const express = createRequire(new URL('../../agent-core/package.json', import.meta.url))('express')
  const { createServer } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const token = 'browser-fixture-device-pairing-code'
  const api = express()
  api.use(express.json({ limit: '1kb' }))
  api.use(createAccessControl({ token }))
  api.get('/api/probe', (_req, res) => res.json({ ok: true }))
  const harness = `
    import {createApp,h} from 'vue';
    import Gate from '/src/components/DeviceAccessGate.vue';
    import Panel from '/src/components/settings/DeviceAccessPanel.vue';
    import '/src/styles/tokens.css';import '/src/styles/base.css';
    import '/src/styles/components.css';import '/src/styles/animations.css';
    document.documentElement.dataset.theme=new URL(location.href).searchParams.get('theme')||'warm';
    createApp({render:()=>new URL(location.href).searchParams.has('panel')?h(Panel):
      h(Gate,null,{default:()=>h('h1','连接成功')})}).mount('#app');`
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [vue(), { name: 'device-access-acceptance', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (/^\/api\//i.test(req.url)) return api(req, res, next)
        if (!req.url.startsWith('/__device')) return next()
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module">${harness}</script></body></html>`))
      })
    } }], server: { host: '127.0.0.1', port: 0 } })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined })
  t.after(() => browser.close())
  const origin = server.resolvedUrls.local[0]
  for (const theme of ['warm', 'dark']) {
    const context = await browser.newContext({ viewport: theme === 'warm' ? { width: 1280, height: 900 } : { width: 360, height: 800 },
      extraHTTPHeaders: { 'X-Forwarded-For': '192.168.1.55' } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    assert.equal((await context.request.get(`${origin}api/probe`)).status(), 401)
    await page.goto(`${origin}__device?theme=${theme}`)
    await page.getByRole('heading', { name: '连接你的邻舍' }).waitFor()
    await page.getByRole('textbox', { name: '配对码', exact: true }).fill('incorrect')
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '配对码不正确' }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByRole('textbox', { name: '配对码', exact: true }).fill(token)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('heading', { name: '连接成功' }).waitFor()
    assert.equal((await context.request.get(`${origin}api/probe`)).status(), 200)
    assert.equal((await context.request.get(`${origin}API/data/export`)).status(), 403)
    const cookie = (await context.cookies()).find(c => c.name === 'linshe_access')
    assert.equal(cookie.httpOnly, true)
    await page.reload()
    await page.getByRole('heading', { name: '连接成功' }).waitFor()
    await page.goto(`${origin}__device?panel&theme=${theme}`)
    await page.getByText('此设备已连接。数据备份与恢复请在电脑本机操作。').waitFor()
    assert.equal(await page.getByRole('button', { name: '显示配对码' }).count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
  }
  const local = await browser.newPage()
  await local.goto(`${origin}__device?panel`)
  await local.getByRole('button', { name: '显示配对码' }).click()
  assert.equal(await local.getByRole('textbox', { name: '设备配对码' }).inputValue(), token)
  await local.getByRole('button', { name: '隐藏配对码' }).click()
  assert.notEqual(await local.getByRole('textbox', { name: '设备配对码' }).inputValue(), token)
})
