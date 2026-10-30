/**
 * 生图知识库「成人闸门已拆除」的口径（2026-10-21，用户裁定「聊天出图不要有任何审查限制」）
 *
 * 背景：旧口径要求 query 必须命中 `EXPLICIT_ADULT_PATTERN` 露骨词表，`adult_*` 类目才允许
 * 被召回（`pose.pr24.*` 曾单独豁免）。真机表现是「图出了，但跟对话里的露骨内容不符」——
 * 对话写得含蓄、或只有「她继续」这种短句时，一个露骨词都不命中 ⇒ 整个体位/解剖词库被
 * 整类屏蔽 ⇒ 英文画面描述里写了性行为，尾巴上却补不到任何体位/身体细节 tag。
 *
 * 现在的边界（本文件钉住）：
 *   ① **不再整类封禁**：非露骨 query 也能召回 `adult_*`（成人内容不参与检索准入判断）；
 *   ② **相关性仍然生效**：日常/无关 query 一条成人类目都不许冒出来；
 *   ③ 保底位（`collectAdultRescueItems`）不再要求 query 露骨，只看 keyword 是否真的命中；
 *   ④ 源码守卫：闸门函数不许被加回来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, seedImagePromptKnowledge } from '../src/db/index.js';
import {
  keywordSearchImagePromptKnowledge,
  collectAdultRescueItems,
} from '../src/services/imagePromptKnowledge.js';
import { composeImagePrompt } from '../src/services/imagePromptPreparer.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/services/imagePromptKnowledge.js');

/**
 * 合成一条「成人类目、但标签里一个露骨词都没有」的词库条目。
 * 用它就能把「闸门是否存在」和「种子数据里恰好有没有这类条目」彻底解耦。
 */
function seedWithSyntheticAdultRow() {
  const db = getDb();
  seedImagePromptKnowledge(db);
  db.prepare(`
    INSERT OR REPLACE INTO image_prompt_knowledge
      (knowledge_id, category, title, search_terms, content, executable_tags, scenes, is_default, priority, version, is_active)
    VALUES (?, ?, ?, ?, ?, ?, '[]', 0, 42, '1', 1)
  `).run(
    'adult_test_vocab',
    'adult_test_vocabulary',
    '测试成人词条',
    '构图 距离 测试成人词条',
    '标签词汇菜单（测试用）',
    JSON.stringify([{ tag: 'test_composition_tag', label: '构图距离', group: '测试' }]),
  );
  return db;
}

test('非露骨 query 也能召回 adult_* 词库（成人闸门已拆除）', () => {
  const db = seedWithSyntheticAdultRow();
  const items = keywordSearchImagePromptKnowledge('构图 距离', { scene: 'chat', limit: 200, db });
  const hit = items.find(i => i.id === 'adult_test_vocab');
  assert.ok(hit, '「构图 距离」不含任何露骨词，但必须能召回 adult_* 条目');
  assert.equal(hit.category, 'adult_test_vocabulary');
});

test('相关性仍然生效：无关 query 不召回成人类目', () => {
  const db = seedWithSyntheticAdultRow();
  for (const q of ['杯子里的一杯热咖啡放在木桌上', 'girl standing in a classroom, sunlight through window']) {
    const items = keywordSearchImagePromptKnowledge(q, { scene: 'chat', limit: 200, db });
    assert.equal(items.some(i => i.id === 'adult_test_vocab'), false, `无关 query 不该召回：${q}`);
  }
});

test('保底位不再要求 query 露骨，只看 keyword 是否真的命中', () => {
  const db = seedWithSyntheticAdultRow();
  const keywordItems = keywordSearchImagePromptKnowledge('构图 距离', { scene: 'chat', limit: 200, db });
  assert.ok(keywordItems.some(i => i.id === 'adult_test_vocab'), '前置条件：keyword 召回里有该成人条目');
  // fused 里完全没有该成人类目 ⇒ 应被保底补回
  const rescued = collectAdultRescueItems('构图 距离', [], keywordItems);
  assert.ok(rescued.some(i => i.id === 'adult_test_vocab'), 'keyword 命中就该保底，与 query 露不露骨无关');
  // keyword 里一条成人类目都没命中 ⇒ 不保底（相关性优先）
  const cleanItems = keywordSearchImagePromptKnowledge('一杯热咖啡', { scene: 'chat', limit: 200, db })
    .filter(i => !String(i.category || '').startsWith('adult_'));
  assert.deepEqual(collectAdultRescueItems('一杯热咖啡', [], cleanItems), []);
});

test('源码守卫：成人闸门函数不许被加回来', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.equal(src.includes('queryAllowsCategory'), false, '成人闸门（queryAllowsCategory）已拆除，不要再加回来');
  assert.equal(
    /adult_[\s\S]{0,40}containsExplicitAdultContent/.test(src),
    false,
    '不许再用露骨词表决定 adult_* 类目是否可见',
  );
});

test('日常 query 的成人类目候选不会被追加进最终 prompt（相关性地板仍在）', () => {
  const db = getDb();
  seedImagePromptKnowledge(db);
  const query = '杯子里的一杯热咖啡放在木桌上';
  const prompt = 'a cup of hot coffee on a wooden table, morning sunlight through the window';
  const items = keywordSearchImagePromptKnowledge(query, { scene: 'chat', limit: 200, db });
  // 拆掉成人闸门后，keyword 召回的候选里**会**混进成人类目（同一个 bigram 撞上了），
  // 但它们必须过不了 composeImagePrompt 的 LIB_TAG_MIN_SCORE(14)，从而不进最终 prompt。
  const { selectedTags } = composeImagePrompt(prompt, items, { ragQuery: query });
  const adultAppended = selectedTags.filter(t => String(t.category || '').startsWith('adult_'));
  assert.deepEqual(adultAppended, [], `日常画面不许被追加成人 tag：${adultAppended.map(t => t.tag).join(',')}`);
});
