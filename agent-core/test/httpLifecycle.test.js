import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHttpLifecycle } from '../src/server/httpLifecycle.js';
import streamRoutes from '../src/routes/stream.js';

test('真实 SSE 长连接在退出时结束，server.close 无需等待硬超时', async () => {
  const lifecycle = createHttpLifecycle();
  const app = express(); app.use(lifecycle.middleware); app.use('/api/stream', streamRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const req = http.get(`http://127.0.0.1:${server.address().port}/api/stream`);
  req.on('error', () => {});
  try {
    const res = await new Promise(resolve => req.once('response', resolve));
    const ended = new Promise(resolve => res.once('end', resolve));
    res.resume();
    assert.equal(await lifecycle.close(server, { timeoutMs: 1000 }), true);
    await ended;
  } finally { req.destroy(); server.closeAllConnections(); server.close(); }
});

test('超时的普通请求会被断开并返回非优雅状态，不阻止调用方清理资源', async () => {
  const lifecycle = createHttpLifecycle(); const app = express(); app.use(lifecycle.middleware);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  app.get('/stuck', (_req, res) => { res.write('started'); started(); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const req = http.get(`http://127.0.0.1:${server.address().port}/stuck`);
  req.on('error', () => {}); req.on('response', response => { response.on('error', () => {}); response.resume(); });
  try { await ready; assert.equal(await lifecycle.close(server, { timeoutMs: 30 }), false); }
  finally { req.destroy(); server.closeAllConnections(); server.close(); }
});
