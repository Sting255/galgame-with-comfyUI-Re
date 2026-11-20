#!/usr/bin/env node
/**
 * 后端保留测试入口。
 *
 * 存在的理由（2026-11-16）：系统 Node 与 better-sqlite3 的 ABI 经常不匹配
 * （实测系统 Node 24 需要 NODE_MODULE_VERSION 137，仓库 runtime 22.18 编译的是 127），
 * 直接 `npm --prefix agent-core test` 会以 ERR_DLOPEN_FAILED 失败，
 * 看起来像业务断言失败，实际是运行时用错。这里固定用仓库 runtime。
 *
 * 测试一律走 agent-core/test/force-memory-db.cjs 强制 :memory:，
 * 即使外部 shell 设置了真实 DB_PATH 也不会写玩家库。
 *
 * 用法：node scripts/test-backend.mjs [额外参数...]
 * 退出码：0 全通过；1 有用例失败或运行时缺失。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const runtimeNode = path.join(root, 'runtime', 'nodejs', isWin ? 'node.exe' : 'node');

if (!existsSync(runtimeNode)) {
  console.error(`[test-backend] 未找到仓库运行时：${runtimeNode}`);
  console.error('[test-backend] 请先执行 runtime 安装，或用 --use-system-node 显式覆盖。');
  process.exit(1);
}

const extra = process.argv.slice(2);
const args = [
  '--require', path.join(root, 'agent-core', 'test', 'force-memory-db.cjs'),
  '--test',
  path.join(root, 'agent-core', 'test', '*.test.js'),
  ...extra,
];

const result = spawnSync(runtimeNode, args, {
  cwd: path.join(root, 'agent-core'),
  stdio: 'inherit',
  env: { ...process.env, DB_PATH: ':memory:' },
});

if (result.error) {
  console.error(`[test-backend] 启动失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
