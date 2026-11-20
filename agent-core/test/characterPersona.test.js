import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// Set isolation before importing characterPersona's config/db dependency chain.
await import('./force-memory-db.cjs');
process.env.LINSHE_ENV_PATH = path.join(os.tmpdir(), `linshe-persona-${randomUUID()}.missing.env`);
const {
  buildCharacterPersona,
  buildCharacterAppearanceSection,
  buildImageCrossRefInfo,
  captureCharacterOutfitSnapshot,
} = await import('../src/services/characterPersona.js');
const { registerSceneOutfitProvider } = await import('../src/services/sceneOutfitRegistry.js');

const appearance = '## 你的外观\nA Cheng (Floating Isles) has amber eyes, short black hair, wearing a white jacket.\n';
const character = {
  id: 101,
  display_name: '阿澄',
  base_prompt: `你是阿澄，来自浮岛。\n\n## 你的性格\n你喜欢地图。\n\n${appearance}`,
  short_prompt: '',
};

test('无生效外观时完整人格、短外观和外观段保留原文字节', () => {
  assert.equal(buildCharacterPersona(character, { variant: 'full', outfits: null }), character.base_prompt);
  assert.equal(buildCharacterPersona(character, { variant: 'short', outfits: null }), appearance.trim());
  assert.equal(buildCharacterAppearanceSection(character, { outfits: null }), appearance);
  assert.equal(buildCharacterPersona({ base_prompt: '只有人格，没有外观。\n' }, { variant: 'full', outfits: null }), '只有人格，没有外观。\n');
  assert.equal(buildCharacterPersona({ short_prompt: 'An original traveller.' }, { variant: 'full', outfits: null }), 'An original traveller.');
});

test('同一单图快照在服装切换后仍保持原服装且各入口一致', () => {
  let description = 'red linen coat with brass buttons';
  let reads = 0;
  registerSceneOutfitProvider(() => {
    reads++;
    return {
      scene: 'custom_travel', source: 'schedule', outfitId: 31, bodyLocked: true,
      outfit: { id: 31, description }, limited: [{ name: '旅行装', description }],
    };
  });
  try {
    const snapshot = captureCharacterOutfitSnapshot(character, { outfits: [] });
    description = 'blue cotton dress with a white sash';
    const originalReads = reads;
    for (const output of [
      buildCharacterPersona(character, { variant: 'full', outfitSnapshot: snapshot }),
      buildCharacterAppearanceSection(character, { outfitSnapshot: snapshot }),
      buildImageCrossRefInfo(character, { outfitSnapshot: snapshot }),
    ]) {
      assert.match(output, /red linen coat with brass buttons/);
      assert.doesNotMatch(output, /blue cotton dress/);
      assert.match(output, /amber eyes, short black hair/);
    }
    assert.equal(reads, originalReads, '重试/复用快照不得重新读取日程衣服');
    const later = captureCharacterOutfitSnapshot(character, { outfits: [] });
    assert.equal(snapshot.description, 'red linen coat with brass buttons');
    assert.equal(later.description, description);
    assert.notEqual(snapshot.descriptionHash, later.descriptionHash);
    assert.match(snapshot.descriptionHash, /^[a-f0-9]{16}$/);
  } finally {
    registerSceneOutfitProvider(() => null);
  }
});

test('另一角色不能消费不属于自己的服装快照', () => {
  const snapshot = captureCharacterOutfitSnapshot(character, {
    outfits: { limited: [{ name: '旅行披肩', description: 'a scarlet wool cape' }], exclusive: null },
  });
  const other = { ...character, id: 202, display_name: '小禾' };
  assert.match(buildCharacterPersona(character, { variant: 'full', outfitSnapshot: snapshot }), /scarlet wool cape/);
  assert.equal(buildCharacterPersona(other, { variant: 'full', outfitSnapshot: snapshot }), other.base_prompt);
  assert.equal(buildCharacterAppearanceSection(other, { outfitSnapshot: snapshot }), appearance);
  assert.doesNotMatch(buildImageCrossRefInfo(other, { outfitSnapshot: snapshot }), /scarlet wool cape|旅行披肩/);
});

test('目标日期及忽略当前手动选装标记传至同一次服装解析', () => {
  const targetDate = new Date(2030, 0, 12, 8, 30);
  let captured;
  registerSceneOutfitProvider((id, options) => {
    captured = { id, options };
    return { scene: 'sleep', source: 'schedule', outfitId: 9,
      outfit: { id: 9, description: 'cotton nightdress, barefoot' },
      limited: [{ name: '睡衣', description: 'cotton nightdress, barefoot' }], bodyLocked: true };
  });
  try {
    const snapshot = captureCharacterOutfitSnapshot(character, {
      outfits: [], outfitScene: 'current', date: targetDate, ignoreOverride: true,
    });
    assert.equal(captured.id, character.id);
    assert.equal(captured.options.date.getTime(), targetDate.getTime());
    assert.equal(captured.options.ignoreOverride, true);
    assert.equal(snapshot.scene, 'sleep');
    assert.equal(snapshot.source, 'schedule');
    assert.equal(snapshot.outfitId, 9);
  } finally {
    registerSceneOutfitProvider(() => null);
  }
});

test('显式禁用外观的历史图片快照不查询也不注入当前服装', () => {
  let reads = 0;
  registerSceneOutfitProvider(() => { reads++; return null; });
  try {
    const snapshot = captureCharacterOutfitSnapshot(character, { outfits: null, outfitScene: 'none' });
    assert.equal(reads, 0);
    assert.equal(snapshot.source, 'none');
    assert.equal(snapshot.description, '');
    assert.equal(buildCharacterPersona(character, { variant: 'full', outfitSnapshot: snapshot }), character.base_prompt);
  } finally {
    registerSceneOutfitProvider(() => null);
  }
});

test('日程服装的身体锁不吞掉独立限时形态', () => {
  registerSceneOutfitProvider(() => ({
    scene: 'work', source: 'schedule', bodyLocked: true,
    outfit: { id: 7, description: 'navy jacket with gold trim' },
    limited: [{ name: '常服', description: 'navy jacket with gold trim' }],
  }));
  try {
    const snapshot = captureCharacterOutfitSnapshot(character, {
      outfits: [{ name: '临时银发形态', description: 'long silver hair' }],
    });
    const output = buildCharacterPersona(character, { variant: 'full', person: character.display_name, outfitSnapshot: snapshot });
    assert.match(output, /long silver hair/);
    assert.match(output, /navy jacket with gold trim/);
    assert.match(output, /身体锁不限制/);
    assert.match(output, /只属于阿澄一个人/);
  } finally {
    registerSceneOutfitProvider(() => null);
  }
});
