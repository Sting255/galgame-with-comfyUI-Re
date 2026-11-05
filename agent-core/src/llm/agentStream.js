// 原生工具调用流；普通聊天的 string generator 契约保持不变。

/** 部分模型（实测 deepseek 系）用这套自定义标签表达工具调用，而不是标准 tool_calls。 */
// ⚠ 标记里的竖线是全角 U+FF5C，手写成字面量极易混进外形相近的字符（实测踩过两次：
//   一次正则全不命中、一次闭合标签永远匹配不到导致正文被吞）。一律用码点构造。
const DSML_BAR = String.fromCodePoint(0xff5c, 0xff5c);
const DSML_OPEN = `<${DSML_BAR}DSML${DSML_BAR}`;
const DSML_CLOSE_ALL = `</${DSML_BAR}DSML${DSML_BAR} calls>`;

/** textBuf 末尾有多长正好是 DSML_OPEN 的一段前缀（分片时用来扣住不外发）。 */
function tailOpenPrefixLen(text, open) {
  for (let k = Math.min(open.length - 1, text.length); k > 0; k -= 1) {
    if (text.endsWith(open.slice(0, k))) return k;
  }
  return 0;
}

/**
 * 把一段 DSML 文本解析成标准 tool_calls 并塞进 calls（index → call）。
 * 格式：
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="read_group_messages">
 *   <｜｜DSML｜｜ parameter name="group_id" string="false">5</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 * string="false" 的参数按 JSON 还原成数字/布尔/对象，其余一律当字符串。
 */
