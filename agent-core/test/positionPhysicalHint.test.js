/**
 * physicalHintOf：体位身体细节的取值优先级（PR#24 84 体位融合的接入点）
 *
 *   ① 面板精选 17 条（`POSITION_PHYSICAL_HINTS`）—— 文案逐字不动
 *   ② 84 条全量词库的 `frozen`（中文定格）—— 精选表没覆盖的体位靠它
 *   ③ 通用兜底句
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  physicalHintOf, POSITION_PHYSICAL_HINTS, GENERIC_PHYSICAL_HINT, PREFERRED_POSITION_KEYS,
} from '../src/services/intimateActionService.js';
import { listPositions } from '../src/services/positionLibrary.js';

test('精选体位仍用人工文案（逐字不动）', () => {
  const key = PREFERRED_POSITION_KEYS[0];
  assert.equal(physicalHintOf(key), POSITION_PHYSICAL_HINTS[key]);
});

test('精选表未覆盖的体位走 84 条词库的 frozen 定格描写', () => {
  const pos = listPositions().find(p => !POSITION_PHYSICAL_HINTS[p.key] && p.frozen);
  assert.ok(pos, '至少要有一条非精选体位');
  const hint = physicalHintOf(pos.name);
  assert.match(hint, new RegExp(pos.frozen.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '应带上 frozen 原文');
  assert.match(hint, /体位：/, '要标出体位名，便于模型锁定');
});

test('未知体位 / 空值回落通用兜底', () => {
  assert.equal(physicalHintOf(''), GENERIC_PHYSICAL_HINT);
  assert.equal(physicalHintOf('不存在的体位'), GENERIC_PHYSICAL_HINT);
  assert.equal(physicalHintOf(null), GENERIC_PHYSICAL_HINT);
});
