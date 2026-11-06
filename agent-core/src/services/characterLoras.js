/**
 * 角色 LoRA 解析 —— **全仓唯一实现**（2026-10-17 收口）
 *
 * ## 为什么要有这个文件
 *
 * 同一个函数名 `parseCharacterLoras` 在本仓曾有 **4 份本地实现**，而且**语义分成两派**：
 *
 * | 位置 | 形态 | 谁在用 |
 * | --- | --- | --- |
 * | `emojiService.js:481` | **归一化版**：滤掉无 `path` 条目、补 `weight` 默认 0.6、补 `triggerWord` | 表情包、立绘（expressionStandingService） |
 * | `groupImageLoraMatcher.js:126` | **归一化版**（与上面逐字段等价） | 群聊发图人 LoRA（groupImagePipeline） |
 * | `mediaService.js:1355` | **裸版**：只 `JSON.parse` + `Array.isArray` | 媒体配图 |
 * | `newspaperService.js:401` | **裸版**（与上面逐字段等价） | 报纸特稿配图 |
 *
 * 2026-10-15 那一轮曾把它判为"语义不同、保持原样"，结果 2026-10-17 全项目复查 §三-4
 * 实测 **4 份俱在**（记录与现状不符），列成 P2 要求一次性收口。
 *
 * ## 收口口径（为什么是"一份实现 + 两种形态"而不是硬合成一份）
 *
 * 两派**不是**同一件事：
 *   · 归一化版的输出是**已加工**的（`weight` 有默认、`triggerWord` 保证是字符串），
 *     给 `generateImageRaw({ loras })` 用，它直接塞进工作流节点；
 *   · 裸版的输出是**原样**的（`raw` 交给 `generateImageRaw`，由 `imageSkill.buildWorkflow`
 *     自己 `normalizeLoraValue` + 过滤）。
 *
 * 硬把裸版改成归一化版**会改变行为**（例如给 `weight: undefined` 的条目补上 0.6，
 * 而旧行为是让下游自己决定）—— 那是"顺手改行为"，不是收敛。
 * 所以本模块**保留两种形态**，但**只有一份代码**：`raw: true` 走裸版分支。
 * 两派的差异被显式写成参数，而不是散在四个文件里靠人记。
 *
 * ## 用法
 *
 * ```js
 * import { parseCharacterLoras } from './characterLoras.js'
 *
 * parseCharacterLoras(char)               // 归一化版（默认）：emoji / 立绘 / 群聊发图人
 * parseCharacterLoras(char?.loras, { raw: true })  // 裸版：媒体 / 报纸
 * ```
 *
 * ⚠️ 传参口径：两种形态都接受「角色对象」或「loras 字段本身」（字符串 / 数组），
 *    因为四个旧调用点就是这么传的（两个传 char、两个传 char.loras）。
 *
 * ⚠️ 本模块**零依赖**（不 import config / DB / LLM）—— 它被 6 个模块引用，
 *    拖进 DB 或生图栈会放大启动成本（同 `jsonExtract.js` 的教训）。
 */

/**
 * 把 `loras` 字段（字符串 / 数组 / 空）解析成数组。
 * @param {unknown} value
 * @returns {Array} 解析失败 / 非数组 ⇒ `[]`
 */
function toLoraArray(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 角色 LoRA 解析（唯一实现）。
 *
 * @param {object|string|Array|null} source 角色对象（取 `.loras`）或 loras 字段本身
 * @param {{ raw?: boolean }} [opts]
 *   `raw: false`（默认）＝ 归一化版：滤掉无 `path` 的条目、`weight` 默认 0.6、`triggerWord` 默认 ''
 *   `raw: true` ＝ 裸版：原样返回解析结果（交给下游自己加工）
 * @returns {Array} 永不为 null；解析失败给 `[]`
 */
export function parseCharacterLoras(source, { raw = false } = {}) {
  // 传角色对象时取它的 loras 字段；传字段本身时（字符串 / 数组）直接用
  const value = (source && typeof source === 'object' && !Array.isArray(source))
    ? source.loras
    : source;
  const parsed = toLoraArray(value);
  if (raw) return parsed;
  return parsed
    .filter(lora => lora?.path && typeof lora.path === 'string')
    .map(lora => ({
      path: lora.path,
      weight: typeof lora.weight === 'number' ? lora.weight : 0.6,
      triggerWord: lora.triggerWord || '',
    }));
}
