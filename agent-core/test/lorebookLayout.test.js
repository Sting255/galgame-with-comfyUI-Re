import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBook, evaluateBook, injectBook } from '../src/services/lorebook/engine.js';
import { applyLorebookLayout } from '../src/services/lorebook/layout.js';
const activation=(position=4,depth=2)=>evaluateBook(normalizeBook({entries:{0:{uid:0,constant:true,position,depth,content:'LORE'}}}).document,{},{});
const stripLore=text=>text.replace(/\n\n<worldbook>\n[\s\S]*?\n<\/worldbook>\n\n/g,'');

test('private depth uses offsets inside active history, including multiline duplicate messages',()=>{
  const activeSegments=['[Alice]: same\nsecond line','[Bob]: same\nsecond line'];
  const original=[{role:'system',content:'stable'},{role:'user',content:`<dynamic_context>\n<active_chat_history>\n${activeSegments.join('\n')}\n</active_chat_history>\nweather\n</dynamic_context>\n\nnew`}];
  const options={activeSegments,historyStart:1,historyEnd:2};
  for(const depth of [0,1,2,3,4,100]) {
    const result=applyLorebookLayout(original,activation(4,depth),options);
    assert.equal(result.messages.length,2);assert.deepEqual(result.messages.map(m=>m.role),['system','user']);
    assert.deepEqual(result.messages.map(m=>({...m,content:stripLore(m.content)})),original);
    assert.equal(result.messages[0],original[0]);
    const text=result.messages[1].content;
    if(depth<=1) assert.match(text,/weather[\s\S]*LORE[\s\S]*<\/dynamic_context>\n\nnew$/);
    if(depth===2) assert.match(text,/\[Alice\]: same\nsecond line[\s\S]*LORE[\s\S]*\[Bob\]: same\nsecond line/);
    assert.deepEqual(applyLorebookLayout(original,activation(4,depth),options),result);
  }
});

test('group depth edits the existing transcript user and keeps the directive user untouched',()=>{
  const transcriptSegments=['A: hello\nline two','B: hi'];
  const original=[{role:'system',content:'protocol'},{role:'user',content:`<group_transcript>\n${transcriptSegments.join('\n')}\n</group_transcript>`},{role:'user',content:'directive'}];
  for(const depth of [0,1,2,100]) {
    const result=applyLorebookLayout(original,activation(4,depth),{transcriptSegments});
    assert.deepEqual(result.messages.map(m=>m.role),['system','user','user']);
    assert.equal(result.messages[2],original[2]);
    assert.deepEqual(result.messages.map(m=>({...m,content:stripLore(m.content)})),original);
    if(depth===0) assert.match(result.messages[1].content,/B: hi[\s\S]*LORE[\s\S]*<\/group_transcript>$/);
    if(depth===1) assert.match(result.messages[1].content,/line two[\s\S]*LORE[\s\S]*B: hi/);
  }
});

test('inactive books preserve original message array identity, including multiple users and assistants',()=>{
  const original=[{role:'system',content:'stable'},{role:'user',content:'history'},{role:'assistant',content:'answer'},{role:'user',content:'task'}];
  assert.equal(applyLorebookLayout(original,{entries:[],warnings:[]},{}).messages,original);
});

test('cache mapping fronts stable lore, while explicit anchors edit existing character layer',()=>{
  const original=[{role:'system',content:'rules'},{role:'system',content:'character'},{role:'assistant',content:'history'},{role:'user',content:'<dynamic_context>weather</dynamic_context>\n\nnew'}];
  const native=applyLorebookLayout(original,activation(0),{anchors:{beforeCharacter:1}});
  const cached=applyLorebookLayout(original,activation(0),{anchors:{beforeCharacter:1},cachePlacement:true});
  assert.match(native.messages[1].content,/LORE[\s\S]*character$/);
  assert.deepEqual(cached.messages.slice(1),original.slice(1));
  assert.match(cached.messages[0].content,/LORE[\s\S]*rules/);
  assert.equal(cached.placements[0].mode,'inline');assert.ok(cached.placements[0].mapped);
});

test('moments front stable lore in the existing first system and retain all other layers',()=>{
  const original=[{role:'system',content:'world'},{role:'system',content:'posting format'},{role:'system',content:'persona'},{role:'system',content:'post and memories'},{role:'user',content:'reply to this post'}];
  for(const position of [0,1,2,3,4,5,6]) {
    const result=applyLorebookLayout(original,activation(position),{cachePlacement:true});
    assert.equal(result.messages.length,original.length);
    assert.deepEqual(result.messages.slice(1),original.slice(1));
    assert.equal(stripLore(result.messages[0].content),original[0].content);
  }
});

test('mismatched envelope metadata never splits or loses original history',()=>{
  const original=[{role:'system',content:'stable'},{role:'user',content:'<active_chat_history>original</active_chat_history>task'}];
  const result=applyLorebookLayout(original,activation(),{activeSegments:['different']});
  assert.deepEqual(result.messages.map(m=>({...m,content:stripLore(m.content)})),original);
});

test('ignoreBudget never bypasses the total request context limit',()=>{
  const doc=normalizeBook({entries:{0:{uid:0,constant:true,ignoreBudget:true,content:'x'.repeat(100)}}}).document;
  const result=evaluateBook(doc,{}, {availableTokens:1});
  assert.equal(result.entries.length,0);assert.equal(result.trace[0].reason,'context-limit');
});

test('example entries stay as text inside existing user, not independent conversation turns',()=>{
  const document=normalizeBook({entries:{0:{constant:true,position:5,content:'<START>\nAlice: hello\nBob: welcome\ncome in'}}}).document;
  const original=[{role:'system',content:'rules'},{role:'user',content:'new'}];
  const result=injectBook(original,evaluateBook(document,{},{}));
  assert.deepEqual(result.messages.map(m=>m.role),['system','user']);
  assert.match(result.messages[1].content,/<example_dialogue>\n<START>\nAlice: hello\nBob: welcome\ncome in\n<\/example_dialogue>/);
  assert.equal(stripLore(result.messages[1].content),'new');
});
