/**
 * `parseCharacterLoras` 收口回归（2026-10-17 新建，对应全项目复查 §三-4）
 *
 * ## 背景
 *
 * 这个函数名在本仓曾有 **4 份本地实现**，而且语义分成两派：
 *   · 归一化版（滤无 path、weight 默认 0.6、triggerWord 保证字符串）—— emojiService / groupImageLoraMatcher
 *   · 裸版（只 JSON.parse + isArray）—— mediaService / newspaperService
 *
 * 2026-10-15 那轮判"语义不同、保持原样"；2026-10-17 复查实测 **4 份俱在**（记录与现状不符），
 * 列 P2 要求一次性收口。
 *
 * ## 本文件钉什么
 *
 *   ① 正源只有 `services/characterLoras.js` 一份，且**零依赖**（6 个模块引用它，
 *      拖 DB / 生图栈会放大启动成本 —— 同 jsonExtract.js 的教训）；
 *   ② 四个旧位置不再自带实现（两个已删除、两个只剩一行 `raw: true` 的薄绑定）；
 *   ③ **两种形态语义逐字段不变**（收口不许顺手改行为）：
 *      归一化版补 weight / 滤无 path；裸版原样返回（`weight: undefined` 不许被补成 0.6）；
 *   ④ 再导出位（emojiService / groupImageLoraMatcher）与正源**同一个函数**（不是两份实现）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../src/services/${rel}`, import.meta.url), 'utf8');

const { parseCharacterLoras } = await import('../src/services/characterLoras.js');
const emoji = await import('../src/services/emojiService.js');
const matcher = await import('../src/services/groupImageLoraMatcher.js');

// ── ① 正源 ────────────────────────────────────────────────────────────────

test('① 正源 characterLoras.js 零依赖（6 个模块引用它，不许拖 DB / 生图栈）', () => {
  const src = read('characterLoras.js');
  assert.equal(/^import /m.test(src), false, '不许 import 任何东西');
  assert.match(src, /export function parseCharacterLoras\(/, '要导出唯一实现');
});

test('② 四个旧位置不再自带实现（两个已删、两个只剩薄绑定）', () => {
  // 已删除本地实现的：改为再导出
  // ⚠️ 断言的是 `import ... ; export { ... }` 这种**建立本地绑定**的写法，
  //    不是 `export { x } from '...'` —— 后者不会在当前模块建立绑定，
  //    而 groupImageLoraMatcher 内部还要自己调它（实测会 ReferenceError）。
  for (const file of ['emojiService.js', 'groupImageLoraMatcher.js']) {
    const src = read(file);
    assert.match(src, /import \{ parseCharacterLoras \} from '\.\/characterLoras\.js'/, `${file} 要 import 正源`);
    assert.match(src, /export \{ parseCharacterLoras \}/, `${file} 要原样再导出`);
    assert.equal(/export function parseCharacterLoras\(/.test(src), false, `${file} 不许再自带实现`);
  }
  // 内部还要自己调它的那个文件，必须是「import + export」而不是 `export {} from`
  assert.equal(
    /export \{ parseCharacterLoras \} from/.test(read('groupImageLoraMatcher.js')), false,
    'groupImageLoraMatcher 内部要调用它，必须 import 建立本地绑定（`export {} from` 不行）',
  );
  // 裸版调用点：只剩一行绑定，且必须显式 raw: true
  for (const file of ['mediaService.js', 'newspaperService.js']) {
    const src = read(file);
    assert.equal(/^function parseCharacterLoras\(/m.test(src), false, `${file} 不许再自带实现`);
    assert.match(
      src,
      /const parseCharacterLoras = \(loras\) => parseCharacterLorasImpl\(loras, \{ raw: true \}\)/,
      `${file} 必须显式绑裸版（raw: true）—— 用默认归一化版会顺手补 weight、改变行为`,
    );
    assert.match(src, /import \{ parseCharacterLoras as parseCharacterLorasImpl \} from '\.\/characterLoras\.js'/,
      `${file} 要从正源引入`);
  }
  // 全仓只允许一处 `function parseCharacterLoras`
  const files = ['characterLoras.js', 'emojiService.js', 'groupImageLoraMatcher.js', 'mediaService.js', 'newspaperService.js'];
  const defs = files.filter(f => /(^|\n)(export )?function parseCharacterLoras\(/.test(read(f)));
  assert.deepEqual(defs, ['characterLoras.js'], '实现只许在正源里');
});

// ── ③ 归一化版：语义逐字段不变 ────────────────────────────────────────────

test('③ 归一化版：滤无 path、weight 默认 0.6、triggerWord 保证字符串（与旧实现逐字段一致）', () => {
  const char = {
    loras: JSON.stringify([
      { path: 'a.safetensors', weight: 0.8, triggerWord: 'trig' },
      { path: 'b.safetensors' },                          // 无 weight / triggerWord
      { weight: 0.5 },                                     // 无 path ⇒ 滤掉
      { path: 123 },                                       // path 非字符串 ⇒ 滤掉
      null,                                                // 脏条目不崩
    ]),
  };
  assert.deepEqual(parseCharacterLoras(char), [
    { path: 'a.safetensors', weight: 0.8, triggerWord: 'trig' },
    { path: 'b.safetensors', weight: 0.6, triggerWord: '' },
  ]);
});

test('③ 归一化版：坏输入一律给 []（不抛、不返回 null）', () => {
  for (const bad of [null, undefined, {}, { loras: '' }, { loras: 'not json' }, { loras: '{}' }, { loras: '[]' }, { loras: 123 }]) {
    assert.deepEqual(parseCharacterLoras(bad), [], `坏输入 ${JSON.stringify(bad)} 要给 []`);
  }
  // 数组字段直接传（不是角色对象）也要能用
  assert.deepEqual(parseCharacterLoras([{ path: 'x' }]), [{ path: 'x', weight: 0.6, triggerWord: '' }]);
});

// ── ④ 裸版：原样返回（不许被归一化污染） ──────────────────────────────────

test('④ 裸版（raw: true）：原样返回，**不许**补 weight / 滤无 path（否则就是改行为）', () => {
  const input = [{ path: 'a.safetensors' }, { weight: 0.5 }, 'weird'];
  assert.deepEqual(parseCharacterLoras(input, { raw: true }), input,
    '裸版必须原样返回（旧 mediaService / newspaperService 就是这么用的）');
  // 传角色对象也支持（旧调用点传的是 char.loras，两种都接受）
  assert.deepEqual(parseCharacterLoras({ loras: JSON.stringify([{ weight: 1 }]) }, { raw: true }), [{ weight: 1 }]);
  for (const bad of [null, undefined, {}, { loras: 'not json' }, { loras: '{}' }]) {
    assert.deepEqual(parseCharacterLoras(bad, { raw: true }), []);
  }
});

test('④ 两派差异是显式的：同一条无 weight 的 LoRA，两版输出必须不同', () => {
  const input = [{ path: 'a.safetensors' }];
  assert.deepEqual(parseCharacterLoras(input), [{ path: 'a.safetensors', weight: 0.6, triggerWord: '' }]);
  assert.deepEqual(parseCharacterLoras(input, { raw: true }), [{ path: 'a.safetensors' }],
    '裸版不许补 weight —— 这正是两派不能硬合成一份的原因');
});

// ── ⑤ 再导出位与正源是同一个函数 ──────────────────────────────────────────

test('⑤ 再导出位与正源是**同一个函数引用**（不是两份实现，改一处必须两处都变）', () => {
  assert.equal(emoji.parseCharacterLoras, parseCharacterLoras, 'emojiService 的再导出必须指向正源');
  assert.equal(matcher.parseCharacterLoras, parseCharacterLoras, 'groupImageLoraMatcher 的再导出必须指向正源');
});

test('⑤ 既有调用点仍按各自形态使用（防将来有人把裸版改成归一化版）', () => {
  // emoji / 立绘：归一化版（不传 raw）
  assert.match(read('emojiService.js'), /parseCharacterLoras\(char\)/, 'emojiService 用归一化版');
  assert.match(read('expressionStandingService.js'), /loras: parseCharacterLoras\(char\)/, '立绘用归一化版');
  assert.match(read('groupImagePipeline.js'), /parseCharacterLoras\(speaker\)/, '群聊发图人用归一化版');
  // media / newspaper：裸版
  assert.match(read('mediaService.js'), /parseCharacterLoras\(character\?\.loras\)/, '媒体用裸版');
  assert.match(read('newspaperService.js'), /parseCharacterLoras\(character\?\.loras\)/, '报纸用裸版');
});
