import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCacheEntry } from '../src/services/lorebook/cachePolicy.js';
import { normalizeBook, evaluateBook } from '../src/services/lorebook/engine.js';
import { applyLorebookLayout } from '../src/services/lorebook/layout.js';

const document=entries=>normalizeBook({entries:Object.fromEntries(entries.map((entry,uid)=>[uid,{uid,content:`entry ${uid}`,position:4,depth:99,...entry}]))}).document;
const run=(doc,history=[],settings={},context={},options={})=>evaluateBook(doc,settings,{history,...context},{},options);
const strip=text=>text.replace(/\n\n<worldbook>\n[\s\S]*?\n<\/worldbook>\n\n/g,'');

test('constant flag alone does not certify a stable prefix',()=>{
  const fixed={constant:true,probability:100,content:'world law {{newline}}'};
  assert.equal(classifyCacheEntry(fixed).tier,'stable');
  for(const change of [{constant:false},{probability:50},{group:'one-of'},{triggers:['normal']},{characterFilter:{names:['Alice']}},{characterFilter:{tags:['town']}},{sticky:1},{cooldown:1},{delay:1},{delayUntilRecursion:1},{vectorized:true},...['time','date','random::a::b','pick::a::b','lastmessage','getvar::x','setvar::x::y','outlet::x','char','user','unknown'].map(m=>({content:`{{${m}}}`}))]) {
    assert.equal(classifyCacheEntry({...fixed,...change}).tier,'dynamic',JSON.stringify(change));
  }
  assert.equal(classifyCacheEntry({...fixed,probability:1,useProbability:false}).tier,'stable');
});

test('private constant lore is stable before all history while keywords and time macros stay in final user',()=>{
  const doc=document([{constant:true,content:'PERMANENT',order:10},{key:['hit'],content:'CONDITIONAL',order:1000},{constant:true,content:'CLOCK {{time}}'}]);
  const make=(word,time)=>{
    const activeSegments=['[Alice]: old','[Bob]: reply'];
    const original=[{role:'system',content:'base world'},{role:'system',content:'persona'},{role:'user',content:'old checkpoint'},{role:'assistant',content:'old answer'},{role:'user',content:`<dynamic_context>\n<active_chat_history>\n${activeSegments.join('\n')}\n</active_chat_history>\ntime ${time}\n</dynamic_context>\n\n${word}`}];
    const active=run(doc,[{role:'user',content:word}],{}, {now:time});
    const result=applyLorebookLayout(original,active,{cachePlacement:true,protectedPrefix:2,activeSegments,historyStart:2,historyEnd:5});
    assert.deepEqual(result.messages.map(m=>({...m,content:strip(m.content)})),original);
    assert.equal(result.messages.length,original.length);
    return result;
  };
  const a=make('hit','2026-10-17T01:00:00Z'); const b=make('miss','2026-10-18T02:00:00Z');
  assert.match(a.messages[0].content,/PERMANENT[\s\S]*base world/);
  assert.deepEqual(a.messages.slice(0,-1),b.messages.slice(0,-1));
  assert.equal(a.stableLoreHash,b.stableLoreHash);
  assert.match(a.messages.at(-1).content,/CONDITIONAL/);assert.doesNotMatch(b.messages.at(-1).content,/CONDITIONAL/);
  assert.doesNotMatch(a.messages[0].content,/CLOCK|CONDITIONAL/);
});

test('group transcript stays intact and conditional lore is placed in the directive user',()=>{
  const doc=document([{constant:true,content:'PERMANENT'},{constant:true,probability:50,content:'RANDOM'}]);
  const transcriptSegments=['[Alice]: one','[Bob]: two'];
  const original=[{role:'system',content:'world'},{role:'system',content:'protocol'},{role:'system',content:'members'},{role:'user',content:`<group_transcript>\n${transcriptSegments.join('\n')}\n</group_transcript>`},{role:'user',content:'continue'}];
  const assemble=random=>applyLorebookLayout(original,run(doc,[],{}, {},{random}),{cachePlacement:true,protectedPrefix:3,transcriptSegments});
  const hit=assemble(()=>0);const miss=assemble(()=>.9);
  assert.deepEqual(hit.messages.slice(0,-1),miss.messages.slice(0,-1));
  assert.equal(hit.messages[3],original[3]);assert.match(hit.messages[0].content,/PERMANENT/);
  assert.match(hit.messages.at(-1).content,/RANDOM/);assert.equal(miss.messages.at(-1),original.at(-1));
});