function appendDsmlCalls(block, calls) {
  // ⚠ 用常量拼正则而不是写字面量：DSML 标记用的是全角竖线（U+FF5C），
  //   手写字面量时极易混进外形相近的字符（实测就踩了，正则一条都匹配不上）。
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = esc(DSML_OPEN);            // <｜｜DSML｜｜
  const openBody = esc(DSML_OPEN.slice(1)); // ｜｜DSML｜｜（闭合标签是 </｜｜DSML｜｜ xxx>）
  const invokeRe = new RegExp(`${open}\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/${openBody}\\s*invoke>`, 'g');
  const paramRe = new RegExp(`${open}\\s*parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)<\\/${openBody}\\s*parameter>`, 'g');
  for (const invoke of block.matchAll(invokeRe)) {
    const name = invoke[1];
    const args = {};
    for (const param of invoke[2].matchAll(paramRe)) {
      const [, key, isString, raw] = param;
      const value = String(raw ?? '');
      if (isString === 'false') {
        try { args[key] = JSON.parse(value); continue; } catch { /* 不是合法 JSON 就当字符串 */ }
      }
      args[key] = value;
    }
    const index = calls.size;
    calls.set(index, {
      id: `dsml_${Date.now()}_${index}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
}

export function buildAgentRequest(messages, tools, llm, { forceThinking = true, temperature = 0.72, toolChoice = 'auto' } = {}) {
  const params = { ...llm.extraBody, model: llm.model, messages, stream: true };
  delete params.response_format;
  delete params.tools;
  delete params.tool_choice;
  if (tools?.length) { params.tools = tools; params.tool_choice = toolChoice; }
  if (!forceThinking) {
    const normal = { model: llm.model, messages, temperature, stream: true };
    if (llm.thinkingMode !== 'omit') normal.thinking = { type: llm.thinkingMode === 'enabled' ? 'enabled' : 'disabled' };
    Object.assign(normal, llm.extraBody);
    delete normal.tools; delete normal.tool_choice; delete normal.response_format;
    if (tools?.length) { normal.tools = tools; normal.tool_choice = toolChoice; }
    return normal;
  }
  // 神说的思考不可被全局开关或 extraBody 关闭。按服务商协议设置，不靠 prompt 伪造思考。
  const model = String(llm.model || '').toLowerCase();
  if (llm.connectionType === 'vertexai' || /gemini/.test(model)) {
    params.thinking = { type: 'enabled' };
    if (llm.connectionType === 'vertexai') {
      params.generationConfig = { ...params.generationConfig, thinkingConfig: {
        ...(/gemini-3/.test(model) ? { thinkingLevel: 'HIGH' } : { thinkingBudget: -1 }), includeThoughts: true,
      } };
    } else params.reasoning_effort = 'high';
  } else if (/^(o[134](?:-|$)|gpt-[56])/.test(model)) {
    delete params.thinking;
    delete params.temperature;
    params.reasoning_effort = 'high';
    params.max_completion_tokens = llm.maxTokens;
  } else {
    params.thinking = { ...(params.thinking || {}), type: 'enabled' };
    if (/claude/.test(model)) params.thinking.budget_tokens = Math.max(1024, Math.min(4096, Number(llm.maxTokens || 8192) - 1));
    if (/qwen/.test(model)) { params.enable_thinking = true; params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: true }; }
  }
  if (params.reasoning) params.reasoning = { ...params.reasoning, enabled: true, effort: 'high', exclude: false };
  if ('enable_thinking' in params) params.enable_thinking = true;
  if (params.chat_template_kwargs) params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: true };
  if ('reasoning_effort' in params) params.reasoning_effort = 'high';
  return params;
}

export async function* readAgentResponse(stream, { signal, allowEmpty = false } = {}) {
  const message = { role: 'assistant', content: '', reasoning_content: '' };
  const calls = new Map();
  const details = new Map();
  const vertexParts = [];
  let finishReason = null;
  // 有些模型（实测 deepseek 系）在原生工具流里不走标准 tool_calls，而是把调用写成
  // 自定义的 DSML 文本块（<｜｜DSML｜｜ calls> … </｜｜DSML｜｜ calls>）。不识别的话：
  //   ① 这一轮工具调用直接丢失；② 这坨标签会当正文显示在界面上。
  // 下面按「流式拦截 + 结束时解析」处理：标记前的内容照常流式输出，标记内的内容只缓存不外发。
  let textBuf = '';   // 还没确认是否属于 DSML 标记的尾部
  let dsmlBuf = '';   // 已经确定在 DSML 块内的内容
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    if (chunk.usage) yield { type: 'usage', usage: chunk.usage };
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    const reasoning = delta.reasoning_content || delta.reasoning || '';
    if (typeof reasoning === 'string' && reasoning) {
      message.reasoning_content += reasoning;
      yield { type: 'reasoning_delta', text: reasoning };
    }
    if (typeof delta.content === 'string' && delta.content) {
      textBuf += delta.content;
      for (;;) {
        // ① 已在 DSML 块里：先把新到的分片并进去，等闭合标记出现
        if (dsmlBuf) {
          if (textBuf) { dsmlBuf += textBuf; textBuf = ''; }
          const closeAt = dsmlBuf.indexOf(DSML_CLOSE_ALL);
          if (closeAt < 0) break;            // 还没收完，等下一片
          const block = dsmlBuf.slice(0, closeAt + DSML_CLOSE_ALL.length);
          const rest = dsmlBuf.slice(closeAt + DSML_CLOSE_ALL.length);
          dsmlBuf = '';
          appendDsmlCalls(block, calls);
          textBuf = rest + textBuf;
        }
        // ② 找 DSML 起点：前面的正文照常流式发出
        const at = textBuf.indexOf(DSML_OPEN);
        if (at >= 0) {
          const head = textBuf.slice(0, at);
          if (head) { message.content += head; yield { type: 'text_delta', text: head }; }
          dsmlBuf = textBuf.slice(at);
          textBuf = '';
          continue;
        }
        // ③ 普通文本：扣住可能是标记前缀的尾部（标记可能被分片切开）
        const keep = tailOpenPrefixLen(textBuf, DSML_OPEN);
        const safe = keep ? textBuf.slice(0, textBuf.length - keep) : textBuf;
        if (safe) { message.content += safe; yield { type: 'text_delta', text: safe }; }
        textBuf = keep ? textBuf.slice(textBuf.length - keep) : '';
        break;
      }
    }
    if (Array.isArray(delta.vertex_parts)) vertexParts.push(...delta.vertex_parts);
    for (const part of delta.reasoning_details || []) {
      const key = part.index ?? part.id ?? details.size;
      const old = details.get(key) || {};
      details.set(key, { ...old, ...part, ...(part.text ? { text: (old.text || '') + part.text } : {}), ...(part.data ? { data: (old.data || '') + part.data } : {}) });
      if (!reasoning && typeof part.text === 'string') yield { type: 'reasoning_delta', text: part.text };
    }
    for (const piece of delta.tool_calls || []) {
      const index = piece.index ?? calls.size;
      const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (piece.id) call.id = piece.id;
      if (piece.function?.name && call.function.name !== piece.function.name) call.function.name += piece.function.name;
      if (piece.function?.arguments) call.function.arguments += piece.function.arguments;
      if (piece.extra_content) call.extra_content = piece.extra_content;
      if (call.function.arguments.length > 128000 || (!calls.has(index) && calls.size >= 16)) throw new Error('工具请求超过本轮上限');
      calls.set(index, call);
    }
  }
  signal?.throwIfAborted();
  // 流结束时把扣住的尾巴和对未闭合的 DSML 块收个尾：
  //   · textBuf 只是普通文本 ⇒ 作为正文补发
  //   · dsmlBuf 没等到闭合标记（上游截断）⇒ 能解析多少算多少，别把这坨标签当正文
  if (dsmlBuf) {
    const partial = dsmlBuf;
    dsmlBuf = '';
    if (partial.includes(DSML_OPEN) && /invoke\s+name=/.test(partial)) {
      appendDsmlCalls(partial.includes(DSML_CLOSE_ALL) ? partial : `${partial}\n</${DSML_BAR}DSML${DSML_BAR} invoke>\n${DSML_CLOSE_ALL}`, calls);
    }
  }
  if (textBuf) {
    message.content += textBuf;
    yield { type: 'text_delta', text: textBuf };
    textBuf = '';
  }
  if (!finishReason) throw new Error('模型连接提前结束，未执行未完成的工具请求');
  if (!['stop', 'tool_calls'].includes(finishReason)) throw new Error(`模型未完成本轮回复（${finishReason}），请检查输出额度与模型配置`);
  if (calls.size) {
    message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const ids = new Set();
    for (const call of message.tool_calls) {
      if (!call.id || !call.function.name || ids.has(call.id)) throw new Error('模型返回了无效的工具调用标识');
      ids.add(call.id);
      try { JSON.parse(call.function.arguments); } catch { throw new Error('模型返回了不完整的工具参数，未执行'); }
    }
  }
  if (details.size) message.reasoning_details = [...details.values()];
  if (vertexParts.length) message.vertex_parts = vertexParts;
  if (!allowEmpty && !message.content && !message.tool_calls?.length) throw new Error('模型未返回回复或工具调用，请使用支持思考与工具的模型');
  yield { type: 'assistant_end', message };
}
