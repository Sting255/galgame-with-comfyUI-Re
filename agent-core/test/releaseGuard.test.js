import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { assertNotDowngrade, recordAppRelease, RELEASE_MARKER_KEY } from '../src/db/releaseGuard.js';

function fixture(t) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT)');
  t.after(() => db.close());
  return db;
}

test('发行版本标记只升不降，构建后缀不改变数据兼容级别', t => {
  const db = fixture(t);
  assert.equal(recordAppRelease(db, '4.5.0'), true);
  assert.equal(recordAppRelease(db, '4.5.0-f'), false);
  assert.equal(recordAppRelease(db, '4.2.2'), false);
  assert.equal(recordAppRelease(db, '4.6.0'), true);
  assert.equal(db.prepare('SELECT setting_value FROM system_settings WHERE setting_key=?').pluck().get(RELEASE_MARKER_KEY), '4.6.0');
});

test('更高发行或结构版本被拒绝，拒绝不修改数据库', t => {
  const db = fixture(t);
  recordAppRelease(db, '9.9.9');
  const before = db.serialize();
  assert.throws(() => assertNotDowngrade(db, { current: '4.5.0', schemaVersion: 1, env: {} }), { code: 'DB_NEWER_THAN_APP' });
  assert.deepEqual(db.serialize(), before);
  db.pragma('user_version = 99');
  assert.throws(() => assertNotDowngrade(db, { current: '9.9.9', schemaVersion: 1, env: {} }), { code: 'DB_NEWER_THAN_APP' });
  assert.doesNotThrow(() => assertNotDowngrade(db, { current: '4.5.0', schemaVersion: 1, env: { LINSHE_ALLOW_DB_DOWNGRADE: '1' } }));
});

test('全新库允许初始化，缺失发行版本仍保留结构版本保护', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  assert.doesNotThrow(() => assertNotDowngrade(db, { current: '4.5.0', schemaVersion: 1, env: {} }));
  db.pragma('user_version = 2');
  assert.throws(() => assertNotDowngrade(db, { current: null, schemaVersion: 1, env: {} }), { code: 'DB_NEWER_THAN_APP' });
});
