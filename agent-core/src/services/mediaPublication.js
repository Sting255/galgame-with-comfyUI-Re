import { getDb } from '../db/index.js';
import { broadcast } from './unifiedStreamBus.js';
import { checkCharacterPublishable, GATE_REASON } from './publishGate.js';

// NULL = 待发布；0 = 升级前已展示的旧内容（沿用 id 游标）；正数 = 实际发布顺序。
export const MEDIA_PUBLICATION_ORDER = 'COALESCE(NULLIF(p.published_seq, 0), p.id)';

export function mediaImagesReady(post) {
  let payload;
  try { payload = JSON.parse(post.payload_json || 'null'); } catch { return false; }
  const ready = item => !String(item?.image_prompt || '').trim() || !!item?.image;
  if (payload?.portal) return Array.isArray(payload.sections) && payload.sections.every(ready);
  return ready(post) && (!Array.isArray(payload?.panels) || payload.panels.every(ready));
}

export function isMediaPostPublished(postId) {
  return !!getDb().prepare('SELECT 1 FROM media_posts WHERE id = ? AND published_seq IS NOT NULL').get(postId);
}

/** 发布一次：配图齐全后才分配游标，晚完成的旧草稿仍排在最新位置。 */
export function publishMediaPostIfReady(postId) {
  const db = getDb();
  const published = db.transaction(() => {
    const post = db.prepare('SELECT * FROM media_posts WHERE id = ?').get(postId);
    if (!post || post.published_seq !== null || post.image_status === 'discarded') return null;

    if (post.author_type === 'character' && post.character_id) {
      const gate = checkCharacterPublishable(db, post.character_id, { flag: 'moments_disabled' });
      if (!gate.allowed) {
        const terminal = gate.reason === GATE_REASON.NOT_FOUND || gate.reason === GATE_REASON.SYSTEM;
        if (terminal) {
          db.prepare("UPDATE media_posts SET image_status = 'discarded', image_error = ? WHERE id = ? AND published_seq IS NULL")
            .run(gate.reason, postId);
        }
        console.log(`[media] post #${postId} ${terminal ? '丢弃' : '发布延期'}：${gate.reason}`);
        return null;
      }
    }
    if (!mediaImagesReady(post)) return null;

    const previous = Number(db.prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'media_publication_sequence'").pluck().get()) || 0;
    const lastId = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'media_posts'").pluck().get() || 0;
    const seq = Math.max(previous, lastId) + 1;
    const payload = JSON.parse(post.payload_json || 'null');
    const cover = post.image || (payload?.portal ? payload.sections.find(section => section.image)?.image : null) || null;
    db.prepare("INSERT OR REPLACE INTO system_settings (setting_key, setting_value) VALUES ('media_publication_sequence', ?)").run(String(seq));
    db.prepare("UPDATE media_posts SET published_seq = ?, image = ?, image_status = 'done', image_error = NULL WHERE id = ? AND published_seq IS NULL").run(seq, cover, postId);
    return { outletId: post.outlet_id, postId, count: 1 };
  })();
  if (published) broadcast('media_new_posts', published);
  return !!published;
}

/**
 * 「只发布、不生图」的到期扫描（P1-10）。
 *
 * 为什么需要：`publishMediaPostIfReady` 在角色睡着 / 朋友圈关闭时会拒绝发布并延期，
 * 但延期之后没有任何东西会再调它一次——素材早就齐全，却要等用户手动打开传媒页
 * 或者下一次生成批次才可能被发出去。
 *
 * 为什么不能直接复用 `fillPendingImages`：那会为缺图的帖子派发生图任务，
 * 与「不后台定时出图」的既定决策冲突（实测 30 分钟被派单 46 次那次的教训）。
 *
 * 所以这里只挑**素材已经齐全**的帖子：调用 publishMediaPostIfReady 之前先判
 * `mediaImagesReady`，保证这条路径永远不会触发任何生图。
 *
 * @param {{limit?: number}} [opts]
 * @returns {number} 本次成功发布的条数
 */
export function publishReadyDeferredPosts({ limit = 20 } = {}) {
  const db = getDb();
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT * FROM media_posts
      WHERE published_seq IS NULL
        AND image_status != 'discarded'
        AND COALESCE(image_status, '') != 'generating'
      ORDER BY id ASC LIMIT ?
    `).all(limit);
  } catch (err) {
    console.warn('[media] deferred publish scan read failed:', err?.message || err);
    return 0;
  }
  let published = 0;
  for (const post of rows) {
    // 素材不齐的直接跳过——本函数绝不触发补图
    if (!mediaImagesReady(post)) continue;
    try {
      if (publishMediaPostIfReady(post.id)) published += 1;
    } catch (err) {
      console.warn(`[media] deferred publish failed for #${post.id}:`, err?.message || err);
    }
  }
  if (published > 0) console.log(`[media] 延期发布补上 ${published} 条（未触发任何生图）`);
  return published;
}
