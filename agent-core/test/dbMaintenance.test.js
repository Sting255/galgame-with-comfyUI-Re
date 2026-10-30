/**
 * 数据库维护策略（2026-10-15，对应待办里那条"DB 维护没提示"）
 *
 * ## 背景
 * `接手必读.md` §6.3-19 挂着一句「`DB_AUTO_VACUUM` 触发时启动日志没有提示」。
 * 实测：**`DB_AUTO_VACUUM` 从来没有被实现过**（全仓零引用），那句话是一场误会。
 * 真正该做的是：给 SQLite 配上合适的 `auto_vacuum` 策略 + 启动时跑一次 `PRAGMA optimize`。
 *
 * ## 本轮实测暴露的顺序陷阱（本文件重点钉住）
 * SQLite 规定：`auto_vacuum` **在 WAL 模式下设置会静默失效**。
 * 第一版先 `journal_mode = WAL` 再设 `auto_vacuum` ⇒ 实测新库仍是 `0 = NONE`，白写一行代码。
 * 顺序必须反过来。这种"不报错、只是不起作用"的坑，只有**真建库读 pragma** 才能发现。
 *
 * 本文件钉住：
 *   ① 新库拿到 INCREMENTAL（=2）且仍是 WAL；
 *   ② 老库（已 NONE 且非空）**不被擅自动手** —— 切换要整库 VACUUM，不能替用户决定；
 *   ③ 调用顺序（源码守卫）：applyAutoVacuumPolicy 必须在 journal_mode = WAL 之前；
 *   ④ 维护动作失败不能挡住启动（都是 try 包着的）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = path.join(ROOT, '..', 'runtime', 'nodejs', 'node.exe');
// better-sqlite3 是 CJS 原生模块：这里用 createRequire 同步拿（test 回调不是 async，不能用 await import）
const Database = createRequire(import.meta.url)(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const dbSrc = fs.readFileSync(new URL('../src/db/index.js', import.meta.url), 'utf8');

/**
 * 在**独立子进程**里开库读 pragma。
 * 为什么必须开子进程：`getDb()` 是模块级单例 + 会跑迁移，同进程里换 DB_PATH 也拿不到第二份干净的库
 * （`import` 缓存 + 单片 sqlite 句柄）。子进程是本仓验证 db.js 的标准做法。
 */
