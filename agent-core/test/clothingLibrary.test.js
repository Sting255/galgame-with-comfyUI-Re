import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClothingMarkdown, clothingEntryKind } from '../../scripts/import-clothing-library.mjs';
import { getClothingLibrary, resolveClothingTags, buildClothingAppearanceMessages, parseClothingAppearance } from '../src/services/clothingLibrary.js';

test('九类语料整理为唯一纯文本 tag，不包含图片或示例角色身份字段', () => {
  const library = getClothingLibrary();
  assert.equal(library.categories.length, 9);
  assert.equal(library.entries.length, 992);
  assert.equal(new Set(library.entries.map(entry => entry.tag)).size, library.entries.length);
  for (const entry of library.entries) {
    assert.ok(entry.label && entry.description && entry.categories.length);
    assert.ok(['scene', 'outfit'].includes(entry.kind));
    assert.equal('character' in entry, false);
    assert.equal('image' in entry, false);
  }
});

test('语料异构表头提取中文名与详细含义，忽略角色；dress 与 skirt 保留区分', () => {
  const source = '## 1. shirt — 衬衫\n<img src="./images/1 (1).jpg" />\n| Tag | shirt |\n| 中文含义 | 衬衫 / 上衣 |\n| 中文介绍 | 上半身服装 |\n| 角色 | unrelated_character |';
  const [entry] = parseClothingMarkdown(source, '衬衫');
  assert.equal(entry.tag, 'shirt');
  assert.equal(entry.label, '衬衫 / 上衣');
  assert.equal(entry.description, '上半身服装');
  assert.equal('imageSource' in entry, false);
  assert.equal('character' in entry, false);
  assert.match(resolveClothingTags(['dress'])[0].description, /skirt/);
});

test('选取去重，只允许库中的静态 tag，睡衣鞋袜硬拦截', () => {
  assert.deepEqual(resolveClothingTags(['collared_shirt', 'collared_shirt', 'pleated_skirt']).map(entry => entry.tag), ['collared_shirt', 'pleated_skirt']);
  assert.throws(() => resolveClothingTags(['fake_clothing']), /不存在/);
  assert.throws(() => resolveClothingTags('shirt'), /请选择/);
  assert.throws(() => resolveClothingTags(Array(33).fill('shirt')), /请选择/);
  assert.throws(() => resolveClothingTags(['shirt'], 'invalid'), /场景/);
  for (const tag of ['holding_shoes', 'unworn_shirt', 'shirt_lift', 'sock_pull', 'pantyhose_on_head']) assert.throws(() => resolveClothingTags([tag]), /静态外观/);
  assert.throws(() => resolveClothingTags(['shoes'], 'sleep'), /赤脚/);
  assert.throws(() => resolveClothingTags(['thighhighs'], 'sleep'), /赤脚/);
  assert.equal(clothingEntryKind('sundress'), 'outfit');
});

test('静态前缀逐字节稳定，完整 JSON 示例，角色与词条靠后，user 最后', () => {
  const first = buildClothingAppearanceMessages({ systemRules: '固定规则', worldRule: '固定世界观强化', persona: '角色甲', entries: resolveClothingTags(['shirt']), scene: 'work' });
  const second = buildClothingAppearanceMessages({ systemRules: '固定规则', worldRule: '固定世界观强化', persona: '角色乙', entries: resolveClothingTags(['dress']), scene: 'home', brief: '绣花' });
  assert.deepEqual(first.slice(0, 3), second.slice(0, 3));
  const example = JSON.parse(first[2].content.match(/\{"appearance":.*\}/)[0]);
  assert.deepEqual(Object.keys(example), ['appearance', 'conflict']);
  assert.equal(second.at(-1).role, 'user');
  assert.match(second.at(-1).content, /绣花/);
  assert.match(first[4].content, /shirt —/);
  assert.equal(buildClothingAppearanceMessages({ systemRules: '固定规则', persona: '角色甲', entries: [], scene: 'work' }).length, 5);
});

test('解析失败与搭配冲突不回填，英文外观与精确 tag 一起保存', () => {
  const entries = resolveClothingTags(['collared_shirt', 'pleated_skirt']);
  const appearance = 'Original Character has amber eyes and long brown hair, wearing a white shirt and a pleated skirt.';
  assert.equal(parseClothingAppearance(JSON.stringify({ appearance, conflict: '' }), entries), `${appearance}\nOutfit tags: collared_shirt, pleated_skirt.`);
  assert.throws(() => parseClothingAppearance('invalid', entries), /JSON/);
  assert.throws(() => parseClothingAppearance('{"appearance":"short"}', entries), /字段/);
  assert.throws(() => parseClothingAppearance('{"appearance":"short","conflict":""}', entries), /太短/);
  assert.throws(() => parseClothingAppearance('{"appearance":"","conflict":"同一件衬衫颜色冲突"}', entries), /颜色冲突/);
  assert.throws(() => parseClothingAppearance(JSON.stringify({ appearance: appearance + '（此处填写英文描述）', conflict: '' }), entries), /英文/);
  assert.throws(() => parseClothingAppearance(JSON.stringify({ appearance, conflict: '' }), entries, 'sleep'), /赤脚/);
  assert.throws(() => parseClothingAppearance(JSON.stringify({ appearance: appearance + ' barefoot with slippers.', conflict: '' }), entries, 'sleep'), /赤脚/);
  assert.match(parseClothingAppearance(JSON.stringify({ appearance: appearance + ' barefoot.', conflict: '' }), entries, 'sleep'), /barefoot/);
});

