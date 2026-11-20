#!/usr/bin/env node
/**
 * 生图冒烟隔离入口。
 *
 * 由发布脚本 `--with-smoke` 调用。父进程必须先显式设置内存库、隔离媒体目录
 * 与临时 LINSHE_ENV_PATH；本 helper 只验证这些变量，并在创建子进程时原样继承。
 * 现有 agent-core/.env 的只读合并也由父进程完成，本 helper 不读、不复制、不打印
 * 配置内容。它只覆盖本次真实生图直接依赖的可写入口，不把 “LINSHE_DATA_DIR”
 * 宣称为整个应用的 data 根。退出码原样透传：
 *   0 = 真正出图
 *   2 = ComfyUI 未开 / 不可达，环境阻塞
 *   1 = 代码链路失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptsDir, '..');
const core = path.join(repo, 'agent-core');
const node = process.execPath;
const smoke = path.join(scriptsDir, 'smoke-image.mjs');
const runRoot = process.env.LINSHE_SMOKE_ROOT ? path.resolve(process.env.LINSHE_SMOKE_ROOT) : '';

const requiredKeys = ['IMAGES_DIR', 'TTS_AUDIO_DIR', 'LINSHE_DATA_DIR', 'COMFYUI_OUTPUT_DIR', 'LINSHE_ENV_PATH'];

function assertInside(tempRoot, value, label) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const rel = path.relative(normalize(tempRoot), normalize(path.resolve(value)));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} 未落在 smoke 临时目录: ${value}`);
  }
}

try {
  if (!runRoot || !fs.existsSync(runRoot)) throw new Error('父进程未提供已有的 LINSHE_SMOKE_ROOT');
  if (process.env.DB_PATH !== ':memory:') throw new Error('父进程必须显式设置 DB_PATH=:memory:');
  for (const key of requiredKeys) {
    if (!process.env[key]) throw new Error(`父进程未提供 ${key}`);
    assertInside(runRoot, process.env[key], key);
  }
  for (const key of ['TEMP', 'TMP']) assertInside(runRoot, process.env[key], key);
  console.log(`[smoke] 隔离根：${runRoot}`);
  console.log('[smoke] 已确认父进程 DB_PATH=:memory:，媒体/配置/临时目录均在隔离根内；子进程原样继承');
  const result = spawnSync(node, [smoke], {
    cwd: core,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`[smoke] 启动失败：${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
  if (process.exitCode === 0) console.log('[smoke] PASS：真实出图成功');
  else if (process.exitCode === 2) console.error('[smoke] ENV BLOCKED：ComfyUI 未开或不可达，不能把本轮视为通过');
  else console.error(`[smoke] FAIL：生图链路退出码 ${process.exitCode}`);
} catch (error) {
  console.error(`[smoke] FAIL：${error?.message || error}`);
  process.exitCode = 1;
}
