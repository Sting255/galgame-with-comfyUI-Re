/**
 * 84 条体位的**检索**口径（用户 2026-10-21 裁定「不允许过滤」）
 *
 * 三条要钉住的边界：
 *   ① 只要 query 带体位意图（哪怕一个字都不露骨，如「姿势」「后入」），就能检索到 84 条体位；
 *      不会因为 category 是 `adult_*` 被整类挡掉（成人闸门 2026-10-21 已整条拆除，
 *      见 `imagePromptKnowledge.js` 顶部；那条口径由 `imagePromptAdultRetrieval.test.js` 接管）。
 *   ② 相关性仍生效 —— 日常画面描述（教室看书 / 一杯咖啡 / `girl standing in a classroom`）
 *      不该召回体位，否则普通配图会被污染（实测曾是 31/50）。
 *   ③ 体位意图词（`POSE_INTENT_RE`）是**相关性**约束，不是内容封禁：露骨语境下一律全额可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, seedImagePromptKnowledge } from '../src/db/index.js';
import { keywordSearchImagePromptKnowledge } from '../src/services/imagePromptKnowledge.js';

function seededDb() {
  const db = getDb();
  seedImagePromptKnowledge(db);
  const count = db.prepare(
    "SELECT COUNT(1) AS c FROM image_prompt_knowledge WHERE knowledge_id LIKE 'pose.pr24.%' AND is_active = 1"
  ).get();
  assert.equal(count.c, 84, '库里应有 84 条体位知识');
  return db;
}

const poseHits = (db, q, limit = 50) =>
  keywordSearchImagePromptKnowledge(q, { scene: 'chat', limit, db })
    .filter(i => i.id.startsWith('pose.pr24.'));

test('带体位意图但不露骨的 query 也能检索到（成人闸门已豁免）', () => {
  const db = seededDb();
  const hits = poseHits(db, '体位 姿势 pose');
  assert.ok(hits.length > 0, '「体位 姿势」应能命中');
});

test('露骨 query 命中量足够（后入 / doggystyle）', () => {
  const db = seededDb();
  assert.ok(poseHits(db, '后入').length >= 5, '「后入」至少命中 5 条');
  assert.ok(poseHits(db, 'doggystyle sex from behind').length >= 5, 'doggystyle 至少命中 5 条');
});

test('日常画面描述不召回体位（避免污染普通配图）', () => {
  const db = seededDb();
  for (const q of ['杯子里的一杯热咖啡放在木桌上', '银发少女在教室里看书', 'girl standing in a classroom, sunlight through window', '两人面对面躺着聊天']) {
    assert.equal(poseHits(db, q).length, 0, `日常 query 不该召回体位：${q}`);
  }
});

// 成人闸门（`queryAllowsCategory`）已于 2026-10-21 整条拆除，旧用例
// 「其它 adult_* 条目仍被闸门挡住」随之作废；新口径（不整类封禁 + 仍然按相关性）
// 由 `test/imagePromptAdultRetrieval.test.js` 接管，这里不再重复钉。
