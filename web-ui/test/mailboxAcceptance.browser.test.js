import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

test('信箱双入口：失败重投、刷新详情、删除冲突和发送中保护草稿', { skip: !process.env.PLAYWRIGHT_MODULE, timeout: 120000 }, async t => {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
  const { createServer } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  let letters = [], retryFailure = true, deleteFailure = true, pendingSend = null, sends = 0, sendArrived
  const harness = `
    import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';
    import {createRouter,createWebHistory} from 'vue-router';
    import Mailbox from '/src/views/MailboxView.vue';import Modal from '/src/components/MailboxModal.vue';
    import {useMailboxStore} from '/src/stores/mailbox.js';import {useChatStore} from '/src/stores/chat.js';
    import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/components.css';
    const mode=new URL(location.href).searchParams.get('mode');
    const characters=[{id:1,name:'fixture',display_name:'测试收信人',base_prompt:'合成资料'}];
    const app=createApp({setup(){const visible=ref(true);return ()=>mode==='modal'?h(Modal,{visible:visible.value,characters,onClose:()=>visible.value=false}):h(Mailbox)}});
    app.use(createPinia());const router=createRouter({history:createWebHistory(),routes:[{path:'/:pathMatch(.*)*',component:Mailbox}]});app.use(router);
    useChatStore().characters=characters;window.mailbox=useMailboxStore();window.notices=[];
    app.provide('toast',(text,type)=>window.notices.push({text,type}));app.provide('isMobile',innerWidth<768);
    await router.isReady();app.mount('#app');`
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), plugins: [vue(), {
    name: 'mailbox-acceptance', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/__mailbox')) {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module">${harness}</script></body></html>`));return
      }
      if (!req.url.startsWith('/api/')) return next()
      const respond = (data, status = 200) => { res.statusCode = status;res.setHeader('Content-Type', 'application/json');res.end(JSON.stringify(data)) }
      if (req.url.startsWith('/api/mailbox?')) return respond({ letters })
      if (req.url === '/api/mailbox/unread') return respond({ unread: 0, processing: 0 })
      if (req.url.endsWith('/retry')) {
        if (retryFailure) return respond({ error: '测试重投失败' }, 503)
        letters[0] = { ...letters[0], status: 'pending', retry_count: 0 }
        return respond({ letter: letters[0] })
      }
      if (req.method === 'DELETE') {
        if (deleteFailure) return respond({ error: '这封信正在回信中，请稍后再删除' }, 409)
        const id = Number(req.url.split('/').at(-1));letters = letters.filter(l => l.id !== id)
        return respond({ ok: true })
      }
      if (req.url === '/api/mailbox/send') {
        let body = '';for await (const chunk of req) body += chunk
        const payload = JSON.parse(body);sends++
        pendingSend = success => {
          if (!success) return respond({ error: '测试寄送失败，正文已保留' }, 503)
          const letter = { ...letters[0], id: 9, character_id: payload.character_id, content: payload.content, status: 'pending' }
          letters.unshift(letter);respond({ letter })
        }
        sendArrived?.()
        return
      }
      respond({ ok: true, enabled: false })
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  t.after(() => server.close());await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined })
  t.after(() => browser.close())
  for (const mode of ['page', 'modal']) for (const width of [1440, 360]) {
    letters = [1, 2].map(id => ({ id, character_id: 1, display_name: '测试收信人', direction: 'user_to_char', status: id === 1 ? 'failed' : 'pending', retry_count: 5, content: `合成原信${id}`, created_at: '2026-11-05T08:00:00Z' }))
    retryFailure = true;deleteFailure = true;pendingSend = null;sends = 0
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    page.setDefaultTimeout(10000)
    const errors = [];page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(theme => document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', theme)), width === 360 ? 'dark' : 'warm')
    await page.goto(`${server.resolvedUrls.local[0]}__mailbox?mode=${mode}`)
    await page.locator('.letter-card').filter({ hasText: '合成原信1' }).click()
    const retry = page.getByRole('button', { name: '重新投递', exact: true })
    await retry.click()
    await page.waitForFunction(() => window.notices.some(n => n.text === '测试重投失败'))
    const retryBounds = await retry.boundingBox()
    assert.ok(retryBounds.x >= 0 && retryBounds.x + retryBounds.width <= width, `${mode} ${width}: 重投按钮超出视口 ${JSON.stringify(retryBounds)}`)
    assert.equal(await retry.isVisible(), true)
    retryFailure = false;await retry.click()
    await retry.waitFor({ state: 'detached' })
    await page.waitForFunction(() => window.notices.some(n => n.type === 'success'))
    letters[0] = { ...letters[0], status: 'processing' };await page.evaluate(() => window.mailbox.fetchLetters())
    const detail = page.locator(mode === 'page' ? '.detail-inner' : '.detail-panel')
    await detail.getByText('正在等待角色回信...', { exact: true }).waitFor()
    assert.equal(await detail.getByRole('button', { name: '删除信件', exact: true }).isDisabled(), true)
    letters[0] = { ...letters[0], status: 'completed', direction: 'char_to_user', reply_content: '刷新后的回信正文' }
    await page.evaluate(() => window.mailbox.fetchLetters())
    await detail.getByText('刷新后的回信正文', { exact: true }).waitFor()
    await detail.getByRole('button', { name: '删除信件', exact: true }).click()
    await page.locator('.confirm-overlay').getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => window.notices.some(n => n.text.includes('稍后再删除')))
    assert.equal(await detail.getByText('刷新后的回信正文', { exact: true }).isVisible(), true)
    deleteFailure = false
    await detail.getByRole('button', { name: '删除信件', exact: true }).click()
    await page.locator('.confirm-overlay').getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => !window.mailbox.letters.some(l => l.id === 1))
    await page.getByRole('button', { name: mode === 'page' ? '写信' : '开始写一封信', exact: true }).click()
    await page.locator(mode === 'page' ? '.picker-char' : '.char-card').first().click()
    const input = page.locator('.paper-textarea');await input.fill('寄送失败后仍要保留的正文')
    for (const success of [false, true]) {
      const received = new Promise(resolve => { sendArrived = resolve })
      await page.getByRole('button', { name: '寄出', exact: true }).click()
      await received
      await page.waitForFunction(() => document.querySelector('.paper-textarea')?.disabled)
      assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: mode === 'page' ? '写信' : '开始写一封信', exact: true }).isDisabled(), true)
      assert.ok(pendingSend);pendingSend(success);pendingSend = null
      if (!success) {
        await page.waitForFunction(() => window.notices.some(n => n.text.includes('测试寄送失败')))
        assert.equal(await input.inputValue(), '寄送失败后仍要保留的正文')
        assert.equal(await input.isEnabled(), true)
        if (process.env.MAILBOX_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.MAILBOX_SCREENSHOT_DIR, `${mode}-${width}.png`) })
      }
    }
    await input.waitFor({ state: 'detached' })
    assert.equal(await page.getByRole('button', { name: mode === 'page' ? '写信' : '开始写一封信', exact: true }).isEnabled(), true)
    assert.equal(sends, 2)
    assert.equal(await page.evaluate(() => window.mailbox.letters.filter(l => l.id === 9).length), 1)
    assert.deepEqual(errors, [])
    await page.close()
  }
})
