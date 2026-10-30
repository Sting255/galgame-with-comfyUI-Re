/**
 * positionLibrary 单测（PR#24 84 体位融合的本地口径）
 *
 * 钉住：
 *   ① 84 条全量、key 唯一、knowledgeId 前缀为 `pose.pr24.`（PR#24 硬约束）
 *   ② 行为分类覆盖 vaginal / anal / oral / paizuri / handjob / tribadism
 *   ③ 非插入类（乳交/手交/指交/相贴）不被误判成插入；插入类必须判成插入
 *   ④ 本地既有的 17 条精选体位与 28 条触摸动作**逐字不动**（PR#24 硬约束）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  POSITIONS, POSITION_ACTIONS, listPositions, getPosition, getPositionByNo,
  resolvePositionKey, positionStats,
} from '../src/services/positionLibrary.js';

test('84 条全量，key 唯一，knowledgeId 前缀 pose.pr24.', () => {
  assert.equal(POSITIONS.length, 84, '源数据就是 84 条');
  const keys = new Set(POSITIONS.map(p => p.key));
  assert.equal(keys.size, 84, 'key 必须唯一');
  for (const p of POSITIONS) {
    assert.match(p.key, /^pr24\.\d{3}\.[a-z]+$/, `key 形状不对: ${p.key}`);
    assert.ok(p.knowledgeId.startsWith('pose.pr24.'), `knowledgeId 前缀不对: ${p.knowledgeId}`);
    assert.ok(p.name, `${p.key} 缺中文名`);
  }
});

test('行为分类覆盖主要类别', () => {
  const { byAct } = positionStats();
  for (const act of ['vaginal', 'anal', 'oral', 'paizuri', 'handjob', 'tribadism']) {
    assert.ok(byAct[act] > 0, `分类 ${act} 一条都没有`);
  }
  assert.equal(Object.values(POSITION_ACTIONS).flat().length, 84, '分类不丢条目');
});

test('非插入类不被误判，插入类必须判成插入', () => {
  const byName = new Map(listPositions().map(p => [p.name, p]));
  for (const name of ['双人乳交', '手交', '指交', '双女相贴交', '舔阴']) {
    const p = byName.get(name);
    if (!p) continue;
    assert.equal(p.penetrative, false, `${name} 不该判成插入`);
  }
  const vaginal = listPositions().filter(p => p.actKey === 'vaginal');
  assert.ok(vaginal.length > 0);
  assert.ok(vaginal.every(p => p.penetrative), 'vaginal 类必须全是插入');
});

test('按 key / 编号 / 名字都能查到', () => {
  const first = POSITIONS[0];
  assert.equal(getPosition(first.key)?.no, first.no);
  assert.equal(getPositionByNo(first.no)?.key, first.key);
  assert.equal(resolvePositionKey(first.name), first.key);
  assert.equal(resolvePositionKey('不存在的体位'), null);
});

test('本地 17 条精选体位与 28 条触摸动作保持原样（不被 84 条覆盖）', () => {
  const intimate = readFileSync(new URL('../src/services/intimateActionService.js', import.meta.url), 'utf8');
  assert.match(intimate, /export const PREFERRED_POSITION_KEYS = Object\.freeze\(\[/);
  assert.match(intimate, /'missionary',/, '精选体位第一条还在');
  assert.match(intimate, /'anal doggy, anus gape',/, '精选体位最后一条还在');

  const touch = readFileSync(new URL('../src/services/touchActionService.js', import.meta.url), 'utf8');
  assert.match(touch, /export const TOUCH_ACTIONS = Object\.freeze\(\[/, '触摸动作表还在');
  const touchKeys = [...touch.matchAll(/\{ key: '([a-z_]+)'/g)].map(m => m[1]);
  assert.equal(touchKeys.length, 28, `TOUCH_ACTIONS 应仍是 28 条，实际 ${touchKeys.length}`);
});
