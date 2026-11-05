import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { useChatActionPanels } from '../src/composables/useChatActionPanels.js'

function fixture(t) {
  const previous = globalThis.window
  globalThis.window = new EventTarget()
  const conversation = ref(1)
  let ui
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
  const app = renderer.createApp({ setup() { ui = useChatActionPanels(conversation); return () => null } })
  app.mount({})
  t.after(() => { app.unmount(); globalThis.window = previous })
  return { ui, conversation }
}

test('clicking the same entry toggles it; opening another closes the previous panel', t => {
  const { ui } = fixture(t)
  for (const name of ['touch', 'toy', 'intimate']) {
    ui.togglePanel(name)
    assert.equal([ui.showTouchPanel.value, ui.showToyPanel.value, ui.showIntimatePanel.value].filter(Boolean).length, 1)
    ui.togglePanel(name)
    assert.equal([ui.showTouchPanel.value, ui.showToyPanel.value, ui.showIntimatePanel.value].some(Boolean), false)
  }
  ui.showTouchPanel.value = true
  ui.showIntimatePanel.value = true
  assert.equal(ui.showTouchPanel.value, false)
  assert.equal(ui.showIntimatePanel.value, true)
  ui.showTouchPanel.value = false // late close event from the outgoing panel
  assert.equal(ui.showIntimatePanel.value, true)
})

test('conversation changes synchronously close panels before another character receives controls', t => {
  const { ui, conversation } = fixture(t)
  ui.showToyPanel.value = true
  conversation.value = 2
  assert.equal(ui.showToyPanel.value, false)
})

test('Escape closes an interaction panel; a handled Escape does not close underlying content', t => {
  const { ui } = fixture(t)
  ui.showTouchPanel.value = true
  const handled = new Event('keydown', { cancelable: true });handled.key = 'Escape';handled.preventDefault()
  window.dispatchEvent(handled)
  assert.equal(ui.showTouchPanel.value, true)
  const escape = new Event('keydown');escape.key = 'Escape';window.dispatchEvent(escape)
  assert.equal(ui.showTouchPanel.value, false)
})

test('the two chat views share the toolbar and keep panel visibility controlled', () => {
  for (const name of ['ChatView', 'GroupChatView']) {
    const code = readFileSync(new URL(`../src/views/${name}.vue`, import.meta.url), 'utf8')
    assert.match(code, /<ChatActionToolbar/)
    assert.match(code, /useChatActionPanels\(/)
    for (const panel of ['Touch', 'Toy', 'Intimate']) assert.ok(code.includes(`@close="show${panel}Panel = false"`))
  }
})
