/**
 * D4 体型三态优先级（2026-10-29）
 *
 * 口径：身体档案里人工填的身高 > AI 预填的身高 > 卡面/身体描述的文本推断。
 * 钉住四件事：
 *   ① 人工填的覆盖卡面文本（哪怕卡面写的是另一个数）
 *   ② AI 预填同样生效，但来源标记为 profile-ai（上层可提示"这是猜的、能改"）
 *   ③ 档案为空/非法时回落到文本推断，结果与没有档案时逐字一致
 *   ④ 数值解析认「157」「157cm」「1.57m」「约157厘米」这几种真有人写的写法
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };

const { getDb } = await import('../src/db/index.js');
const {
  resolveBodySize, buildBodySizeLine, parseProfileHeightCm, deriveBuild,
} = await import('../src/services/characterBuild.js');

function seedCharacter(basePrompt = '身高 150cm，体型偏瘦。') {
  const info = getDb()
    .prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run(`d4-${Math.random().toString(36).slice(2, 9)}`, '测试角色', basePrompt);
  return Number(info.lastInsertRowid);
}

function setProfile(characterId, height, aiEditFields = []) {
  getDb()
    .prepare('INSERT INTO character_body_profile (character_id, height, ai_edit_fields) VALUES (?, ?, ?)')
    .run(characterId, height, JSON.stringify(aiEditFields));
}

test('档案里人工填的身高覆盖卡面文本', () => {
  const id = seedCharacter('身高 150cm，体型偏瘦。');
  setProfile(id, '168');
  const d = resolveBodySize({ id, base_prompt: '身高 150cm，体型偏瘦。' });
  assert.equal(d.heightCm, 168, '人工值必须赢过卡面的 150');
  assert.equal(d.source, 'profile-manual');
  assert.equal(d.bucket, 'average');
});

test('AI 预填同样生效，但来源标记为 profile-ai', () => {
  const id = seedCharacter('身高 150cm。');
  setProfile(id, '172', ['height']);
  const d = resolveBodySize({ id, base_prompt: '身高 150cm。' });
  assert.equal(d.heightCm, 172);
  assert.equal(d.source, 'profile-ai');
  assert.equal(d.bucket, 'tall');
});

test('档案为空时回落到文本推断，结果与没有档案逐字一致', () => {
  const id = seedCharacter('身高 163cm。');
  setProfile(id, '');
  const withProfile = resolveBodySize({ id, base_prompt: '身高 163cm。' });
  const withoutProfile = deriveBuild({ base_prompt: '身高 163cm。' });
  assert.deepEqual(withProfile, withoutProfile);
  assert.equal(withProfile.source, 'height');
});

test('档案身高非法（写错/超范围）时回落文本，不猜数值', () => {
  const id = seedCharacter('体态纤细。');
  setProfile(id, '大概很高吧');
  const d = resolveBodySize({ id, base_prompt: '体态纤细。' });
  assert.equal(d.heightCm, null);
  assert.equal(d.source, 'keyword', '应回落到体型词而不是编一个身高');
});

test('档案身高解析：常见写法都能读，越界与乱写返回 null', () => {
  assert.equal(parseProfileHeightCm('157'), 157);
  assert.equal(parseProfileHeightCm('157cm'), 157);
  assert.equal(parseProfileHeightCm('约157厘米'), 157);
  assert.equal(parseProfileHeightCm('1.57m'), 157);
  assert.equal(parseProfileHeightCm('1.72 米'), 172);
  assert.equal(parseProfileHeightCm('99'), null, '低于 120 视为误填');
  assert.equal(parseProfileHeightCm('260'), null, '高于 210 视为误填');
  assert.equal(parseProfileHeightCm('很高'), null);
  assert.equal(parseProfileHeightCm(''), null);
});

test('体型行用的是档案值', () => {
  const id = seedCharacter('身高 150cm。');
  setProfile(id, '178');
  assert.match(buildBodySizeLine({ id, base_prompt: '身高 150cm。' }), /178cm/);
});
