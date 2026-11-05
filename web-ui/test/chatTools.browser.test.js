import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('聊天互动：双主题窄屏、群聊选人、面板互斥与切会话收起', {
  skip: !process.env.PLAYWRIGHT_MODULE, timeout: 120000,
}, async t => {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
  const { createServer } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const requests = []
  let toyFailure = false
  let advanceFailure = false
  let emptyWorn = false
  let sleepMode = 'sleep'
  let scheduleFailure = false
  const harness = `
    import {createApp,h} from 'vue';import {createPinia} from 'pinia';
    import {createRouter,createWebHistory} from 'vue-router';
    import Chat from '/src/views/ChatView.vue';import Group from '/src/views/GroupChatView.vue';
    import {useChatStore} from '/src/stores/chat.js';import {useGroupsStore} from '/src/stores/groups.js';
    import {useSettingsStore} from '/src/stores/settings.js';import {useScheduleStore} from '/src/stores/schedule.js';
    import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/components.css';
    const group=new URL(location.href).searchParams.get('mode')==='group';
    const app=createApp({render:()=>h(group?Group:Chat)});const pinia=createPinia();app.use(pinia);
    const router=createRouter({history:createWebHistory(),routes:[{path:'/:prefix/:id',component:group?Group:Chat}]});app.use(router);
    const characters=[{id:1,name:'fixture',display_name:'测试角色',base_prompt:'合成资料',affinity:10},{id:2,name:'fixture2',display_name:'名字较长的另一位测试角色',base_prompt:'合成资料',affinity:10}];
    const chat=useChatStore();chat.characters=characters;chat.activeCharId=1;
    chat.messages=[{id:1,role:'assistant',content:'今天想聊些什么？',created_at:'2026-11-05T08:00:00Z'},{id:2,role:'user',content:'聊聊今天的安排吧。',created_at:'2026-11-05T08:01:00Z'}];
    chat.guesses={a:'聊聊今天的安排',b:'一起散步怎么样'};
    chat.loadCharacters=async()=>{};chat.selectChar=async id=>{chat.activeCharId=id};
    const groups=useGroupsStore();groups.groups=[{id:1,name:'朋友们',members:characters},{id:2,name:'另一个群',members:characters}];
    groups.activeGroupId=1;groups.loadGroups=async()=>{};groups.selectGroup=async id=>{groups.activeGroupId=Number(id)};groups.connectSSE=()=>{};
    const settings=useSettingsStore();settings.loadComfyConfig=async()=>{};settings.hasApiKey=true;
    window.refreshSchedule=()=>useScheduleStore().fetchOverview(true);
    window.completeReply=async()=>{chat.streaming=true;groups.sending=true;await import('vue').then(v=>v.nextTick());chat.streaming=false;groups.sending=false};
    window.switchConversation=()=>{if(group)groups.activeGroupId=2;else chat.activeCharId=2};
    app.provide('isMobile',innerWidth<768);app.provide('toggleMobileSidebar',()=>{});
    app.provide('toast',()=>{});app.provide('confirm',async()=>true);
    await router.isReady();app.mount('#app');`
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [vue(), { name: 'chat-tools-acceptance', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/__chat-ui/')) {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module">${harness}</script></body></html>`)); return
      }
      if (!req.url.startsWith('/api/')) return next()
      requests.push(req.url)
      if ((toyFailure && /\/toys(?:\?|$)/.test(req.url)) || (advanceFailure && req.url.includes('/intimate-actions/')) || (scheduleFailure && req.url === '/api/schedule')) {
        res.statusCode = 503;res.setHeader('Content-Type', 'application/json');res.end(JSON.stringify({ error: '测试服务暂不可用' }));return
      }
      let data = { ok: true, enabled: false }
      if (/\/toys(?:\?|$)/.test(req.url)) data = { unlocked: true, worn: emptyWorn ? [] : [{ toyKey: 'thigh_vibe', intensity: 1, mode: 'steady', status: 'worn' }], catalog: [{ key: 'collar', gate: { allowed: false, message: '测试条件未满足' } }] }
      if (req.url.includes('/touch/actions')) data = { actions: [{ key: 'pat_head', label: '摸头', level: 1, levelLabel: '日常' }, { key: 'hug', label: '拥抱', level: 2, levelLabel: '亲近' }], levels: { 1: '日常', 2: '亲近' }, gate: { pat_head: { allowed: true }, hug: { allowed: false, message: '测试条件未满足' } } }
      if (req.url.includes('/touch/state')) data = { states: {} }
      if (req.url.includes('/intimate')) data = { enabled: true, state: {}, actions: [{ key: 'position', label: '切换', available: true }], positionOptions: [{ key: 'fixture', label: '测试选项', preferred: true }] }
      if (req.url === '/api/config') data = { llm: { hasApiKey: true }, comfy: {}, features: {}, groupChat: {} }
      if (req.url.includes('/schedule')) data = { schedules: [] }
      if (req.url.includes('/wake-up-phone')) { sleepMode = 'temporary';data = { success: true } }
      if (req.url === '/api/schedule') data = { characters: [
        { id: '1', display_name: '测试角色', is_sleeping: sleepMode === 'sleep', sleep_kind: sleepMode === 'nap' ? 'nap' : 'main', is_temp_woken: sleepMode === 'temporary' },
        { id: 2, display_name: '名字较长的另一位测试角色', is_sleeping: false },
      ] }
      res.setHeader('Content-Type', 'application/json');res.end(JSON.stringify(data))
    }) } }], server: { host: '127.0.0.1', port: 0 } })
  t.after(() => server.close());await server.listen()
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined })
  t.after(() => browser.close())
  for (const mode of ['private', 'group']) for (const width of [1440, 360, 320]) {
    sleepMode = 'sleep';scheduleFailure = false
    const theme = width === 1440 ? 'warm' : 'dark'
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    page.setDefaultTimeout(10000)
    const errors = [];page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(theme => { localStorage.setItem('linshe_theme_mode', theme);document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', theme)) }, theme)
    await page.goto(`${server.resolvedUrls.local[0]}__chat-ui/1?mode=${mode}`)
    const toolbar = page.getByRole('group', { name: '聊天互动' })
    await toolbar.waitFor()
    const sleep = page.locator('.chat-header .chat-sleep-status')
    await sleep.getByText(mode === 'private' ? '睡眠中' : '1 人睡眠中', { exact: true }).waitFor()
    const sleepBounds = await sleep.boundingBox()
    assert.ok(sleepBounds.width > 20 && sleepBounds.x >= 0 && sleepBounds.x + sleepBounds.width <= width, '睡眠状态在页头可见且不溢出')
    if (mode === 'private') {
      assert.ok(await page.locator('.sleep-zzz').count() > 0)
      await page.getByTitle('叫醒角色', { exact: true }).click()
    } else {
      sleepMode = 'temporary';await page.evaluate(() => window.completeReply())
    }
    await sleep.getByText(mode === 'private' ? '暂时清醒' : '1 人暂时清醒', { exact: true }).waitFor()
    if (mode === 'private') {
      assert.equal(await page.getByTitle('叫醒角色', { exact: true }).count(), 0)
      assert.equal(await page.locator('.sleep-zzz').count(), 0)
    }
    sleepMode = 'nap';await page.evaluate(() => window.completeReply())
    await sleep.getByText(mode === 'private' ? '小憩中' : '1 人小憩中', { exact: true }).waitFor()
    scheduleFailure = true;await page.evaluate(() => window.refreshSchedule())
    await sleep.getByText('睡眠状态待更新', { exact: true }).waitFor()
    scheduleFailure = false;sleepMode = 'awake'
    await sleep.getByRole('button', { name: '刷新睡眠状态', exact: true }).click()
    await sleep.getByText(mode === 'private' ? '清醒' : '全员清醒', { exact: true }).waitFor()
    sleepMode = 'sleep';await page.evaluate(() => window.refreshSchedule())
    await sleep.getByText(mode === 'private' ? '睡眠中' : '1 人睡眠中', { exact: true }).waitFor()
    if (process.env.CHAT_UI_SCREENSHOT_DIR) {
      await page.waitForFunction(() => !document.querySelector('.sleep-status-enter-active'))
      await page.screenshot({ path: join(process.env.CHAT_UI_SCREENSHOT_DIR, `${mode}-${width}-sleep.png`) })
    }
    const input = page.locator('.chat-input');await input.blur()
    for (const label of ['动作', '玩具', '亲密']) {
      const button = toolbar.getByRole('button', { name: label, exact: true });await button.waitFor()
      const box = await button.boundingBox();assert.ok(box.x >= 0 && box.x + box.width <= width, `${mode} ${width} ${label} 溢出`)
      assert.equal(await button.locator('svg').count(), 1, '三个入口均以图标呈现')
      assert.doesNotMatch(await button.innerText(), /动作|玩具|亲密/, '入口不再展开文字胶囊')
      assert.ok(Math.abs(box.width - box.height) < 1, '入口保持圆形比例')
      assert.ok(await button.getAttribute('title'), '图标保留悬停名称')
      if (width < 768) assert.ok(box.height >= 44 && box.width >= 44, '触屏入口至少 44px')
    }
    assert.ok((await input.boundingBox()).width >= 120, '输入区不应被功能按钮挤窄')
    const inputBounds = await input.boundingBox()
    const toolbarBounds = await toolbar.boundingBox()
    assert.ok(toolbarBounds.y >= inputBounds.y + inputBounds.height, '工具栏在输入框下方')
    if (mode === 'private') {
      const guesses = await page.locator('.guesses-row').boundingBox()
      assert.ok(guesses.y + guesses.height <= inputBounds.y, '对话推测独占输入区上方')
    }
    await toolbar.getByRole('button', { name: '动作', exact: true }).focus()
    await page.keyboard.press('Enter')
    if (mode === 'group') {
      await page.getByRole('listbox', { name: '选择动作对象' }).waitFor()
      await page.getByRole('option').filter({ hasText: '测试角色' }).first().click()
    }
    const touch = page.getByRole('dialog', { name: '动作', exact: true });await touch.waitFor()
    const touchBounds = await touch.boundingBox();assert.ok(touchBounds.x >= 0 && touchBounds.x + touchBounds.width <= width)
    await touch.getByRole('tab', { name: '亲近', exact: true }).click()
    assert.equal(await touch.locator('.touch-card').count(), 1)
    assert.match(await touch.locator('.touch-card-status').textContent(), /测试条件未满足/)
    await touch.getByRole('tab', { name: '全部', exact: true }).click()
    assert.equal(await touch.locator('.touch-card').count(), 2)
    if (process.env.CHAT_UI_SCREENSHOT_DIR && width === 360) {
      await page.waitForFunction(() => !document.querySelector('.touch-overlay-enter-active'))
      await page.screenshot({ path: join(process.env.CHAT_UI_SCREENSHOT_DIR, `${mode}-actions.png`) })
    }
    advanceFailure = true
    await toolbar.getByRole('button', { name: '亲密', exact: true }).click()
    await touch.waitFor({ state: 'detached' })
    const advance = page.locator('.ia-panel');await advance.waitFor()
    await advance.getByRole('alert').waitFor()
    advanceFailure = false
    await advance.getByRole('button', { name: '重试', exact: true }).click()
    await advance.getByRole('alert').waitFor({ state: 'detached' })
    assert.equal(await advance.getByRole('button', { name: '测试选项', exact: true }).count(), 0, '选项默认收起，优先显示操作')
    await advance.getByRole('button', { name: /^选择体位/ }).click()
    await advance.getByRole('button', { name: '测试选项', exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('.ia-panel .collapse-enter-active'))
    if (process.env.CHAT_UI_SCREENSHOT_DIR && width === 360) {
      await page.screenshot({ path: join(process.env.CHAT_UI_SCREENSHOT_DIR, `${mode}-advance.png`) })
    }
    await advance.getByRole('button', { name: /^收起选择/ }).click()
    const advanceBounds = await advance.boundingBox();assert.ok(advanceBounds.y >= 0 && advanceBounds.x + advanceBounds.width <= width)
    await page.keyboard.press('Escape');await advance.waitFor({ state: 'detached' })
    toyFailure = true
    await toolbar.getByRole('button', { name: '玩具', exact: true }).click()
    await page.locator('.toy-panel').waitFor()
    const toy = page.locator('.toy-panel')
    await toy.getByRole('alert').waitFor()
    toyFailure = false;emptyWorn = true
    await toy.getByRole('button', { name: '重试', exact: true }).click()
    await toy.getByRole('alert').waitFor({ state: 'detached' })
    await toy.getByRole('tab', { name: '已佩戴 0', exact: true }).waitFor()
    emptyWorn = false
    await toy.getByRole('tab', { name: '背包', exact: true }).click()
    assert.equal(await toy.locator('.toy-gate-reason').isVisible(), true, '拒绝原因在卡片中可见，无需悬停')
    if (mode === 'group') assert.match(await page.locator('.modal-title').textContent(), /测试角色/)
    await page.keyboard.press('Escape');await page.locator('.toy-panel').waitFor({ state: 'detached' })
    await toolbar.getByRole('button', { name: '玩具', exact: true }).click()
    await toy.getByRole('tab', { name: '已佩戴 1', exact: true }).click()
    await toy.getByRole('button', { name: '模式与曲线', exact: true }).click()
    await toy.getByRole('tab', { name: '持续', exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('.toy-panel .collapse-enter-active'))
    if (process.env.CHAT_UI_SCREENSHOT_DIR && width === 360) {
      await page.screenshot({ path: join(process.env.CHAT_UI_SCREENSHOT_DIR, `${mode}-toys.png`) })
    }
    await toy.getByRole('button', { name: '收起设置', exact: true }).click()
    await page.keyboard.press('Escape');await toy.waitFor({ state: 'detached' })
    await toolbar.getByRole('button', { name: '动作', exact: true }).click();await touch.waitFor()
    await page.evaluate(() => window.switchConversation());await touch.waitFor({ state: 'detached' })
    if (mode === 'group') {
      await toolbar.getByRole('button', { name: '选择互动对象' }).click()
      await page.getByRole('listbox', { name: '选择动作对象' }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('listbox', { name: '选择动作对象' }).waitFor({ state: 'detached' })
      await toolbar.getByRole('button', { name: '玩具', exact: true }).click()
      const target = page.getByRole('option').filter({ hasText: '名字较长' })
      await page.keyboard.press('ArrowDown')
      assert.equal(await target.evaluate(el => el === document.activeElement), true, '选人支持方向键且自动取得焦点')
      await page.keyboard.press('Enter')
      await page.locator('.toy-panel').waitFor()
      assert.match(await page.locator('.modal-title').textContent(), /名字较长/)
      await page.keyboard.press('Escape');await page.locator('.toy-panel').waitFor({ state: 'detached' })
      await toolbar.getByRole('button', { name: '动作', exact: true }).click()
      await touch.waitFor()
      const close = await page.getByRole('button', { name: '关闭动作面板' }).boundingBox()
      assert.ok(close.x >= 0 && close.x + close.width <= width)
    }
    assert.deepEqual(errors, [], `${mode} ${width} 页面异常`)
    await page.close()
  }
  assert.equal(requests.some(url => url.startsWith('/api/context/')), false)
  assert.doesNotMatch(readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8'), /ContextUsagePanel|ctx-usage|contextPanelClass/)
})
