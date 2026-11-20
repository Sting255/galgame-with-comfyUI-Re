/**
 * LLM 输出里的 JSON 提取（括号配对扫描）—— 全仓统一口径
 *
 * ## 为什么单独成模块（2026-10-01）
 * 这段逻辑原本只住在 `eventGenerator.js`（13 个模块从那里 import）。
 * 但 `eventGenerator` 会**连带拉起生图栈**（`imageSkill` → `comfyClient`，import 时就会去打 ComfyUI
 * `/object_info`）—— 情绪评估只是想容错解析一段 JSON，不该顺手把整条生图依赖拖进来：
 * 启动变慢、单测凭空多出网络副作用。所以把扫描器抽到这里，谁要谁 import 这个小文件。
 *
 * `eventGenerator.js` 仍原样**再导出** `extractFirstJson`（13 处既有 import 不用改）。
 *
 * ## 它解决什么
 * 模型常见三种脏输出：
 *   ① 前后带话（"好的，这是结果：{…}"）
 *   ② 合法 JSON + **尾部多余字符**（真机日志逐字：`Unexpected non-whitespace character after JSON at position 169`）
 *   ③ ```json 代码块包裹
 * 关键点是**在第一个括号配平处收手**：尾部垃圾自然被丢掉。
 * 反例（曾经的写法）：取"第一个 `{` 到**最后**一个 `}`" ⇒ 把尾垃圾一起切进来、二次解析照样失败。
 *
 * 扫描时正确跳过字符串里的括号与转义（`{"a":"}"}` 这种不会提前收手）。
 */

/**
 * 从任意文本里取出**第一个完整的 JSON 对象**字符串。
 * @param {string} text
 * @returns {string|null} 未闭合 / 找不到 `{` 时返回 null
 */
export function extractFirstJson(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null; // 括号未闭合
}

/**
 * 修掉 LLM 在 JSON **字符串内部**写出的非法转义，但保留合法的 `\\` 对。
 *
 * 旧实现 `/\\\\([^"\\\\/bfnrtu])/g` 会对每个反斜杠独立匹配：合法 JSON 里的
 * `"A \\\\(original\\\\)"`（双反斜杠编码一个文字反斜杠）会被删成非法的 `\\(`。
 * 现在逐字符扫描，只有字符串内、且不是合法 JSON 转义起始的单反斜杠才去掉。
 * 对象外的反斜杠不属于 JSON token，原样保留，交给严格解析器判断。
 *
 * @param {string} text
 * @returns {string} 修好转义的原文（**不做** JSON.parse）
 */
export function repairJson(text) {
  const source = String(text ?? '');
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }

    const next = source[i + 1];
    if (next === undefined) {
      // 未闭合字符串的尾部反斜杠：留给严格 JSON 解析器判为不完整。
      out += ch;
      break;
    }
    if ('"\\/bfnrt'.includes(next)) {
      out += ch + next;
      i++;
      continue;
    }
    if (next === 'u') {
      // 只有完整 4 位十六进制才是合法 JSON Unicode 转义。残缺的 `\u12`、
      // 非法 `\uZZZZ` 与尾截断 `\u` 都必须原样留给严格解析器判失败，
      // 不能把反斜杠删成普通文字，否则会静默改写内容。
      if (/^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
        out += source.slice(i, i + 6);
        i += 5;
      } else {
        out += ch;
      }
      continue;
    }
    // 字符串内的非法单转义：例如 `\(` / `\.` / `\'`。
    out += next;
    i++;
  }
  return out;
}

/**
 * 「扫出第一个完整 JSON 对象并解析成值」的便利封装。
 * 与 `extractFirstJson` 的区别：这个直接给**对象**，失败给 `null`（调用方不用自己再 parse 一遍）。
 * 解析顺序与各模块既有写法一致：先原样 `JSON.parse`，失败再用 `repairJson` 修一次。
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseFirstJson(text) {
  const jsonStr = extractFirstJson(text);
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    try { return JSON.parse(repairJson(jsonStr)); } catch { return null; }
  }
}
