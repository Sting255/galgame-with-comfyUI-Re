@echo off
title Linshe DB Cleanup
rem ============================================================
rem  Linshe one-shot database cleanup (re-runnable).
rem  Usage: put THIS file in the project ROOT (next to the
rem  launcher exe), close the app, then double-click. The app
rem  will be closed automatically if it is running.
rem  Node runtime: bundled runtime/nodejs*/ first, then PATH
rem  (same discovery order as the launcher).
rem  This file = small batch shell + embedded JS payload after
rem  the ___JS___ marker. Readable/auditable. Only removes
rem  runtime garbage; characters/chats/memories never touched.
rem  NOTE (2026-10-18): the server ALREADY auto-purges this class
rem  of garbage (townService.purgeTownActionHistory, first run
rem  ~90s after boot then every 5 min). What the server does NOT
rem  do is VACUUM -- deletes only free pages, the file keeps its
rem  size. That is the reason this tool still exists.
rem ============================================================

set "LINSHE_CORE=%~dp0agent-core"
if not exist "%LINSHE_CORE%\package.json" (
  echo [X] agent-core\package.json not found here.
  echo     Put this file in the project ROOT folder, then run again.
  echo.
  pause
  exit /b 1
)
if not exist "%LINSHE_CORE%\data\agent.db" (
  echo [X] agent-core\data\agent.db not found.
  echo.
  pause
  exit /b 1
)

rem Node runtime discovery: bundled runtime/nodejs*/ first, then PATH
set "LINSHE_NODE="
for /d %%d in ("%~dp0runtime\nodejs*") do (
  if exist "%%d\node.exe" set "LINSHE_NODE=%%d\node.exe"
)
if defined LINSHE_NODE goto :have_node
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found: no bundled runtime\nodejs*\ and no system node.
  echo     Start the app once via its launcher, or install Node.js.
  echo.
  pause
  exit /b 1
)
set "LINSHE_NODE=node"
:have_node

echo Extracting embedded cleanup script...
set "LINSHE_SCRIPT=%~f0"
powershell -NoProfile -Command "$c=[IO.File]::ReadAllLines($env:LINSHE_SCRIPT); $i=[Array]::IndexOf($c,'___JS___'); if($i -lt 0){exit 1}; [IO.File]::WriteAllLines($env:TEMP+'\linshe_db_cleanup.cjs', $c[($i+1)..($c.Count-1)])"
if errorlevel 1 (
  echo [X] Failed to extract the embedded script.
  pause
  exit /b 1
)

echo.
echo Do NOT close this window while cleaning. Progress will be printed.
echo The app will be closed automatically if it is running.
echo Large databases may take 10-30 minutes.
echo.
set /p LINSHE_CONFIRM=Type Y and press Enter to start cleaning:
if /i not "%LINSHE_CONFIRM%"=="Y" (
  echo Cancelled.
  pause
  exit /b 0
)

cd /d "%LINSHE_CORE%"
"%LINSHE_NODE%" "%TEMP%\linshe_db_cleanup.cjs" "%LINSHE_CORE%"
set LINSHE_RC=%errorlevel%
del "%TEMP%\linshe_db_cleanup.cjs" >nul 2>nul
echo.
if "%LINSHE_RC%"=="0" (echo Cleanup finished.) else (echo Cleanup failed - please send the full output above to the author.)
pause
exit /b %LINSHE_RC%
___JS___
// 邻舍数据库一键清理（由批处理外壳解包后以 node 运行；本行起为 JS 载荷）
// 只删运行垃圾：已结束的动作流水（保留 24 小时，动态流水页按条数读最新记录且
// 排除 cancelled）、命令幂等缓存、旧世界纪元/停产类型/30 天前的事件日志。
// 角色/聊天/记忆/经历等用户数据一律不碰。
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const RETENTION_DAYS = 7;   // 导演候选等保留天数（与服务器内置任务一致）
const ACTIONS_RETENTION_HOURS = 24; // 已结束动作流水保留窗口：动态流水页按条数读最新记录，旧版本 churn 数据无需长留
const CHUNK_ACTIONS = 5000;
const CHUNK_LOGS = 100000;

