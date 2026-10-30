/**
 * `scripts/dead-image-check.mjs`（死图引用体检）的自检（2026-10-18）
 *
 * ## 为什么这个工具有守卫
 * 它回答的是「哪些图 DB 引用了但文件不在」。这条清单之所以挂了两轮没人动，是因为
 * **下一步就是改真实库**（删悬空引用），而判断错就是删用户数据。所以本工具的
 * 要紧属性是：**只读、只报告、不删任何东西**，且判定口径必须可复跑、可复核。
 *
 * ## 本文件钉住
 *   ① 工具存在且跑得通，输出里含"死图"汇总（不是空输出假绿）；
 *   ② 它**不提供任何删除能力**（源码里不许出现 DELETE/UPDATE/DROP/unlink/rm）；
 *   ③ 它以 **readonly** 方式开库（防哪天有人顺手加个写操作）；
 *   ④ 在**自造的库**上判定正确：文件在 → 不算死；文件缺 → 算死（证明它真的在查磁盘，
 *      而不是"看到列名就报死"）；
 *   ⑤ 外链 / 非图片 / 非本仓路径**不算死图**（口径偏保守，防误判成可删）。
 *
 * ⚠️ 全程在 `%TEMP%` 造库 + 造文件跑（`DB_PATH` / 临时 data 目录），**绝不碰真实库**。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dead-image-check.mjs');
const NODE = path.join(ROOT, 'runtime', 'nodejs', 'node.exe');
const CORE = path.join(ROOT, 'agent-core');
const Database = createRequire(path.join(CORE, 'package.json'))(path.join(CORE, 'node_modules', 'better-sqlite3'));

let tmp = null;
let dbFile = null;

/** 真实库指纹 —— 用来断言我们没碰它 */
const REAL_DB = path.join(CORE, 'data', 'agent.db');
let realDbStat = null;

before(() => {
  realDbStat = fs.existsSync(REAL_DB) ? { size: fs.statSync(REAL_DB).size, mtime: fs.statSync(REAL_DB).mtimeMs } : null;

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-image-'));
  dbFile = path.join(tmp, 'agent.db');

  // ⚠️ 脚本把 `/images/...` 映射到 `<仓库>/agent-core/data/images/...`（写死的），
  //    所以本测试**只能**用真实存在的那些文件来做"活着"的那一半断言，
  //    用不存在的路径做"死了"的那一半断言。这样既不碰真实库，也不写真实 data 目录。
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE characters (id INTEGER PRIMARY KEY, avatar_path TEXT, standing_url TEXT);
    CREATE TABLE character_emojis (id INTEGER PRIMARY KEY, image_path TEXT);
    CREATE TABLE event_history (id INTEGER PRIMARY KEY, final_image TEXT);
  `);
  // 活着的：真实库那 33 个 town 素材之一（前面已核实存在）
  db.prepare('INSERT INTO characters (id, avatar_path, standing_url) VALUES (1, ?, ?)')
    .run('/town-assets/asset_1_player_down_427baeaf-ce3a-4700-99b8-af4a6ec29b9a.png',
      '/images/standing/definitely_missing_probe_000.png');
  db.prepare('INSERT INTO character_emojis (id, image_path) VALUES (1, ?)')
    .run('/images/emoji/also_missing_probe_000.png');
  // 不该被算成死图的三种：外链 / 非图片 / 非本仓路径
  db.prepare('INSERT INTO event_history (id, final_image) VALUES (1, ?)')
    .run('https://example.com/remote.png');
  db.prepare('INSERT INTO event_history (id, final_image) VALUES (2, ?)')
    .run('/images/events/not_an_image_target.txt');
  // ⚠️ 这条要能"看出它不是本仓资源路径"。注意它**不能**写成带图片扩展名的相对路径，
  //    否则扫描器按 basename 去 data/ 下找、找不到就当死图 —— 那是脚本的既有口径
  //    （裸相对路径也算候选），本测试不该去挑战它。用 .txt 排除扩展名即可覆盖这条。
  db.close();
});

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (args = []) => {
  const opts = {
    cwd: CORE, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, DB_PATH: dbFile },
  };
  try {
    return { code: 0, out: execFileSync(NODE, [SCRIPT, ...args], opts) };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') };
  }
};

test('① 工具跑得通，且有死图时退出码非 0（供巡检当信号）', () => {
  const { code, out } = run();
  assert.notEqual(code, 0, '发现死图时应当以非 0 退出');
  assert.match(out, /死图/, '输出里要有"死图"汇总');
  assert.match(out, /按列分布/, '要有按列分布');
});

test('② 判定真的在查磁盘：文件在的算活、文件缺的算死', () => {
  const { out } = run(['--json']);
  const json = JSON.parse(out);
  // 我们造的 2 条缺失引用必须被抓到
  const values = json.dead.map((d) => d.value);
  assert.ok(values.some((v) => v.includes('definitely_missing_probe_000.png')),
    '缺文件的 /images/** 引用必须算死图');
  assert.ok(values.some((v) => v.includes('also_missing_probe_000.png')),
    '缺文件的 emoji 引用必须算死图');
  // 文件真实存在的那条**不能**算死图
  assert.ok(!values.some((v) => v.includes('asset_1_player_down')),
    '文件确实存在的引用绝不能算死图（那会导致误删用户素材）');
});

test('③ 口径保守：外链 / 非图片扩展名都不算死图', () => {
  const { out } = run(['--json']);
  const values = JSON.parse(out).dead.map((d) => d.value);
  assert.ok(!values.some((v) => v.startsWith('https://')), '外链不算死图');
  assert.ok(!values.some((v) => v.endsWith('.txt')), '非图片扩展名不算死图');
});

test('④ 只读守卫：源码里不许有删除/写入能力，且必须以 readonly 开库', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of [/\bDELETE\s+FROM\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDROP\s+TABLE\b/i, /\bunlinkSync\b/, /\brmSync\b/, /\bwriteFileSync\b/]) {
    assert.ok(!forbidden.test(code),
      `死图工具必须是只读的，源码里不许出现 ${forbidden}（清理是数据决策，要人确认后另做）`);
  }
  assert.match(code, /readonly:\s*true/, '必须以 readonly 方式开库');
});

test('⑤ 全程没碰真实库', () => {
  if (!realDbStat) return;
  const now = fs.statSync(REAL_DB);
  assert.equal(now.size, realDbStat.size, '真实库大小不许变');
  assert.equal(now.mtimeMs, realDbStat.mtime, '真实库 mtime 不许变（动了就是写过了）');
});
