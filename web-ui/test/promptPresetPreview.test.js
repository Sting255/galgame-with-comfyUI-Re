import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as utils from '../src/utils/promptPresets.js'

const source = readFileSync(new URL('../src/components/PromptPresetModal.vue', import.meta.url), 'utf8')
const code = compileScript(parse(source).descriptor, { id:'preset-preview-test' }).content
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"]/g, (_, names) => `const { ${names} } = Vue`)
  .replace(/^import .*from.*$/gm, '')
  .replace('export default', 'return')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const flush = async () => { await Vue.nextTick(); await pause(10) }
const preview = (content = 'A\n\nB') => ({content,entries:[{identifier:'a',reason:'included',start:0,end:1},{identifier:'b',reason:'included',start:3,end:4}],estimatedTokens:2})

function fixture(t) {
  const requests = [], scrolls = []
  const api = {previewPromptPreset(payload) { return new Promise((resolve,reject)=>requests.push({payload,resolve,reject})) }}
  const controls = ['LinsheModal','LinsheButton','LinsheInput','LinsheSelect','LinsheSwitch','LinsheTabs']
  const component = new Function('Vue','api','window',...Object.keys(utils),...controls,code)(
    {...Vue,inject:()=>async()=>true}, api, {matchMedia:()=>({matches:true})}, ...Object.values(utils), ...controls.map(()=>({})),
  )
  const props = Vue.reactive({modelValue:false})
  const scope = Vue.effectScope()
  const state = scope.run(()=>component.setup(props,{expose(){},emit(){}}))
  t.after(()=>scope.stop())
  state.items.value = [{key:'draft',name:'test',orderId:'1',document:{prompts:[{identifier:'a',content:'A'},{identifier:'b',content:'B'}],prompt_order:[{character_id:1,order:[{identifier:'a',enabled:true},{identifier:'b',enabled:true}]}]}}]
  state.selectedKey.value = 'draft'
  // 通过与界面相同的弹窗打开监听器加载隔离的测试数据。
  props.modelValue = true
  api.getPromptPresets = async () => ({items:[{id:1,revision:1,active:true,name:'test',orderId:'1',document:Vue.toRaw(state.items.value[0].document)}]})
  state.previewOutput.value = {
    scrollTop:20,
    scrollHeight:10000,clientHeight:500,
    getBoundingClientRect:()=>({top:100}),
    querySelector:()=>({getBoundingClientRect:()=>({top:state.entryId.value==='a'?100:500})}),
    scrollTo:options=>scrolls.push(options),
  }
  return {state,requests,scrolls,api,props}
}

test('no preset deactivates without overwriting drafts and remains selected after reopening', async t => {
  const {state,api,props} = fixture(t)
  await flush()
  const original=state.selected.value
  const saved=JSON.parse(JSON.stringify(original))
  original.document.prompts[0].content='unsaved edit'
  let calls=0
  api.activatePromptPreset=async(id,active,revision)=>{
    calls++;assert.deepEqual([id,active,revision],[1,false,1])
    return {item:{...saved,active:false,revision:2}}
  }
  await state.selectPreset(state.noPresetKey);await flush()
  assert.equal(calls,1)
  assert.equal(state.selected.value,undefined)
  assert.equal(state.activeName.value,'')
  assert.equal(original.document.prompts[0].content,'unsaved edit')
  assert.equal(original.revision,2)
  assert.equal(state.dirtyCount.value,1)
  await state.selectPreset(original.key);await flush()
  assert.equal(state.selected.value,original)
  assert.equal(state.selected.value.active,false)
  await state.selectPreset(state.noPresetKey)
  assert.equal(calls,1)
  api.getPromptPresets=async()=>({items:[{...saved,active:false,revision:2}]})
  props.modelValue=false;await flush();props.modelValue=true;await flush()
  assert.equal(state.selectedKey.value,state.noPresetKey)
  assert.equal(state.items.value.length,1)
})

test('failed deactivation preserves active selection and preview', async t => {
  const {state,api} = fixture(t)
  await flush()
  const previous=state.selected.value
  state.result.value=preview()
  api.activatePromptPreset=async()=>{throw new Error('conflict')}
  await state.selectPreset(state.noPresetKey);await flush()
  assert.equal(state.selected.value,previous)
  assert.equal(previous.active,true)
  assert.equal(previous.revision,1)
  assert.equal(state.result.value.content,'A\n\nB')
  assert.equal(state.error.value,'conflict')
  assert.equal(state.busy.value,false)
})

