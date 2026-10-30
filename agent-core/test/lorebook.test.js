import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBook, evaluateBook, injectBook, renderMacros } from '../src/services/lorebook/engine.js';

const book = entries => normalizeBook({entries:Object.fromEntries(entries.map((e,i)=>[i,{uid:i,key:[],content:`content ${i}`,position:1,...e}]))}).document;
const run = (entries,text='',settings={},context={},state={},options={}) => evaluateBook(book(entries),{budgetCap:100000,...settings},{history:[{role:'user',content:text}],...context},state,options);

test('ST and character-book formats preserve unknown fields',()=>{
  const original={entries:[{id:9,keys:['city'],content:'world',enabled:true,position:'after_char',extensions:{depth:2,position:4,custom:'keep'},customField:42}]};
  const doc=normalizeBook({character_book:original}).document;
  assert.equal(doc.entries[9].depth,2);assert.equal(doc.entries[9].position,4);assert.equal(doc.entries[9].customField,42);assert.equal(doc.entries[9].extensions.custom,'keep');
  assert.throws(()=>normalizeBook({entries:[{uid:1},{uid:1}]}),/重复/);
});
test('primary keywords, disabled entries and secondary logic',()=>{
  for(const [logic,expected] of [[0,true],[1,true],[2,false],[3,false]]){
    assert.equal(run([{key:['city'],keysecondary:['red','blue'],selectiveLogic:logic}],'city red').entries.length>0,expected);
  }
  assert.equal(run([{key:['city'],disable:true}],'city').entries.length,0);
});
test('regex flags, case and whole words',()=>{
  assert.equal(run([{key:['/CAT/i']}],'cat').entries.length,1);
  assert.equal(run([{key:['cat'],caseSensitive:true}],'CAT').entries.length,0);
  assert.equal(run([{key:['cat'],matchWholeWords:true}],'catch').entries.length,0);
  assert.equal(run([{key:['/[broken/']}],'anything').warnings.length,1);
});
test('scan depth is messages, entry override and minimum activation expansion',()=>{
  const history=[{role:'user',content:'city'},{role:'assistant',content:'nothing'},{role:'user',content:'new'}];
  assert.equal(run([{key:['city']}],'',{scanDepth:2},{history}).entries.length,0);
  assert.equal(run([{key:['city'],scanDepth:3}],'',{scanDepth:2},{history}).entries.length,1);
  assert.equal(run([{key:['city']}],'',{scanDepth:1,minActivations:1},{history}).entries.length,1);
});
test('optional scan data and character filtering',()=>{
  assert.equal(run([{key:['city'],matchScenario:true}],'',{}, {scenario:'city'}).entries.length,1);
  assert.equal(run([{constant:true,characterFilter:{names:['A'],isExclude:false}}],'',{}, {characterName:'B'}).entries.length,0);
  assert.equal(run([{constant:true,triggers:['continue']}],'').entries.length,0);
});
test('recursion chain and both recursion switches',()=>{
  const entries=[{key:['city'],content:'council'},{key:['council'],content:'mages'}];
  assert.equal(run(entries,'city',{recursive:true}).entries.length,2);
  assert.equal(run([{...entries[0],preventRecursion:true},entries[1]],'city',{recursive:true}).entries.length,1);
  assert.equal(run([entries[0],{...entries[1],excludeRecursion:true}],'city',{recursive:true}).entries.length,1);
});
test('delayed recursion activates at requested level',()=>{
  const result=run([{constant:true,content:'council'},{key:['council'],delayUntilRecursion:2}],'');
  assert.equal(result.entries.length,2);
});
test('probability is sampled once and dry evaluation does not mutate state',()=>{
  let rolls=0;const state={variables:{a:1}};const before=JSON.stringify(state);
  const result=run([{constant:true,probability:0}], '', {recursive:true}, {}, state, {random:()=>{rolls++;return .5;}});
  assert.equal(result.entries.length,0);assert.equal(rolls,1);assert.equal(JSON.stringify(state),before);
});
test('group override, weights and scoring select one winner',()=>{
  assert.deepEqual(run([{constant:true,group:'a',groupOverride:true,order:100},{constant:true,group:'a',order:200}]).entries.map(e=>e.uid),[0]);
  const result=run([{key:['a'],group:'g'},{key:['a','b'],group:'g'}],'a b',{useGroupScoring:true});assert.deepEqual(result.entries.map(e=>e.uid),[1]);
});
test('sticky and cooldown progress by logical messages',()=>{
  const entries=[{key:['city'],sticky:2,cooldown:2}];
  const first=run(entries,'city',{}, {step:10});
  assert.equal(run(entries,'',{}, {step:12},first.nextState).entries.length,1);
  assert.equal(run(entries,'city',{}, {step:13},first.nextState).entries.length,0);
  assert.equal(run(entries,'city',{}, {step:15},first.nextState).entries.length,1);
});
test('budget drops complete entries, order prioritizes before final reverse order',()=>{
  const result=run([{constant:true,order:10,content:'aaaa'},{constant:true,order:20,content:'bbbb'}],'',{budgetCap:8},{},{},{countTokens:s=>s.length});
  assert.deepEqual(result.entries.map(e=>e.uid),[1]);assert.equal(result.trace.find(e=>e.uid===0).reason,'budget');
  assert.deepEqual(run([{constant:true,order:20},{constant:true,order:10}]).entries.map(e=>e.uid),[1,0]);
});
test('ignoreBudget entries survive the world budget overflow',()=>{
  const result=run([{constant:true,content:'x'.repeat(100),order:200},{constant:true,ignoreBudget:true,order:100}],'',{budgetCap:5});assert.deepEqual(result.entries.map(e=>e.uid),[1]);
});
test('constant and forced activation, decorators',()=>{
  assert.equal(run([{content:'@@activate\nhello'}]).entries[0].content,'hello');
  assert.equal(run([{constant:true,content:'@@dont_activate\nhello'}]).entries.length,0);
  assert.equal(run([{}],'',{}, {vectorIds:['0']}).entries[0].reason,'vector');
});
test('depth insertion uses original history and preserves final user',()=>{
  const messages=[{role:'system',content:'static'},{role:'user',content:'old'},{role:'assistant',content:'reply'},{role:'user',content:'new'}];
  const result=injectBook(messages,run([{constant:true,position:4,depth:2,role:0,content:'depth2'},{constant:true,position:4,depth:0,content:'depth0'}]),{historyStart:1,historyEnd:4});
  assert.deepEqual(result.messages.map(m=>m.role),['system','user','assistant','user']);
  assert.match(result.messages[1].content,/^old[\s\S]*depth2/);
  assert.equal(result.messages[2],messages[2]);
  assert.match(result.messages.at(-1).content,/depth0[\s\S]*new$/);
  assert.ok(result.placements.find(p=>p.uid===1).mapped);
});
test('all explicit anchors and outlet resolved without automatic outlet append',()=>{
  const messages=[{role:'system',content:'rules {{outlet::lore}}'},{role:'user',content:'go'}];
  const result=injectBook(messages,run([{constant:true,position:0,content:'before'},{constant:true,position:7,outletName:'lore',content:'outlet'}]),{anchors:{beforeCharacter:1}});
  assert.deepEqual(result.messages.map(m=>m.role),['system','user']);
  assert.match(result.messages[0].content,/rules [\s\S]*outlet/);
  assert.match(result.messages[1].content,/before[\s\S]*go$/);
});
test('no activation is an identity operation, dynamic changes preserve earlier prefix',()=>{
  const messages=[{role:'system',content:'fixed'},{role:'user',content:'test'}];
  assert.equal(injectBook(messages,run([{key:['absent']}])).messages,messages);
  const a=injectBook(messages,run([{key:['a'],content:'A'},{key:['b'],content:'B'}],'a'));
  const b=injectBook(messages,run([{key:['a'],content:'A'},{key:['b'],content:'B'}],'b'));
  assert.equal(a.stablePrefixHash,b.stablePrefixHash);assert.deepEqual(a.messages[0],b.messages[0]);
});
test('macro values, variables and unknown macros are explicit',()=>{
  const variables={};const warnings=[];
  const out=renderMacros('{{char}} {{setvar::x::hello}}{{getvar::x}} {{unsupported}}',{characterName:'A'},variables,()=>0,warnings);
  assert.equal(out,'A hello {{unsupported}}');assert.equal(variables.x,'hello');assert.equal(warnings.length,1);
});

