import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBook,evaluateBook} from '../src/services/lorebook/engine.js';
import {applyLorebookLayout} from '../src/services/lorebook/layout.js';
import {buildPromptProfile} from '../src/services/lorebook/promptProfile.js';

const world='<world_setting>WORLD</world_setting>';
const book=entries=>normalizeBook({entries:Object.fromEntries(entries.map((e,uid)=>[uid,{uid,constant:true,content:`LORE_${uid}`,position:uid,...e}]))}).document;
const active=entries=>evaluateBook(book(entries),{}, {history:[{role:'user',content:'hit'}]});
const withoutLore=messages=>messages.filter(m=>!/^<worldbook>/.test(m.content)).map(m=>({...m,content:m.content.replace(/\n\n<worldbook>\n[\s\S]*?\n<\/worldbook>\n\n/g,'')}));

test('private world and persona before/after are distinct cache-safe offsets, ahead of buffs/history',()=>{
  const original=[{role:'system',content:`RULES\n${world}`},{role:'system',content:'PERSONA\nBUFF NOW'},{role:'system',content:'SUMMARY NOW'},{role:'user',content:'<dynamic_context>history</dynamic_context>task'}];
  const result=applyLorebookLayout(original,active([{}, {}, {}, {}, {depth:4}, {order:999}, {order:1}]),{cachePlacement:true,personaTexts:['PERSONA'],staticTexts:['RULES',world],worldText:world});
  assert.match(result.messages[0].content,/RULES[\s\S]*LORE_2[\s\S]*WORLD[\s\S]*LORE_3/);
  assert.match(result.messages[1].content,/LORE_0[\s\S]*PERSONA[\s\S]*LORE_1[\s\S]*BUFF NOW/);
  assert.match(result.messages[1].content,/LORE_5[\s\S]*LORE_6[\s\S]*BUFF NOW/);
  assert.match(result.messages[1].content,/LORE_4[\s\S]*BUFF NOW/);
  assert.deepEqual(withoutLore(result.messages),original);
  assert.ok(result.placements.every(p=>p.role==='system' && p.actualAnchor));
});

test('group card anchors precede summary and transcript; activation changes leave original prefix intact',()=>{
  const doc=book([{position:0},{position:1},{position:5,constant:false,key:['hit']}]);
  const build=word=>{
    const original=[{role:'system',content:world},{role:'system',content:'PROTOCOL'},{role:'system',content:'GROUP CARD'},{role:'system',content:'SUMMARY'},{role:'user',content:'<group_transcript>old</group_transcript>'},{role:'user',content:word}];
    const activation=evaluateBook(doc,{}, {history:[{role:'user',content:word}]});
    const result=applyLorebookLayout(original,activation,{cachePlacement:true,personaTexts:['GROUP CARD'],cacheBoundary:{index:2,offset:10}});
    assert.deepEqual(withoutLore(result.messages),original);
    return result;
  };
  const hit=build('hit'), miss=build('miss');
  assert.deepEqual(hit.messages.slice(0,5),miss.messages.slice(0,5));
  assert.match(hit.messages[2].content,/LORE_0[\s\S]*GROUP CARD[\s\S]*LORE_1/);
  assert.equal(hit.messages.at(-2).role,'system');
  assert.match(hit.messages.at(-2).content,/LORE_2/);
});

test('moments persona preceded by post data is clamped before that data only in cache mode',()=>{
  const original=[{role:'system',content:world},{role:'system',content:'POST DATA'},{role:'system',content:'PERSONA'},{role:'user',content:'reply'}];
  const activation=active([{position:0},{position:1}]);
  const options={worldText:world,personaTexts:['PERSONA']};
  const cache=applyLorebookLayout(original,activation,{...options,cachePlacement:true});
  assert.match(cache.messages[0].content,/WORLD[\s\S]*LORE_0[\s\S]*LORE_1/);
  assert.equal(cache.messages[2],original[2]);
  const anchored=applyLorebookLayout(original,activation,options);
  assert.match(anchored.messages[2].content,/LORE_0[\s\S]*PERSONA[\s\S]*LORE_1/);
  assert.deepEqual(withoutLore(cache.messages),original);
});

