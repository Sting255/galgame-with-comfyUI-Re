import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeDb, initSchema, getSchemaVersion, SCHEMA_VERSION } from '../src/db/index.js';
import { runSchemaMigrations, prepareMigrationSnapshot, finishMigrationSnapshot } from '../src/db/migrations/runner.js';

const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();

test('全新库结构与拆分前基线一致，重复启动不改变结构或用户数据', t => {
  const db = getDb();
  t.after(closeDb);
  assert.equal(db.name, ':memory:');
  const before = schema(db);
  db.prepare("INSERT INTO characters (name,display_name,base_prompt,short_prompt) VALUES ('fixture','迁移样本','personality','short')").run();
  const count = db.prepare('SELECT COUNT(*) n FROM characters').get().n;
  initSchema(db);
  initSchema(db);
  assert.deepEqual(schema(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM characters').get().n, count);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
  // 原迁移顺序生成的结构摘要；结构调整必须通过新的版本化迁移明确更新基线。
  assert.equal(createHash('sha256').update(JSON.stringify(before)).digest('hex'), 'ca007fdc4a897d5cbb48c928225c40d85fbd9455e4828dded115ad9ce51a9fc5');
});

test('后续迁移 DDL 与数据原子回滚，版本不前移，修复后可重试', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const first = { version: 1, description: '合成基线', up: db => db.exec('CREATE TABLE records(value TEXT); INSERT INTO records VALUES (\'original\')') };
  const failing = { version: 2, description: '合成失败', up: db => { db.exec("ALTER TABLE records ADD COLUMN added TEXT; UPDATE records SET value='changed'"); throw new Error('fixture failure'); } };
  assert.throws(() => runSchemaMigrations(db, { migrations: [first, failing] }), /迁移 2.*合成失败.*fixture failure/);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.deepEqual(db.pragma('table_info(records)').map(c => c.name), ['value']);
  assert.equal(db.prepare('SELECT value FROM records').pluck().get(), 'original');
  const second = { version: 2, description: '合成修复', up: db => db.exec('ALTER TABLE records ADD COLUMN added TEXT') };
  assert.deepEqual(runSchemaMigrations(db, { migrations: [first, second] }).applied, [2]);
  assert.deepEqual(runSchemaMigrations(db, { migrations: [first, second] }).applied, []);
});

test('首次旧库迁移先留一致快照，仅成功迁移后保留最近两份', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-schema-test-'));
  const db = new Database(path.join(directory, 'agent.db'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  db.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('before'); CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT)");
  const first = prepareMigrationSnapshot(db);
  db.exec("UPDATE records SET value='after'");
  const snapshot = new Database(first, { readonly: true });
  assert.equal(snapshot.prepare('SELECT value FROM records').pluck().get(), 'before');
  assert.equal(snapshot.pragma('integrity_check', { simple: true }), 'ok');
  snapshot.close();
  finishMigrationSnapshot(db, first);
  db.pragma('user_version = 1');
  assert.equal(prepareMigrationSnapshot(db), null);
  for (let i = 0; i < 2; i++) {
    db.prepare("DELETE FROM system_settings WHERE setting_key='migration_baseline_revision'").run();
    const file = prepareMigrationSnapshot(db);
    finishMigrationSnapshot(db, file);
  }
  assert.equal(fs.readdirSync(directory).filter(name => name.includes('.pre-migrate-')).length, 2);
});

test('合成旧表的重复表情槽保留新版图片，旧表冲突留档且重新初始化幂等', t => {
  const db = getDb();
  t.after(closeDb);
  const id = db.prepare("INSERT INTO characters(name,display_name,base_prompt,short_prompt) VALUES('legacy','旧库样本','','')").run().lastInsertRowid;
  db.prepare("INSERT INTO expression_standings(character_id,slot_id,image_url,status) VALUES(?,'happy','/images/new.avif','done')").run(id);
  db.exec(`CREATE TABLE character_expression_standings AS SELECT * FROM expression_standings WHERE 0;
    INSERT INTO character_expression_standings SELECT * FROM expression_standings WHERE slot_id='happy';
    UPDATE character_expression_standings SET image_url='/images/legacy.avif';
    INSERT INTO character_expression_standings SELECT * FROM expression_standings WHERE slot_id='happy';
    UPDATE character_expression_standings SET slot_id='sad',image_url='/images/legacy.avif' WHERE rowid=2;`);
  initSchema(db);
  const slots = db.prepare('SELECT slot_id,image_url FROM expression_standings WHERE character_id=? ORDER BY slot_id').all(id);
  assert.deepEqual(slots, [{ slot_id: 'happy', image_url: '/images/new.avif' }, { slot_id: 'sad', image_url: '/images/legacy.avif' }]);
  const saved = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'character_expression_standings_conflict_%'").all();
  assert.equal(saved.length, 1);
  initSchema(db);
  assert.deepEqual(db.prepare('SELECT slot_id,image_url FROM expression_standings WHERE character_id=? ORDER BY slot_id').all(id), slots);
  assert.equal(db.pragma('foreign_key_check').length, 0);
});
