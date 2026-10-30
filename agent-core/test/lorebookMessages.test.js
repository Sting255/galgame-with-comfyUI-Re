import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, normalizeBook, evaluateBook, injectBook } from '../src/services/lorebook/engine.js';

const stripLore = text => text.replace(/\n\n<worldbook>\n[\s\S]*?\n<\/worldbook>\n\n/g, '');
const history = () => [{role:'system',content:'stable'}, {role:'user',name:'Alice',content:'old'}, {role:'assistant',content:'reply'}, {role:'user',content:'task'}];
const activation = (position=4, extra={}) => evaluateBook(normalizeBook({entries:{0:{constant:true,position,depth:2,content:'LORE',...extra}}}).document,{},{});
function preserved(original, result) {
  const existing = result.filter(message => !/^<worldbook>\n[\s\S]*\n<\/worldbook>$/.test(message.content));
  assert.deepEqual(existing.map(message => ({...message, content:stripLore(message.content)})), original);
  assert.equal(result.filter(m=>m.role==='user').length,original.filter(m=>m.role==='user').length);
  assert.ok(result.filter(m=>!existing.includes(m)).every(m=>m.role==='system'));
}

test('all ST positions and imported roles preserve existing message roles, order and content', () => {
  for(let position=0;position<7;position++) for(let role=0;role<3;role++) {
    const original=history(); const snapshot=structuredClone(original);
    const active=activation(position,{role}); const before=structuredClone(active);
    const result=injectBook(original,active,{historyStart:1,historyEnd:4});
    preserved(original,result.messages); assert.deepEqual(original,snapshot); assert.deepEqual(active,before);
    assert.equal(result.messages.length,original.length);
    assert.ok(result.placements.every(p=>p.mode==='inline'&&['system','user'].includes(p.role)));
  }
});

test('allocate one dedicated system slot only when a boundary has no system/user carrier', () => {
  const original=[{role:'system',content:'rules'},{role:'assistant',content:'one'},{role:'assistant',content:'two'},{role:'user',content:'task'}];
  const result=injectBook(original,activation(),{historyStart:1,historyEnd:4});
  preserved(original,result.messages); assert.equal(result.messages.length,5);
  assert.deepEqual(result.messages.map(m=>m.role),['system','assistant','system','assistant','user']);
  assert.equal(result.placements[0].mode,'slot');
});

test('multimodal messages and historical attachments stay at original positions', () => {
  const image={type:'image_url',image_url:{url:'https://example.invalid/a.png'}};
  const original=[{role:'system',content:'rules'},{role:'user',content:[{type:'text',text:'old image'},image]},{role:'assistant',content:'seen'},{role:'user',content:[{type:'text',text:'task'}]}];
  const snapshot=structuredClone(original);
  const result=injectBook(original,activation(),{historyStart:1,historyEnd:4});
  assert.deepEqual(result.messages.map(m=>m.role),original.map(m=>m.role));
  assert.deepEqual(result.messages[1].content.slice(0,-1),original[1].content);
  assert.match(result.messages[1].content.at(-1).text,/LORE/);
  assert.equal(result.messages[3],original[3]); assert.deepEqual(original,snapshot);
});

test('outlets expand in place in system/user text and multimodal parts, without moving tasks', () => {
  const active=activation(7,{outletName:'slot'});
  const image={type:'image_url',image_url:{url:'test'}};
  const original=[{role:'system',content:'rules {{outlet::slot}}'}, {role:'assistant',content:'literal {{outlet::slot}}'}, {role:'user',content:[{type:'text',text:'do {{OUTLET::slot}} now'},image]}];
  const result=injectBook(original,active);
  assert.equal(result.messages.length,3); assert.equal(result.messages[1],original[1]);
  assert.match(result.messages[0].content,/rules [\s\S]*LORE/);
  assert.match(result.messages[2].content[0].text,/do [\s\S]*LORE[\s\S]* now/);
  assert.equal(result.messages[2].content[1],image);
  assert.deepEqual(result.placements[0].targets.map(p=>p.role),['system','user']);
  const unused=injectBook(history(),active); assert.deepEqual(unused.messages,history()); assert.equal(unused.placements[0].used,false);
});

