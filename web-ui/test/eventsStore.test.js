import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useEventsStore } from '../src/stores/events.js'

function setup(t) {
  setActivePinia(createPinia())
  const store = useEventsStore()
  const requests = []
  t.mock.method(globalThis, 'fetch', (url) => new Promise(resolve => {
    requests.push({ url, reply: (data, status = 200) => resolve(Response.json(data, { status })) })
  }))
  store.activeEvents = [1, 2, 3, 4].map(id => ({ id, processing: false }))
  return { store, requests }
}

test('queued choices retain their caller and surface failure without blocking the next choice', async t => {
  const { store, requests } = setup(t)
  const first = store.makeChoice(1, 'A')
  const second = store.makeChoice(2, 'B')
  const third = store.makeChoice(3, 'C', 'draft')
  const rejected = assert.rejects(third, /生成失败/)
  const fourth = store.makeChoice(4, 'A')
  assert.equal(store.activeEvents[2]._queued, true)
  assert.equal(requests.length, 2)
  requests[0].reply({ event: { id: 1, processing: false } })
  await first
  assert.equal(requests.length, 3)
  requests[2].reply({ error: '生成失败' }, 500)
  await rejected
  assert.equal(requests.length, 4)
  requests[3].reply({ event: { id: 4, title: 'next', processing: false } })
  assert.equal((await fourth).event.title, 'next')
  requests[1].reply({ event: { id: 2, processing: false } })
  await second
  assert.equal(store.activeEvents[2].processing, false)
})

test('cancel only removes waiting choices and settles their promise', async t => {
  const { store, requests } = setup(t)
  const first = store.makeChoice(1, 'A')
  const second = store.makeChoice(2, 'A')
  const waiting = store.makeChoice(3, 'A')
  assert.equal(store.cancelQueuedChoice(1), false)
  assert.equal(store.activeEvents[0].processing, true)
  assert.equal(store.cancelQueuedChoice(3), true)
  assert.equal((await waiting).cancelled, true)
  requests[0].reply({ event: { id: 1 } })
  requests[1].reply({ event: { id: 2 } })
  await Promise.all([first, second])
  assert.equal(requests.length, 2)
})

test('undo locates the event again after the active list changes', async t => {
  const { store, requests } = setup(t)
  const pending = store.undoChoice(2)
  store.activeEvents.unshift({ id: 9, title: 'new story' })
  requests[0].reply({ event: { id: 2, title: 'previous branch' } })
  await pending
  assert.deepEqual(store.activeEvents.map(e => e.id), [9, 1, 2, 3, 4])
  assert.equal(store.activeEvents[2].title, 'previous branch')
})

test('choice failure rolls back only its own optimistic countdown', async t => {
  const { store, requests } = setup(t)
  const expires = new Date(Date.now() + 600000).toISOString()
  store.activeEvents[0].expires_at = expires
  const pending = store.makeChoice(1, 'A')
  const rejected = assert.rejects(pending, /失败/)
  requests[0].reply({ message: '失败' }, 500)
  await rejected
  assert.equal(store.activeEvents[0].expires_at, expires)
})

test('failed delete and dismiss keep data and reject to the UI', async t => {
  const { store, requests } = setup(t)
  for (const action of ['deleteEvent', 'dismissEvent']) {
    const failed = assert.rejects(store[action](1), /忙碌/)
    requests.at(-1).reply({ message: '忙碌' }, 409)
    await failed
    assert.equal(store.activeEvents[0].id, 1)
  }
})

test('reload clears old errors and background refresh does not mark stories read', async t => {
  const { store, requests } = setup(t)
  const first = store.loadEvents()
  requests[0].reply({ error: '离线' }, 503)
  await first
  assert.equal(store.loadError, '离线')
  const second = store.loadEvents()
  requests[1].reply({ active: [], history: [] })
  await second
  assert.equal(store.loadError, null)
  assert.equal(requests.length, 2)
})

test('a refresh arriving during load waits for a fresh snapshot', async t => {
  const { store, requests } = setup(t)
  const first = store.loadEvents()
  const second = store.loadEvents()
  requests[0].reply({ active: [{ id: 1 }], history: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 2)
  requests[1].reply({ active: [{ id: 2 }], history: [] })
  await Promise.all([first, second])
  assert.deepEqual(store.activeEvents.map(e => e.id), [2])
})

test('server refresh cannot unlock a locally pending choice', async t => {
  const { store, requests } = setup(t)
  const pending = store.makeChoice(1, 'A')
  const reload = store.loadEvents()
  requests[1].reply({ active: [{ id: 1, processing: false }], history: [] })
  await reload
  assert.equal(store.activeEvents[0].processing, true)
  assert.equal(await store.makeChoice(1, 'B'), null)
  assert.equal(requests.length, 2)
  requests[0].reply({ event: { id: 1 } })
  await pending
})

test('refresh removing a queued event settles its caller without sending a choice', async t => {
  const { store, requests } = setup(t)
  const first = store.makeChoice(1, 'A')
  const second = store.makeChoice(2, 'A')
  const queued = store.makeChoice(3, 'A')
  const reload = store.loadEvents()
  requests[2].reply({ active: [{ id: 1 }, { id: 2 }], history: [] })
  await reload
  assert.equal((await queued).cancelled, true)
  requests[0].reply({ event: { id: 1 } })
  requests[1].reply({ event: { id: 2 } })
  await Promise.all([first, second])
  assert.equal(requests.length, 3)
})
