import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, ref } from 'vue'
import { useDialogueEmojis } from '../src/composables/useDialogueEmojis.js'

const settle = () => new Promise(resolve => setImmediate(resolve))

function mount(t, fetchAssets) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = (url, options) => {
    calls.push(url)
    assert.equal(options.method, 'GET', 'checking prerequisites must never generate assets')
    assert.match(url, /^\/api\/characters\/\d+\/reaction-assets$/)
    return fetchAssets(url)
  }
  const id = ref(1), active = ref(true)
  let state
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
  const app = renderer.createApp({ setup() { state = useDialogueEmojis(() => id.value, () => active.value); return () => null } })
  app.mount({})
  t.after(() => { app.unmount(); globalThis.fetch = originalFetch })
  return { state, id, active, calls, app }
}

test('an avatar or an empty active sticker set cannot satisfy the emoji requirement', async t => {
  let emojis = []
  const { state, calls } = mount(t, () => Response.json({ characterId: 1, avatar_url: '/avatar.png', emojis }))
  await settle()
  assert.equal(state.checked.value, true)
  assert.equal(state.available.value, false)
  emojis = [{ key: '开心', url: ' ' }, { key: '委屈', url: null }]
  await state.refresh()
  assert.equal(state.available.value, false)
  emojis = [{ key: '开心', url: '/images/emoji/ready.png' }]
  await state.refresh()
  assert.equal(state.available.value, true)
  emojis = []
  await state.refresh()
  assert.equal(state.available.value, false, 'deleting stickers or activating an empty set must close the gate again')
  assert.equal(calls.length, 4)
})

test('switching characters rejects late responses and re-entry checks the current configuration', async t => {
  const pending = []
  const { state, id, active } = mount(t, () => new Promise(resolve => pending.push(resolve)))
  id.value = 2
  assert.equal(state.available.value, false)
  assert.equal(state.checked.value, false)
  pending[1](Response.json({ characterId: 2, emojis: [] }))
  await settle()
  pending[0](Response.json({ characterId: 1, emojis: [{ url: '/old.png' }] }))
  await settle()
  assert.equal(state.available.value, false)
  active.value = false
  active.value = true
  assert.equal(pending.length, 3)
  pending[2](Response.json({ characterId: 2, emojis: [{ url: '/new.png' }] }))
  await settle()
  assert.equal(state.available.value, true)
})

test('failed checks remain blocked and recover after a manual recheck', async t => {
  let fail = true
  const { state } = mount(t, () => fail ? Promise.reject(new Error('网络暂不可用')) : Response.json({ characterId: 1, emojis: [{ url: '/ready.png' }] }))
  await settle()
  assert.equal(state.checked.value, true)
  assert.equal(state.available.value, false)
  assert.equal(state.error.value, '网络暂不可用')
  fail = false
  await state.refresh()
  assert.equal(state.available.value, true)
  assert.equal(state.error.value, '')
  assert.equal(state.loading.value, false)
})

test('leaving the stage invalidates an in-flight check', async t => {
  let finish
  const { state, active } = mount(t, () => new Promise(resolve => { finish = resolve }))
  active.value = false
  finish(Response.json({ characterId: 1, emojis: [{ url: '/ready.png' }] }))
  await settle()
  assert.equal(state.available.value, false)
  assert.equal(state.checked.value, false)
})
