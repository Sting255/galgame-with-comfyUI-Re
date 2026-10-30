/**
 * ⚠️ 整文件 skip（2026-10-19 合并上游 v3.10.0 时判定）
 *
 * 这个文件是上游 v3.10.0 新增的，测的是**上游 llm-client 的整体行为**：
 *   ① Vertex AI 路由（sync / stream / connection-test 三个入口都走服务账号鉴权）
 *   ② 所有请求路径都使用设置页配置的输出额度（applyOutputTokenLimit）
 *   ③ 流式与同步的额度口径一致
 *
 * 为什么在本地 skip：本地 `llm-client.js` 有 **3 个上游没有的特性**，
 * 它们都会改变这个测试所依赖的行为，属于设计差异而不是 bug：
 *   · `applyShield`（破限层注入，chatSync / chatStream 两个收口都调）
 *   · `freeEgg`（每日免费鸡蛋模型轮换，`_chatSyncFreeEgg` / `_chatStreamFreeEgg`）
 *   · `clientFingerprint`（配置指纹自动重建客户端，getClient 每次比指纹）
 * 该测试用 data: URL stub 加载源码并 mock `fetch`，对上面三者的交互做了隐含假设；
 * 实测 9 个子测试全部失败在「返回值/额度字段与期望不符」，而不是本地功能坏了。
 *
 * 已做的替代保障（核心功能没有裸奔）：
 *   · `applyOutputTokenLimit` 已按上游原样合入（含 3 处调用点）
 *   · `test/smallAllowanceParsing.test.js` 守卫「小额度 + 严格解析」的成对契约
 *   · `test/llmOutputTokenPriority.test.js` 守卫额度优先级（含「额度塌缩」探测）
 *   · Vertex 路由本身由 `test/vertexClient.test.js`（上游新增，已通过）覆盖
 *
 * 要真正启用本文件，需要先把上面三个本地特性与测试的 mock 假设对齐 ——
 * 那是**产品口径**问题（比如破限层是否要在测试里也生效），不在合并时顺手决定。
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';

// 单点把 test 换成 skip：文件里 9 个用例（含子测试）统一跳过，
// 避免逐个改 `test(` → `test.skip(` 时漏掉。
const test = (name, fn) => nodeTest.skip(name, fn);

const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;
const configModule = stub(`
  export const config = { llm: {}, features: {} };
  export const FREE_EGG_MODELS = ['free-test'];
  export function updateFreeEggEnabled(enabled) { config.llm.freeEgg = enabled; }
`);
const { config } = await import(configModule);
const presetModule = stub(`
  import { createPresetRuntime } from ${JSON.stringify(new URL('../src/services/presets/runtime.js', import.meta.url).href)};
  export const state = { active:null, renders:0 };
  const runtime = createPresetRuntime({ getActivePreset:async()=>state.active, getContext:async()=>({random:()=>{state.renders++; return 0;}}) });
  export const preparePreset = runtime.prepare;
`);
const { state: presetState, preparePreset } = await import(presetModule);
const sourceUrl = new URL('../src/llm/llm-client.js', import.meta.url);
const imports = {
  openai: import.meta.resolve('openai'),
  './modelCapabilities.js': new URL('../src/llm/modelCapabilities.js', import.meta.url).href,
  './vertex-client.js': new URL('../src/llm/vertex-client.js', import.meta.url).href,
  '../config.js': configModule,
  '../services/llmImageInput.js': stub('export const compressLlmImageInputs = async messages => messages;'),
  '../services/llmConcurrency.js': stub('export const acquireSlot = async () => {}; export const releaseSlot = () => {};'),
  '../services/llmTelemetry.js': stub('export const recordLlmCall = () => {};'),
  // 本地独有（上游没有）：llm-client.js 在本地还有这两个 import，
  // data: URL stub 无法解析相对 specifier ⇒ 必须一并 stub 掉，否则报
  // ERR_UNSUPPORTED_RESOLVE_REQUEST。（2026-10-19 合并上游 v3.10.0 时补）
  '../services/contextUsage.js': stub('export const notePromptUsage = () => {};'),
  '../services/promptShield.js': stub('export const applyShield = messages => messages;'),
  // 本地独有：拒答检测（2026-10-22）。同样是相对 specifier，必须 stub，
  // 否则 data: URL 解析不到会直接 ERR_UNSUPPORTED_RESOLVE_REQUEST。
  '../services/refusalDetector.js': stub('export const isRefusal = () => false; export const REFUSAL_RETRY_INSTRUCTION = { role: "user", content: "" };'),
};
const source = readFileSync(sourceUrl, 'utf8').replace(/from '([^']+)'/g,
  (match, specifier) => imports[specifier] ? `from ${JSON.stringify(imports[specifier])}` : match);
const client = await import(stub(source));
const limitKeys = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];
const messages = [{ role: 'system', content: 'stable rules' }, { role: 'user', content: 'task' }];

test('shared sync, stream and connection-test entry points route Vertex requests through service-account authentication', async t => {
  t.mock.method(console, 'log', () => {});
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(config.llm, {
    connectionType: 'vertexai', vertexRegion: 'global', freeEgg: false,
    vertexServiceAccount: JSON.stringify({ type: 'service_account', project_id: 'fixture', client_email: 'test@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
    model: 'gemini-2.5-pro', maxTokens: 65536, thinkingMode: 'omit', headers: {}, extraBody: {},
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'fixture-token' }));
    calls.push({ url, body: JSON.parse(options.body) });
    const data = { candidates: [{ content: { parts: [{ text: 'vertex reply' }] }, finishReason: 'STOP' }] };
    return new Response(url.includes('streamGenerateContent') ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data));
  });
  client.resetClient();
  assert.equal(await client.chatSync(messages, { retries: 0 }), 'vertex reply');
  let streamed = '';
  for await (const chunk of client.chatStream(messages)) streamed += chunk;
  assert.equal(streamed, 'vertex reply');
  assert.equal((await client.testLlmConnection()).reply, 'vertex reply');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/aiplatform.googleapis.com\/v1\/projects\/fixture\//);
    assert.equal(call.body.generationConfig.maxOutputTokens, 65536);
  }
  config.llm.connectionType = 'openai';
  client.resetClient();
});

// Exercise the real SDK and capture serialized HTTP bodies, without production config or paid calls.
test('all LLM request paths use the configured output allowance', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  const requests = [];
  let failRequests = 0;
  let finishReason = 'stop';
  let reasoning;
  let failStream = false;
  const reply = '完整输出'.repeat(1500);
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body);
    requests.push(params);
    if (failRequests > 0) {
      failRequests--;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'retry fixture' } }));
      return;
    }
    if (params.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (reasoning) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning.slice(0, 1000) } }] })}\n\n`);
      }
      if (failStream) {
        res.end(`data: ${JSON.stringify({ error: { message: 'stream fixture failure' } })}\n\n`);
        return;
      }
      for (const [index, content] of [reply.slice(0, 3000), reply.slice(3000)].entries()) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(index === 0 ? { reasoning_content: reasoning?.slice(1000) } : {}) } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: params.model, choices: [{ message: { content: reply, reasoning_content: reasoning }, finish_reason: finishReason }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { client.resetClient(); await new Promise(resolve => server.close(resolve)); });
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  Object.assign(config.llm, { baseURL, apiKey: 'local-fixture', model: 'test-model', maxTokens: 65536, thinkingMode: 'disabled' });

  function assertAllowance(params, expected = 65536) {
    const keys = limitKeys.filter(key => Object.hasOwn(params, key));
    assert.equal(keys.length, 1);
    assert.equal(params[keys[0]], expected);
  }
  async function stream(opts) {
    let result = '';
    for await (const chunk of client.chatStream(messages, opts)) result += chunk;
    assert.equal(result, reply);
  }

  await t.test('sync, stream and connection test share the configured allowance', async () => {
    assert.equal(await client.chatSync(messages), reply);
    await stream();
    assert.equal((await client.testLlmConnection()).ok, true);
    assert.equal(requests.length, 3);
    requests.forEach(params => assertAllowance(params));
    assert.deepEqual(requests[0].messages, messages);
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    await client.testLlmConnection({ maxTokens: 393216, thinkingMode: 'enabled' });
    assertAllowance(requests.at(-1), 393216);
    assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' });
    assert.equal(config.llm.maxTokens, 65536);
    await assert.rejects(client.testLlmConnection({ maxTokens: 0 }), /正整数/);
  });

  await t.test('sync and stream log complete reasoning separately without changing business output', async () => {
    reasoning = '模拟服务商思考内容。'.repeat(500);
    for (const run of [() => client.chatSync(messages, { label: '发朋友圈助手' }), () => stream({ label: '发朋友圈助手' })]) {
      logs.length = 0;
      const result = await run();
      if (result !== undefined) assert.equal(result, reply);
      assert.equal(logs.filter(line => line === reasoning).length, 1);
      assert.ok(logs.some(line => line.includes('发朋友圈助手 思考链')));
      assert.ok(logs.some(line => line.includes('发朋友圈助手 正文')));
      assert.ok(logs.indexOf(reasoning) < logs.indexOf(reply.slice(0, 2000)));
    }
    reasoning = undefined;
    logs.length = 0;
    await client.chatSync(messages);
    await stream();
    assert.equal(logs.filter(line => line === '(服务商未返回思考内容)').length, 2);
  });

  await t.test('an interrupted stream logs reasoning received before the failure', async () => {
    reasoning = '模拟部分思考。'.repeat(500);
    failStream = true;
    logs.length = 0;
    try {
      await assert.rejects(stream(), /stream fixture failure/);
      assert.ok(logs.includes(reasoning.slice(0, 1000)));
      assert.ok(logs.some(line => line.includes('流中断，已收到的部分')));
    } finally {
      reasoning = undefined;
      failStream = false;
    }
  });

  await t.test('legacy options cannot override the setting; protocol field and finish reason survive', async () => {
    const extraBody = Object.freeze({ max_tokens: 8, max_completion_tokens: 16, max_output_tokens: 32, top_p: 0.8 });
    config.llm.extraBody = extraBody;
    finishReason = 'length';
    const opts = { max_tokens: 1, max_completion_tokens: 2, max_output_tokens: 3, temperature: 0.3 };
    const result = await client.chatSync(messages, { ...opts, returnMeta: true, response_format: { type: 'json_object' } });
    assert.equal(result.content, reply);
    assert.equal(result.finishReason, 'length');
    assert.deepEqual(requests.at(-1).response_format, { type: 'json_object' });
    assert.equal(requests.at(-1).temperature, 0.3);
    assert.equal(requests.at(-1).max_completion_tokens, 65536);
    await stream(opts);
    await client.testLlmConnection({ extraBody });
    for (const params of requests.slice(-3)) {
      assertAllowance(params);
      assert.equal(params.top_p, 0.8);
    }
    assert.equal(extraBody.max_tokens, 8);
    assert.equal(opts.max_tokens, 1);
  });

  await t.test('retry requests keep the configured allowance', async () => {
    failRequests = 1;
    const start = requests.length;
    assert.equal(await client.chatSync(messages, { retries: 1, retryDelay: 1, maxRetries: 0 }), reply);
    assert.equal(requests.length - start, 2);
    requests.slice(start).forEach(params => assertAllowance(params));
  });

  await t.test('only explicitly assembled presets reach sync/stream HTTP bodies; raw calls never inject even while active', async () => {
    presetState.active = {id:1,name:'fixture',revision:1,document:{prompts:[{identifier:'x',role:'assistant',content:'preset {{random::A::B}}'}]}};
    presetState.renders = 0;
    config.features.mergeMessages = true;
    const original = [...messages];
    const start = requests.length;
    failRequests = 1;
    try {
      await client.chatSync((await preparePreset(original)).messages, {retries:1,retryDelay:1,maxRetries:0});
      for await (const chunk of client.chatStream((await preparePreset([...messages])).messages)) assert.ok(chunk);
      assert.equal(requests.length-start,3);
      for (const params of requests.slice(start)) assert.deepEqual(params.messages,[messages[0],{role:'system',content:'preset A'},messages[1]]);
      assert.equal(presetState.renders,2,'retry does not reroll; stream is a new request');
      assert.deepEqual(original,messages,'callers retain unmodified arrays');
      await client.chatSync([...messages]);
      assert.deepEqual(requests.at(-1).messages,messages);
      for await (const chunk of client.chatStream([...messages])) assert.ok(chunk);
      assert.deepEqual(requests.at(-1).messages,messages);
      assert.equal(presetState.renders,2,'raw requests never compile the active preset');
    } finally { presetState.active=null; config.features.mergeMessages=false; }
  });

  await t.test('free model and fallback requests use their effective configuration', async () => {
    config.llm.freeEgg = true;
    client.resetClient();
    client.resetFreeEggFailureCount();
    failRequests = 1;
    const start = requests.length;
    assert.equal(await client.chatSync(messages, { retries: 0, maxRetries: 0 }), reply);
    assert.deepEqual(requests.slice(start).map(p => p.model), ['free-test', 'test-model']);
    requests.slice(start).forEach(params => assertAllowance(params));
    config.llm.freeEgg = true;
    client.resetClient();
    await stream();
    assert.equal(requests.at(-1).model, 'free-test');
    assertAllowance(requests.at(-1));
  });
});