test('includeNames uses participant names, honors explicit speakers and can be disabled', () => {
  const entries = [{key:['Alice']}, {key:['Bob']}, {key:['assistant']}];
  const context = {characterName:'Alice', userName:'Bob', history:[{role:'assistant',content:'hello'}, {role:'user',content:'hi'}]};
  assert.deepEqual(run(entries,'',{},context).entries.map(e=>e.uid), [0,1]);
  assert.equal(run(entries,'',{includeNames:false},context).entries.length, 0);
  assert.equal(run([{key:['Carol']}],'',{}, {...context,history:[{role:'assistant',name:'Carol',content:'hi'}]}).entries.length,1);
  assert.equal(run([{key:['Alice']}],'',{}, {...context,group:true,history:[{role:'assistant',content:'Carol: hi'}]}).entries.length,0);
});

test('setter-only entries persist state once per evaluation without injecting empty blocks', () => {
  const entries = [{constant:true,order:200,content:'{{setvar::weather::rain}}'}, {constant:true,order:100,content:'weather={{getvar::weather}}'}];
  const state = {variables:{old:'keep'}};
  const result = run(entries,'',{recursive:true},{step:1},state);
  assert.equal(result.nextState.variables.weather,'rain');
  assert.equal(result.nextState.variables.old,'keep');
  assert.equal(state.variables.weather,undefined);
  assert.equal(result.entries.find(e=>e.uid===0).tokens,0);
  assert.equal(result.entries.find(e=>e.uid===1).content,'weather=rain');
  assert.equal(result.trace.filter(e=>e.uid===0 && e.reason==='activated').length,1);
  const output=injectBook([{role:'user',content:'go'}],result);
  assert.deepEqual(output.placements.map(e=>e.uid),[1]);
  assert.equal(run([entries[0]],'',{}, {step:2},result.nextState).entries.length,1);
  assert.equal(run([{...entries[0],probability:0}]).nextState.variables.weather,undefined);
});