const appDir = (process.argv[2] || process.cwd()).replace(/[\\/"]+$/, '');
const dbPath = path.join(appDir, 'data', 'agent.db');
const fmtGB = n => (n / 1073741824).toFixed(2) + ' GB';
const DAY = 86400000;
const sleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const say = m => console.log(m);
const fail = m => { say('[X] ' + m); process.exit(1); };

let Database;
try { Database = require(path.join(appDir, 'node_modules', 'better-sqlite3')); }
catch (e) { fail('未找到 better-sqlite3 模块——请在程序目录内运行本脚本。'); }

if (!fs.existsSync(dbPath)) fail('未找到数据库 ' + dbPath);

// ── 运行中检测：发现邻舍进程就自动结束它，专心清理 ──
const ps = script => {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return execSync(`powershell -NoProfile -EncodedCommand ${b64}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
};
const psJson = script => {
  try {
    const r = JSON.parse(ps(script) || 'null');
    return Array.isArray(r) ? r : r ? [r] : [];
  } catch { return []; }
};
const isNode = name => /^node(\.exe)?$/i.test(name || '');
function port3099Pids() {
  try {
    const out = execSync('netstat -ano | findstr ":3099"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))];
  } catch { return []; }
}
function procInfo(pid) {
  return psJson(`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object Name,ParentProcessId | ConvertTo-Json -Compress`)[0] || null;
}
function findAppProcs() {
  // 邻舍后端 = node.exe 且命令行含 app.js（兼容改过端口/免 nodemon 启动）
  return psJson(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'app\\.js' } |
    Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`);
}
function topNodeAncestor(pid) {
  // 沿父链向上找最顶层的 node 祖先（npm → 监控器 → app.js），对它整树结束
  let cur = pid, top = pid, hops = 0;
  while (cur > 4 && hops++ < 15) {
    const p = procInfo(cur);
    if (!p || !isNode(p.Name)) break;
    top = cur;
    cur = p.ParentProcessId;
  }
  return top;
}
function ensureAppClosed() {
  for (let round = 0; round < 2; round++) {
    const listeners = port3099Pids();
    const procs = findAppProcs();
    if (!listeners.length && !procs.length) return true;
    say('检测到邻舍正在运行，正在自动关闭以专心清理...');
    const kill = new Set(procs.map(p => topNodeAncestor(p.ProcessId)));
    for (const pid of listeners) {
      const info = procInfo(pid);
      if (info && isNode(info.Name)) kill.add(topNodeAncestor(pid));
      else fail(`端口 3099 被其他程序（PID ${pid}）占用，无法自动处理，请手动解决后再运行本脚本。`);
    }
    for (const pid of kill) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* 已自行退出 */ }
    }
    // 启动器（邻舍.EXE.exe）可能守护后端：一并结束
    for (const img of ['邻舍.EXE.exe', 'NeighborExe.exe']) {
      try { execSync(`taskkill /IM "${img}" /F`, { stdio: 'ignore' }); } catch (e) { /* 未在运行 */ }
    }
    sleep(2000);
    if (!port3099Pids().length && !findAppProcs().length) return true;
  }
  return !port3099Pids().length && !findAppProcs().length;
}
if (!ensureAppClosed()) fail('邻舍进程未能自动关闭——请手动关闭后重试。');

let db;
try { db = new Database(dbPath); }
catch (e) { fail('数据库被占用或无法打开：' + e.message); }
db.pragma('busy_timeout = 3000');
db.pragma('foreign_keys = ON');

// ── 运行中检测（兜底闸）：抢占写锁。程序在跑就几乎必然撞上 ──
let locked = true;
for (let i = 0; i < 3 && locked; i++) {
  try { db.exec('BEGIN IMMEDIATE'); db.exec('COMMIT'); locked = false; }
  catch (e) { say('    数据库正被占用，2 秒后重试...'); sleep(2000); }
}
if (locked) fail('数据库持续被占用——请确认程序已完全关闭后重试。');

const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const count = t => db.prepare('SELECT count(*) n FROM ' + t).get().n;
const sizeOf = p => { try { return fs.statSync(p).size; } catch { return 0; } };

const sizeBefore = sizeOf(dbPath);
say('==============================================');
say(' 邻舍数据库一键清理');
say('==============================================');
say('数据库：' + dbPath);
say('当前体积：' + fmtGB(sizeBefore));

say('正在统计各表行数（大库首次读取可能需要几分钟，请稍候）...');
const stats = {};
for (const t of ['town_actions', 'town_activity_log', 'town_action_requests', 'town_domain_events']) {
  stats[t] = has(t) ? count(t) : -1;
}
say('动作流水 ' + stats.town_actions + ' 行 | 审计 ' + stats.town_activity_log
  + ' 行 | 幂等记录 ' + stats.town_action_requests + ' 行 | 事件日志 ' + stats.town_domain_events + ' 行');
say('');

const t0 = Date.now();
const done = [];

