/**
 * characterStandingDisplay.js — 场景立绘的**展示状态**（哪个角色、哪一套、播到第几帧）。
 *
 * 2026-10-13 合并上游 v3.9.0。与 characterStanding.js 的分工：
 *   characterStanding.js  数据层（character_standings 表的读写 + 兜底）
 *   本文件                 展示层（全局选中谁/哪套 + 每个角色各自的回合指针）
 *
 * 为什么要"每个角色各自一份"：全局 display 只追踪当前选中那个角色，
 * 切走再切回来时原来那个角色的回合（表情播放进度）就断了 ⇒ 用 per-character
 * 的 scoped display 保住各自的 turn，全局只负责"现在看谁"。
 */

import { createStandingDisplay } from './standingDisplayState.js';

/** Keep per-character turns alive when the independent display selects someone else. */
export function withCharacterStandingStates(global, options) {
  const characters = new Map();
  const turns = new WeakMap();
  function character(id) {
    id = Number(id);
    if (!characters.has(id)) characters.set(id, createStandingDisplay({ ...options, initialCharacter: id }));
    return characters.get(id);
  }
  return {
    ...global,
    characterSnapshot: id => character(id).snapshot(),
    begin(id, key) {
      const turn = global.begin(id, key);
      const scoped = character(id);
      turns.set(turn, { scoped, turn: scoped.begin(id, key) });
      return turn;
    },
    expression(turn, slot) {
      global.expression(turn, slot);
      const local = turns.get(turn);
      if (local) local.scoped.expression(local.turn, slot);
    },
    complete(turn) {
      global.complete(turn);
      const local = turns.get(turn);
      if (local) local.scoped.complete(local.turn);
    },
    reason(turn, text) {
      global.reason(turn, text);
      const local = turns.get(turn);
      if (local) local.scoped.reason(local.turn, text);
    },
    refresh() { global.refresh(); for (const local of characters.values()) local.refresh(); },
  };
}
