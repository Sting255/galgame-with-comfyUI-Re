import test from 'node:test'
import assert from 'node:assert/strict'
import { useLlmProfiles } from '../src/composables/useLlmProfiles.js'

function fixture(overrides = {}) {
  const notices = [], applied = [], calls = []
  const profiles = [{ id: 'a', name: '个人' }, { id: 'b', name: '备用' }]
  const manager = useLlmProfiles({
    api: {
      activateLlmProfile: async id => { calls.push(id); return { ok: true, profiles, activeProfileId: id, llmConfig: { model: id } } },
      deleteLlmProfile: async id => ({ ok: true, profiles: profiles.filter(p => p.id !== id), activeProfileId: 'a' }),
      addLlmProfile: async name => ({ ok: true, profiles: [...profiles, { id: 'c', name }], activeProfileId: 'a' }),
      ...overrides.api,
    },
    notify: (...args) => notices.push(args), applyConfig: config => applied.push(config),
    confirm: async () => true, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'api')),
  })
  manager.load({ llmProfiles: profiles, activeLlmProfileId: 'a' })
  return { ...manager, notices, applied, calls }
}

test('cancelled dirty switch keeps profile and draft without a request', async () => {
  const ui = fixture({ isDirty: () => true, confirm: async () => false })
  assert.equal(await ui.switchProfile('b'), false)
  assert.equal(ui.activeId.value, 'a')
  assert.deepEqual(ui.calls, [])
  assert.deepEqual(ui.applied, [])
  assert.equal(ui.busy.value, false)
})

test('one lock covers confirmation, mutation and post-activation refresh', async () => {
  let release
  const ui = fixture({ refreshFeatures: () => new Promise(resolve => { release = resolve }) })
  const switching = ui.switchProfile('b')
  while (!release) await Promise.resolve()
  assert.equal(ui.busy.value, true)
  assert.equal(await ui.addProfile('重复'), false)
  assert.equal(await ui.removeProfile('a'), false)
  assert.equal(await ui.switchProfile('a'), false)
  release()
  assert.equal(await switching, true)
  assert.equal(ui.busy.value, false)
  assert.deepEqual(ui.calls, ['b'])
})

test('activation rejection preserves old selection and draft, unlocks for retry', async () => {
  const ui = fixture({ api: { activateLlmProfile: async () => ({ ok: false, error: '写入失败' }) } })
  assert.equal(await ui.switchProfile('b'), false)
  assert.equal(ui.activeId.value, 'a')
  assert.deepEqual(ui.applied, [])
  assert.match(ui.notices[0][0], /写入失败/)
  assert.equal(ui.busy.value, false)
})

test('secondary refresh failure reports the successful activation accurately', async () => {
  const ui = fixture({ refreshFeatures: async () => { throw Error('断网') } })
  assert.equal(await ui.switchProfile('b'), true)
  assert.equal(ui.activeId.value, 'b')
  assert.deepEqual(ui.applied, [{ model: 'b' }])
  assert.equal(ui.notices[0][1], 'warning')
})

test('inactive deletion never reapplies model config or clears the draft', async () => {
  const ui = fixture({ isDirty: () => true })
  assert.equal(await ui.removeProfile('a'), false)
  assert.equal(await ui.removeProfile('b'), true)
  assert.equal(ui.profiles.value.length, 1)
  assert.deepEqual(ui.applied, [])
  assert.equal(await ui.removeProfile('a'), false)
})

test('created profile remains available if activation fails; duplicate names use new ID', async () => {
  const ids = []
  const ui = fixture({ api: { activateLlmProfile: async id => { ids.push(id); throw Error('失败') } } })
  assert.equal(await ui.addProfile('备用', {}, { activateNew: true }), false)
  assert.deepEqual(ids, ['c'])
  assert.equal(ui.profiles.value.length, 3)
  assert.equal(ui.activeId.value, 'a')
  assert.match(ui.notices[0][0], /已创建，但启用失败/)
})

test('save or free-mode lock prevents all profile mutations', async () => {
  const ui = fixture({ isBlocked: () => true })
  assert.equal(await ui.switchProfile('b'), false)
  assert.equal(await ui.addProfile('新增'), false)
  assert.equal(await ui.removeProfile('b'), false)
  assert.deepEqual(ui.calls, [])
  assert.equal(ui.profiles.value.length, 2)
})
