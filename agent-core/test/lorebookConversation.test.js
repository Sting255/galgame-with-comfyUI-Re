import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { migrateLorebooks, createLorebookRepository } from '../src/db/lorebookRepository.js';
import { buildConversationLorebookContext } from '../src/services/lorebook/conversationContext.js';

const stub=source=>`data:text/javascript,${encodeURIComponent(source)}`;
const runtimeUrl=new URL('../src/services/lorebook/runtime.js',import.meta.url);
const key='__lorebookConversationTest';
const substitutions={
  '../../db/index.js':stub(`export const getDb=()=>globalThis.${key};`),
  '../../db/worldRepository.js':stub(`export const getActiveWorldSetting=()=>({id:1,content:''});export const isWorldSettingHidden=()=>false;export const getSystemRules=()=>'';`),
  '../../config.js':stub('export const config={user:{nickname:"Bob"}};'),
};
const source=readFileSync(runtimeUrl,'utf8').replace(/(['"])(\.\.?\/[^'"]+)\1/g,(_,quote,path)=>JSON.stringify(substitutions[path]||new URL(path,runtimeUrl).href));
const {prepareLorebook}=await import(stub(source));

test('ordinary, proactive, wake and delayed replies share durable effects, variables and logical message steps',async t=>{
  const db=new Database(':memory:');
  globalThis[key]=db;
  t.after(()=>{db.close();delete globalThis[key];});
  db.exec(`CREATE TABLE world_settings(id INTEGER PRIMARY KEY);
    INSERT INTO world_settings VALUES(1);
    CREATE TABLE characters(id INTEGER PRIMARY KEY,name TEXT,display_name TEXT,base_prompt TEXT,short_prompt TEXT);
    CREATE TABLE raw_messages(id INTEGER PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT);`);
  migrateLorebooks(db);
  const repo=createLorebookRepository(db);
  repo.save(1,{document:{entries:{0:{uid:0,key:['seed'],sticky:4,cooldown:2,content:'FLAG {{setvar::x::rain}}',order:200},1:{uid:1,constant:true,content:'weather={{getvar::x}}',order:100}}}});
  const character={id:1,name:'alice',display_name:'Alice',base_prompt:'Alice has a stable character definition.'};
  const insert=(role,content)=>db.prepare('INSERT INTO raw_messages(conversation_id,role,content) VALUES(?,?,?)').run('char_1',role,content).lastInsertRowid;
  insert('user','seed');
  const messages=[{role:'system',content:character.base_prompt},{role:'user',content:'temporary task'}];
  let step=1;
  for(const kind of ['chat','proactive','wake:phone','delayed']) {
    const context=buildConversationLorebookContext(db,{conversationId:'char_1',character,kind,userName:'Bob'});
    assert.equal(context.step,step++);
    assert.equal(context.history[0].name,'Bob');
    if(kind!=='chat')assert.equal(context.history.at(-1).name,'Alice');
    const prepared=await prepareLorebook(messages,context);
    assert.equal(prepared.activation.entries.find(e=>e.uid===0).reason,kind==='chat'?'keyword':'sticky');
    assert.equal(prepared.activation.entries.find(e=>e.uid===1).content,'weather=rain');
    const before=db.prepare('SELECT COUNT(*) AS n FROM world_lorebook_runs').get().n;
    assert.equal(before,context.step-1,'preparation alone never commits');
    assert.equal(buildConversationLorebookContext(db,{conversationId:'char_1',character,kind}).turnKey,context.turnKey,'retry key remains stable before persistence');
    insert('assistant','reply');
    prepared.commit();
    prepared.commit();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM world_lorebook_runs').get().n,before+1);
  }
  insert('user','seed'); // step 6: sticky has ended, cooldown remains active.
  const normal=buildConversationLorebookContext(db,{conversationId:'char_1',character,kind:'chat'});
  const cooled=await prepareLorebook(messages,normal);
  assert.equal(cooled.activation.entries.some(e=>e.uid===0),false);
  assert.equal(cooled.activation.entries[0].content,'weather=rain');
  assert.ok(cooled.activation.trace.some(e=>e.reason==='cooldown'));
  const dry=await prepareLorebook(messages,{...normal,dryRun:true});
  dry.commit();
  assert.equal(repo.snapshot(1,'char_1',normal.turnKey,1),null);
  const other=buildConversationLorebookContext(db,{conversationId:'char_2',character:{...character,id:2},kind:'wake:door'});
  assert.equal(other.step,0);
  assert.equal((await prepareLorebook(messages,other)).activation.nextState.variables.x,undefined);
});
