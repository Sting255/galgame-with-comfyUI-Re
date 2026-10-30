import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
const {
  buildCharacterPersona, extractAppearanceIdentityCorpus, replaceAppearanceSection, splitAppearanceSection,
} = await import('../src/services/characterPersona.js');

// 单独执行文字扩写路由，避免加载其他路由的后台任务；人格组装与回填使用真实实现。
const source = readFileSync(new URL('../src/routes/characters.js', import.meta.url), 'utf8');
const routeSource = source.slice(source.indexOf('const EXPAND_APPEARANCE_SYSTEM_PROMPT ='), source.indexOf('function _parseCharLoras'));
const character = {
  id: 42,
  short_prompt: 'SHORT_PERSONA: reserved, practical athlete.',
  base_prompt: '你是测试角色，来自《测试作品》。\n\n## 你的性格\nFULL_PERSONA_MUST_NOT_BE_SENT\n\n## 你的外观\nDEFAULT_APPEARANCE: silver hair, default uniform.',
};

function setup() {
  let handler;
  const requests = [];
  runInNewContext(routeSource, {
    router: { post(path, callback) { assert.equal(path, '/expand-appearance-draft'); handler = callback; } },
    config: { llm: { model: 'test' } },
    console: { log() {}, error() {} },
    getSystemRules: () => 'Fixed system rules',
    getDb: () => ({ prepare: () => ({ get: id => id === character.id ? character : undefined }) }),
    buildCharacterPersona, extractAppearanceIdentityCorpus, replaceAppearanceSection, splitAppearanceSection,
    chatSync: async messages => { requests.push(messages); return 'Test Character wears a newly designed sporty outfit.'; },
  });
  return {
    requests,
    async request(body) {
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
      await handler({ body }, response);
      return response;
    },
  };
}

for (const scene of ['私服', '居家', '睡衣']) {
  test(`${scene} 仅传角色简述与默认外观，旧服装仅用于回填`, async () => {
    const app = setup();
    const basePrompt = '草稿人设，保留不变。\n\n## 你的外观\nOLD_SCENE_OUTFIT\n## 后续段落\n保留后文';
    const response = await app.request({ brief: '帅气的运动装', character_id: 42, base_prompt: basePrompt, display_name: '测试角色', scene_label: scene });
    assert.equal(response.statusCode, 200);
    assert.equal(app.requests.length, 1);
    const messages = app.requests[0];
    const context = messages.find(message => message.content.includes('【角色简述与默认外观】')).content;
    assert.match(context, /SHORT_PERSONA/);
    assert.match(context, /DEFAULT_APPEARANCE/);
    assert.ok(messages.every(message => !/OLD_SCENE_OUTFIT|FULL_PERSONA_MUST_NOT_BE_SENT/.test(message.content)));
    assert.equal(messages.at(-1).role, 'user');
    assert.match(messages.at(-1).content, /帅气的运动装/);
    assert.match(response.body.base_prompt, /^草稿人设，保留不变。/);
    assert.match(response.body.base_prompt, /newly designed sporty outfit/);
    assert.ok(response.body.base_prompt.endsWith('## 后续段落\n保留后文'));
    assert.doesNotMatch(response.body.base_prompt, /OLD_SCENE_OUTFIT/);
  });
}

test('场景服装缺少或找不到角色时不回退到旧服装上下文', async () => {
  const app = setup();
  const body = { brief: '运动装', base_prompt: '## 你的外观\nOLD_SCENE_OUTFIT', scene_label: '私服' };
  assert.equal((await app.request(body)).statusCode, 400);
  assert.equal((await app.request({ ...body, character_id: 999 })).statusCode, 404);
  assert.equal(app.requests.length, 0);
});

test('未入库招募草稿仍可扩写默认外观，不发送完整人格', async () => {
  const app = setup();
  const response = await app.request({ brief: '运动装', display_name: '测试角色', base_prompt: character.base_prompt });
  assert.equal(response.statusCode, 200);
  const contents = app.requests[0].map(message => message.content).join('\n');
  assert.match(contents, /DEFAULT_APPEARANCE/);
  assert.doesNotMatch(contents, /FULL_PERSONA_MUST_NOT_BE_SENT/);
});
