import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useEventsStore } from '../src/stores/events.js'

test('choice countdown only previews a five-minute extension in the final 15 minutes and uses the server result', async t => {
  const now = Date.parse('2026-10-13T03:00:00Z')
  t.mock.timers.enable({ apis: ['Date'], now })
  setActivePinia(createPinia())
  const store = useEventsStore()
  let reply
  t.mock.method(globalThis, 'fetch', async () => new Promise(resolve => { reply = resolve }))

  for (const id of [1, 'town:2']) {
    for (const seconds of [1200, 901, 900, 899, 0, -1]) {
      const expires_at = new Date(now + seconds * 1000).toISOString()
      store.activeEvents = [{ id, expires_at, processing: false }]
      const pending = store.makeChoice(id, 'A')
      const expected = new Date(now + (seconds + (seconds > 0 && seconds <= 900 ? 300 : 0)) * 1000).toISOString()
      assert.equal(store.activeEvents[0].expires_at, expected)

      // 服务端时间始终覆盖本地预估（包含客户端/服务端跨过临界点的情况）。
      reply({ ok: true, text: async () => JSON.stringify({ concluded: false, event: { id, expires_at, processing: false } }) })
      await pending
      assert.equal(store.activeEvents[0].expires_at, expires_at)
    }
  }
})
