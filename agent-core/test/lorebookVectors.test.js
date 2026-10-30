import test from 'node:test';
import assert from 'node:assert/strict';
import { createLorebookVectorStore } from '../src/services/lorebook/vectorStore.js';

const book = (entries=[{uid:1,content:'one'},{uid:2,content:'two'}]) => ({worldId:1,revision:1,settings:{vectorAll:true},document:{entries:Object.fromEntries(entries.map(e=>[e.uid,e]))}});

test('cold queries return immediately, concurrent callers share background work and edits reuse embeddings', async () => {
  let release;
  const batches=[];
  const gate=new Promise(resolve=>release=resolve);
  const store=createLorebookVectorStore({embedBatch:async texts=>{batches.push(texts);await gate;return texts.map(()=>[1,0]);},embedText:async()=>[1,0]});
  const original=book();
  await assert.rejects(store.recall(original,'query'),/后台准备/);
  const first=store.warm(original), second=store.warm(original);
  assert.equal(first,second);
  assert.equal(batches.length,1);
  release();
  await first;
  assert.deepEqual(await store.recall(original,'query'),['1','2']);
  await store.warm({...original,revision:2});
  assert.equal(batches.length,1,'revision-only changes do not reindex');
  const changed=book([{uid:1,content:'one'},{uid:3,content:'three'}]);
  await store.warm(changed);
  assert.deepEqual(batches,[['one','two'],['three']]);
  assert.deepEqual(await store.recall(changed,'query'),['1','3']);
  const remapped=book([{uid:99,content:'one'}]);
  await store.warm(remapped);
  assert.deepEqual(await store.recall(remapped,'query'),['99']);
  assert.equal(batches.length,2);
});

test('query deadlines abort the provider and background deadlines recover for retry', async () => {
  let querySignal, indexSignal, failIndex=true;
  const querying=createLorebookVectorStore({queryTimeoutMs:40,embedBatch:async texts=>texts.map(()=>[1,0]),embedText:async(_,{signal})=>{querySignal=signal;return new Promise(()=>{});}});
  await querying.warm(book());
  await assert.rejects(querying.recall(book(),'query'),/超时/);
  assert.equal(querySignal.aborted,true);
  const indexing=createLorebookVectorStore({indexTimeoutMs:40,retryMs:0,embedBatch:async(texts,{signal})=>{indexSignal=signal;return failIndex?new Promise(()=>{}):texts.map(()=>[1,0]);},embedText:async()=>[1,0]});
  await assert.rejects(indexing.warm(book()),/超时/);
  assert.equal(indexSignal.aborted,true);
  failIndex=false;
  await indexing.warm(book());
  assert.deepEqual(await indexing.recall(book(),'query'),['1','2']);
});

test('invalid vectors fail safely and disabled entries never enter the index', async () => {
  const batches=[];
  const store=createLorebookVectorStore({embedBatch:async texts=>{batches.push(texts);return texts.map(()=>[1,0]);},embedText:async()=>undefined});
  const input=book([{uid:1,content:'enabled'},{uid:2,content:'disabled',disable:true}]);
  await store.warm(input);
  assert.deepEqual(batches,[['enabled']]);
  await assert.rejects(store.recall(input,'query'),/格式无效/);
});
