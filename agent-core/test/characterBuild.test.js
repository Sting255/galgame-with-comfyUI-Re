/**
 * characterBuild 单测（移植 PR#24 + 本地 D4 三态口径）
 *
 * 钉住：
 *   ① 身高解析（「身高157cm」「157cm」）与档位分界
 *   ② 只有体型词没有身高 → keyword 来源
 *   ③ 什么都没有 → null（绝不猜数值）
 *   ④ 交叉参考里的体型行（`buildBodySizeLine`）措辞与显著性
 *   ⑤ 多人同屏体型对照（`buildCastBodySummary`）：少于两人不输出
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHeightCm, bucketOfHeight, extractBuildTag, deriveBuild,
  buildBodySizeLine, buildCastBodySummary,
} from '../src/services/characterBuild.js';

test('身高解析：明确写法优先，120~210 之外视为误匹配', () => {
  assert.equal(extractHeightCm('你身高157cm，体型偏瘦'), 157);
  assert.equal(extractHeightCm('身高约 168 cm'), 168);
  assert.equal(extractHeightCm('157cm'), 157);
  assert.equal(extractHeightCm('身高 99cm'), null, '低于 120 视为误匹配');
  assert.equal(extractHeightCm('身高 260cm'), null, '高于 210 视为误匹配');
  assert.equal(extractHeightCm('没有身高信息'), null);
});

test('档位分界：152 / 160 / 168 / 175', () => {
  assert.equal(bucketOfHeight(151), 'petite');
  assert.equal(bucketOfHeight(152), 'short');
  assert.equal(bucketOfHeight(159), 'short');
  assert.equal(bucketOfHeight(160), 'average');
  assert.equal(bucketOfHeight(168), 'average');
  assert.equal(bucketOfHeight(169), 'tall');
  assert.equal(bucketOfHeight(175), 'tall');
  assert.equal(bucketOfHeight(176), 'verytall');
  assert.equal(bucketOfHeight(null), null);
});

test('体型词兜底：娇小/纤细/丰满/高挑/匀称', () => {
  assert.equal(extractBuildTag('身材娇小'), 'petite');
  assert.equal(extractBuildTag('体态纤细'), 'slender');
  assert.equal(extractBuildTag('身姿丰满'), 'curvy');
  assert.equal(extractBuildTag('个子高挑'), 'tall');
  assert.equal(extractBuildTag('身材匀称'), 'average');
  assert.equal(extractBuildTag('普通描述'), null);
});

test('deriveBuild：身高优先，其次体型词，都没有则 null', () => {
  const byHeight = deriveBuild({ base_prompt: '你是云璃。身高 158cm，剑士。' });
  assert.equal(byHeight.source, 'height');
  assert.equal(byHeight.heightCm, 158);
  assert.match(byHeight.en, /short \(about 158cm\)/);

  const byTag = deriveBuild({ base_prompt: '你是某甲。体态纤细，话少。' });
  assert.equal(byTag.source, 'keyword');
  assert.equal(byTag.bucket, 'slender');
  assert.match(byTag.en, /slender build/);

  const none = deriveBuild({ base_prompt: '你是某乙。来路不明。' });
  assert.equal(none.source, null);
  assert.equal(none.en, null);
});

test('体型行：读得出就给「【体型】」标注，读不出返回 null（不加噪声）', () => {
  const line = buildBodySizeLine({ base_prompt: '身高 172cm' });
  assert.match(line, /【体型】身高约 172cm/);
  assert.match(line, /生图 tag：/);
  assert.equal(buildBodySizeLine({ base_prompt: '没有体型信息' }), null);
});

test('多人同屏对照：少于两人或只有一人有身高时不输出', () => {
  assert.equal(buildCastBodySummary([{ display_name: 'A', base_prompt: '身高 155cm' }]), null, '单人不需要对照');
  assert.equal(buildCastBodySummary([
    { display_name: 'A', base_prompt: '身高 155cm' },
    { display_name: 'B', base_prompt: '没有身高' },
  ]), null, '只有一个人有身高 → 无从对比');
});

test('多人同屏对照：按身高排序并标出最矮/最高', () => {
  const out = buildCastBodySummary([
    { display_name: '银狼', base_prompt: '身高 168cm' },
    { display_name: '纳西妲', base_prompt: '身高 152cm' },
    { display_name: '云璃', base_prompt: '身高 158cm' },
  ]);
  assert.match(out, /必须体现在画面的高度差上/);
  const lines = out.split('\n');
  assert.match(lines[1], /纳西妲.*152cm.*全场最矮/);
  assert.match(lines[3], /银狼.*168cm.*全场最高/);
  assert.match(out, /严禁把全场角色画成同一高度/);
});
