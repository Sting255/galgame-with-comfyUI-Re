import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'

const descriptor = parse(readFileSync(new URL('../src/components/ui/LinsheTabs.vue', import.meta.url), 'utf8')).descriptor
const code = compileScript(descriptor, { id: 'tabs-disabled-test' }).content.replace('export default', 'return')
const Tabs = new Function(code)()

test('a focused tab cannot change selection after the whole control becomes disabled', () => {
  const props = { disabled: false }
  const emitted = []
  const { select } = Tabs.setup(props, { expose() {}, emit: (...args) => emitted.push(args) })
  select({ value: 'first' })
  props.disabled = true // A request starts while keyboard focus remains on a tab.
  select({ value: 'second' })
  props.disabled = false
  select({ value: 'locked', disabled: true })
  select({ value: 'second' })
  assert.deepEqual(emitted, [['update:modelValue', 'first'], ['update:modelValue', 'second']])
})
