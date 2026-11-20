import { normalizePreset, getPresetOrder } from '../services/presets/engine.js';

export function migratePresets(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS prompt_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, document_json TEXT NOT NULL,
    order_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1
  ); CREATE UNIQUE INDEX IF NOT EXISTS prompt_presets_one_active ON prompt_presets(active) WHERE active=1;`);
}

export function createPresetRepository(db) {
  const read = row => row ? { id:row.id, name:row.name, document:normalizePreset(JSON.parse(row.document_json)), orderId:row.order_id, active:!!row.active, revision:row.revision } : null;
  const get = id => read(db.prepare('SELECT * FROM prompt_presets WHERE id=?').get(id));
  const check = (id, revision) => {
    const item = get(id);
    if (!item) throw Object.assign(new Error('预设不存在'), { status:404 });
    if (revision !== item.revision) throw Object.assign(new Error('预设已在其他窗口修改，请关闭并重新打开预设窗口后再操作'), { status:409 });
    return item;
  };
  return {
    get,
    list: () => db.prepare('SELECT * FROM prompt_presets ORDER BY id').all().map(read),
    active: () => read(db.prepare('SELECT * FROM prompt_presets WHERE active=1').get()),
    save: db.transaction((id, input) => {
      if (id != null) check(id, input.expectedRevision);
      if (input.activate != null && typeof input.activate !== 'boolean') throw new Error('activate 必须是布尔值');
      const name = String(input.name || '').trim();
      if (!name || name.length > 200) throw new Error('预设名称须为 1–200 个字符');
      const document = normalizePreset(input.document);
      const orderId = String(getPresetOrder(document, input.orderId).character_id);
      if (id == null) id = Number(db.prepare('INSERT INTO prompt_presets(name,document_json,order_id) VALUES(?,?,?)').run(name, JSON.stringify(document), orderId).lastInsertRowid);
      else db.prepare('UPDATE prompt_presets SET name=?,document_json=?,order_id=?,revision=revision+1 WHERE id=?').run(name,JSON.stringify(document),orderId,id);
      if (input.activate === true) {
        db.prepare('UPDATE prompt_presets SET active=0,revision=revision+1 WHERE active=1 AND id<>?').run(id);
        db.prepare('UPDATE prompt_presets SET active=1 WHERE id=?').run(id);
      }
      return get(id);
    }),
    activate: db.transaction((id, revision, active) => {
      check(id, revision);
      if (active) db.prepare('UPDATE prompt_presets SET active=0,revision=revision+1 WHERE active=1 AND id<>?').run(id);
      db.prepare('UPDATE prompt_presets SET active=?,revision=revision+1 WHERE id=?').run(active ? 1 : 0,id);
      return get(id);
    }),
    remove: db.transaction((id, revision) => { check(id, revision); db.prepare('DELETE FROM prompt_presets WHERE id=?').run(id); }),
  };
}
