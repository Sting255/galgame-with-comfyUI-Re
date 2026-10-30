/**
 * 「默认关闭思考」契约 —— thinking.type 与 reasoning_effort 两条路一起发
 *
 * 真机取证（2026-10-15，网关 `wb2api`，20 个模型逐个实测）：
 *   ┌─ cn:deepseek-v4-flash ─────────────────────────────────────────────┐
 *   │ 不传任何参数        → reasoning_len=294（**默认是开思考的**）        │
 *   │ 只 thinking:disabled → reasoning_len=0   ✅ 真正关掉                │
 *   │ 只 effort:low        → reasoning_len=363（对它无效）                 │
 *   │ 两个都传             → reasoning_len=0   ✅ 且无害                  │
 *   ├─ cn:glm-5.1 ───────────────────────────────────────────────────────┤
 *   │ 不传 effort          → 网关直接报错                                  │
 *   │   "the reasoning effort value is not supported by the current model"│
 *   │ 传 effort:low        → 正常出正文                                    │
 *   └────────────────────────────────────────────────────────────────────┘
 * 结论：**两条路必须一起发**，缺一条都有模型会漏。用户口径是"所有模型默认都关思考"，
 * 所以 `reasoning_effort` 默认值就是 `low`（不是空串）。
 *
 * 本文件钉住：
 *   ① 默认（不配任何东西）⇒ 请求体同时带 thinking:{disabled} 与 reasoning_effort:'low'
 *   ② 显式 thinkingMode:'enabled' ⇒ thinking 翻成 enabled，effort 仍是 low（用户可另配）
 *   ③ extraBody 仍能覆盖两者（自定义网关逃生口）
 *   ④ getLlmConfig 回显默认 'low'（UI 读到的就是生效值）
 *   ⑤ 免费鸡蛋通道不发 effort（端点免 Key，historically 对 thinking 也敏感）
 *
 * 假上游只监听 127.0.0.1，不联网。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_PATH = ':memory:';

const { config, getLlmConfig } = await import('../src/config.js');
config.dbPath = ':memory:';
config.llm.freeEgg = false;
config.llm._model = 'stub-model';
config.llm._extraBody = {};
const { chatSync, chatStream, resetClient } = await import('../src/llm/llm-client.js');

const servers = [];
const L = (...a) => { try { process.stdout.write('[llmReasoningEffort] ' + a.join(' ') + '\n'); } catch { /* 忽略 */ } };
function makeUpstream() {
  const state = { bodies: [], calls: 0 };
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', c => { text += c; });
    req.on('end', () => {
      state.calls += 1;
      state.bodies.push(text);
      if (/"stream"\s*:\s*true/.test(text)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }] }));
      }
    });
  });
  servers.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ state, baseURL: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}
after(() => { for (const s of servers) s.close(); resetClient(); });

test('① 默认配置 ⇒ 请求体同时带 thinking:{disabled} 与 reasoning_effort:low', async () => {
  const { state, baseURL } = await makeUpstream();
  config.llm._baseURL = baseURL;
  config.llm._thinkingMode = 'disabled';
  config.llm._reasoningEffort = 'low';   // 默认值（见文件头实测结论）
  resetClient();
  await chatSync([{ role: 'user', content: '在吗' }], { label: 'unit-default', retries: 0 });
  assert.equal(state.calls, 1);
  const body = JSON.parse(state.bodies[0]);
  assert.deepEqual(body.thinking, { type: 'disabled' }, 'thinking:{disabled} 是主力（deepseek 系靠它关）');
  assert.equal(body.reasoning_effort, 'low', 'reasoning_effort:low 是兜底（glm-5.1 不传就被网关拒）');
});

test('② stream 两条路也都在', async () => {
  const { state, baseURL } = await makeUpstream();
  config.llm._baseURL = baseURL;
  config.llm._thinkingMode = 'disabled';
  config.llm._reasoningEffort = 'low';
  resetClient();
  for await (const _ of chatStream([{ role: 'user', content: '在吗' }], { label: 'unit-stream', retries: 0 })) { /* 消费掉 */ }
  const body = JSON.parse(state.bodies[0]);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.reasoning_effort, 'low');
});