test('examples use preceding system or a lore-only slot, before group ordering overrides entry priority',()=>{
  for(const role of ['system','assistant','user']) {
    const original=[{role,content:'context'},{role:'user',content:'task'}];
    const result=applyLorebookLayout(original,active([{position:6,order:1},{position:5,order:999}]),{});
    const carrier=result.messages.at(-2);
    assert.equal(carrier.role,'system');
    assert.match(carrier.content,/LORE_1[\s\S]*LORE_0/);
    assert.equal(result.messages.at(-1),original.at(-1));
    assert.deepEqual(withoutLore(result.messages),original);
  }
});

test('no persona/world and no system are explicit fallbacks, never fabricate a user',()=>{
  const original=[{role:'user',content:'task'}];
  const profile=buildPromptProfile(original);
  assert.match(profile.anchors.beforeCharacter.label,/未提供/);
  const result=applyLorebookLayout(original,active([{position:0}]),{cachePlacement:true});
  assert.deepEqual(result.messages.map(m=>m.role),['system','user']);
  assert.equal(result.messages.at(-1),original[0]);
});

test('ST vector selection keeps keyword fallback, group scoring includes constant/vector candidates',()=>{
  let doc=book([{constant:false,vectorized:true,key:['hit']}]);
  assert.equal(evaluateBook(doc,{}, {history:[{role:'user',content:'hit'}]}).entries[0].reason,'keyword');
  assert.equal(evaluateBook(doc,{}, {vectorIds:['0']}).entries[0].reason,'vector');
  doc=book([{group:'g',useGroupScoring:true,key:['hit']},{group:'g',useGroupScoring:true,key:['miss'],groupOverride:true}]);
  assert.deepEqual(evaluateBook(doc,{}, {history:[{role:'user',content:'hit'}]}).entries.map(e=>e.uid),[0]);
});

test('character-book extensions retain character filter and extra scan sources are opt-in',()=>{
  const doc=normalizeBook({character_book:{entries:[{id:0,keys:['WORLD'],content:'x',extensions:{character_filter:{names:['Alice']},match_creator_notes:true}}]}}).document;
  assert.equal(evaluateBook(doc,{}, {characterName:'Alice',creatorNotes:'WORLD'}).entries.length,1);
  assert.equal(evaluateBook(doc,{}, {characterName:'Bob',creatorNotes:'WORLD'}).entries.length,0);
  assert.equal(evaluateBook(doc,{}, {characterName:'Alice'}).entries.length,0);
});

test('persona in final user has real anchor-mode offsets but stays out of the cache prefix',()=>{
  const original=[{role:'system',content:'RULES'},{role:'user',content:'facts\nPERSONA\ntask'}];
  const options={staticTexts:['RULES'],personaTexts:['PERSONA']};
  const activation=active([{position:0},{position:1}]);
  const anchor=applyLorebookLayout(original,activation,options);
  assert.match(anchor.messages[1].content,/facts[\s\S]*LORE_0[\s\S]*PERSONA[\s\S]*LORE_1[\s\S]*task/);
  const cache=applyLorebookLayout(original,activation,{...options,cachePlacement:true});
  assert.equal(cache.messages[1],original[1]);
  assert.match(cache.messages[0].content,/RULES[\s\S]*LORE_0[\s\S]*LORE_1/);
});

test('multimodal system content cannot accidentally certify later personas as static',()=>{
  const image={type:'image_url',image_url:{url:'test://variable'}};
  const original=[{role:'system',content:[{type:'text',text:'variable observation'},image]},{role:'system',content:'PERSONA'},{role:'user',content:'task'}];
  const result=applyLorebookLayout(original,active([{position:1}]),{personaTexts:['PERSONA'],cachePlacement:true});
  assert.match(result.messages[0].content[0].text,/LORE_0/);
  assert.deepEqual(result.messages[0].content.slice(1),original[0].content);
  assert.equal(result.messages[1],original[1]);
});
