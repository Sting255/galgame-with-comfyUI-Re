import test from 'node:test'
import assert from 'node:assert/strict'
import { presetRows, presetOrder, setPresetEntryEnabled, movePresetEntry, removePresetEntry, presetSnapshot, presetPreviewSegments, createPresetScroller } from '../src/utils/promptPresets.js'

test('preview anchors preserve exact output and distinguish identical expanded entries', () => {
  const result = {content:' 相同😀\n\n\n相同😀',entries:[{identifier:'vars',reason:'variables'},{identifier:'a',reason:'included',start:0,end:6},{identifier:'b',reason:'included',start:8,end:12}]}
  const segments = presetPreviewSegments(result)
  assert.equal(segments.map(s=>s.text).join(''),result.content)
  assert.deepEqual(segments.filter(s=>s.identifier).map(s=>s.identifier),['a','b'])
  assert.equal(presetPreviewSegments({content:'older server response'})[0].text,'older server response')
})

test('source highlighting splits the consumer text without changing output or matching identical text elsewhere', () => {
  const result={content:'same same',entries:[{identifier:'source',reason:'variables',ranges:[{start:5,end:9}]},{identifier:'consumer',reason:'included',start:0,end:9,ranges:[{start:0,end:9}]}]}
  const segments=presetPreviewSegments(result,'source')
  assert.equal(segments.map(s=>s.text).join(''),result.content)
  assert.deepEqual(segments.filter(s=>s.selected).map(s=>s.text),['same'])
  assert.equal(segments[0].selected,false)
})

test('preview scroll eases through intermediate positions, retargets, cancels and respects reduced motion', () => {
  const frames=new Map();let frameId=0
  const scroller=createPresetScroller({requestFrame:cb=>{frames.set(++frameId,cb);return frameId},cancelFrame:id=>frames.delete(id)})
  const el={scrollTop:0,scrollHeight:20000,clientHeight:600,scrollTo({top}){this.scrollTop=top}}
  const tick=time=>{const pending=[...frames.values()];frames.clear();pending.forEach(cb=>cb(time))}
  scroller.scroll(el,10000)
  tick(0);tick(200)
  assert.ok(el.scrollTop>0 && el.scrollTop<10000)
  const intermediate=el.scrollTop
  scroller.scroll(el,1000)
  tick(250)
  assert.equal(el.scrollTop,intermediate)
  tick(1000)
  assert.equal(el.scrollTop,1000)
  scroller.scroll(el,2000);scroller.cancel();tick(2000)
  assert.equal(el.scrollTop,1000)
  createPresetScroller({requestFrame:()=>assert.fail('no animation'),cancelFrame:()=>{},reducedMotion:()=>true}).scroll(el,50000)
  assert.equal(el.scrollTop,19400)
})

const fixture = () => ({name:'test',orderId:'100001',document:{extensions:{preserved:true},prompts:[{identifier:'a',content:'A'},{identifier:'b',content:'B'},{identifier:'c',content:'C'}],prompt_order:[{character_id:100001,order:[{identifier:'b',enabled:false},{identifier:'a',enabled:true}]},{character_id:5,order:[{identifier:'a',enabled:true}]}]}})
test('unlisted prompts stay off until added; order profiles remain independent', () => {
  const item=fixture();const initial=presetSnapshot(item)
  assert.deepEqual(presetRows(item).map(r=>[r.entry.identifier,r.entry.enabled,r.index]),[['b',false,0],['a',true,1],['c',false,-1]])
  setPresetEntryEnabled(item,'c',true);movePresetEntry(item,'c',-2)
  assert.deepEqual(presetOrder(item).map(p=>p.identifier),['c','b','a'])
  assert.notEqual(presetSnapshot(item),initial)
  item.orderId='5';assert.deepEqual(presetOrder(item),[{identifier:'a',enabled:true}])
  assert.deepEqual(item.document.extensions,{preserved:true})
})
test('removing a prompt cleans every profile and preserves unrelated fields', () => {
  const item=fixture();removePresetEntry(item,'a')
  assert.equal(item.document.prompts.length,2)
  assert.equal(item.document.prompt_order[1].order.length,0)
  assert.deepEqual(item.document.prompt_order[0].order,[{identifier:'b',enabled:false}])
  assert.equal(item.document.extensions.preserved,true)
})
