import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBook, evaluateBook } from '../src/services/lorebook/engine.js';
import { runLorebookTask } from '../src/services/lorebook/workerClient.js';

test('pathological imported keyword and replacement regexes time out without blocking the event loop', async () => {
  const document=normalizeBook({entries:{0:{key:['/(a+)+$/'],content:'lore'}}}).document;
  let ticks=0;
  const timer=setInterval(()=>ticks++,20);
  try {
    await assert.rejects(runLorebookTask('evaluate',[document,{}, {history:[{role:'user',content:'a'.repeat(40)+'!'}]},{}],{timeoutMs:500}), /超时/);
    assert.ok(ticks>=3, `main thread heartbeat: ${ticks}`);
    const activation=evaluateBook(normalizeBook({entries:{0:{constant:true,content:'a'.repeat(40)+'!'}}}).document,{});
    await assert.rejects(runLorebookTask('layout',[[{role:'user',content:'go'}],activation,{regexRules:[{pattern:'(a+)+$',replacement:'x'}]}],{timeoutMs:500}), /超时/);
    const normal=normalizeBook({entries:{0:{key:['/(?<=city )hall/i'],content:'safe'}}}).document;
    const result=await runLorebookTask('evaluate',[normal,{}, {history:[{role:'user',content:'City Hall'}]},{}]);
    assert.equal(result.entries.length,1,'worker capacity is restored; JS regex semantics preserved');
  } finally {clearInterval(timer);}
});

test('worker layout preserves multimodal attachments and source messages', async () => {
  const messages=[{role:'system',content:'rules'},{role:'user',content:[{type:'image_url',image_url:{url:'test://image'}},{type:'text',text:'task'}]}];
  const before=structuredClone(messages);
  const activation=evaluateBook(normalizeBook({entries:{0:{constant:true,content:'foo'}}}).document,{});
  const result=await runLorebookTask('layout',[messages,activation,{regexRules:[{pattern:'foo',replacement:'bar'}]}]);
  assert.deepEqual(messages,before);
  assert.deepEqual(result.messages.at(-1).content.find(p=>p.type==='image_url'),before.at(-1).content[0]);
  assert.match(result.messages[0].content,/bar/);
});
