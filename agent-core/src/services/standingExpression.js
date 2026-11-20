/**
 * 立绘表情切帧的**唯一驱动入口**（2026-10-21 收口）。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────
 * 立绘是**服务端独占**通道：前端只能读 `standing_display_state` / `character_standing_state`，
 * 唯一能改表情的是 `standingDisplay.publishStandingKeys(turn, [emojiKey])`（chat.js 用它播
 * 回复里的 `[表情名]`）。触摸 / 亲密 / 玩具三条链各自调 LLM 拿到 `facial_expression` 之后，
 * 也要推一次同样的通道 —— 原先 `routes/touch.js` 与 `routes/intimateActions.js` 各写了一份
 * **一模一样的三行子串匹配**（玩具链根本没推），真机结果是：
 *
 *   用户 2026-10-21：「动作倒是有了，表情很僵硬，都只有一个微笑，面部也没有别的反应。」
 *   日志实测：27 种自由表情词 → 旧匹配 **0/27 命中** → 立绘永远停在 `normal` 槽位。
 *
 * 所以这里收成一个入口：**匹配（`emojiExpressionMatch.matchEmojiKey`）+ 推帧**，
 * 三条链都只调 `driveStandingExpression(characterId, facialExpression, { tag })`。
 *
 * ── 口径 ──────────────────────────────────────────────────────────────
 * · 匹配不到就返回 null（**不猜、不报错、不影响动作**）—— 这是既有行为的兼容底线；
 * · 任何异常只 warn（立绘是表现层，永远不能把动作链带崩）；
 * · `tag` 只用于日志前缀（`[touch]` / `[intimate-action]` / `[toys]`），便于真机定位。
 */
import { randomUUID } from 'node:crypto';
import { getStandingDisplay, publishStandingKeys } from './standingDisplay.js';
import { getCharacterEmojiMap } from './emojiService.js';
import { matchEmojiKey } from './emojiExpressionMatch.js';

/**
 * 按自由表情词推一次立绘表情帧。
 *
 * @param {number} characterId
 * @param {string} facialExpression  模型给的自由表情词（「失神咬唇」「潮红失神」…）
 * @param {{ tag?: string }} [opts]  `tag` 仅用于日志前缀
 * @returns {string|null} 命中的表情名（诊断用）；没命中 / 出错都返回 null
 */
export function driveStandingExpression(characterId, facialExpression, { tag = 'standing-expression' } = {}) {
  const label = String(facialExpression || '').trim();
  if (!label) return null;
  try {
    const keys = [...getCharacterEmojiMap(characterId).keys()];
    const hit = matchEmojiKey(keys, label);
    if (!hit) return null;
    const display = getStandingDisplay();
    display.select(characterId);
    const turn = display.begin(characterId, randomUUID());
    publishStandingKeys(turn, [hit]);
    display.complete(turn);
    return hit;
  } catch (err) {
    console.warn(`[${tag}] 立绘表情联动失败（不影响动作）:`, err?.message || err);
    return null;
  }
}
