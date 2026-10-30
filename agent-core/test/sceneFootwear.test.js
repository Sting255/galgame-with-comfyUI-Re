/**
 * 场景服装脚部口径（`enforceSceneFootwear`）单测 —— 移植自 PR#24 `outfitScene.js:144-218`
 *
 * 钉住四件事：
 *   ① 居家：赤脚/袜子段**原位**换成 indoor slippers（不挪到末尾、不留悬空片段）
 *   ② 居家：已有拖鞋时只删赤脚/袜子段，不重复追加
 *   ③ 睡衣：删掉所有脚部段（含裸脚踝），末尾补 barefoot
 *   ④ 其它场景 / 空值：原样返回（不凭空造鞋）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceSceneFootwear } from '../src/services/outfitScene.js';

test('居家：赤脚段原位换成室内拖鞋，其它段顺序不变', () => {
  const out = enforceSceneFootwear('home', 'oversized hoodie, barefoot, black shorts');
  assert.match(out, /indoor slippers/);
  assert.doesNotMatch(out, /barefoot/i);
  assert.equal(out, 'oversized hoodie, indoor slippers, black shorts', '顺序必须保持原位');
});

test('居家：袜子+赤脚同时出现 → 只留一个拖鞋，不留悬空片段', () => {
  const out = enforceSceneFootwear('home', 'covered in fuzzy slippers and ankle socks, barefoot');
  const hits = out.match(/slipper/gi) || [];
  assert.equal(hits.length, 1, '拖鞋只能出现一次');
  assert.doesNotMatch(out, /covered in$/i, '不能留下悬空片段');
});

test('居家：已有拖鞋 → 不重复追加', () => {
  const out = enforceSceneFootwear('home', 'linen dress, white cloth indoor slippers');
  assert.equal((out.match(/slipper/gi) || []).length, 1);
  assert.equal(out, 'linen dress, white cloth indoor slippers');
});

test('居家：裸脚踝/脚链保留（不是鞋）', () => {
  const out = enforceSceneFootwear('home', 'knit cardigan, bare ankle with a thin anklet');
  assert.match(out, /bare ankle/i, '裸脚踝不是鞋，不能被删');
});

test('睡衣：删掉所有鞋袜并补 barefoot', () => {
  const out = enforceSceneFootwear('sleep', 'short camisole, white socks, bedroom slippers');
  assert.doesNotMatch(out, /socks|slippers/i);
  assert.match(out, /barefoot/);
  assert.equal(out, 'short camisole, barefoot');
});

test('睡衣：本来就赤脚 → 不重复 barefoot', () => {
  const out = enforceSceneFootwear('sleep', 'camisole and shorts, barefoot');
  assert.equal((out.match(/barefoot/gi) || []).length, 1);
});

test('其它场景与空值原样返回', () => {
  const casual = 'blue jeans, white sneakers';
  assert.equal(enforceSceneFootwear('casual', casual), casual, '私服不动');
  assert.equal(enforceSceneFootwear('work', 'suit, leather shoes'), 'suit, leather shoes', '常服不动');
  assert.equal(enforceSceneFootwear('home', ''), '', '空值不凭空造鞋');
  assert.equal(enforceSceneFootwear('home', null), null);
  assert.equal(enforceSceneFootwear('sleep', undefined), undefined);
});
