import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './harness/appHarness.js';

test('超过两千条的朋友圈按时间和 id 续页，筛选在分页前生效', async t => {
  const h = await appHarness(t, [], { moments: true });
  const author = h.character('较早发帖的作者');
  const add = h.db.prepare('INSERT INTO moment_posts(character_id,content,status,created_at) VALUES(?,?,?,?)');
  const ids = [];
  h.db.transaction(() => {
    for (let i = 0; i < 2051; i++) ids.push(Number(add.run(i < 2 ? author : null, `合成帖子 ${i}`, 'done', i % 2 ? '2026-11-19 10:00:00' : '2026-11-20 10:00:00').lastInsertRowid));
    add.run(author, '未发布的占位', 'failed', '2026-11-20 11:00:00');
  })();
  h.db.prepare('INSERT INTO moment_likes(post_id) VALUES(?)').run(ids[0]);
  const get = async query => {
    const response = await fetch(`${h.url}/api/moments?${new URLSearchParams(query)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  let cursor = {};
  const loaded = [];
  for (let i = 0; i < 3; i++) {
    const result = await get({ limit: 1000, ...cursor });
    loaded.push(...result.posts.map(p => p.id));
    assert.equal(result.hasMore, i < 2);
    cursor = { before_id: result.nextCursor.id, before_created_at: result.nextCursor.created_at };
  }
  assert.equal(loaded.length, 2051);
  assert.equal(new Set(loaded).size, 2051);
  assert.deepEqual(loaded, h.db.prepare("SELECT id FROM moment_posts WHERE status='done' ORDER BY created_at DESC,id DESC").all().map(r => r.id));
  const byAuthor = await get({ limit: 1, character_id: author });
  assert.equal(byAuthor.posts.length, 1);
  assert.equal(byAuthor.posts[0].character_id, author);
  assert.equal(byAuthor.hasMore, true);
  assert.deepEqual((await get({ liked: 1, character_id: author })).posts.map(p => p.id), [ids[0]]);
  const user = await get({ limit: 20, user_only: 1 });
  assert.equal(user.posts.length, 20);
  assert.ok(user.posts.every(p => p.author_type === 'user'));
  assert.equal(h.stub.requests.length, 0);
});

test('上一页的游标帖被删后继续翻页，不重页也不漏页', async t => {
  const h = await appHarness(t, [], { moments: true });
  const add = h.db.prepare("INSERT INTO moment_posts(content,status,created_at) VALUES(?,'done','2026-11-20 12:00:00')");
  const ids = ['最旧', '游标', '最新'].map(s => Number(add.run(s).lastInsertRowid));
  const first = await (await fetch(`${h.url}/api/moments?limit=2`)).json();
  h.db.prepare('DELETE FROM moment_posts WHERE id=?').run(first.nextCursor.id);
  const query = new URLSearchParams({ limit: '2', before_id: first.nextCursor.id, before_created_at: first.nextCursor.created_at });
  const next = await (await fetch(`${h.url}/api/moments?${query}`)).json();
  assert.deepEqual(next.posts.map(p => p.id), [ids[0]]);
  assert.equal(next.hasMore, false);
});
