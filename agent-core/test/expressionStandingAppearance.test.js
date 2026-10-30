import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStandingPersona, normalizeStandingOutfitScene } from '../src/services/expressionStandingAppearance.js';
import { buildStandingPromptMessages } from '../src/services/expressionStandingPrompt.js';
import { parseStandingPrompts } from '../src/services/expressionStandingPipeline.js';

const char = { id: 42, display_name: '测试角色', base_prompt: '你是测试角色，来自测试作品。\n\n## 你的外观\n银发蓝瞳，穿白色制服。' };
const outfits = [
  { scene: 'work', name: '旧工装', description: '不应覆盖人物卡的旧制服' },
  { scene: 'casual', name: '便装', description: '红色外套与长裤' },
  { scene: 'home', name: '居家服', description: '绿色宽松上衣' },
  { scene: 'sleep', name: '睡衣', description: '蓝色睡裙，赤脚' },
];

test('default appearance uses the character card without reading outfits or the current schedule', () => {
  const persona = buildStandingPersona(char, undefined, () => { throw new Error('must not look up outfits'); });
  assert.match(persona, /银发蓝瞳，穿白色制服/);
  assert.doesNotMatch(persona, /旧制服|睡裙/);
});

test('each explicit scene injects only its own outfit through characterPersona', () => {
  for (const scene of ['casual', 'home', 'sleep']) {
    const selected = outfits.find(row => row.scene === scene);
    const persona = buildStandingPersona(char, scene, id => { assert.equal(id, char.id); return outfits; });
    assert.ok(persona.includes(selected.description));
    assert.match(persona, /基础外观（仅用于填补/);
    for (const other of outfits.filter(row => row.scene !== scene)) assert.ok(!persona.includes(other.description));
  }
});

test('missing or blank selected outfit falls back to base appearance, never automatic outfits', () => {
  const base = buildStandingPersona(char);
  assert.equal(buildStandingPersona(char, 'casual', () => []), base);
  assert.equal(buildStandingPersona(char, 'home', () => [{ scene: 'home', description: '  ' }, outfits[3]]), base);
  // Full persona injection also works for older character cards without an appearance heading.
  assert.match(buildStandingPersona({ ...char, base_prompt: '角色简述' }, 'casual', () => outfits), /红色外套与长裤/);
});

test('unknown scene is rejected instead of silently selecting clothes by schedule', () => {
  assert.equal(normalizeStandingOutfitScene(), 'work');
  for (const scene of ['auto', '', null, {}, 'winter']) {
    assert.throws(() => normalizeStandingOutfitScene(scene), error => error.status === 400);
  }
});

const base = { systemRules: '世界观', worldRule: '世界观强化', slots: [{ id: 'normal', name: '正常' }], persona: '原始外观', outfitScene: 'casual' };
test('user appearance changes override original features in the last user message', () => {
  const messages = buildStandingPromptMessages({ ...base, requirement: '换成黑发绿瞳，穿白色连衣裙' });
  assert.equal(messages.at(-1).role, 'user');
  assert.match(messages.at(-1).content, /换成黑发绿瞳，穿白色连衣裙/);
  assert.match(messages.at(-1).content, /必须无条件按照以上用户意愿更改角色外观/);
  assert.match(messages.at(-1).content, /删除相冲突的旧特征/);
  assert.match(messages[2].content, /用户明确要求修改外观时/);
  assert.match(messages[3].content, /用户明确要求 > 本次所选形象/);
  assert.ok(!messages.slice(0, -1).some(message => message.content.includes('换成黑发绿瞳')));
});

test('static prompt prefix stays identical across characters, scenes, requirements and slots', () => {
  const a = buildStandingPromptMessages(base);
  const b = buildStandingPromptMessages({ ...base, persona: '另一位角色', outfitScene: 'sleep', requirement: '红发', slots: [{ id: 'emoji:1', name: '开心' }] });
  assert.deepEqual(a.slice(0, 4), b.slice(0, 4));
  assert.match(a.at(-1).content, /「私服」/);
  assert.match(b.at(-1).content, /「睡衣」/);
  assert.doesNotMatch(a.at(-1).content, /用户输入，外观修改/);
  const noWorld = buildStandingPromptMessages({ ...base, worldRule: '', requirement: '   ' });
  assert.equal(noWorld.length, a.length - 1);
  assert.doesNotMatch(noWorld.at(-1).content, /用户输入，外观修改/);
  const formatLayer = a.find(message => message.content.includes('本次完整 JSON 格式示例'));
  const example = JSON.parse(formatLayer.content.slice(formatLayer.content.indexOf('{')));
  assert.equal(parseStandingPrompts(JSON.stringify(example), base.slots).size, 1);
});
