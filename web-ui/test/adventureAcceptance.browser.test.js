import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

test('奇遇与备份：失败重试保留草稿、空筛选可恢复、远端限制及恢复后锁定', {
  skip: !process.env.PLAYWRIGHT_MODULE, timeout: 90000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
  const { createServer } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const harness = `
    import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';
    import {createRouter,createWebHistory} from 'vue-router';
    import Events from '/src/views/EventsView.vue';import Card from '/src/components/EventCard.vue';
    import Backup from '/src/components/settings/DataBackupPanel.vue';
    import {useEventsStore} from '/src/stores/events.js';import {useChatStore} from '/src/stores/chat.js';
    import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/components.css';
    import '/src/styles/animations.css';
    const params=new URL(location.href).searchParams;const mode=params.get('mode');
    document.documentElement.dataset.theme=params.get('theme')||'warm';
    const notice=ref('');const app=createApp({setup(){const store=useEventsStore();
      useChatStore().characters=[{id:1,display_name:'旅人',events_disabled:0}];
      if(mode==='card')store.activeEvents=[{id:1,title:'沿河散步',display_name:'旅人',character_id:1,
        choice_a:'沿河走走',choice_b:'去看风景',choice_history:[],processing:false,expires_at:'2099-01-01T00:00:00Z'}];
      return ()=>h('main',[h('p',{role:'alert','data-notice':''},notice.value),mode==='backup'?h(Backup):
        mode==='card'?h(Card,{event:store.activeEvents[0],initialOpen:true}):h(Events)]);
    }});app.use(createPinia());app.use(createRouter({history:createWebHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]}));
    app.provide('toast',text=>notice.value=text);app.provide('confirm',async()=>true);
    app.provide('isMobile',false);app.provide('toggleMobileSidebar',()=>{});app.mount('#app');`
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [vue(), { name: 'adventure-acceptance', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith('/__adventure')) return next()
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
    const page = await browser.newPage({ viewport: theme === 'warm' ? { width: 1280, height: 900 } : { width: 360, height: 800 } })
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    t.after(() => { if (errors.length) console.error('Browser errors:', errors) })
    let local = false
    let summaryCalls = 0
    let importCalls = 0
    let generateCalls = 0
    let choiceCalls = 0
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const path = new URL(route.request().url()).pathname
      let status = 200
      let body = {}
      if (path === '/api/access') body = { local, authorized: true }
      else if (path === '/api/data/export/info') { summaryCalls++; body = { counts: { characters: 2, messages: 3, groups: 1, memories: 4 }, dbBytes: 1024 } }
      else if (path === '/api/data/import') {
        importCalls++
        status = importCalls === 1 ? 400 : 200
        body = status === 400 ? { error: '归档损坏' } : { ok: true, restartRequired: true }
      } else if (path === '/api/events') body = { active: [], history: [{ id: 8, character_id: 1, display_name: '旅人', title: '旧故事', engaged: false, ended_at: '2026-01-01T00:00:00Z', choice_history: [] }] }
      else if (path === '/api/events/generate') {
        generateCalls++
        status = generateCalls === 1 ? 409 : 200
        body = status === 409 ? { message: '暂时无法生成' } : { id: 2 }
      } else if (path === '/api/events/1/choose') {
        choiceCalls++
        status = choiceCalls === 1 ? 409 : 200
        body = status === 409 ? { message: '暂时无法推进' } : { event: { id: 1, title: '沿河散步', choice_a: '返回家中', choice_b: '继续散步', choice_history: [], expires_at: '2099-01-01T00:00:00Z' } }
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })

    await page.goto(`${origin}__adventure?mode=events&theme=${theme}`)
    try { await page.locator('.history-header').click() }
    catch (error) { console.error('Page:', await page.locator('body').innerText()); throw error }
    await page.locator('.filter-heart').click()
    await page.getByText('没有符合筛选条件的奇遇，可切换为「全部」。').waitFor()
    await page.locator('.filter-all').click()
    await page.locator('.preview-title').filter({ hasText: '旧故事' }).waitFor()
    await page.getByRole('button', { name: '🎬 扰动世界线' }).click()
    await page.locator('.picker-item').filter({ hasText: '旅人' }).click()
    await page.locator('textarea').fill('一起去河边寻找春天')
    await page.getByRole('button', { name: '开始推演', exact: true }).click()
    await page.locator('[data-notice]').filter({ hasText: '生成失败' }).waitFor()
    assert.equal(await page.locator('textarea').inputValue(), '一起去河边寻找春天')
    await page.getByRole('button', { name: '开始推演', exact: true }).click()
    await page.locator('textarea').waitFor({ state: 'hidden' })
    assert.equal(generateCalls, 2)

    await page.goto(`${origin}__adventure?mode=card&theme=${theme}`)
    await page.locator('.vn-input').fill('慢慢沿河走')
    await page.locator('.vn-submit').click()
    await page.locator('[data-notice]').filter({ hasText: '推进失败' }).waitFor()
    assert.equal(await page.locator('.vn-input').inputValue(), '慢慢沿河走')
    await page.locator('.vn-submit').click()
    await page.getByRole('button', { name: '返回家中', exact: true }).waitFor()
    assert.equal(await page.locator('.vn-input').inputValue(), '')

    await page.goto(`${origin}__adventure?mode=backup&theme=${theme}`)
    await page.getByText('数据备份与恢复请在运行邻舍的电脑本机操作。').waitFor()
    assert.equal(summaryCalls, 0)
    assert.equal(await page.getByRole('button', { name: '一键导入', exact: true }).count(), 0)
    local = true
    await page.reload()
    await page.getByText(/角色 2 · 消息 3/).waitFor()
    const upload = page.locator('input[type=file]')
    await upload.setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('test') })
    await page.locator('.data-backup-notice').filter({ hasText: '只支持' }).waitFor()
    assert.equal(importCalls, 0)
    for (let attempt = 0; attempt < 2; attempt++) {
      await upload.setInputFiles({ name: 'fixture.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from('fixture') })
      await page.getByRole('button', { name: '确认导入', exact: true }).click()
      await page.locator('.data-backup-notice').filter({ hasText: attempt ? '请重启' : '归档损坏' }).waitFor()
      await page.locator('.modal-overlay').waitFor({ state: 'hidden' })
    }
    assert.equal(await page.getByRole('button', { name: '一键导入', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '一键导出全部数据', exact: true }).isDisabled(), true)
    assert.equal(summaryCalls, 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
    await page.close()
  }
})
