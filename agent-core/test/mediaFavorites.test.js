import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateMediaFavorites, setMediaPostFavorite } from '../src/db/mediaFavorites.js';

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE media_posts(id INTEGER PRIMARY KEY, title TEXT, published_seq INTEGER);
    INSERT INTO media_posts VALUES (1, '社交帖子', 1), (2, '数字报刊', 2), (3, '尚未发布', NULL);`);
  migrateMediaFavorites(db);
  return db;
}

test('upgrading an existing database preserves content and saved favorites on repeated migration', t => {
  const db = setup(t);
  assert.equal(db.prepare('SELECT title FROM media_posts WHERE id = 1').get().title, '社交帖子');
  assert.equal(db.prepare('SELECT favorited_at FROM media_posts WHERE id = 1').get().favorited_at, null);
  const saved = setMediaPostFavorite(db, 1, true);
  assert.equal(saved.is_favorite, true);
  assert.ok(saved.favorited_at > 0);
  migrateMediaFavorites(db);
  assert.deepEqual(setMediaPostFavorite(db, 1, true), saved);
});

test('social posts and digital issues can be saved independently and cancellation is idempotent', t => {
  const db = setup(t);
  setMediaPostFavorite(db, 1, true);
  const issue = setMediaPostFavorite(db, 2, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_posts WHERE favorited_at IS NOT NULL').get().n, 2);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(setMediaPostFavorite(db, 1, false), { id: 1, is_favorite: false, favorited_at: null });
  }
  assert.deepEqual(setMediaPostFavorite(db, 2, true), issue);
  db.prepare('DELETE FROM media_posts WHERE id = 2').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_posts WHERE favorited_at IS NOT NULL').get().n, 0);
});

test('invalid input, missing posts and unpublished drafts cannot change favorites', t => {
  const db = setup(t);
  for (const id of [NaN, 0, -1, 1.5, '1']) {
    assert.throws(() => setMediaPostFavorite(db, id, true), { statusCode: 400 });
  }
  for (const favorite of [undefined, null, 1, 'false']) {
    assert.throws(() => setMediaPostFavorite(db, 1, favorite), { statusCode: 400 });
  }
  for (const id of [3, 999]) {
    assert.throws(() => setMediaPostFavorite(db, id, true), { statusCode: 404 });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_posts WHERE favorited_at IS NOT NULL').get().n, 0);
});

test('favorite lists keep category filters, pagination and counts aligned', async t => {
  // 隔离于用户数据库，覆盖服务实际执行的 JOIN / 分页 SQL 与返回映射。
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Database test: network disabled'); });
  const { config } = await import('../src/config.js');
  config.dbPath = ':memory:';
  const { getDb } = await import('../src/db/index.js');
  const { listPosts } = await import('../src/services/mediaService.js');
  const db = getDb();
  t.after(() => db.close());
  const social = Number(db.prepare("INSERT INTO media_outlets(name, layout) VALUES ('收藏测试社交', 'feed')").run().lastInsertRowid);
  const digital = Number(db.prepare("INSERT INTO media_outlets(name, layout) VALUES ('收藏测试报刊', 'portal')").run().lastInsertRowid);
  const insert = db.prepare(`INSERT INTO media_posts(outlet_id, title, content, author_type, published_seq, favorited_at)
    VALUES (?, '测试内容', '正文', 'character', ?, ?)`);
  const first = Number(insert.run(social, 1, 100).lastInsertRowid);
  const second = Number(insert.run(social, 2, 200).lastInsertRowid);
  const issue = Number(insert.run(digital, 3, 300).lastInsertRowid);
  const issuePayload = {
    portal: true,
    issue: 1,
    title: '整期报刊',
    sections: ['头条', '访谈', '榜单', '读者来信'].map((name, i) => ({
      key: `section-${i}`, name, image: `/images/section-${i}.png`,
      body: [{ type: 'p', text: `${name}正文` }],
    })),
  };
  db.prepare('UPDATE media_posts SET payload_json = ? WHERE id = ?').run(JSON.stringify(issuePayload), issue);
  insert.run(social, 4, null);
  insert.run(digital, null, 400);
  const page = listPosts({ category: 'social', favoritesOnly: true, limit: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.posts.map(p => p.id), [second]);
  assert.equal(page.posts[0].is_favorite, true);
  assert.equal(page.posts[0].favorited_at, 200);
  assert.deepEqual(listPosts({ category: 'social', favoritesOnly: true, limit: 1, offset: 1 }).posts.map(p => p.id), [first]);
  const paper = listPosts({ category: 'digital', favoritesOnly: true });
  assert.equal(paper.total, 1);
  assert.deepEqual(paper.posts.map(p => p.id), [issue]);
  assert.deepEqual(paper.posts[0].payload, issuePayload);
  setMediaPostFavorite(db, second, false);
  assert.equal(listPosts({ category: 'social', favoritesOnly: true }).total, 1);
  assert.equal(listPosts({ outletId: social }).total, 3);
});