(async () => {
  // ── 1. 备份（失败即取消，不动任何数据）──
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const backupPath = path.join(appDir, 'data', 'agent.db.cleanup-backup-' + stamp);
  say('[1/6] 备份数据库 → ' + path.basename(backupPath));
  say('      （大库需要几分钟；确认程序一切正常后可手动删除备份）');
  let lastPct = -10;
  try {
    await db.backup(backupPath, { progress: ({ totalPages, remainingPages }) => {
      const pct = totalPages ? Math.floor((totalPages - remainingPages) * 100 / totalPages) : 100;
      if (pct >= lastPct + 10 || remainingPages === 0) { lastPct = pct; say('      备份进度 ' + pct + '%'); }
    } });
  }
  catch (e) { fail('备份失败，已取消清理：' + e.message); }
  say('      备份完成 ' + fmtGB(sizeOf(backupPath)));
  say('');

  // ── 索引：删 actions 时 FK 逐行检查 activity_log，没有 action_id 索引会全表扫描 ──
  if (has('town_activity_log')) {
    db.exec('CREATE INDEX IF NOT EXISTS town_activity_log_action ON town_activity_log(action_id)');
  }

  // ── 2. 已结束的动作流水（保留最近 24 小时）+ 审计子行 ──
  if (has('town_actions')) {
    say('[2/6] 清理 24 小时前已结束的动作流水及审计行...');
    const hasActivity = has('town_activity_log');
    const cutoff = Date.now() - ACTIONS_RETENTION_HOURS * 3600_000;
    const page = db.prepare('SELECT id, status, updated_at FROM town_actions WHERE id > ? ORDER BY id LIMIT ' + CHUNK_ACTIONS);
    const delChildren = ids => db.prepare(`DELETE FROM town_activity_log WHERE action_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    const delParents = ids => db.prepare(`DELETE FROM town_actions WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    let cursor = '', delA = 0, delAl = 0, nextMark = 20000;
    for (;;) {
      const rows = page.all(cursor);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      const stale = rows.filter(r => r.updated_at < cutoff
        && (r.status === 'completed' || r.status === 'cancelled' || r.status === 'failed')).map(r => r.id);
      if (stale.length) {
        db.transaction(() => {
          if (hasActivity) delAl += delChildren(stale).changes;
          delA += delParents(stale).changes;
        })();
      }
      if (delA >= nextMark) { say('      已删动作 ' + delA + ' 行 / 审计 ' + delAl + ' 行'); nextMark += 20000; }
    }
    done.push('动作流水 -' + delA + ' 行，审计 -' + delAl + ' 行');
    say('      完成：动作 -' + delA + ' 行，审计 -' + delAl + ' 行');
  }

  // ── 3. 命令幂等记录：运行时去重缓存，整表清空（服务停止时绝对安全）──
  if (has('town_action_requests')) {
    say('[3/6] 清空命令幂等记录...');
    let delR = 0, nextMark = 50000;
    for (;;) {
      const r = db.prepare('DELETE FROM town_action_requests WHERE rowid IN (SELECT rowid FROM town_action_requests LIMIT ' + CHUNK_LOGS + ')').run();
      delR += r.changes;
      if (!r.changes) break;
      if (delR >= nextMark) { say('      已删 ' + delR + ' 行'); nextMark += 50000; }
    }
    done.push('幂等记录 -' + delR + ' 行');
    say('      完成：-' + delR + ' 行');
  }

  // ── 4. 事件日志：旧纪元整段清 + 停产类型一次扫净 + 30 天前按 occurredAt 清 ──
  // （经历账本引用的事件是记忆凭证，三类清扫都永久保留；未投递完的事件也不删）
  if (has('town_domain_events')) {
    say('[4/6] 清理事件日志（旧纪元 / 停产类型 / 30 天前）...');
    const hasDeliveries = has('town_event_deliveries');
    const hasActivity = has('town_activity_log');
    const hasExp = has('town_experiences');
    const expFilter = hasExp ? ' AND event_id NOT IN (SELECT event_id FROM town_experiences)' : '';
    const dlvGuard = hasDeliveries
      ? ` AND NOT EXISTS (SELECT 1 FROM town_event_deliveries d WHERE d.event_id = town_domain_events.event_id AND d.status IN ('pending','processing'))` : '';
    const wheres = [];
    if (has('town_world_state')) {
      const epochRow = db.prepare('SELECT epoch FROM town_world_state').get();
      if (epochRow && Number.isSafeInteger(epochRow.epoch)) wheres.push(`world_epoch < ${epochRow.epoch}`);
    }
    wheres.push(`type = 'town.action.changed'`);
    wheres.push(`CAST(json_extract(envelope, '$.occurredAt') AS INTEGER) < ${Date.now() - 30 * DAY}`);
    let delE = 0, delD = 0, delAl = 0;
    for (const extra of wheres) {
      const where = `WHERE ${extra}${expFilter}${dlvGuard}`;
      for (;;) {
        // rowid 在有 INTEGER PRIMARY KEY 的表上返回的是主键列名，必须显式别名
        const rows = db.prepare(`SELECT rowid AS rid FROM town_domain_events ${where} ORDER BY rowid LIMIT 50000`).all();
        if (!rows.length) break;
        const rids = rows.map(r => r.rid).join(',');
        db.transaction(() => {
          if (hasDeliveries) delD += db.prepare(`DELETE FROM town_event_deliveries WHERE event_id IN
            (SELECT event_id FROM town_domain_events WHERE rowid IN (${rids}))`).run().changes;
          if (hasActivity) delAl += db.prepare(`DELETE FROM town_activity_log WHERE event_id IN
            (SELECT event_id FROM town_domain_events WHERE rowid IN (${rids}))`).run().changes;
          delE += db.prepare(`DELETE FROM town_domain_events WHERE rowid IN (${rids})`).run().changes;
        })();
        say('      已删事件 ' + delE + ' 行 / 投递 ' + delD + ' 行 / 审计 ' + delAl + ' 行');
      }
    }
    done.push(`事件日志 -${delE} 行，投递 -${delD} 行，审计 -${delAl} 行`);
    say('      完成：事件 -' + delE + ' 行，投递 -' + delD + ' 行，审计 -' + delAl + ' 行');
  }

  // ── 5. 其他运行垃圾（保留期与服务器内置清理任务一致）──
  say('[5/6] 清理候选/相遇/投递状态等运行残留...');
  const eco = [];
  if (has('town_director_candidates')
    && db.prepare('PRAGMA table_info(town_director_candidates)').all().some(c => c.name === 'created_utc_ms')) {
    const r = db.prepare('DELETE FROM town_director_candidates WHERE created_utc_ms < ?')
      .run(Date.now() - RETENTION_DAYS * DAY);
    if (r.changes) eco.push('导演候选 -' + r.changes + ' 行');
  }
  if (has('town_encounters')) {
    const r = db.prepare('DELETE FROM town_encounters WHERE COALESCE(ended_at, created_at) < ?')
      .run(new Date(Date.now() - 30 * DAY).toISOString().slice(0, 19).replace('T', ' '));
    if (r.changes) eco.push('相遇 -' + r.changes + ' 行');
  }
  if (has('town_event_deliveries')) {
    const r = db.prepare("DELETE FROM town_event_deliveries WHERE status IN ('done','dead')").run();
    if (r.changes) eco.push('投递状态 -' + r.changes + ' 行');
  }
  say('      ' + (eco.length ? eco.join('，') : '无残留'));
  if (eco.length) done.push(eco.join('，'));

  // ── 6. 压缩 + 校验 ──
  say('[6/6] VACUUM 压缩（大库需要几分钟，期间窗口无响应、进度按 10 秒心跳显示，请勿关闭）...');
  // VACUUM 会阻塞本进程事件循环，心跳由独立子进程向同一控制台打印
  const hb = spawn(process.execPath, ['-e',
    'const t0=Date.now();setInterval(()=>console.log("      压缩进行中，已耗时 "+Math.round((Date.now()-t0)/1000)+"s ..."),10000)'],
    { stdio: 'inherit' });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  hb.kill();
  say('      完整性校验：' + db.pragma('integrity_check', { simple: true }));

  const sizeAfter = sizeOf(dbPath);
  say('');
  say('==============================================');
  say(' 清理完成（用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒）');
  for (const line of done) say('  · ' + line);
  say('  体积：' + fmtGB(sizeBefore) + ' → ' + fmtGB(sizeAfter));
  say(' 备份：' + path.basename(backupPath) + '（确认正常后可手动删除）');
  say('==============================================');
  say(' 说明（2026-10-18 更正）：');
  say('   · 服务器**有**内置自动清理 —— services/town/townService.js 的 purgeTownActionHistory');
  say('     在启动后 90 秒跑首轮，此后每 5 分钟一轮，按保留期清动作流水 / 幂等记录 / 事件日志 /');
  say('     投递状态 / 相遇 / 导演候选（保留期：动作 7 天、事件与相遇 30 天、候选 7 天）。');
  say('     ⚠️ 本行以前写的是「当前版本没有内置自动清理」—— 那是**错的**，已核实并更正。');
  say('   · 但服务器**不做 VACUUM**：删除只把页标成空闲，磁盘体积不缩。本脚本的价值就在这里 ——');
  say('     它多做了 [1] 备份、[6] VACUUM + integrity_check。所以玩久了（页碎片多、体积虚高）');
  say('     隔几个月跑一次本脚本仍然值得，但**不必**为「垃圾堆积」担心。');
  say('   · 它只清小镇的运行期垃圾；人物、聊天记录、记忆、关系一律不碰，而且**动手前会先备份**。');
  db.close();
  process.exit(0);
})().catch(e => {
  say('[X] 清理中断：' + (e && e.message || e));
  say('    数据库已有备份：data/ 目录下 agent.db.cleanup-backup-*');
  process.exit(1);
});
