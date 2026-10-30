import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as Vue from 'vue'

const source = readFileSync(new URL('../src/components/WorldLorebookModal.vue', import.meta.url), 'utf8')
const code = compileScript(parse(source).descriptor, { id: 'lorebook-editor-test' }).content
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"]/g, (_, names) => `const { ${names} } = Vue`)
  .replace(/^import .* from .*$/gm, '')
  .replace('export default', 'return')

async function fixture(t) {
  const entry = { uid: 47, comment: '规则', content: '原始内容', key: ['city'], keysecondary: ['night'],
    constant: true, vectorized: false, position: 4, depth: 4, role: 2, order: 99,
    probability: 37, useProbability: true, selective: true, selectiveLogic: 3,
    sticky: 3, cooldown: 5, group: 'rules', characterFilter: { names: ['Alice'], isExclude: true },
    customExtension: { keep: true } }
  let book = { name: '导入书', enabled: true, revision: 1, document: { entries: { 47: entry } },
    settings: { scanDepth: 8, recursive: true, positionPolicy: 'anchors', regexRules: [{ pattern: 'a', replacement: 'b' }] } }
  const saves = []
  const api = {
    getWorldLorebook: async () => ({ book: structuredClone(book) }),
    saveWorldLorebook: async (id, payload) => {
      saves.push(JSON.parse(JSON.stringify(payload)))
      book = { ...saves.at(-1), revision: book.revision + 1 }
      return { book: structuredClone(book), warnings: [] }
    },
  }
  const component = new Function('Vue', 'api', 'LinsheModal', 'LinsheButton', 'LinsheInput', 'LinsheSelect', 'LinsheSwitch', 'WorldLorebookEntryRow', code)(
    { ...Vue, inject: () => async () => true }, api,
  )
  const props = Vue.reactive({ modelValue: false, worldId: 5, worldName: '测试世界' })
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {}, emit() {} }))
  t.after(() => scope.stop())
  props.modelValue = true
  await Vue.nextTick()
  await Promise.resolve()
  return { state, props, saves, entry }
}

test('inline editing and navigation preserve every imported advanced field on save', async t => {
  const { state, saves, entry } = await fixture(t)
  assert.deepEqual(state.expanded.value, [])
  assert.equal(state.dirty.value, false)
  state.toggleEntry(47)
  state.entries.value[0].content = '编辑后的正文'
  state.tab.value = 'settings'
  state.tab.value = 'entries'
  state.toggleEntry(47)
  assert.equal(saves.length, 0, 'navigation does not persist or reset the draft')
  await state.save()
  assert.deepEqual(saves[0].document.entries[47], { ...entry, content: '编辑后的正文' })
  assert.equal(saves[0].settings.positionPolicy, 'anchors')
  assert.equal(saves[0].settings.scanDepth, 8)
  assert.deepEqual(saves[0].settings.regexRules, [{ pattern: 'a', replacement: 'b' }])
  assert.equal(state.dirty.value, false)
})

test('new entries use defaults without changing other entries or global settings', async t => {
  const { state, entry } = await fixture(t)
  const settings = JSON.stringify(state.settings.value)
  const uid = state.addEntry()
  const added = state.documentData.value.entries[uid]
  assert.equal(added.position, 1)
  assert.equal(added.probability, 100)
  assert.equal(added.scanDepth, undefined, 'inherits the book scan depth')
  assert.deepEqual(added.keysecondary, [])
  assert.deepEqual(JSON.parse(JSON.stringify(state.documentData.value.entries[47])), entry)
  assert.equal(JSON.stringify(state.settings.value), settings)
})

test('reopening collapses rows without losing saved book settings', async t => {
  const { state, props } = await fixture(t)
  state.toggleEntry(47)
  state.tab.value = 'settings'
  props.modelValue = false
  await Vue.nextTick()
  props.modelValue = true
  await Vue.nextTick()
  await Promise.resolve()
  assert.deepEqual(state.expanded.value, [])
  assert.equal(state.entries.value[0].depth, 4)
  assert.equal(state.settings.value.positionPolicy, 'anchors')
  assert.equal(state.dirty.value, false)
})

