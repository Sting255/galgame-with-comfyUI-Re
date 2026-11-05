import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAccessControl } from '../src/server/accessControl.js';

const token = 'test-only-device-pairing-secret';
const create = () => createAccessControl({ token, hosts: ['192.168.1.2'] });
function call(guard, { local = false, path = '/api/characters', method = 'GET', headers = {}, body } = {}) {
  let result = { status: 200, headers: {} };
  const req = { socket: { remoteAddress: local ? '127.0.0.1' : '192.168.1.3' }, path, method,
    headers: { host: local ? 'localhost:3199' : '192.168.1.2:3199', ...headers }, body };
  const res = { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; },
    setHeader(key, value) { result.headers[key] = value; }, cookie(key, value, options) { result.cookie = { key, value, options }; },
    sendStatus(status) { result.status = status; } };
  guard(req, res, () => { result.next = true; });
  return result;
}
test('本机直连无需配对，远端不能读取 API、图片或配对码', () => {
  const guard = create();
  assert.equal(call(guard, { local: true }).next, true);
  for (const path of ['/api/characters', '/API/characters', '/api/data/export', '/images/a.png', '/IMAGES/a.png', '/avatars/a.png']) {
    assert.equal(call(guard, { path }).status, 401);
  }
  assert.equal(call(guard, { path: '/api/access' }).body.pairingCode, undefined);
  assert.equal(call(guard, { path: '/api/access', local: true }).body.pairingCode, token);
});
test('配对设备获得 HttpOnly Cookie，仍不能备份、恢复、取密钥或关闭服务', () => {
  const guard = create();
  const paired = call(guard, { path: '/api/access/session', method: 'POST', body: { code: token } });
  assert.equal(paired.cookie.options.httpOnly, true);
  assert.equal(paired.cookie.options.sameSite, 'strict');
  const headers = { cookie: `${paired.cookie.key}=${paired.cookie.value}` };
  assert.equal(call(guard, { headers }).next, true);
  for (const path of ['/api/data/export', '/API/Data/import', '/api/config/llm/key', '/api/config/llm/key/', '/API/SHUTDOWN/']) {
    assert.equal(call(guard, { path, headers }).status, 403);
  }
});
test('跨站、DNS 重绑定、代理来源不继承本机权限', () => {
  const guard = create();
  assert.equal(call(guard, { local: true, headers: { origin: 'https://evil.invalid' } }).status, 403);
  assert.equal(call(guard, { local: true, headers: { host: 'evil.invalid:3199' } }).status, 403);
  assert.equal(call(guard, { local: true, headers: { 'x-forwarded-for': '192.168.1.3' } }).status, 401);
  assert.equal(call(guard, { local: true, headers: { 'sec-fetch-site': 'cross-site' } }).status, 403);
});
test('配对失败有速率限制，Bearer 可用于授权的远端集成', () => {
  const guard = create();
  assert.equal(call(guard, { headers: { authorization: `Bearer ${token}` } }).next, true);
  for (let i = 0; i < 10; i++) assert.equal(call(guard, { path: '/api/access/session', method: 'POST', body: { code: 'wrong' } }).status, 401);
  assert.equal(call(guard, { path: '/api/access/session', method: 'POST', body: { code: token } }).status, 429);
});
test('真实 HTTP 同源配对与 Cookie 解析，非法 Origin 无法读取本机接口', async () => {
  const app = express(); app.use(express.json()); app.use(create());
  app.get('/api/probe', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/api/probe`)).status, 200);
    assert.equal((await fetch(`${url}/api/probe`, { headers: { Origin: 'http://evil.invalid' } })).status, 403);
    const paired = await fetch(`${url}/api/access/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: token }) });
    assert.equal(paired.status, 200);
    assert.match(paired.headers.get('set-cookie'), /HttpOnly/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
