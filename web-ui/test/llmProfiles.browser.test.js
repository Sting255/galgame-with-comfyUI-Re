import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

test('模型设置实际点击：失败保留草稿、配置互斥、免费模式恢复及双主题', {
  skip: !process.env.PLAYWRIGHT_MODULE, timeout: 120000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
  const { createServer } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  let profiles, activeId, freeEgg, createGate, createCount, failCreate, failSave, failActivate
  const personal = { hasApiKey: true, preview: 'fixture', baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat', maxTokens: 8192, contextWindow: 128000, headers: {}, extraBody: {} }
  const harness = `
    import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';
    import {createRouter,createWebHistory} from 'vue-router';
    import Settings from '/src/views/SettingsView.vue';
    import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/components.css';
    const notice=ref('');window.acceptConfirm=true;window.confirmCalls=0;
    const app=createApp({setup(){return ()=>[h('output',{'data-test':'notice'},notice.value),h(Settings)]}});
    app.use(createPinia());app.use(createRouter({history:createWebHistory(),routes:[{path:'/:pathMatch(.*)*',component:Settings}]}));
    app.provide('toast',text=>notice.value=text);
    app.provide('confirm',async()=>{window.confirmCalls++;return window.acceptConfirm});app.mount('#app');`
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [vue(), { name: 'llm-profiles-acceptance', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/__profiles')) {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module">${harness}</script></body></html>`))
        return
      }
      if (!req.url.startsWith('/api/')) return next()
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      let output = { ok: true }
      const profileResult = () => ({ ok: true, profiles, activeProfileId: activeId })
      if (req.url === '/api/config') output = {
        comfy: { artist: '', width: 1024, height: 1024 },
        llm: freeEgg ? { ...personal, freeEgg: true, model: 'free-fixture', contextWindow: 32000 } : personal,
        features: { mergeMessages: true }, workflow: { mode: 'turbo' }, llmProfiles: profiles, activeLlmProfileId: activeId,
      }
      if (req.url === '/api/config/llm/profiles' && req.method === 'POST') {
        createCount++
        if (createGate) await createGate.promise
        if (failCreate) output = { ok: false, error: '创建失败夹具' }
        else { profiles = [...profiles, { id: 'c', name: body.name }]; output = profileResult() }
      }
      if (req.method === 'DELETE' && req.url.startsWith('/api/config/llm/profiles/')) {
        profiles = profiles.filter(p => p.id !== req.url.split('/').at(-1)); output = profileResult()
      }
      if (req.url.endsWith('/activate')) {
        if (failActivate) output = { ok: false, error: '切换失败夹具' }
        else { activeId = req.url.split('/').at(-2); output = { ...profileResult(), llmConfig: { ...personal, contextWindow: 64000 } } }
      }
      if (req.url === '/api/config/llm' && req.method === 'PUT') output = { ok: true, ...personal, ...body }
      if (req.url === '/api/config/features' && failSave) output = { ok: false, error: '选项保存失败夹具' }
      if (req.url === '/api/config/llm/free-egg') {
        freeEgg = body.enabled; output = { ok: true, ...personal, freeEgg }
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(output))
    }) } }], server: { host: '127.0.0.1', port: 0 } })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined })
  t.after(() => browser.close())
  for (const theme of ['warm', 'dark']) {
    profiles = [{ id: 'a', name: '个人' }, { id: 'b', name: '备用' }]
    activeId = 'a'; freeEgg = false; createGate = null; createCount = 0
    failCreate = false; failSave = false; failActivate = false
    const page = await browser.newPage({ viewport: theme === 'warm' ? { width: 1440, height: 1000 } : { width: 360, height: 800 } })
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(theme => { localStorage.setItem('linshe_theme_mode', theme); document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', theme)) }, theme)
    const origin = server.resolvedUrls.local[0]
    await page.goto(`${origin}__profiles`)
    const form = page.locator('.llm-api-switch-body')
    const key = page.locator('input[name=linshe-llm-key]')
    const windowInput = page.getByRole('textbox', { name: '上下文窗口（token）', exact: true })
    await key.fill('synthetic-draft-key')
    await windowInput.fill('256000')
    await page.getByRole('button', { name: '删除配置 备用', exact: true }).click()
    await page.getByRole('button', { name: '备用', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await key.inputValue(), 'synthetic-draft-key')
    assert.equal(await windowInput.inputValue(), '256000')

    await page.getByRole('button', { name: '+ 新增配置', exact: true }).click()
    const name = page.getByRole('textbox', { name: '配置名称', exact: true })
    const longName = '备用配置'.repeat(15)
    await name.fill(longName)
    let release
    createGate = { promise: new Promise(resolve => { release = resolve }) }
    failCreate = true
    await name.press('Enter')
    await page.waitForFunction(() => document.querySelector('.llm-profiles-bar').getAttribute('aria-busy') === 'true')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    assert.equal(await name.isVisible(), true)
    assert.equal(createCount, 1)
    release()
    await page.getByText('新增配置失败：创建失败夹具', { exact: true }).waitFor()
    assert.equal(await name.inputValue(), longName)
    failCreate = false; createGate = null
    await page.getByRole('button', { name: '确定', exact: true }).click()
    await name.waitFor({ state: 'detached' })
    const alternate = page.getByRole('button', { name: longName, exact: true })
    await alternate.waitFor()
    assert.equal(createCount, 2)
    const bounds = await alternate.boundingBox()
    assert.ok(bounds.x + bounds.width <= page.viewportSize().width, '长配置名不应溢出手机屏幕')

    await page.evaluate(() => { window.acceptConfirm = false })
    await alternate.click()
    await page.waitForFunction(() => document.querySelector('.llm-profiles-bar').getAttribute('aria-busy') === 'false')
    assert.equal(activeId, 'a')
    assert.equal(await key.inputValue(), 'synthetic-draft-key')
    await page.evaluate(() => { window.acceptConfirm = true })
    failActivate = true
    await alternate.click()
    await page.getByText('切换配置失败：切换失败夹具', { exact: true }).waitFor()
    assert.equal(await windowInput.inputValue(), '256000')
    failActivate = false

    failSave = true
    await form.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('[data-test=notice]').filter({ hasText: '草稿已保留' }).waitFor()
    assert.equal(await key.inputValue(), 'synthetic-draft-key')
    assert.equal(await windowInput.inputValue(), '256000')
    assert.equal(await form.getByRole('button', { name: '保存', exact: true }).isEnabled(), true)
    failSave = false
    await form.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('input[name=linshe-llm-key]').value === '')
    assert.equal(await windowInput.inputValue(), '256000')
    assert.equal(await page.getByPlaceholder('https://your-api-endpoint/v1', { exact: true }).isVisible(), true)
    await alternate.click()
    await page.waitForFunction(() => document.querySelector('#llm-context-window').value === '64000')
    assert.equal(activeId, 'c')
    assert.equal(await page.getByPlaceholder('https://your-api-endpoint/v1', { exact: true }).isVisible(), true)

    // Initial load in free mode must restore personal fields when turned off.
    freeEgg = true
    await page.goto(`${origin}__profiles`)
    await page.locator('.free-egg-btn.active').click()
    await windowInput.waitFor()
    assert.equal(await windowInput.inputValue(), '128000')
    assert.equal(freeEgg, false)
    assert.deepEqual(errors, [])
    await page.close()
  }
})
