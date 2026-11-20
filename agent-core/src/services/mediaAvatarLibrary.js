import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { designMediaAvatars, AVATAR_PROMPT_BATCH_SIZE } from './mediaAvatarDesigner.js';
import { generateImageRaw, captureImageGenerationConfig } from './imageSkill.js';
import { saveBase64Image, deleteImageFileByUrl, imageUrlExists } from './imagePaths.js';
import { invalidateGalleryCache } from './galleryCache.js';
import { broadcast } from './unifiedStreamBus.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export const DEFAULT_MEDIA_AVATAR_ARTIST = '@ebora';

// Progress and prompts live only in memory; the database stores images and NPC assignments.
export function createMediaAvatarLibrary({
  database = getDb, design = designMediaAvatars, generate = generateImageRaw,
  snapshot = () => captureImageGenerationConfig('avatar'), save = saveBase64Image,
  discard = deleteImageFileByUrl, exists = imageUrlExists,
  notify = broadcast, invalidate = invalidateGalleryCache,
} = {}) {
  let running = null;
  let progress = null;

  function list() {
    const db = database();
    return {
      busy: !!running,
      progress: progress ? { ...progress } : null,
      artist: db.prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'media_avatar_artist'").get()?.setting_value ?? DEFAULT_MEDIA_AVATAR_ARTIST,
      avatars: db.prepare("SELECT id, image FROM media_avatars WHERE enabled = 1 AND COALESCE(image, '') != '' ORDER BY id DESC").all(),
    };
  }

  async function run(direction, artist, count, avatarId = null) {
    const db = database();
    try {
      const opts = { ...snapshot(), artist, globalLoraSnapshot: [], width: 1024, height: 1024,
        scene: 'avatar', priority: 'high', imageProvider: 'comfyui', alreadyPrepared: true, disableRAG: true };
      const previous = [];
      for (let offset = 0; offset < count; offset += AVATAR_PROMPT_BATCH_SIZE) {
        const batchSize = Math.min(AVATAR_PROMPT_BATCH_SIZE, count - offset);
        progress.stage = 'designing';
        let prompts;
        try {
          prompts = await design(direction, batchSize, [...previous]);
        } catch (error) {
          progress.failed += batchSize;
          progress.error = String(error.message).slice(0, 300);
          continue;
        }
        previous.push(...prompts);
        progress.stage = 'generating';
        // One ComfyUI request per prompt; no duplicate pass and no persistent task history.
        for (const prompt of prompts) {
          try {
            const result = await generate(prompt, opts);
            if (!result?.success || !result.images?.[0]?.base64) throw new Error(result?.error || 'ComfyUI 未返回图片');
            const image = save('media_avatars', `avatar_${randomUUID()}.png`, result.images[0].base64);
            try {
              if (avatarId !== null) {
                const result = db.prepare('UPDATE media_avatars SET image = ? WHERE id = ? AND enabled = 1').run(image, avatarId);
                if (!result.changes) throw fail('头像已移出，取消替换', 404);
              } else db.prepare('INSERT INTO media_avatars (image) VALUES (?)').run(image);
            } catch (error) {
              try { discard(image); } catch { /* Keep the original database error. */ }
              throw error;
            }
            progress.completed++;
            try { invalidate(); } catch (error) { console.warn('[media-avatar] 相册缓存更新失败:', error.message); }
          } catch (error) {
            progress.failed++;
            progress.error = String(error.message).slice(0, 300);
          }
        }
      }
      progress.stage = progress.failed ? 'failed' : 'done';
    } catch (error) {
      progress.stage = 'failed';
      progress.error = String(error.message).slice(0, 300);
    }
  }

  function launch(direction, artist, count, avatarId = null) {
    if (running) throw fail('头像正在生成，请稍候', 409);
    if (typeof direction !== 'string' || direction.length > 2000) throw fail('生成方向最多2000字');
    if (typeof artist !== 'string' || artist.length > 2000) throw fail('画师串最多2000字');
    if (avatarId === null && (!Number.isInteger(count) || count < 10 || count > 50)) throw fail('头像数量必须为10至50之间的整数');
    if (avatarId !== null && !database().prepare('SELECT id FROM media_avatars WHERE id = ? AND enabled = 1').get(avatarId)) throw fail('头像不存在', 404);
    database().prepare("INSERT OR REPLACE INTO system_settings (setting_key, setting_value) VALUES ('media_avatar_artist', ?)").run(artist.trim());
    progress = { stage: 'designing', total: count, completed: 0, failed: 0, error: null };
    if (avatarId !== null) progress.avatarId = avatarId;
    // Assign the single-flight guard before starting async work.
    running = Promise.resolve().then(() => run(direction.trim(), artist.trim(), count, avatarId)).finally(() => {
      running = null;
      notify('media_avatars_updated', { ...progress });
    });
    running.catch(error => console.error('[media-avatar]', error.message));
    return { started: true };
  }

  function start(direction = '', artist = DEFAULT_MEDIA_AVATAR_ARTIST, count = 10) {
    return launch(direction, artist, count);
  }

  function regenerate(id, direction = '', artist = DEFAULT_MEDIA_AVATAR_ARTIST) {
    if (!Number.isSafeInteger(id) || id < 1) throw fail('头像不存在', 404);
    return launch(direction, artist, 1, id);
  }

  function remove(id) {
    const db = database();
    return db.transaction(() => {
      const result = db.prepare('UPDATE media_avatars SET enabled = 0 WHERE id = ? AND enabled = 1').run(id);
      if (!result.changes) throw fail('头像不存在', 404);
      // Shared avatars can have assignments across multiple outlets. Reassign only on the next appearance.
      db.prepare('DELETE FROM media_npc_avatars WHERE avatar_id = ?').run(id);
      return { success: true };
    })();
  }

  function resolve(outletId, name) {
    const db = database();
    const author = String(name || '匿名用户').trim() || '匿名用户';
    return db.transaction(() => {
      const current = db.prepare(`SELECT a.image FROM media_npc_avatars n JOIN media_avatars a ON a.id = n.avatar_id
        WHERE n.outlet_id = ? AND n.author_name = ?`).get(outletId, author);
      if (current?.image && exists(current.image)) return current.image;
      const candidates = db.prepare('SELECT id, image FROM media_avatars WHERE enabled = 1 ORDER BY RANDOM()').all();
      const selected = candidates.find(a => a.image && exists(a.image));
      if (!selected) return null;
      db.prepare('INSERT OR REPLACE INTO media_npc_avatars (outlet_id, author_name, avatar_id) VALUES (?, ?, ?)')
        .run(outletId, author, selected.id);
      return selected.image;
    })();
  }

  return { list, start, regenerate, remove, resolve, wait: () => running };
}

export const mediaAvatarLibrary = createMediaAvatarLibrary();
