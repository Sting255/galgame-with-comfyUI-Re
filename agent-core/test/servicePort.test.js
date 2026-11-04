import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveServicePort, shutdownLinshe, isLinsheService } from '../src/utils/servicePort.js';
import { belongsToProject } from '../../scripts/lib/projectProcesses.mjs';

test('PORT 环境覆盖文件，支持注释/引号，非法值明确失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-port-'));
  const envPath = path.join(dir, '.env');
  try {
    assert.equal(resolveServicePort({ env: {}, envPath }), 3099);
    fs.writeFileSync(envPath, 'PORT="3199" # local\n');
    assert.equal(resolveServicePort({ env: {}, envPath }), 3199);
    assert.equal(resolveServicePort({ env: { PORT: '3399' }, envPath }), 3399);
    for (const PORT of ['0', '65536', '3199oops', '-1']) {
      assert.throws(() => resolveServicePort({ env: { PORT }, envPath }), /PORT/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('健康检查核对应用与 PID，停服不会向其它应用发送 POST', async () => {
  const calls = [];
  let health = { status: 'ok', application: 'another-app', pid: 123 };
  const fetchImpl = async (url, opts) => { calls.push({ url, method: opts.method }); return new Response(JSON.stringify(health)); };
  assert.equal(await shutdownLinshe('http://localhost:3199', { fetchImpl }), false);
  assert.equal(calls.some(c => c.method === 'POST'), false);
  health = { status: 'ok', application: 'linshe', pid: 123 };
  assert.equal(await isLinsheService('http://localhost:3199', { fetchImpl, pid: 456 }), false);
  assert.equal(await shutdownLinshe('http://localhost:3199', { fetchImpl }), true);
  assert.equal(calls.at(-1).method, 'POST');
});

test('相同 Node 命令名或端口不构成当前项目归属证据', () => {
  const root = 'D:\\邻舍改';
  assert.equal(belongsToProject({ CommandLine: 'node app.js', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe' }, root), false);
  assert.equal(belongsToProject({ CommandLine: 'node D:\\其它项目\\app.js' }, root), false);
  assert.equal(belongsToProject({ CommandLine: 'node D:\\邻舍改旧版\\agent-core\\app.js' }, root), false);
  assert.equal(belongsToProject({ CommandLine: 'node D:\\邻舍改\\agent-core\\app.js' }, root), true);
  assert.equal(belongsToProject({ ExecutablePath: 'D:\\邻舍改\\runtime\\nodejs\\node.exe' }, root), true);
});