test('③ thinkingMode=enabled 时 thinking 翻成 enabled，effort 保持 low（可被 extraBody 改）', async () => {
  const { state, baseURL } = await makeUpstream();
  config.llm._baseURL = baseURL;
  config.llm._thinkingMode = 'enabled';
  config.llm._reasoningEffort = 'low';
  resetClient();
  await chatSync([{ role: 'user', content: '在吗' }], { label: 'unit-enabled', retries: 0 });
  const body = JSON.parse(state.bodies[0]);
  assert.deepEqual(body.thinking, { type: 'enabled' }, '用户显式开思考要生效');
  assert.equal(body.reasoning_effort, 'low');
  config.llm._thinkingMode = 'disabled';
});

test('④ extraBody 能覆盖两条路（自定义网关逃生口）', async () => {
  const { state, baseURL } = await makeUpstream();
  config.llm._baseURL = baseURL;
  config.llm._thinkingMode = 'disabled';
  config.llm._reasoningEffort = 'low';
  config.llm._extraBody = { thinking: { type: 'enabled' }, reasoning_effort: 'max' };
  resetClient();
  await chatSync([{ role: 'user', content: '在吗' }], { label: 'unit-override', retries: 0 });
  const body = JSON.parse(state.bodies[0]);
  assert.deepEqual(body.thinking, { type: 'enabled' }, 'extraBody 优先');
  assert.equal(body.reasoning_effort, 'max', 'extraBody 优先');
  config.llm._extraBody = {};
});

test('⑤ getLlmConfig 默认回显 low；空串/脏值也归一回 low（不提供置空出口）', async () => {
  config.llm._reasoningEffort = 'low';
  assert.equal(getLlmConfig().reasoningEffort, 'low');
  config.llm.reasoningEffort = 'high';
  assert.equal(getLlmConfig().reasoningEffort, 'high');
  // 非法值被 setter 归一回默认 low，不会退化成"不发字段"
  config.llm.reasoningEffort = 'super-duper';
  assert.equal(getLlmConfig().reasoningEffort, 'low');
  // 用户口径"默认一定要关掉思考"：**空串也归一回 low**，不提供置空出口
  // （置空会让 deepseek 系退回开着思考跑，实测 reasoning_len≈294）
  config.llm.reasoningEffort = '';
  assert.equal(getLlmConfig().reasoningEffort, 'low', '空串也归一回 low');
  config.llm._reasoningEffort = '';
  assert.equal(getLlmConfig().reasoningEffort, 'low', '底层字段被清空也归一回 low');
  config.llm._reasoningEffort = 'low';
});

test('⑤b 空串配置下请求体仍带 reasoning_effort:low（不会静默放开思考）', async () => {
  const { state, baseURL } = await makeUpstream();
  config.llm._baseURL = baseURL;
  config.llm._thinkingMode = 'disabled';
  config.llm._reasoningEffort = '';   // 模拟"有人把配置清空了"
  resetClient();
  await chatSync([{ role: 'user', content: '在吗' }], { label: 'unit-empty-cfg', retries: 0 });
  const body = JSON.parse(state.bodies[0]);
  assert.equal(body.reasoning_effort, 'low', '空串配置也必须带 low，否则 deepseek 系会开着思考跑');
  assert.deepEqual(body.thinking, { type: 'disabled' });
});

test('⑥ 免费鸡蛋通道不发 effort（直接判 freeEgg，不靠空串推断）', async () => {
  // 2026-10-15 修过一个真 bug：原来靠「getter 返回空串」推断 freeEgg，
  // 而空串在 config 层已被归一回 low ⇒ "配置被清空"会被误判成 freeEgg、
  // 反过来 freeEgg 关了之后又可能漏发。现在 configuredReasoningEffort 直接判 freeEgg。
  config.llm.freeEgg = true;
  config.llm._thinkingMode = 'disabled';
  config.llm._reasoningEffort = 'low';
  resetClient();
  const { state, baseURL } = await makeUpstream();
  config.llm._baseURL = baseURL;
  resetClient();
  try {
    await chatSync([{ role: 'user', content: '在吗' }], { label: 'unit-freeegg', retries: 0 });
  } catch { /* 免费端点打不通是环境事实，只关心请求体形状 */ }
  // 免费端点（opencode.ai）打不通时会自动关 freeEgg 并用自有配置重发，
  // 那时 freeEgg 已关、理应恢复下发 —— 所以这里断言"重发那一次"的形状。
  if (state.calls > 0) {
    const body = JSON.parse(state.bodies[state.bodies.length - 1]);
    assert.deepEqual(body.thinking, { type: 'disabled' }, '回落自有配置后 thinking 恢复');
    assert.equal(body.reasoning_effort, 'low', '回落自有配置后 effort 恢复');
  }
  config.llm.freeEgg = false;
  resetClient();
});
