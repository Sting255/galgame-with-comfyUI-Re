/**
 * 全角色统一服装类型（2026-11-07 用户：设置里统一加一个服装种类，对所有人生效）。
 *
 * 与角色自建的 `custom_<时间戳>` 的区别：
 *   自建类型只存在某个角色名下；统一类型在设置里定义一次，每个角色都有一行同名服装，
 *   并且 scene key 固定为 `custom_g<id>` —— 同一类型在所有角色上 key 相同，
 *   批量生成、页签文案、统计都靠它对齐。
 *
 * 表结构只有 id + name；真正的服装仍落在 character_outfits，
 * 描述与立绘各自生成（不做跨角色共享，每个角色仍要自己的那一套）。
 */
import { getDb } from '../db/index.js';

export const GLOBAL_SCENE_PREFIX = 'custom_g';
export const GLOBAL_TYPE_NAME_MAX = 20;

export function sceneKeyOf(id) {
  return `${GLOBAL_SCENE_PREFIX}${Number(id)}`;
}

/** 从 scene key 反查统一类型 id（不是统一类型返回 null） */
export function typeIdOfScene(scene) {
  const match = new RegExp(`^${GLOBAL_SCENE_PREFIX}(\\d+)$`).exec(String(scene || ''));
  return match ? Number(match[1]) : null;
}

function normalizeName(name) {
  const text = String(name || '').trim().replace(/\s+/g, ' ');
  if (!text) throw Object.assign(new Error('请填写服装类型名称'), { statusCode: 400 });
  if (text.length > GLOBAL_TYPE_NAME_MAX) {
    throw Object.assign(new Error(`服装类型名称不能超过 ${GLOBAL_TYPE_NAME_MAX} 字`), { statusCode: 400 });
  }
  return text;
}

function assertUniqueName(name, exceptId = null) {
  const row = getDb().prepare('SELECT id FROM global_outfit_types WHERE name = ?').get(name);
  if (row && row.id !== exceptId) {
    throw Object.assign(new Error(`已经有一个叫「${name}」的统一服装类型了`), { statusCode: 409 });
  }
}

/** 给还没有这一行的角色补一条空描述（新建类型 / 新建角色 / 历史角色都能用） */
export function applyTypeToAllCharacters(typeRow) {
  const db = getDb();
  const scene = sceneKeyOf(typeRow.id);
  const characters = db.prepare('SELECT id FROM characters').all();
  const exists = db.prepare('SELECT id FROM character_outfits WHERE character_id = ? AND scene = ?');
  const insert = db.prepare('INSERT INTO character_outfits (character_id, name, description, scene) VALUES (?, ?, ?, ?)');
  let added = 0;
  const run = db.transaction(() => {
    for (const char of characters) {
      if (exists.get(char.id, scene)) continue;
      insert.run(char.id, typeRow.name, '', scene);
      added++;
    }
  });
  run();
  return added;
}

export function listGlobalOutfitTypes() {
  const db = getDb();
  const rows = db.prepare('SELECT id, name, created_at FROM global_outfit_types ORDER BY id').all();
  const characters = db.prepare('SELECT COUNT(*) AS n FROM characters').get()?.n || 0;
  return rows.map(row => {
    const scene = sceneKeyOf(row.id);
    const outfits = db.prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN TRIM(COALESCE(description, \'\')) <> \'\' THEN 1 ELSE 0 END) AS filled FROM character_outfits WHERE scene = ?'
    ).get(scene) || {};
    const standings = db.prepare(
      `SELECT COUNT(*) AS n FROM character_standings WHERE scene = ? AND COALESCE(image_url, '') <> ''`
    ).get(scene)?.n || 0;
    return {
      id: row.id,
      name: row.name,
      scene,
      createdAt: row.created_at,
      characterCount: characters,
      appliedCount: outfits.total || 0,
      describedCount: outfits.filled || 0,
      standingCount: standings || 0,
    };
  });
}

export function createGlobalOutfitType(name) {
  const db = getDb();
  const clean = normalizeName(name);
  assertUniqueName(clean);
  const info = db.prepare('INSERT INTO global_outfit_types (name) VALUES (?)').run(clean);
  const row = db.prepare('SELECT id, name, created_at FROM global_outfit_types WHERE id = ?').get(info.lastInsertRowid);
  const added = applyTypeToAllCharacters(row);
  return { ...row, scene: sceneKeyOf(row.id), applied: added };
}

export function renameGlobalOutfitType(id, name) {
  const db = getDb();
  const row = db.prepare('SELECT id, name FROM global_outfit_types WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('服装类型不存在'), { statusCode: 404 });
  const clean = normalizeName(name);
  assertUniqueName(clean, row.id);
  db.prepare('UPDATE global_outfit_types SET name = ? WHERE id = ?').run(clean, row.id);
  // 各角色那一行的 name 也要跟着改，否则页签文案会各说各话
  db.prepare('UPDATE character_outfits SET name = ? WHERE scene = ?').run(clean, sceneKeyOf(row.id));
  return { ...row, name: clean, scene: sceneKeyOf(row.id) };
}

/**
 * 删除统一类型。
 * 口径（2026-11-07 定）：连同各角色的这套描述与立绘一起删 —— 「统一」删掉就该整套消失，
 * 否则留下没人管理的孤立页签更容易困惑。角色自建的 custom_<时间戳> 类型不受影响。
 */
export function deleteGlobalOutfitType(id) {
  const db = getDb();
  const typeId = Number(id);
  const row = db.prepare('SELECT id, name FROM global_outfit_types WHERE id = ?').get(typeId);
  if (!row) throw Object.assign(new Error('服装类型不存在'), { statusCode: 404 });
  const scene = sceneKeyOf(typeId);
  const removed = db.transaction(() => {
    const outfits = db.prepare('DELETE FROM character_outfits WHERE scene = ?').run(scene).changes;
    const standings = db.prepare('DELETE FROM character_standings WHERE scene = ?').run(scene).changes;
    db.prepare('DELETE FROM global_outfit_types WHERE id = ?').run(typeId);
    return { outfits, standings };
  })();
  return { id: typeId, name: row.name, scene, ...removed };
}

/** 新角色创建后调用：把已有的统一类型全部补到它名下 */
export function applyAllTypesToCharacter(characterId) {
  const db = getDb();
  const types = db.prepare('SELECT id, name FROM global_outfit_types ORDER BY id').all();
  if (!types.length) return 0;
  const exists = db.prepare('SELECT id FROM character_outfits WHERE character_id = ? AND scene = ?');
  const insert = db.prepare('INSERT INTO character_outfits (character_id, name, description, scene) VALUES (?, ?, ?, ?)');
  let added = 0;
  const run = db.transaction(() => {
    for (const type of types) {
      const scene = sceneKeyOf(type.id);
      if (exists.get(characterId, scene)) continue;
      insert.run(characterId, type.name, '', scene);
      added++;
    }
  });
  run();
  return added;
}
