/**
 * JSON 扫描器与转义修复的收口（2026-10-15）
 *
 * 背景：`extractFirstJson` / `repairJson` 这对函数在本仓**曾有 5 份本地实现**
 *   （`eventGenerator` / `itemService` / `libraryGenerator` / `momentResponseParser` / `replyPlanner`），
 * 于是"改一处忘一处"必然发生 —— 有的链路能容错解析、有的不能，日志里看不出来。
 * 现在正源只有 `services/jsonExtract.js` 一份；`eventGenerator.repairJson` 保留是给
 * 3 个既有 `import { repairJson } from './eventGenerator.js'` 的模块（mediaService / newspaperService /
 * itemGiftNarrative）用的**再导出兼容位**，不是第二份实现。
 *
 * 本文件钉住三件事：
 *   ① 正源模块零依赖（抽出来的意义就在这：不拖生图栈、不拖 DB）；
 *   ② 四个调用方不再自带扫描器（本地定义必须消失）；
 *   ③ 收口后语义不变（字符串口径 / 对象口径各归各，别接错）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readSrc = (rel) => fs.readFileSync(new URL(`../src/services/${rel}`, import.meta.url), 'utf8');
/** src 根目录的**真实路径**（仓库路径含中文，不能用 URL.pathname，会得到百分号编码） */
const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

const jsonExtract = await import('../src/services/jsonExtract.js');

// ── ① 正源模块 ───────────────────────────────────────────────────────────

test('jsonExtract.js 零依赖（抽出来的意义：不拖生图栈 / DB）', () => {
  const src = readSrc('jsonExtract.js');
  assert.equal(/^import /m.test(src), false, '不许 import 任何东西');
});

test('正源导出三个函数：extractFirstJson（字符串）/ repairJson / parseFirstJson（对象）', () => {
  assert.equal(typeof jsonExtract.extractFirstJson, 'function');
  assert.equal(typeof jsonExtract.repairJson, 'function');
  assert.equal(typeof jsonExtract.parseFirstJson, 'function');
});

test('extractFirstJson 返回**字符串**；parseFirstJson 返回**对象**（口径别接错）', () => {
  const raw = '好的：{"a":1} 尾巴';
  const str = jsonExtract.extractFirstJson(raw);
  assert.equal(typeof str, 'string');
  assert.equal(str, '{"a":1}');

  const obj = jsonExtract.parseFirstJson(raw);
  assert.equal(typeof obj, 'object');
  assert.deepEqual(obj, { a: 1 });
  assert.equal(jsonExtract.parseFirstJson('没有 JSON'), null, '扫不到给 null');
  assert.equal(jsonExtract.parseFirstJson('{"a":1'), null, '未闭合给 null');
});

test('repairJson 只修非法转义，合法转义原样保留', () => {
  assert.equal(jsonExtract.repairJson('{"a":"\\("}'), '{"a":"("}', '非法转义 \\( 要去掉反斜杠');
  assert.equal(jsonExtract.repairJson('{"a":"\\n"}'), '{"a":"\\n"}', '合法 \\n 保留');
  assert.equal(jsonExtract.repairJson('{"a":"\\"x"}'), '{"a":"\\"x"}', '合法 \\" 保留');
  assert.equal(jsonExtract.repairJson('{"a":"\\\\"}'), '{"a":"\\\\"}', '合法 \\\\ 保留');
  assert.equal(jsonExtract.repairJson(''), '', '空串不崩');
  assert.equal(jsonExtract.repairJson(null), '', 'null 不崩（不返回 "null"）');
});

test('parseFirstJson 遇到非法转义能自愈（与各调用方旧写法等价）', () => {
  // 模型常把 \（ 这类写出来 —— 原样 parse 必失败，修一次就过
  const bad = '{"text":"她\\（笑\\）"}';
  assert.equal((() => { try { JSON.parse(bad); return true } catch { return false } })(), false, '原样确实解析不了');
  assert.deepEqual(jsonExtract.parseFirstJson(bad), { text: '她（笑）' });
});

// ── ② 四个调用方不再自带扫描器 ───────────────────────────────────────────

test('四个调用方的本地实现都消失，改为 import 正源', () => {
  const cases = [
    ['itemService.js', /import \{ parseFirstJson as extractFirstJson \} from '\.\/jsonExtract\.js'/],
    ['libraryGenerator.js', /import \{ extractFirstJson, repairJson \} from '\.\/jsonExtract\.js'/],
    ['momentResponseParser.js', /import \{ extractFirstJson, repairJson as repairInvalidEscapes \} from '\.\/jsonExtract\.js'/],
    ['replyPlanner.js', /import \{ extractFirstJson, repairJson \} from '\.\/jsonExtract\.js'/],
  ];
  for (const [file, re] of cases) {
    const src = readSrc(file);
    assert.match(src, re, `${file} 要从 jsonExtract 引入`);
    assert.equal(/function extractFirstJson\(/.test(src), false, `${file} 不许再自带扫描器`);
  }
});

test('全仓再没有本地 extractFirstJson（2026-10-17 收掉最后一处 townLayoutAI）', () => {
  // 2026-10-17：`town/townLayoutAI.js` 那份是最后一份本地实现，已改为 import 正源。
  // 它旧实现是"第一个 { 到**最后**一个 }"的朴素切法（会把尾部垃圾一起切进来，
  // 正是本文件 §文件头列的反例）；改成配对扫描后尾垃圾自然被丢掉。
  const town = fs.readFileSync(new URL('../src/services/town/townLayoutAI.js', import.meta.url), 'utf8');
  assert.match(town, /import \{ extractFirstJson \} from '\.\.\/jsonExtract\.js'/, 'townLayoutAI 要从正源引入');
  assert.equal(/function extractFirstJson\(/.test(town), false, 'townLayoutAI 不许再自带扫描器');

  // 全仓扫描：src 下除正源外不许再出现 `function extractFirstJson`
  // ⚠️ 用 fileURLToPath 而不是手拼 pathname：仓库路径含中文，`new URL().pathname`
  //    会给出百分号编码（实测 scandir ENOENT）。
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (/function extractFirstJson\(/.test(src)) offenders.push(path.relative(SRC_ROOT, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(SRC_ROOT);
  assert.deepEqual(offenders, ['services/jsonExtract.js'], `扫描器只许在正源里，实测：${offenders.join('、')}`);
});

test('repairJson 的本地定义只剩正源 + eventGenerator 的兼容再导出位', () => {
  const files = ['itemService.js', 'libraryGenerator.js', 'momentResponseParser.js', 'replyPlanner.js'];
  for (const file of files) {
    assert.equal(/function repairJson\(/.test(readSrc(file)), false, `${file} 的本地 repairJson 应已删除`);
  }
  // eventGenerator 保留（3 个模块从它 import），但它必须是**唯一**的第二个位置
  const gen = readSrc('eventGenerator.js');
  assert.match(gen, /export function repairJson\(/, 'eventGenerator 的兼容位保留（mediaService 等在用）');
});

// ── ③ itemService 的口径特别提醒 ─────────────────────────────────────────

test('itemService 用的是对象口径（它旧版返回的是已解析对象，不是字符串）', () => {
  const src = readSrc('itemService.js');
  assert.match(src, /parseFirstJson as extractFirstJson/, '必须绑对象口径的那个（parseFirstJson）');
  // 调用点把它当对象用（`|| {}`）—— 若误接字符串口径，这里会静默变成"字符串当对象"
  assert.match(src, /extractFirstJson\(raw\) \|\| \{\}/, '调用点仍按对象语义使用');
});
