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
    if (!post || post.published_seq !== null || !mediaImagesReady(post)) return null;

    // ── 发布闸门（A03）──────────────────────────────────────────────────
    // 帖子从生成到配图齐全要等几分钟（一次补一批图）。这段空档里作者可能已经睡下 ——
    // 睡着的人"刚发了条帖"是最出戏的一种。可恢复（睡眠）就**不分配游标**，
    // 让它在原地等：后续每次补图/打开页面都会重新过闸门，醒来自然发布。
    // 其他理由（角色已删除 / 开关关闭）不拦：帖子已生成完，媒体是公共信息流，
    // 不因为作者当下状态而整条丢弃。
    if (post.author_type === 'character' && post.character_id) {
      const gate = checkCharacterPublishable(db, post.character_id);
      if (!gate.allowed && gate.reason === GATE_REASON.SLEEPING) {
        console.log(`[media] post #${postId} 发布延期：作者 ${gate.detail?.name || post.character_id} 睡眠中`);
        return null;
      }
    }

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
