import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateLorebooks,createLorebookRepository } from '../src/db/lorebookRepository.js';

test('one book per world, revision concurrency, independent state and cascade deletion',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  try{
    db.exec('CREATE TABLE world_settings(id INTEGER PRIMARY KEY);INSERT INTO world_settings VALUES(1),(2)');migrateLorebooks(db);migrateLorebooks(db);
    const repo=createLorebookRepository(db);const document={entries:{0:{uid:0,content:'test',constant:true}}};
    const a=repo.save(1,{name:'A',document}).book;repo.save(2,{name:'B',document});
    assert.equal(repo.get(1).name,'A');assert.equal(repo.get(2).name,'B');
    assert.throws(()=>repo.save(1,{document,expectedRevision:0}),/其他窗口/);
    repo.commit(a,'chat:1','turn1',1,{nextState:{x:1},entries:[]});repo.commit(a,'chat:1','turn1',1,{nextState:{x:2}});
    assert.deepEqual(repo.previous(1,'chat:1',2,1),{x:1});assert.deepEqual(repo.previous(2,'chat:1',2,1),{});
    const updated=repo.save(1,{document,expectedRevision:1}).book;
    repo.commit(updated,'chat:1','turn1',1,{nextState:{x:3},entries:[]});
    assert.deepEqual(repo.previous(1,'chat:1',2,2),{x:3});
    repo.commit(a,'chat:1','turn1',1,{nextState:{x:4},entries:[]});
    assert.deepEqual(repo.previous(1,'chat:1',2,2),{x:3});
    repo.rewind('chat:1',1);assert.equal(repo.snapshot(1,'chat:1','turn1',1),null);
    db.prepare('DELETE FROM world_settings WHERE id=1').run();assert.equal(repo.get(1),null);assert.equal(repo.get(2).name,'B');
  }finally{db.close()}
});
