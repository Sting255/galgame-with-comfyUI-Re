import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageTaskRecovery } from '../src/utils/imageTaskRecovery.js'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../src/stores/chat.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

test('running → done：只开一条查询链并返回可显示的图片', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const done = []
  const tracker = createImageTaskRecovery({
    fetchTask: async () => ++calls === 1 ? { status: 'running' } : { status: 'done', output_paths: ['/images/late.png'] },
    isCurrent: () => true, onDone: (...args) => done.push(args), onError: assert.fail,
  })
  t.after(() => tracker.stopAll())
  tracker.start(1, 'chat'); tracker.start(1, 'chat')
  await flush()
  assert.equal(calls, 1)
  t.mock.timers.tick(2000); await flush()
  assert.deepEqual(done, [[1, [{ url: '/images/late.png' }], 'chat']])
  t.mock.timers.tick(600000); await flush()
  assert.equal(calls, 2)
})

test('失败与缺图任务进入明确终态；暂时网络错误可以恢复', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const errors = [], done = []
  let calls = 0
  const tracker = createImageTaskRecovery({
    fetchTask: async id => {
      if (id === 1) return { status: 'failed', error: '服务离线' }
      if (id === 2) return { status: 'done', output_paths: [] }
      if (++calls === 1) throw new Error('网络暂时中断')
      return { status: 'done', output_paths: ['/images/recovered.png'] }
    },
    isCurrent: () => true, onDone: id => done.push(id), onError: (id, error) => errors.push([id, error]),
  })
  t.after(() => tracker.stopAll())
  tracker.start(1); tracker.start(2); tracker.start(3)
  await flush(); t.mock.timers.tick(2000); await flush()
  assert.deepEqual(errors, [[1, '服务离线'], [2, '图片任务已结束，但没有可用图片']])
  assert.deepEqual(done, [3])
})

test('切角色或销毁后丢弃在途响应，终止请求与定时器', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release, signal
  const tracker = createImageTaskRecovery({
    fetchTask: (_id, options) => { signal = options.signal; return new Promise(resolve => { release = resolve }) },
    isCurrent: () => true, onDone: assert.fail, onError: assert.fail,
  })
  tracker.start(1)
  tracker.stopAll()
  assert.equal(signal.aborted, true)
  release({ status: 'done', output_paths: ['/images/stale.png'] })
  await flush(); t.mock.timers.tick(600000); await flush()
})

test('长时间未完成和连续请求失败都能结束等待', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const errors = []
  const tracker = createImageTaskRecovery({
    fetchTask: async id => { if (id === 2) throw new Error('离线'); return { status: 'running' } },
    isCurrent: () => true, onDone: assert.fail, onError: (id, error) => errors.push([id, error]), maxWaitMs: 7000,
  })
  t.after(() => tracker.stopAll())
  tracker.start(1); tracker.start(2)
  await flush(); t.mock.timers.tick(2000); await flush(); t.mock.timers.tick(2000); await flush()
  assert.deepEqual(errors, [[2, '离线']])
  t.mock.timers.tick(3000); await flush()
  assert.equal(errors[1][0], 1)
  assert.match(errors[1][1], /稍后重新打开/)
})

test('真实 chat store：SSE 提前结束，后台图片仍补回气泡和转录', async t => {
  const originalFetch = globalThis.fetch
  let controller
  const requests = []
  globalThis.fetch = async url => {
    requests.push(url)
    if (url.endsWith('/chat')) return new Response(new ReadableStream({ start(c) { controller = c } }))
    if (url.endsWith('/images/tasks/123/status')) return Response.json({ status: 'done', output_paths: ['/images/late.png'] })
    return Response.json({ characters: [{ id: 1 }] })
  }
  setActivePinia(createPinia())
  const chat = useChatStore()
  t.after(() => { chat.$dispose(); globalThis.fetch = originalFetch })
  chat.activeCharId = 1
  const send = chat.sendMessage('你好', 'smart', false, { galgameMode: true })
  const emit = (event, data) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  emit('token', { content: '你好' })
  emit('msg_saved', { id: 12, role: 'assistant', content: '你好' })
  emit('generate_start', { taskId: 123 })
  emit('response_end', {})
  controller.close(); await send; await flush()
  const message = chat.messages.find(m => m.genId === 123)
  assert.equal(message.genStatus, 'done')
  assert.deepEqual(message.images, [{ url: '/images/late.png' }])
  assert.equal(chat.streaming, false)
  assert.equal(chat.dialogueRevision, 1)
  assert.ok(requests.includes('/api/images/tasks/123/status'))
})
