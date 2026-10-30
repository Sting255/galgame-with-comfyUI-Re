import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer } from 'vue'
import { useClothingDraft, getSavedClothingTags } from '../src/composables/useClothingDraft.js'

test('重开已保存的衣服库恢复精确 tag，未通过衣服库生成的描述保持空选择', () => {
  assert.deepEqual(getSavedClothingTags('Aster wears a collared shirt.\nOutfit tags: collared_shirt, pleated_skirt.'), ['collared_shirt', 'pleated_skirt'])
  assert.deepEqual(getSavedClothingTags('Wearing a collared shirt and a pleated skirt.'), [])
  assert.deepEqual(getSavedClothingTags('Outfit tags: shirt, shirt, skirt.'), ['shirt', 'skirt'])
})

function fixture(t, generate) {
  let state
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
  const app = renderer.createApp({ setup() { state = useClothingDraft(generate, () => ({ characterId: 1, scene: 'home', basePrompt: '默认外观' })); return () => null } })
  app.mount({})
  t.after(() => app.unmount())
  return state
}

test('草稿使用所选 tag 与目标场景；改选或修改补充后不能应用旧结果', async t => {
  let request
  const state = fixture(t, async input => { request = input; return { appearance: '新外观' } })
  state.tags.value = ['shirt']
  await state.createDraft()
  assert.equal(request.scene, 'home')
  assert.deepEqual(request.tags, ['shirt'])
  assert.equal(state.result.value, '新外观')
  state.tags.value.push('skirt')
  assert.equal(state.result.value, '')
  await state.createDraft()
  state.brief.value = '金色纽扣'
  assert.equal(state.result.value, '')
})

test('关闭、切换角色或重置后迟到响应不能回填；请求取消可重新生成', async t => {
  let resolve
  let signal
  const state = fixture(t, input => { signal = input.signal; return new Promise(done => { resolve = done }) })
  state.tags.value = ['shirt']
  const pending = state.createDraft()
  state.cancel()
  assert.equal(signal.aborted, true)
  resolve({ appearance: '迟到结果' })
  await pending
  assert.equal(state.result.value, '')
  assert.equal(state.busy.value, false)
  state.reset()
  assert.deepEqual(state.tags.value, [])
})

test('失败或空结果保留选择并显示错误，允许重试', async t => {
  let failing = true
  const state = fixture(t, async () => { if (failing) throw new Error('标签冲突'); return { appearance: '成功外观' } })
  state.tags.value = ['shirt']
  await state.createDraft()
  assert.equal(state.error.value, '标签冲突')
  assert.deepEqual(state.tags.value, ['shirt'])
  assert.equal(state.result.value, '')
  failing = false
  await state.createDraft()
  assert.equal(state.result.value, '成功外观')
  assert.equal(state.error.value, '')
})
