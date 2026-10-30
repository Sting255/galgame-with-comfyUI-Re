import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')
const loadStart = source.indexOf('    form.value = {', source.indexOf('onMounted(async () =>'))
const loadCode = source.slice(loadStart, source.indexOf('    globalLoras.value', loadStart))
const saveCode = source.slice(source.indexOf('async function saveComfy()'), source.indexOf('function onGlobalLoraSaved('))
const favoriteCode = source.slice(source.indexOf('function applyFavorite('), source.indexOf('async function removeFavorite('))

function loadForm(comfy) {
  const form = { value: {} }
  new Function('data', 'form', loadCode)({ comfy }, form)
  return form.value
}

test('重新打开设置时保留各页签保存的空画师串', () => {
  for (const field of ['artist', 'momentsArtist', 'eventArtist']) {
    const saved = { artist: '@chat', momentsArtist: '@moments', eventArtist: '@event', [field]: '' }
    const form = loadForm(saved)
    for (const key of ['artist', 'momentsArtist', 'eventArtist']) {
      assert.equal(form[key], saved[key], `${field} 留空时 ${key} 应忠实显示保存值`)
    }
  }
})

test('旧配置缺少页签字段时才回退，回退遇到明确空串即停止', () => {
  assert.equal(loadForm({ artist: '@chat' }).momentsArtist, '@chat')
  assert.equal(loadForm({ artist: '@chat' }).eventArtist, '@chat')
  assert.equal(loadForm({ artist: '@chat', momentsArtist: '' }).eventArtist, '')
  assert.equal(loadForm({ artist: '@chat', momentsArtist: null }).momentsArtist, '@chat')
})

test('曾保存空串后重新选收藏并保存，新画师串能写入并重新显示', async () => {
  for (const [mode, field] of [['chat', 'artist'], ['moments', 'momentsArtist'], ['event', 'eventArtist']]) {
    const form = { value: loadForm({ artist: '', momentsArtist: '', eventArtist: '' }) }
    let stored
    // comfySaving / toastFn 是 2026-10-22 给 saveComfy 加的（防重入 + 失败提示），
    // 这里必须一并注入，否则 new Function 作用域里找不到它们。
    const actions = new Function('form', 'updateComfyConfig', 'settingsStore', 'setTimeout', 'comfySaving', 'toastFn', `
      const dirty = { value: false }, saved = { value: false }
      function markDirty() { dirty.value = true }
      ${favoriteCode}
      ${saveCode}
      return { applyFavorite, saveComfy, dirty }
    `)(form, async payload => { stored = payload }, { setComfySize() {}, setEventSize() {} }, () => {}, { value: false }, () => {})
    actions.applyFavorite({ artist: '@ebora' }, mode)
    assert.equal(actions.dirty.value, true)
    await actions.saveComfy()
    assert.equal(stored[field], '@ebora')
    assert.equal(loadForm(stored)[field], '@ebora')
  }
})
