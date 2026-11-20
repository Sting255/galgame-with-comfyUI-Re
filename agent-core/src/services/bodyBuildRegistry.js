/**
 * bodyBuildRegistry.js — 「体型行」的注册表叶子（与 sceneOutfitRegistry 同一套口径）。
 *
 * 为什么不让 characterPersona 直接 import characterBuild：
 *   characterBuild → outfitScene → characterPersona，反方向再引一次就成环
 *   （本仓 TDZ 血泪史：模块初始化期用到的变量直接 ReferenceError）。
 * 所以：
 *   · 本文件零依赖，只存一个 provider；
 *   · characterBuild 在**加载期**把自己注册进来；
 *   · characterPersona 只 import 本叶子。
 *
 * provider 异常一律吞成 null —— 体型是增强项，绝不能拖垮生图主链。
 */

let provider = null;

/** characterBuild 加载时调用（幂等，重复注册以最后一次为准） */
export function registerBodyBuildProvider(fn) {
  if (typeof fn === 'function') provider = fn;
}

/**
 * @param {object} character - characters 表行（至少含 base_prompt；有 id 时还能读身体描述）
 * @returns {string|null} 「【体型】身高约 157cm（生图 tag：…）」这类一行；读不出时为 null
 */
export function getBodyBuildLine(character) {
  if (!provider) return null;
  try {
    return provider(character) || null;
  } catch {
    return null;
  }
}
