/**
 * sceneOutfitPrompt 单测 —— **本地五态契约**（nude / work / casual / home / sleep）。
 *
 * ⚠️ 这份文件在 2026-10-14「上游 v3.9.0 漏合并修复」里被 `git checkout v3.9.0 --` 恢复过一次，
 * 恢复回来的是**上游 4 态旧契约**（casual/home/sleep +「名字 has 身体, wearing 衣服」整段格式）。
 * 本地 `sceneOutfitPrompt.js` 已经演进到 PR #24 的五态 + 身体/服装分层（197 行 vs 上游 69 行），
 * 所以 2026-10-15 按**本地契约**重写了本文件（乙类：上游测试过时 → 改测试，不改代码）。
 *
 * 本地契约（对应 `src/services/sceneOutfitPrompt.js`）：
 *   ① `GENERATED_OUTFIT_SCENES` = ['nude','work','casual','home','sleep']（五态）
 *   ② 每套输出 `body`（五套**完全一致**，来自 bodySource 真源）+ `description`（只写这一套的衣服）
 *   ③ `normalizeDesignScenes` 只接受五态；`buildSceneOutfitMessages` 的 messages 分层固定为
 *      [system 规则, system 设计规范, system 人设(+short_prompt), system? 默认外观, system? 反推层, user]
 *   ④ `parseSceneOutfitDesign` 要求**每个目标场景恰好一条**（缺/重/空名都抛错），
 *      身体一律以 bodySource 为准（模型改写也丢弃），nude 必须显式声明裸体
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSceneOutfitMessages,
  normalizeDesignScenes,
  parseSceneOutfitDesign,
  GENERATED_OUTFIT_SCENES,
  FALLBACK_OUTFITS,
} from '../src/services/sceneOutfitPrompt.js';

const context = {
  systemRules: '固定系统规则与世界观',
  worldRule: '固定世界观强化',
  persona: '人物甲的人设',
  displayName: '甲',
  baseAppearance: 'Existing appearance, unchanged.',
};

const THREE = ['casual', 'home', 'sleep'];

test('五态枚举与只支持设计五态的守卫', () => {
  assert.deepEqual(GENERATED_OUTFIT_SCENES, ['nude', 'work', 'casual', 'home', 'sleep']);
  assert.deepEqual(normalizeDesignScenes(['sleep', 'sleep', 'home']), ['sleep', 'home'], '去重且保序');
  assert.throws(() => normalizeDesignScenes([]), /只支持设计/);
  assert.throws(() => normalizeDesignScenes(['bikini']), /只支持设计/);
  assert.throws(() => normalizeDesignScenes('sleep'), /只支持设计/);
});

test('short_prompt 拼进人设层，前两层静态前缀逐字节不变；空值整条省略', () => {
  const baseline = buildSceneOutfitMessages({ ...context, scenes: [...THREE] });
  const messages = buildSceneOutfitMessages({ ...context, scenes: [...THREE], shortPrompt: '  优雅的裁衣师，偏好金色纹饰。  ' });

  // 前两层（系统规则 + 设计规范）必须逐字节一致
  assert.deepEqual(messages.slice(0, 2), baseline.slice(0, 2));
  // short_prompt 追加在第 3 层（人设层）末尾，且已 trim
  assert.match(messages[2].content, /人物甲的人设/);
  assert.ok(messages[2].content.includes('【角色简述（short_prompt）】\n优雅的裁衣师，偏好金色纹饰。'));
  assert.ok(messages[2].content.endsWith('优雅的裁衣师，偏好金色纹饰。'));

  for (const shortPrompt of [undefined, null, '', '  ']) {
    assert.deepEqual(buildSceneOutfitMessages({ ...context, scenes: [...THREE], shortPrompt }), baseline);
  }
});

test('messages 分层：人设 → 默认外观 → user 收尾；变量在后、前缀稳定', () => {
  const first = buildSceneOutfitMessages({ ...context, scenes: [...THREE] });
  const second = buildSceneOutfitMessages({
    ...context, persona: '人物乙的人设', displayName: '乙', baseAppearance: 'Other appearance.', scenes: ['sleep'],
  });

  // 前两层是跨角色共享的静态前缀（吃 LLM 缓存）
  assert.deepEqual(first.slice(0, 2), second.slice(0, 2));
  assert.match(first[2].content, /人物甲的人设/);
  assert.match(first[3].content, /Existing appearance, unchanged\./);
  // baseAppearance 在 + 没有 seeds/bodySource → 不出现反推层 → 5 条（user 收尾）
  assert.equal(first.length, 5);
  assert.equal(first.at(-1).role, 'user');
  assert.equal(second.at(-1).role, 'user');
  assert.equal(second.at(-1).content, '请设计 sleep，严格按规定 JSON 输出，仅包含这些场景。');

  // 必须提供默认外观
  assert.throws(() => buildSceneOutfitMessages({ ...context, scenes: [...THREE], baseAppearance: ' ' }), /缺少默认外观/);
});

test('设计规范层里的 JSON 示例可解析，且覆盖五态（不是上游的 3 套）', () => {
  const first = buildSceneOutfitMessages({ ...context, scenes: [...THREE] });
  const example = JSON.parse(first[1].content.match(/\{"outfits":.*\}/)[0]);
  const scenes = example.outfits.map(o => o.scene);
  assert.deepEqual(scenes, ['nude', 'work'], '示例只举两套（nude + work），完整枚举写在文字里');
  assert.ok(scenes.every(s => GENERATED_OUTFIT_SCENES.includes(s)));
  // 示例必须把身体/服装拆成两个字段（本地分层契约的核心）
  assert.ok(example.outfits.every(o => typeof o.body === 'string' && typeof o.description === 'string'));
  // nude 那一套的 description 固定成裸体声明
  assert.equal(example.outfits.find(o => o.scene === 'nude').description, FALLBACK_OUTFITS.nude.description);
  // 规范文本里五态标签齐全，且写明睡衣必须赤脚
  for (const label of ['裸体', '常服', '私服', '居家', '睡衣']) {
    assert.ok(first[1].content.includes(label), `设计规范应覆盖「${label}」`);
  }
  assert.match(first[1].content, /barefoot/);
});

test('反推层：seeds / bodySource 存在时插在人设层之后、user 之前', () => {
  const withSeeds = buildSceneOutfitMessages({
    ...context, scenes: [...THREE],
    seeds: [{ scene: 'work', name: '常服', body: 'black hair, green eyes', description: 'wearing a white blouse' }],
    bodySource: 'black hair, green eyes',
  });
  assert.equal(withSeeds.length, 6, '人设 + 默认外观 + 反推层 + user = 比不带锚点多一层');
  assert.match(withSeeds[3].content, /default appearance|Existing appearance/i, '默认外观仍在人设之后');
  assert.match(withSeeds[4].content, /已确定的基准/, '反推层在人设/外观之后');
  assert.match(withSeeds[4].content, /black hair, green eyes/, '身体真源进了反推层');
  // user 收尾要提醒逐字照抄身体真源
  assert.match(withSeeds.at(-1).content, /身体描述的唯一真源/);
  // 只有 bodySource、没有 seeds 时也要有反推层
  const onlySource = buildSceneOutfitMessages({ ...context, scenes: [...THREE], bodySource: 'black hair' });
  assert.equal(onlySource.length, 6);
});

test('解析：目标场景之外的条目被忽略，抽象自然语言不被 300 字符截断', () => {
  const long = 'Wearing a softly fitted cotton dress with delicate embroidery. '.repeat(8).trim();
  assert.ok(long.length > 300, '样例必须超过旧 300 字符上限');
  const raw = JSON.stringify({
    outfits: ['nude', 'work', 'casual', 'home', 'sleep'].map(scene => ({ scene, name: '衣服', body: 'B', description: long })),
  });
  // 只要 casual/home/sleep ⇒ work 与 nude 被忽略
  const result = parseSceneOutfitDesign(raw, [...THREE]);
  assert.deepEqual(result.map(o => o.scene), THREE);
  assert.equal(result[0].description, long, '自然语言整段保留，不按 300 字符截断');
  // 只要 sleep ⇒ 只产出 sleep
  assert.deepEqual(parseSceneOutfitDesign(raw, ['sleep']).map(o => o.scene), ['sleep']);
});

test('解析：每个目标场景必须恰好一条（缺 / 重 / 空名都抛错，不用兜底覆盖原服装）', () => {
  const row = { scene: 'casual', name: '私服', body: 'B', description: 'Wearing a cotton dress.' };
  // casual 只有一条，但目标里还有 home/sleep → 缺 → 抛「不完整」
  assert.throws(() => parseSceneOutfitDesign(JSON.stringify({ outfits: [row] }), [...THREE]), /不完整/);
  // 同场景重复 → 抛「不完整或重复」
  assert.throws(() => parseSceneOutfitDesign(JSON.stringify({ outfits: [row, row] }), ['casual']), /不完整或重复/);
  // 缺名称 → 抛「缺少名称」
  assert.throws(() => parseSceneOutfitDesign(JSON.stringify({ outfits: [{ ...row, name: '  ' }] }), ['casual']), /缺少名称/);
  // 不是合法 JSON / 缺 outfits 数组
  assert.throws(() => parseSceneOutfitDesign('not json', ['casual']), /不是合法 JSON/);
  assert.throws(() => parseSceneOutfitDesign(JSON.stringify({ items: [] }), ['casual']), /缺少 outfits 数组/);
});

test('解析：body 一律以 bodySource 为准；没有真源时退回模型给的 body', () => {
  const raw = JSON.stringify({
    outfits: [{ scene: 'casual', name: '私服', body: '模型擅自改写的身体', description: 'wearing a cotton dress' }],
  });
  const withSource = parseSceneOutfitDesign(raw, ['casual'], { bodySource: 'black hair, green eyes' });
  assert.equal(withSource[0].body, 'black hair, green eyes', '模型改写必须被丢弃，五套身体要一致');
  const withoutSource = parseSceneOutfitDesign(raw, ['casual']);
  assert.equal(withoutSource[0].body, '模型擅自改写的身体');
});

test('解析：nude 必须显式声明裸体，否则回落到固定裸体声明', () => {
  const raw = JSON.stringify({
    outfits: [
      { scene: 'nude', name: '裸体', body: 'B', description: 'wearing a silk nightgown' },
      { scene: 'casual', name: '私服', body: 'B', description: 'wearing a cotton dress' },
    ],
  });
  const result = parseSceneOutfitDesign(raw, ['nude', 'casual']);
  assert.equal(result[0].description, FALLBACK_OUTFITS.nude.description, '没写 nude 字样就回落裸体声明');
  assert.equal(result[1].description, 'wearing a cotton dress', '其它场景不受影响');
  // 显式写了 nude 的则原样保留
  const explicit = parseSceneOutfitDesign(JSON.stringify({
    outfits: [{ scene: 'nude', name: '裸体', body: 'B', description: 'completely nude, bare skin' }],
  }), ['nude']);
  assert.equal(explicit[0].description, 'completely nude, bare skin');
});
