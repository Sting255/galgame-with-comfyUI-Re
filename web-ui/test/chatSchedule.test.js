import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useScheduleStore } from '../src/stores/schedule.js'
import { useChatSchedule } from '../src/composables/useChatSchedule.js'

test('chat refresh follows completion, focus, visibility and conversation; unmount releases all timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const previous = { window: globalThis.window, document: globalThis.document }
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  setActivePinia(createPinia())
  const store = useScheduleStore()
  const fetch = t.mock.method(store, 'fetchOverview', async () => {})
  const id = ref(1), busy = ref(false), revision = ref(0)
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
  const app = renderer.createApp({ setup() { useChatSchedule(() => id.value, () => busy.value, () => revision.value); return () => null } })
  let unmounted = false
  t.after(() => { if (!unmounted) app.unmount(); store.$dispose(); Object.assign(globalThis, previous) })
  app.mount({})
  t.mock.timers.tick(150)
  assert.equal(fetch.mock.callCount(), 1)
  busy.value = true; revision.value++; await nextTick(); t.mock.timers.tick(150)
  assert.equal(fetch.mock.callCount(), 1)
  busy.value = false; await nextTick(); t.mock.timers.tick(150)
  assert.equal(fetch.mock.callCount(), 2)
  id.value = 2; await nextTick(); t.mock.timers.tick(150)
  assert.equal(fetch.mock.callCount(), 3)
  document.hidden = true
  t.mock.timers.tick(30000); t.mock.timers.tick(150)
  assert.equal(fetch.mock.callCount(), 3)
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))
  t.mock.timers.tick(150)
  assert.equal(fetch.mock.callCount(), 4, 'focus and visibility events coalesce')
  t.mock.timers.tick(30000); t.mock.timers.tick(150)
  assert.equal(fetch.mock.callCount(), 5)
  window.dispatchEvent(new Event('focus'))
  app.unmount(); unmounted = true
  window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))
  t.mock.timers.tick(60000)
  assert.equal(fetch.mock.callCount(), 5)
})
