import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useScheduleStore } from '../src/stores/schedule.js'
import { startUnifiedStream, stopUnifiedStream } from '../src/stores/unifiedStream.js'
import { describeScheduleSleep, summarizeScheduleSleep } from '../src/utils/scheduleSleep.js'

function fixture(t) {
  setActivePinia(createPinia())
  const store = useScheduleStore()
  t.after(() => store.$dispose())
  t.mock.method(console, 'error', () => {})
  const requests = []
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => requests.push((data, status = 200) => resolve(Response.json(data, { status })))))
  return { store, requests }
}

test('an old sleeping response cannot overwrite the just-woken overview', async t => {
  const { store, requests } = fixture(t)
  const old = store.fetchOverview()
  const wake = store.fetchOverview(true)
  requests[1]({ characters: [{ id: 1, is_sleeping: false, is_temp_woken: true }] })
  await wake
  assert.equal(store.loading, true, 'visible request still owns its loading indicator')
  requests[0]({ characters: [{ id: 1, is_sleeping: true }] })
  await old
  assert.equal(describeScheduleSleep(store.characters[0]), '暂时清醒')
  assert.equal(store.loading, false)
  assert.equal(store.overviewLoaded, true)
})

test('a late failure cannot mark a newer successful overview as stale', async t => {
  const { store, requests } = fixture(t)
  const old = store.fetchOverview(true)
  const newer = store.fetchOverview(true)
  requests[1]({ characters: [{ id: 1, is_sleeping: false }] })
  await newer
  requests[0]({ error: '旧请求失败' }, 503)
  await old
  assert.equal(store.overviewError, null)
  assert.equal(store.characters[0].is_sleeping, false)
})

test('failed and malformed refreshes preserve the snapshot and allow recovery', async t => {
  const { store, requests } = fixture(t)
  store.characters = [{ id: 1, is_sleeping: true }]
  for (const [data, status, message] of [[{ error: '暂时离线' }, 503, '暂时离线'], [{}, 200, '日程状态格式异常']]) {
    const request = store.fetchOverview(true)
    requests.at(-1)(data, status)
    await request
    assert.equal(store.overviewError, message)
    assert.equal(store.characters[0].is_sleeping, true)
  }
  const retry = store.fetchOverview(true)
  requests.at(-1)({ characters: [] })
  await retry
  assert.equal(store.overviewError, null)
  assert.deepEqual(store.characters, [])
})

test('normal sleep distinguishes naps, temporary waking, missing members and awake groups', () => {
  assert.equal(describeScheduleSleep({ is_sleeping: true, sleep_kind: 'main', is_temp_woken: true }), '暂时清醒')
  assert.equal(describeScheduleSleep({ is_sleeping: false, sleep_kind: 'nap' }), '小憩中')
  assert.equal(summarizeScheduleSleep([null]), '状态未知')
  assert.equal(summarizeScheduleSleep([], true), '状态未知')
  assert.equal(summarizeScheduleSleep([{ is_sleeping: false }, null], true), '1 人状态未知')
  assert.equal(summarizeScheduleSleep([{ is_sleeping: true }, { sleep_kind: 'nap' }, { is_sleeping: true }], true), '2 人睡眠中 · 1 人小憩中')
  assert.equal(summarizeScheduleSleep([{ is_sleeping: false }], true), '全员清醒')
})

test('schedule changes, waking and SSE reconnect all refresh; disposed stores unsubscribe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  setActivePinia(createPinia())
  const store = useScheduleStore()
  let controller
  let requests = 0
  const stream = new ReadableStream({ start(value) { controller = value } })
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/stream')) return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    requests++
    return Response.json({ characters: [{ id: 1, is_sleeping: requests === 1 }] })
  })
  t.after(() => { stopUnifiedStream();controller.close();store.$dispose() })
  startUnifiedStream()
  const dispatch = async event => {
    controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: {}\n\n`))
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  }
  for (const [index, event] of ['connected', 'schedule_state_change', 'schedule_changed', 'connected'].entries()) {
    await dispatch(event)
    assert.equal(requests, index + 1)
  }
  assert.equal(store.characters[0].is_sleeping, false)
  store.$dispose()
  await dispatch('schedule_changed')
  assert.equal(requests, 4)
})
