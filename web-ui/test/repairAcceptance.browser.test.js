import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

test('修复验收：场景外观实际传参、自定义工作流显示七项注入说明', {
  skip: !process.env.PLAYWRIGHT_MODULE, timeout: 90000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
  const { createServer } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const requests = []
  const harness = `
    import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';
    import {createRouter,createWebHistory} from 'vue-router';
    import Settings from '/src/views/SettingsView.vue';
    import Refine from '/src/components/AppearanceRefineModal.vue';
    import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/components.css';
    const mode=new URL(location.href).searchParams.get('mode');
    const app=createApp({setup(){const open=ref(true);return ()=>mode==='settings'?h(Settings):
      h(Refine,{modelValue:open.value,sceneLabel:'睡衣',displayName:'测试角色',basePrompt:'人物资料',
      'onUpdate:modelValue':v=>open.value=v,onApplied:v=>window.applied=v});}});
    app.use(createPinia());app.use(createRouter({history:createWebHistory(),routes:[{path:'/:pathMatch(.*)*',component:Settings}]}));
    app.provide('toast',()=>{});app.mount('#app');`
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [vue(), { name: 'repair-acceptance', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/__repair')) {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module">${harness}</script></body></html>`))
        return
      }
      if (!req.url.startsWith('/api/')) return next()
      let body = ''; for await (const chunk of req) body += chunk
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null })
      let output = {}
      if (req.url === '/api/config') output = { comfy: { artist: '', width: 1024, height: 1024 }, llm: { hasApiKey: true }, features: {}, workflow: { mode: 'turbo' } }
      if (req.url.includes('workflows')) output = { workflows: [{ filename: 'fixture.json', label: '测试工作流', builtin: false }] }
      if (req.url.includes('refine-appearance')) output = { appearance: '测试睡衣外观', prompt_before: '', prompt_after: '' }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(output))
    }) } }], server: { host: '127.0.0.1', port: 0 } })
  t.after(() => server.close())
  await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined })
  t.after(() => browser.close())
  for (const theme of ['warm', 'dark']) {
    const page = await browser.newPage({ viewport: theme === 'warm' ? { width: 1440, height: 1000 } : { width: 390, height: 844 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.stack || error.message))
    await page.addInitScript(theme => { localStorage.setItem('linshe_theme_mode', theme); document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', theme)) }, theme)
    const origin = server.resolvedUrls.local[0]
    await page.goto(`${origin}__repair?mode=refine`)
    await page.getByText('修正「睡衣」外观 — 测试角色', { exact: true }).waitFor()
    await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') })
    await page.getByRole('button', { name: '开始分析', exact: true }).click()
    await page.locator('textarea').waitFor()
    assert.equal(requests.filter(r => r.url.includes('refine-appearance')).at(-1).body.scene_label, '睡衣')
    assert.equal(await page.locator('textarea').inputValue(), '测试睡衣外观')
    await page.getByRole('button', { name: '应用并保存', exact: true }).click()
    await page.waitForFunction(() => window.applied)
    await page.goto(`${origin}__repair?mode=settings`)
    await page.getByRole('button', { name: '切换工作流模式', exact: true }).click()
    await page.locator('.wf-mode-option').filter({ hasText: '自定义' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.wf-inject-row').length === 7)
    assert.equal(await page.locator('.wf-inject-row').count(), 7)
    assert.ok((await page.locator('.wf-inject-node').allTextContents()).includes('画面描述'))
    assert.deepEqual(errors, [])
    await page.close()
  }
})
