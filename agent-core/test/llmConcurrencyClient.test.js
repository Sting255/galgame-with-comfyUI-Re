import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setMaxConcurrency, acquireSlot, releaseSlot } from '../src/services/llmConcurrency.js';

process.env.DB_PATH = ':memory:';
const { config } = await import('../src/config.js');
config.llm.freeEgg = false;
config.llm._apiKey = 'test-only';
config.llm._model = 'stub';
const { chatSync, chatStream, resetClient } = await import('../src/llm/llm-client.js');
let requests = 0;
const server = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); server.unref();
config.llm._baseURL = `http://127.0.0.1:${server.address().port}/v1`;
after(() => { setMaxConcurrency(null); resetClient(); server.closeAllConnections(); server.close(); });
const messages = [{ role: 'user', content: 'hello' }];

test('流式回复中关闭限制，结束后仍释放原占位', { timeout: 3000 }, async () => {
  config.features.serializeBackgroundLLM = true; setMaxConcurrency(1);
  const stream = chatStream(messages);
  assert.equal((await stream.next()).done, false);
  config.features.serializeBackgroundLLM = false; setMaxConcurrency(null);
  while (!(await stream.next()).done) {}
  config.features.serializeBackgroundLLM = true; setMaxConcurrency(1);
  releaseSlot(await acquireSlot());
});

test('无限制开始的流式请求中途启用限制，不会误释放别人的占位', { timeout: 3000 }, async () => {
  config.features.serializeBackgroundLLM = false; setMaxConcurrency(null);
  const stream = chatStream(messages);
  assert.equal((await stream.next()).done, false);
  config.features.serializeBackgroundLLM = true; setMaxConcurrency(1);
  const owner = await acquireSlot();
  while (!(await stream.next()).done) {}
  let entered = false;
  const next = acquireSlot().then(slot => { entered = true; return slot; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(entered, false);
  releaseSlot(owner); releaseSlot(await next);
});

test('同步与流式请求排队时取消，不调用上游、不泄漏占位', { timeout: 3000 }, async () => {
  config.features.serializeBackgroundLLM = true; setMaxConcurrency(1);
  const owner = await acquireSlot();
  const count = requests;
  const syncAbort = new AbortController();
  const sync = chatSync(messages, { signal: syncAbort.signal });
  syncAbort.abort();
  await assert.rejects(sync, error => /abort/i.test(error.name + error.message));
  const streamAbort = new AbortController();
  const stream = chatStream(messages, { signal: streamAbort.signal });
  const step = stream.next();
  streamAbort.abort();
  assert.equal((await step).done, true);
  assert.equal(requests, count);
  releaseSlot(owner); releaseSlot(await acquireSlot());
});
