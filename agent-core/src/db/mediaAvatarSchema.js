/** Keep the images and NPC assignments, removing the retired generation history. */
export function migrateMediaAvatarLibrary(db) {
  const columns = db.prepare('PRAGMA table_info(media_avatars)').all().map(column => column.name);
  if (!columns.includes('batch_id')) return;
  db.transaction(() => {
    db.exec(`
      DELETE FROM media_avatars WHERE COALESCE(image, '') = ''
        AND id NOT IN (SELECT avatar_id FROM media_npc_avatars);
      DROP INDEX IF EXISTS idx_media_avatars_batch;
    `);
    for (const column of ['batch_id', 'title', 'prompt', 'status', 'error']) {
      if (columns.includes(column)) db.exec(`ALTER TABLE media_avatars DROP COLUMN ${column}`);
    }
    db.exec(`
      DROP TABLE IF EXISTS media_avatar_batches;
      DELETE FROM image_tasks WHERE conversation_id = 'media_avatar';
    `);
  })();
}
