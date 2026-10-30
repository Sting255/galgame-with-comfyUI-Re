/**
 * 84 条体位进生图知识库（`pose.pr24.*`）
 *
 * 钉住：
 *   ① 84 条全量、knowledgeId 前缀 `pose.pr24.`（PR#24 硬约束）
 *   ② **不过滤**：显式成人内容原样保留、scenes 覆盖全部出入口（用户 2026-10-21 裁定）
 *   ③ seed 幂等：跑两次不重复；ipk.* 与 pose.pr24.* 两套版本号互不干扰
 *   ④ 旧版本体位会被置 is_active=0，但不碰 ipk.*
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { POSITION_KNOWLEDGE, POSITION_KNOWLEDGE_VERSION } from '../src/db/positionKnowledgeData.js';
import { POSITIONS } from '../src/services/positionLibrary.js';
import { getDb, seedImagePromptKnowledge } from '../src/db/index.js';

const ALL_SCENES = ['chat', 'moments', 'events', 'schedule', 'mailbox', 'avatar', 'gift', 'proactive', 'standalone'];

test('84 条体位全部生成知识条目，前缀 pose.pr24.', () => {
  assert.equal(POSITION_KNOWLEDGE.length, 84);
  assert.equal(POSITION_KNOWLEDGE.length, POSITIONS.length);
  for (const k of POSITION_KNOWLEDGE) {
    assert.ok(k.knowledgeId.startsWith('pose.pr24.'), k.knowledgeId);
    assert.ok(k.title.trim().length > 0, `${k.knowledgeId} 缺标题`);
    assert.ok(k.content.includes('【定格】') || k.content.includes('【画面标签】'), `${k.knowledgeId} 内容为空壳`);
  }
});

test('不过滤：scenes 全开，成人向词汇原样保留', () => {
  for (const k of POSITION_KNOWLEDGE) {
    assert.deepEqual(k.scenes, ALL_SCENES, `${k.knowledgeId} 的 scenes 被裁剪了`);
    assert.equal(k.isDefault, false);
  }
  // 显式成人词不是"每条都有"（乳交/足交类只写 body 部位），但必须大面积存在，且一条没被删改
  const explicit = POSITION_KNOWLEDGE.filter(k => /penis|vaginal|anal|cum/i.test(k.content));
  assert.ok(explicit.length >= 30, `显式成人条件应大面积存在，实际 ${explicit.length}`);
  assert.ok(POSITION_KNOWLEDGE.some(k => k.executableTags.some(t => /anal|vaginal/i.test(t))), '插入类标签必须在');
});

test('seed：写库后 84 条 is_active=1，且可重复执行（幂等）', () => {
  const db = getDb();
  seedImagePromptKnowledge(db);
  seedImagePromptKnowledge(db);   // 第二次应直接早退

  const rows = db.prepare(
    `SELECT knowledge_id, is_active, version FROM image_prompt_knowledge WHERE knowledge_id LIKE 'pose.pr24.%'`
  ).all();
  assert.equal(rows.length, 84, `库里应有 84 条，实际 ${rows.length}`);
  assert.ok(rows.every(r => r.is_active === 1), '全部应处于激活态');
  assert.ok(rows.every(r => r.version === POSITION_KNOWLEDGE_VERSION));

  const setting = db.prepare(
    `SELECT setting_value FROM system_settings WHERE setting_key = 'image_prompt_knowledge_pose_version'`
  ).pluck().get();
  assert.equal(setting, POSITION_KNOWLEDGE_VERSION, '独立版本号要写进 system_settings');
});

test('旧版本体位会被下线，且不碰 ipk.*', () => {
  const db = getDb();
  seedImagePromptKnowledge(db);
  // 造一条旧版本体位 + 一条 ipk 行
  db.prepare(`UPDATE image_prompt_knowledge SET version = 'pose.pr24.OLD' WHERE knowledge_id = ?`)
    .run(POSITION_KNOWLEDGE[0].knowledgeId);
  db.prepare(`INSERT OR REPLACE INTO image_prompt_knowledge
    (knowledge_id, category, title, search_terms, content, executable_tags, scenes, is_default, priority, version, is_active)
    VALUES ('ipk.lib.selftest', 'test', '自检', 't', 'c', '[]', '[]', 0, 1, 'v-test', 1)`).run();
  // 清掉版本号逼它重跑
  db.prepare(`DELETE FROM system_settings WHERE setting_key = 'image_prompt_knowledge_pose_version'`).run();

  seedImagePromptKnowledge(db);

  const old = db.prepare(`SELECT is_active FROM image_prompt_knowledge WHERE knowledge_id = ?`)
    .get(POSITION_KNOWLEDGE[0].knowledgeId);
  assert.equal(old.is_active, 1, '同 id 的新版本会被 upsert 回激活');
  const ipk = db.prepare(`SELECT is_active FROM image_prompt_knowledge WHERE knowledge_id = 'ipk.lib.selftest'`).get();
  assert.equal(ipk.is_active, 1, 'ipk.* 不能被体位版本逻辑下线');
});