test('save and enable preserves the draft workspace, selection and preview, then can reopen the saved preset', async t => {
  const {state,api,props,requests} = fixture(t)
  await flush()
  const doc=JSON.parse(JSON.stringify(state.selected.value.document))
  state.createDraft(doc,'draft','1')
  await flush()
  state.entryId.value='b';state.search.value='B';state.view.value='preview'
  await flush()
  requests[0].resolve(preview());await flush()
  const key=state.selectedKey.value, output=state.result.value
  let saved,calls=0
  api.createPromptPreset=async body=>{
    calls++;assert.equal(body.activate,true)
    saved={id:22,revision:1,name:body.name,document:body.document,orderId:body.orderId,active:true}
    return {item:saved,items:[saved]}
  }
  await state.saveAndActivate();await flush()
  assert.equal(calls,1)
  assert.equal(state.selectedKey.value,key)
  assert.equal(state.entryId.value,'b')
  assert.equal(state.search.value,'B')
  assert.equal(state.view.value,'preview')
  assert.equal(state.result.value,output)
  assert.equal(state.selected.value.active,true)
  assert.equal(state.selectedDirty.value,false)
  assert.equal(requests.length,1)
  api.getPromptPresets=async()=>({items:[saved]})
  props.modelValue=false;await flush();props.modelValue=true;await flush();await pause(170)
  requests.at(-1).resolve(preview());await flush()
  assert.equal(state.selected.value.id,22)
  assert.equal(state.result.value.content,'A\n\nB')
})

test('failed save keeps the draft and preview; locating a missing output does not enable it automatically', async t => {
  const {state,api} = fixture(t)
  await flush()
  const previous=state.selected.value
  state.result.value=preview()
  api.updatePromptPreset=async()=>{throw new Error('conflict')}
  await state.saveAndActivate()
  assert.equal(state.selected.value,previous)
  assert.equal(state.result.value.content,'A\n\nB')
  assert.equal(state.error.value,'conflict')
  state.setEnabled('b',false)
  state.locateOutput({identifier:'b',name:'output'})
  assert.equal(state.search.value,'output')
  assert.equal(state.order.value.find(e=>e.identifier==='b').enabled,false)
})

test('selecting entries keeps the current mode, scrolls preview, and never recompiles it', async t => {
  const {state,requests,scrolls} = fixture(t)
  await flush()
  await state.selectEntry('b')
  assert.equal(state.view.value,'edit')
  state.view.value = 'preview'
  await flush()
  assert.equal(requests.length,1)
  requests[0].resolve(preview())
  await flush()
  const result = state.result.value
  await state.selectEntry('a')
  await state.selectEntry('b')
  await pause(180)
  assert.equal(state.view.value,'preview')
  assert.equal(state.result.value,result)
  assert.equal(state.previewing.value,false)
  assert.equal(requests.length,1)
  assert.equal(scrolls.at(-1).top,408)
})

test('variable sources that contribute to output are not described as empty', async t => {
  const {state} = fixture(t)
  await flush()
  state.result.value = {content:'A',entries:[{identifier:'a',reason:'variables',emptyKind:'assignment',ranges:[{start:0,end:1}]}]}
  assert.match(state.previewEntryNote.value,/通过变量引用注入/)
  assert.equal(state.previewSegments.value[0].selected,true)
  state.result.value.entries[0].ranges=[]
  assert.match(state.previewEntryNote.value,/未被引用或已被覆盖/)
  state.result.value.entries[0].emptyKind='comment'
  assert.equal(state.previewEntryNote.value,'此条目为注释，不参与注入。')
})

test('refresh retains output and scroll position; stale responses cannot replace the latest draft', async t => {
  const {state,requests,scrolls} = fixture(t)
  await flush()
  state.view.value = 'preview'
  await flush()
  requests[0].resolve(preview())
  await flush()
  const result = state.result.value, scrollCount = scrolls.length
  state.setEnabled('a',false)
  await Vue.nextTick()
  assert.equal(state.result.value,result)
  assert.equal(state.previewing.value,true)
  await pause(170)
  state.setEnabled('a',true)
  await Vue.nextTick()
  await pause(170)
  requests[2].resolve(preview('latest'))
  await flush()
  requests[1].resolve(preview('stale'))
  await flush()
  assert.equal(state.result.value.content,'latest')
  assert.equal(scrolls.length,scrollCount)
  state.setEnabled('b',false)
  await Vue.nextTick()
  await pause(170)
  requests[3].reject(new Error('offline'))
  await flush()
  assert.equal(state.result.value.content,'latest')
  assert.equal(state.previewError.value,'offline')
  assert.equal(state.previewing.value,false)
})
