import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as Vue from 'vue'

const descriptor = parse(readFileSync(new URL('../src/components/ExpressionStandingManager.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'standing-restart-test' })
const rewrite = code => code
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"]/g, (_, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
  .replace(/^import .*from.*$/gm, '')
const setupCode = rewrite(script.content).replace('export default', 'return')
const template = compileTemplate({ source: descriptor.template.content, filename: 'ExpressionStandingManager.vue', id: 'standing-restart-test', compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
const render = new Function('Vue', rewrite(template.code).replace('export function render', 'return function render'))(Vue)

function fixture(t, control = async () => {}) {
  let state
  const calls = []
  const api = { controlExpressionStandingTask: (...args) => { calls.push(args); return control(...args) } }
  const components = ['StandingTouchLinesManager', 'StandingGenerationDirection', 'StandingOutfitConfirmation', 'LinsheModal', 'LinsheButton', 'LinsheInput', 'TownImageEditor', 'TownPromptPanel']
  const component = new Function('Vue', 'api', 'onEvent', 'useStandingOutfitConfirmation', ...components, setupCode)(
    Vue, api, () => () => {}, () => ({ outfitConfirmation: Vue.reactive({ open: false }), chooseOutfitPolicy() {} }), ...components.map(name => ({ name })),
  )
  const renderer = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
  const app = renderer.createApp({ setup() {
    state = component.setup({ open: false, character: { id: 7 }, initialOutfitScene: 'work' }, { expose() {}, emit() {} })
    return () => null
  } })
  app.mount({})
  t.after(() => app.unmount())
  state.slots.value = [{ id: 'normal', name: '正常' }]
  state.jobs.value = [{ id: 'paused-job', status: 'paused', slots_json: '["normal"]' }]
  state.busy.value = true
  function buttons() {
    const found = []
    function visit(value) {
      if (Array.isArray(value)) return value.forEach(visit)
      if (!value || typeof value !== 'object') return
      if (value.type?.name === 'LinsheButton') found.push({ props: value.props, text: value.children.default().map(v => v.children).join('') })
      if (Array.isArray(value.children)) visit(value.children)
      else if (value.children?.default) visit(value.children.default())
    }
    visit(render({}, [], {}, Vue.proxyRefs(state), {}, {}))
    return found
  }
  return { state, calls, buttons }
}

test('paused task exposes enabled restart and resume buttons; restarting prevents duplicate requests', async t => {
  let release
  const h = fixture(t, () => new Promise(resolve => { release = resolve }))
  const restart = h.buttons().find(b => b.text === '重新生成')
  const resume = h.buttons().find(b => b.text === '继续任务')
  assert.equal(restart.props.disabled, false)
  assert.equal(resume.props.disabled, false)
  const pending = restart.props.onClick()
  assert.deepEqual(h.calls, [[7, 'paused-job', 'restart']])
  assert.ok(h.buttons().filter(b => ['重新生成', '继续任务'].includes(b.text)).every(b => b.props.disabled))
  await restart.props.onClick()
  await resume.props.onClick()
  assert.equal(h.calls.length, 1)
  release()
  await pending
  assert.equal(h.state.controlling.value, false)
})

test('resume keeps its original action; a failed restart restores controls and displays the error', async t => {
  const h = fixture(t, async (_, __, action) => { if (action === 'restart') throw new Error('重启失败') })
  await h.buttons().find(b => b.text === '继续任务').props.onClick()
  assert.equal(h.calls[0][2], 'resume')
  await h.buttons().find(b => b.text === '重新生成').props.onClick()
  assert.equal(h.state.error.value, '重启失败')
  assert.equal(h.buttons().find(b => b.text === '重新生成').props.disabled, false)
  h.state.jobs.value[0].status = 'stopping'
  assert.ok(!h.buttons().some(b => b.text === '重新生成'))
  assert.ok(h.buttons().find(b => b.text === '正在停止…').props.disabled)
})