test('empty and no-user requests gain no fabricated user; examples never become API dialogue', () => {
  assert.deepEqual(injectBook([], {entries:[],warnings:[]}).messages,[]);
  const original=[{role:'system',content:'task'}];
  const result=injectBook(original,activation(5,{content:'<START>\nAlice: hi\nBob: hello'}));
  preserved(original,result.messages); assert.equal(result.messages.length,1);
  assert.match(result.messages[0].content,/<example_dialogue>/);
  assert.equal(injectBook([],activation()).messages[0].role,'system');
});

// Load the real adapter with in-memory persistence/client boundaries. No database,
// network, model charges or test-only branches in production code.
const fixtureKey='__lorebookRoleTest';
const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;
const fixture = () => globalThis[fixtureKey];
const stateExpr=`globalThis.${fixtureKey}`;
const runtimeUrl=new URL('../src/services/lorebook/runtime.js',import.meta.url);
const substitutions={
  '../../db/lorebookRepository.js':stub(`export const createLorebookRepository=()=>({get:()=>${stateExpr}.book,previous:()=>({}),snapshot:()=>${stateExpr}.snapshot||null,commit:()=>${stateExpr}.commits++});`),
  '../../db/index.js':stub(`export const getDb=()=>({prepare:()=>({get:()=>${stateExpr}.world,all:()=>${stateExpr}.characters||[]})});`),
  '../../db/worldRepository.js':stub(`export const getActiveWorldSetting=()=>${stateExpr}.world;export const isWorldSettingHidden=()=>${stateExpr}.hidden;export const getSystemRules=()=>'';`),
  '../../config.js':stub('export const config={user:{nickname:"Alice"}};'),
  './vectors.js':stub(`export const recallLorebook=async(book,query)=>{${stateExpr}.vectorQuery=query;if(${stateExpr}.vectorError)throw new Error('vector unavailable');return ['0'];};`),
  '../../llm/llm-client.js':stub(`export const chatSync=async messages=>{${stateExpr}.captured=messages;return {content:'ok'}};export async function* chatStream(messages){${stateExpr}.captured=messages;yield 'ok';}`),
};
const runtimeSource=readFileSync(runtimeUrl,'utf8').replace(/(['"])(\.\.?\/[^'"]+)\1/g,(_,quote,path)=>JSON.stringify(substitutions[path]||new URL(path,runtimeUrl).href));
const runtime=await import(stub(runtimeSource));

test('runtime covers disabled, missing, hidden, inactive and active books, reapply and both clients', async t => {
  t.after(()=>{delete globalThis[fixtureKey]});
  const normalized=normalizeBook({entries:{0:{constant:true,position:4,role:1,depth:2,content:'LORE'}}});
  const book={enabled:true,worldId:1,revision:1,name:'test',settings:{...DEFAULT_SETTINGS},...normalized};
  for(const mode of ['opt-out','no-world','hidden','no-book','disabled','inactive','active']) {
    globalThis[fixtureKey]={world:mode==='no-world'?null:{id:1},hidden:mode==='hidden',book:mode==='no-book'?null:{...book,enabled:mode!=='disabled',document:mode==='inactive'?{entries:{}}:book.document},commits:0};
    const options=mode==='opt-out'?false:{scope:'chat:1',turnKey:'1',historyStart:1,historyEnd:4};
    const original=history(); const prepared=await runtime.prepareLorebook(original,options); preserved(original,prepared.messages);
    const recalled=[...history().slice(0,-1),{role:'user',content:'memory recall task'}];
    const reapplied=await prepared.reapply(recalled); preserved(recalled,reapplied);
    if(mode!=='active') { assert.equal(prepared.messages,original); assert.equal(reapplied,recalled); }
    await runtime.chatSync(original,{lorebook:options}); preserved(original,fixture().captured);
    for await (const chunk of runtime.chatStream(original,{lorebook:options})) assert.equal(chunk,'ok');
    preserved(original,fixture().captured);
    if(mode==='active') assert.ok(fixture().captured.some(m=>m.content.includes('LORE')));
  }
});

test('old activation snapshots are reclassified from unrendered source without rerolling',async t=>{
  t.after(()=>{delete globalThis[fixtureKey]});
  const document=normalizeBook({entries:{0:{uid:0,constant:true,content:'time {{time}}'},1:{uid:1,constant:true,content:'permanent'}}}).document;
  const snapshot=evaluateBook(document,{}, {now:'2026-10-17T01:00:00Z'});
  for(const entry of snapshot.entries)delete entry.cacheProfile;
  globalThis[fixtureKey]={world:{id:1},hidden:false,book:{enabled:true,worldId:1,revision:1,name:'test',settings:{...DEFAULT_SETTINGS},document},snapshot,commits:0};
  const original=history();
  const result=await runtime.prepareLorebook(original,{scope:'chat:1',turnKey:'same-turn',protectedPrefix:1});
  assert.equal(result.report.placements.find(p=>p.uid===0).cacheTier,'dynamic');
  assert.equal(result.report.placements.find(p=>p.uid===1).cacheTier,'stable');
  assert.match(result.messages[0].content,/permanent/);assert.doesNotMatch(result.messages[0].content,/time /);
  assert.ok(result.messages.at(-1).content.includes(snapshot.entries.find(e=>e.uid===0).content));
  preserved(original,result.messages);
});

test('runtime discovers saved persona boundaries and maps extra scan sources without rewriting layers',async t=>{
  t.after(()=>{delete globalThis[fixtureKey]});
  const persona='Alice has a long and recognizable character definition.';
  const world='<world_setting>\nWORLD_KEY\n</world_setting>';
  const document=normalizeBook({entries:{0:{uid:0,constant:true,position:0,content:'BEFORE'},1:{uid:1,constant:true,position:1,content:'AFTER'},2:{uid:2,key:['WORLD_KEY'],matchCreatorNotes:true,content:'WORLD_HIT'},3:{uid:3,key:['PERSONALITY_KEY'],matchCharacterPersonality:true,characterFilter:{names:['Alice']},content:'PERSONALITY_HIT'}}}).document;
  globalThis[fixtureKey]={world:{id:1,content:'WORLD_KEY'},hidden:false,characters:[{name:'Alice',display_name:'Alice',base_prompt:persona,short_prompt:'PERSONALITY_KEY'}],book:{enabled:true,worldId:1,revision:1,name:'test',settings:{...DEFAULT_SETTINGS},document},commits:0};
  const original=[{role:'system',content:world},{role:'system',content:persona+'\nEMOTION NOW'},{role:'user',content:'task'}];
  const prepared=await runtime.prepareLorebook(original,{dryRun:true});
  assert.match(prepared.messages[1].content,/BEFORE[\s\S]*Alice[\s\S]*AFTER[\s\S]*EMOTION NOW/);
  assert.match(prepared.messages[2].content,/WORLD_HIT[\s\S]*PERSONALITY_HIT[\s\S]*task/);
  preserved(original,prepared.messages);
  prepared.commit();assert.equal(fixture().commits,0);
});

test('zero keyword depth still queries vectors using its independent message count', async t => {
  t.after(()=>{delete globalThis[fixtureKey]});
  const document=normalizeBook({entries:{0:{uid:0,vectorized:true,content:'VECTOR'},1:{uid:1,key:['query'],content:'KEYWORD'}}}).document;
  globalThis[fixtureKey]={world:{id:1},book:{enabled:true,worldId:1,revision:1,settings:{...DEFAULT_SETTINGS,scanDepth:0,vectorQueryMessages:1},document},commits:0};
  const result=await runtime.prepareLorebook([{role:'system',content:'rules'},{role:'user',content:'query'}],{history:[{role:'user',content:'old'},{role:'user',content:'query'}]});
  assert.equal(fixture().vectorQuery,'query');
  assert.deepEqual(result.activation.entries.map(e=>e.uid),[0]);
  fixture().vectorError=true;
  fixture().book.settings.scanDepth=2;
  const fallback=await runtime.prepareLorebook([{role:'user',content:'query'}]);
  assert.deepEqual(fallback.activation.entries.map(e=>e.uid),[1]);
  assert.ok(fallback.report.warnings.some(w=>w.includes('vector unavailable')));
});

test('runtime abandons a hung regex without rewriting messages or committing effects', async t => {
  t.after(()=>{delete globalThis[fixtureKey]});
  const document=normalizeBook({entries:{0:{key:['/(a+)+$/'],content:'LORE'}}}).document;
  globalThis[fixtureKey]={world:{id:1},book:{enabled:true,worldId:1,revision:1,settings:{...DEFAULT_SETTINGS},document},commits:0};
  const original=[{role:'user',content:'a'.repeat(40)+'!'}];
  const result=await runtime.prepareLorebook(original,{scope:'char_1',turnKey:'turn'});
  assert.equal(result.messages,original);
  assert.ok(result.report.warnings.some(w=>w.includes('超时')));
  result.commit();
  assert.equal(fixture().commits,0);
});
