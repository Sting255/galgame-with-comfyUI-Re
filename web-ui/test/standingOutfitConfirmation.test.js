import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer } from 'vue'
import { useStandingOutfitConfirmation } from '../src/composables/useStandingOutfitConfirmation.js'

function fixture(t) {
  let state
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
  const app = renderer.createApp({ setup() { state = useStandingOutfitConfirmation(); return () => null } })
  app.mount({})
  t.after(() => app.unmount())
  return { state, app }
}
const missing = { sceneLabel: '私服', missingCharacters: [{ id: 1, name: '角色A' }] }

test('complete outfits continue without a modal; missing outfits wait for either explicit decision', async t => {
  const { state } = fixture(t)
  assert.equal(await state.confirmStandingOutfits(async () => ({ missingCharacters: [] })), undefined)
  assert.equal(state.outfitConfirmation.value.open, false)
  for (const policy of ['generate', 'fallback']) {
    let settled = false
    const pending = state.confirmStandingOutfits(async () => missing).then(result => { settled = true; return result })
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(state.outfitConfirmation.value.open, true)
    assert.deepEqual(state.outfitConfirmation.value.missingCharacters, missing.missingCharacters)
    state.chooseOutfitPolicy(policy)
    assert.equal(await pending, policy)
    assert.equal(state.outfitConfirmation.value.open, false)
  }
})

test('cancel and unmount settle the pending request without choosing a generation path', async t => {
  const { state, app } = fixture(t)
  let pending = state.confirmStandingOutfits(async () => missing)
  await Promise.resolve()
  state.chooseOutfitPolicy()
  assert.equal(await pending, null)
  pending = state.confirmStandingOutfits(async () => missing)
  await Promise.resolve()
  app.unmount()
  assert.equal(await pending, null)
})

test('closing or switching character while preflight is pending cannot reopen a stale confirmation', async t => {
  const { state } = fixture(t)
  let release
  const pending = state.confirmStandingOutfits(() => new Promise(resolve => { release = resolve }))
  state.chooseOutfitPolicy()
  release(missing)
  assert.equal(await pending, null)
  assert.equal(state.outfitConfirmation.value.open, false)
})

test('preflight errors do not default to any generation policy', async t => {
  const { state } = fixture(t)
  await assert.rejects(state.confirmStandingOutfits(async () => { throw new Error('network failed') }), /network failed/)
  assert.equal(state.outfitConfirmation.value.open, false)
})