test('generic creative and moments calls keep stable lore ahead of unknown variable first-system text',()=>{
  const doc=document([{constant:true,content:'PERMANENT'},{key:['hit'],content:'CONDITIONAL'}]);
  for(const first of ['world rules','variable timestamp 01:00 and mixed task data']) {
    const original=[{role:'system',content:first},{role:'system',content:'post, persona and memories'},{role:'user',content:'hit: publish/reply'}];
    const result=applyLorebookLayout(original,run(doc,[original.at(-1)]),{cachePlacement:true});
    assert.match(result.messages[0].content,/^\n\n<worldbook>\nPERMANENT/);
    assert.match(result.messages.at(-1).content,/CONDITIONAL/);assert.equal(result.messages[1],original[1]);
    assert.deepEqual(result.messages.map(m=>({...m,content:strip(m.content)})),original);
  }
});

test('stable residents win budget before conditional hits, independent of keyword activity or priority',()=>{
  const doc=document([{constant:true,content:'aaaa',order:1},{key:['hit'],content:'bbbb',order:999}]);
  const settings={budgetCap:8};const options={countTokens:text=>text.length};
  const active=run(doc,[{role:'user',content:'hit'}],settings,{},options);
  const inactive=run(doc,[{role:'user',content:'miss'}],settings,{},options);
  assert.deepEqual(active.entries.map(e=>e.uid),[0]);assert.deepEqual(inactive.entries.map(e=>e.uid),[0]);
  const anchored=run(doc,[{role:'user',content:'hit'}],{...settings,positionPolicy:'anchors'},{},options);
  assert.deepEqual(anchored.entries.map(e=>e.uid),[1]);
  assert.equal(run(doc,[],settings,{availableTokens:1},options).entries.length,0);
});

test('cache mode maps every position, anchor mode still honors depth and source roles remain unchanged',()=>{
  for(const position of [0,1,2,3,4,5,6]) {
    const doc=document([{constant:true,position,role:2,content:'PERMANENT'},{constant:false,key:['hit'],position,role:1,content:'CONDITIONAL'}]);
    const snapshot=structuredClone(doc);
    const original=[{role:'system',content:'rules'},{role:'user',content:'old'},{role:'assistant',content:'reply'},{role:'user',content:'hit'}];
    const active=run(doc,[original.at(-1)]);
    const result=applyLorebookLayout(original,active,{cachePlacement:true,historyStart:1,historyEnd:4});
    assert.match(result.messages[0].content,/PERMANENT/);assert.doesNotMatch(result.messages[0].content,/CONDITIONAL/);
    assert.match(result.messages.at([5,6].includes(position)?-2:-1).content,/CONDITIONAL/);assert.deepEqual(doc,snapshot);
  }
  const doc=document([{constant:true,depth:0,content:'PERMANENT'}]);
  const original=[{role:'system',content:'rules'},{role:'user',content:'task'}];
  const result=applyLorebookLayout(original,run(doc),{cachePlacement:false,historyStart:1,historyEnd:2});
  assert.equal(result.messages[0],original[0]);assert.match(result.messages[1].content,/PERMANENT/);
});

test('conditional Outlet never mutates the prefix on hit/miss and unused Outlets stay unused',()=>{
  const doc=document([{position:7,outletName:'variable',key:['hit'],content:'CONDITIONAL'},{constant:true,position:7,outletName:'fixed',content:'REFERENCED'},{constant:true,position:7,outletName:'unused',content:'UNUSED'},{constant:true,content:'PERMANENT'}]);
  const make=word=>{
    const original=[{role:'system',content:'rules {{outlet::variable}}'},{role:'user',content:`{{outlet::fixed}} ${word}`}];
    return applyLorebookLayout(original,run(doc,[original.at(-1)]),{cachePlacement:true,protectedPrefix:1});
  };
  const hit=make('hit');const miss=make('miss');
  assert.equal(hit.messages[0].content,miss.messages[0].content);
  assert.match(hit.messages[0].content,/PERMANENT/);assert.match(hit.messages[0].content,/\{\{outlet::variable\}\}/);
  assert.doesNotMatch(hit.messages[0].content,/CONDITIONAL/);assert.match(hit.messages.at(-1).content,/CONDITIONAL/);
  assert.doesNotMatch(hit.messages[0].content,/REFERENCED/);assert.match(hit.messages.at(-1).content,/REFERENCED/);
  const withoutReference=applyLorebookLayout([{role:'system',content:'rules {{outlet::variable}}'},{role:'user',content:'miss'}],run(doc,[{role:'user',content:'miss'}]),{cachePlacement:true,protectedPrefix:1});
  assert.equal(withoutReference.messages[0].content,miss.messages[0].content);
  assert.equal(hit.placements.find(p=>p.uid===2).used,false);
  assert.ok(hit.messages.every(m=>!m.content.includes('UNUSED')));
});