test('vector query depth saves independently when keyword scanning is disabled', async t => {
  const { state, saves } = await fixture(t)
  state.settings.value.scanDepth = 0
  state.settings.value.vectorQueryMessages = 4
  await state.save()
  assert.equal(saves[0].settings.scanDepth, 0)
  assert.equal(saves[0].settings.vectorQueryMessages, 4)
  assert.equal(state.dirty.value, false)
})


test('row duplication and deletion target their own entry and retain independent drafts', async t => {
  const { state, entry } = await fixture(t)
  state.duplicateEntry(state.entries.value[0])
  const copy = state.documentData.value.entries[48]
  assert.equal(copy.depth, entry.depth)
  assert.equal(copy.probability, entry.probability)
  copy.characterFilter.names.push('Bob')
  assert.deepEqual(state.documentData.value.entries[47].characterFilter.names, ['Alice'])
  await state.removeEntry(state.documentData.value.entries[47])
  assert.equal(state.documentData.value.entries[47], undefined)
  assert.equal(state.entries.value.length, 1)
  assert.equal(state.entries.value[0].uid, 48)
})

test('all entries remain available while searching and adding preserves the draft', async t => {
  const { state } = await fixture(t)
  for (let uid = 100; uid < 160; uid++) state.documentData.value.entries[uid] = { uid, comment: '条目' + uid, order: 200, content: '' }
  assert.equal(state.filtered.value.length, 61)
  state.toggleEntry(47)
  state.documentData.value.entries[47].content = '保留的草稿'
  state.search.value = '规则'
  assert.equal(state.filtered.value.length, 1)
  state.search.value = '找不到'
  const uid = state.addEntry()
  assert.equal(state.search.value, '')
  assert.ok(state.filtered.value.some(e => e.uid === uid))
  assert.ok(state.expanded.value.includes(String(uid)))
  assert.equal(state.documentData.value.entries[47].content, '保留的草稿')
  state.expandAll()
  assert.ok(state.filtered.value.every(e => state.expanded.value.includes(String(e.uid))))
})


test('inline strategy and depth-role controls preserve unrelated imported settings', () => {
  const rowSource = readFileSync(new URL('../src/components/WorldLorebookEntryRow.vue', import.meta.url), 'utf8')
  const rowCode = compileScript(parse(rowSource).descriptor, { id: 'lorebook-row-test' }).content
    .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"]/g, (_, names) => `const { ${names} } = Vue`)
    .replace(/^import .* from .*$/gm, '')
    .replace('export default', 'return')
  const component = new Function('Vue', 'LinsheButton', 'LinsheInput', 'LinsheSelect', 'LinsheSwitch', rowCode)(Vue)
  const entry = Vue.reactive({ uid: 47, position: 4, role: 2, depth: 4, probability: 37, constant: true, vectorized: false, characterFilter: { names: ['Alice'], custom: 'keep' } })
  const state = component.setup({ entry, expanded: true }, { expose() {}, emit() {} })
  state.updateKeywords('key', '圣杯,')
  assert.equal(state.keywordText.value.key, '圣杯,')
  state.updateKeywords('key', '圣杯, /a{1,3}[/,]/i，令咒')
  assert.deepEqual(entry.key, ['圣杯', '/a{1,3}[/,]/i', '令咒'])
  state.updateKeywords('keysecondary', '夜晚, 城市')
  assert.deepEqual(entry.keysecondary, ['夜晚', '城市'])
  assert.equal(state.placement.value, 'depth:0')
  state.setPlacement(1)
  assert.equal(entry.role, 2)
  assert.equal(entry.depth, 4)
  state.setPlacement('depth:0')
  assert.equal(entry.position, 4)
  assert.equal(entry.role, 2)
  assert.equal(state.positions.some(p => ['depth:1', 'depth:2'].includes(p.value)), false)
  state.setStrategy('keyword')
  assert.equal(entry.constant, false)
  assert.equal(entry.vectorized, false)
  assert.equal(entry.probability, 37)
  state.setFilter('tags', ['school'])
  assert.deepEqual(entry.characterFilter, { names: ['Alice'], tags: ['school'], custom: 'keep' })
})
