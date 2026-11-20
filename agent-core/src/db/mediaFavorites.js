/** 收藏随帖子保存，删除帖子或媒体时自然清理。 */
export function migrateMediaFavorites(db) {
  if (!db.prepare('PRAGMA table_info(media_posts)').all().some(c => c.name === 'favorited_at')) {
    db.exec('ALTER TABLE media_posts ADD COLUMN favorited_at INTEGER');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_posts_favorites
    ON media_posts(favorited_at DESC, id DESC) WHERE favorited_at IS NOT NULL`);
}

export function setMediaPostFavorite(db, postId, favorite) {
  if (!Number.isSafeInteger(postId) || postId <= 0 || typeof favorite !== 'boolean') {
    throw Object.assign(new Error('请提供有效的帖子编号和收藏状态'), { statusCode: 400 });
  }
  // 明确设置目标状态，重复请求不会翻转收藏或改变收藏时间。
  const result = db.prepare(`UPDATE media_posts
    SET favorited_at = CASE WHEN ? THEN COALESCE(favorited_at, ?) ELSE NULL END
    WHERE id = ? AND published_seq IS NOT NULL`).run(Number(favorite), Date.now(), postId);
  if (!result.changes) throw Object.assign(new Error('内容不存在'), { statusCode: 404 });
  const row = db.prepare('SELECT favorited_at FROM media_posts WHERE id = ?').get(postId);
  return { id: postId, is_favorite: row.favorited_at !== null, favorited_at: row.favorited_at };
}