function probeDb(dbFile, extraImportQuery = '') {
  // ⚠️ 子进程里 import 本仓模块必须用 file:// URL —— Windows 绝对路径（D:\…）直接 import 会报
  //    ERR_UNSUPPORTED_ESM_URL_SCHEME（"Received protocol 'd:'"）。用 pathToFileURL 转。
  const modUrl = pathToFileURL(path.join(ROOT, 'src', 'db', 'index.js')).href;
  const script = `
    process.env.DB_PATH = ${JSON.stringify(dbFile)};
    process.env.LOG_TO_FILE = 'false';
    const m = await import(${JSON.stringify(modUrl)} + ${JSON.stringify(extraImportQuery)});
    const db = m.getDb();
    const out = {
      autoVacuum: db.pragma('auto_vacuum', { simple: true }),
      journalMode: db.pragma('journal_mode', { simple: true }),
      tables: db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,
    };
    console.log('PROBE=' + JSON.stringify(out));
    try { m.closeDb(); } catch {}
  `;
  const tmpJs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-vacprobe-')), 'probe.mjs');
  fs.writeFileSync(tmpJs, script, 'utf8');
  try {
    const stdout = execFileSync(NODE, [tmpJs], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const line = stdout.split(/\r?\n/).find(l => l.startsWith('PROBE='));
    assert.ok(line, `探针没输出 PROBE= 行。stdout 尾部：${stdout.slice(-500)}`);
    return JSON.parse(line.slice('PROBE='.length));
  } finally {
    fs.rmSync(path.dirname(tmpJs), { recursive: true, force: true });
  }
}

test('① 新库：auto_vacuum = INCREMENTAL(2)，且 journal_mode 仍是 wal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-vacnew-'));
  try {
    const probe = probeDb(path.join(dir, 'fresh.db'));
    assert.equal(
      probe.autoVacuum, 2,
      '新库要拿到 INCREMENTAL —— 若为 0，八成是「先切 WAL 再设 auto_vacuum」的顺序又反了（SQLite 会静默失效）'
    );
    assert.equal(probe.journalMode, 'wal', 'WAL 不能被这次改动弄丢');
    assert.ok(probe.tables > 100, `建表要正常（实际 ${probe.tables} 张）`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('② 老库（auto_vacuum=NONE 且非空）不被擅自动手', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-vaclegacy-'));
  try {
    const legacy = path.join(dir, 'legacy.db');
    // 用 better-sqlite3 直接造一个 NONE 的库（不依赖本仓模块，避免把单例开起来）
    const raw = new Database(legacy);
    raw.pragma('auto_vacuum = NONE');
    raw.exec('CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY, x TEXT)');
    raw.prepare('INSERT INTO legacy_marker (x) VALUES (?)').run('keep-me');
    raw.close();

    const probe = probeDb(legacy);
    assert.equal(
      probe.autoVacuum, 0,
      '老库必须保持 NONE —— 切到 INCREMENTAL 需要整库 VACUUM（重写文件），不能替用户决定'
    );
    // 数据必须还在（我们没有因为维护动作动过它）
    const raw2 = new Database(legacy, { readonly: true });
    const row = raw2.prepare('SELECT x FROM legacy_marker WHERE id = 1').get();
    raw2.close();
    assert.equal(row?.x, 'keep-me', '老库数据不能被维护动作碰掉');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 源码守卫：applyAutoVacuumPolicy 必须在 journal_mode = WAL **之前**', () => {
  const avIdx = dbSrc.indexOf('applyAutoVacuumPolicy(db)');
  const walIdx = dbSrc.indexOf("db.pragma('journal_mode = WAL')");
  assert.ok(avIdx > 0, '找不到 applyAutoVacuumPolicy 的调用点');
  assert.ok(walIdx > 0, "找不到 journal_mode = WAL");
  assert.ok(
    avIdx < walIdx,
    'auto_vacuum 必须在 WAL **之前**设 —— 反了会静默失效（本轮实测新库仍是 NONE，白写）'
  );
});

test('④ 维护动作失败不许挡住启动（都在 try 里）', () => {
  // optimize 与 incremental_vacuum 都必须被 try 包着，且失败只 warn
  const fn = dbSrc.slice(dbSrc.indexOf('function runStartupDbMaintenance'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /try\s*\{[\s\S]*?pragma\('optimize'\)[\s\S]*?\}\s*catch/, 'optimize 要在 try/catch 里');
  assert.match(body, /catch\s*\(err\)\s*\{\s*console\.warn/, 'optimize 失败只 warn');
  assert.match(body, /incremental_vacuum/, '要有按需回收那一句');
});

test('⑤ 注释纪律：注释行里不许出现反引号（本文件是模板字符串上下文）', () => {
  // 只看我新增的两个函数范围
  const start = dbSrc.indexOf('function applyAutoVacuumPolicy');
  const end = dbSrc.indexOf('function cleanupOrphanedInFlight');
  const block = dbSrc.slice(start, end > start ? end : start + 5000);

  // ⚠️ 只查**注释行**：代码里的模板字符串（console.log 用的反引号）是合法用法，不能一起禁。
  //    （第一版把整段做 `includes('`')` ⇒ 把代码里的 `[db] ...` 日志也判红，是假阳性。）
  const offenders = block
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /^(\/\/|\*|\/\*)/.test(line) && line.includes('`'));

  assert.deepEqual(
    offenders, [],
    '注释里出现反引号会截断 db.exec 的模板字符串（SyntaxError: missing ) after argument list，本仓踩过三次）。'
    + `命中：${JSON.stringify(offenders)}`
  );
});
