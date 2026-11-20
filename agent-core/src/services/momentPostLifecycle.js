/**
 * 失败的普通生成占位不属于动态历史；重试时间由 characters / 日程队列维护。
 * 神说投递保留原行用于幂等重试，有正文、配图或互动的记录也一律保留。
 */
export function discardEmptyFailedMomentPosts(db, postId = null) {
  return db.prepare(`
    DELETE FROM moment_posts
    WHERE status = 'failed'
      AND (? IS NULL OR id = ?)
      AND god_delivery_key IS NULL
      AND TRIM(COALESCE(content, '')) = ''
      AND TRIM(COALESCE(prompt, '')) = ''
      AND (images IS NULL OR TRIM(images) IN ('', '[]'))
      AND NOT EXISTS (SELECT 1 FROM moment_comments WHERE post_id = moment_posts.id)
      AND NOT EXISTS (SELECT 1 FROM moment_likes WHERE post_id = moment_posts.id)
      AND NOT EXISTS (SELECT 1 FROM moment_comment_queue WHERE post_id = moment_posts.id)
  `).run(postId, postId).changes;
}

export function failMomentPost(db, postId, message) {
  return db.transaction(() => {
    // 发布后旁路通知出错，不把已经发出的动态改回失败。
    db.prepare("UPDATE moment_posts SET status = 'failed', error_message = ? WHERE id = ? AND status != 'done'")
      .run(message, postId);
    return discardEmptyFailedMomentPosts(db, postId);
  })();
}
