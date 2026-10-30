/**
 * sceneOutfitRegistry.js — 场景服装的**注册表叶子**（不成环的关键一跳）。
 *
 * 为什么需要它：characterPersona.js 被 58 处引用，是所有生图路径的必经之处；
 * 而 outfitScene.js 反向 import characterPersona（取 splitAppearanceSection）——
 * 两边静态互引会成环（本仓 TDZ 血泪史：变量在 import 阶段被用到直接 ReferenceError）。
 *
 * 解法（与 wornToysBrief 同一套口径）：
 *   · 本文件零依赖，只存一个 provider；
 *   · outfitScene 在**模块加载期**把自己注册进来；
 *   · characterPersona 只 import 本叶子，通过 provider 间接拿「此刻该穿哪套」。
 *
 * provider 抛任何错都被吞成 null（零注入）—— 场景服装是增强项，绝不拖垮生图主链。
 */

let provider = null;

/** outfitScene 加载时调用（幂等，重复注册以最后一次为准） */
export function registerSceneOutfitProvider(fn) {
  if (typeof fn === 'function') provider = fn;
}

/**
 * characterPersona 调用：返回 {limited:[{name,description}], exclusive:null} 或 null
 *
 * @param {number} characterId
 * @param {{scene?: 'current'|'base'}} [opts] - `base` = 基准形象固装（头像/立绘/表情包用常服，
 *   不随时间和日程变），缺省 = 此刻该穿哪套
 */
export function getSceneOutfitProvider(characterId, opts = {}) {
  if (!provider) return null;
  try {
    return provider(characterId, opts) || null;
  } catch {
    return null;
  }
}
