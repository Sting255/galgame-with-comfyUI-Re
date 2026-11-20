/**
 * 死图引用体检（DB 里指向的图片文件不存在）
 *
 * ## 为什么有这个脚本
 * 2026-10-17 全项目复查记了一条「606 条死图引用未清」，但那是**两轮前的估算**、也没写是哪几列。
 * 2026-10-18 实测是 **103 条**，分布也不一样。这条清单一直没人敢动，原因很实在：
 * 它要改的是**真实库**（删掉那些悬空引用），而"哪条算死图"如果判断错，就是删用户数据。
 *
 * 所以本脚本的定位和 `town-assets-check.mjs` 一致：**默认只报告、不删**，
 * 把"哪条是死图"变成**可复跑、可复核**的机械判定，让人（而不是手感）决定要不要清。
 *
 * ## 判定口径
 * 扫**所有表的文本列**，抽出形如 `/images/...`、`/avatars/...`、`/town-assets/...`
 * （以及裸相对路径）的图片引用，按 URL 前缀映射到磁盘目录，逐个 `existsSync`。
 * 前缀 → 目录的映射据实测形态：
 *   `/images/**`      → `agent-core/data/images/**`
 *   `/avatars/**`     → `agent-core/data/avatars/**`
 *   `/town-assets/**` → `agent-core/data/town/assets/**`
 *
 * ⚠️ 口径**偏保守**：拿不准的一律算"未死"（宁可漏报，不可误判成可删）。
 *    另外单独报"库里引用了但文件缺失"与"磁盘有但没人引用"两类，让人分别判断。
 *
 * ⚠️ 本脚本**只读库**（`readonly: true`），不提供删除功能 —— 清理是数据决策，
 *    要动库里就得先拿这份清单跟用户确认。
 *
 * ## 用法
 *   node scripts/dead-image-check.mjs            # 人类可读报告
 *   node scripts/dead-image-check.mjs --json     # 机器可读
 *   node scripts/dead-image-check.mjs --by-column  # 只按列汇总（清单太长时的概览）
 *
 * 退出码：0 = 没发现死图；1 = 有死图（供门禁/巡检当信号）；2 = 读库错误。
 *
 * ⚠️ 必须用仓库自带 node（`runtime\nodejs\node.exe`）：PATH 上的版本可能 ABI 不兼容
 *    `better-sqlite3`，会报 ERR_DLOPEN_FAILED。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CORE = path.join(ROOT, 'agent-core');
const DATA = path.join(CORE, 'data');

const DB_PATH = process.env.DB_PATH && process.env.DB_PATH !== ':memory:'
  ? path.resolve(process.env.DB_PATH)
  : path.join(CORE, 'data', 'agent.db');

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const byColumnOnly = args.has('--by-column');

/** URL 前缀 → 磁盘目录（据 2026-10-18 实测的库里实际形态） */
const URL_PREFIX_MAP = [
  ['/images/', path.join(DATA, 'images')],
  ['/avatars/', path.join(DATA, 'avatars')],
  ['/town-assets/', path.join(DATA, 'town', 'assets')],
];

/** 只要路径以这些结尾就当成图片引用（带 query 的先裁掉） */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

/** 我们只关心"像是本项目资源路径"的值，避免把外链 URL 也算进来 */
const LOOKS_LIKE_ASSET = /^\/?(images|avatars|town-assets)\//i;

function resolveToDisk(rawValue) {
  const s = String(rawValue).split('?')[0].split('#')[0].trim();
  for (const [prefix, dir] of URL_PREFIX_MAP) {
    if (s.startsWith(prefix)) return path.join(dir, s.slice(prefix.length));
  }
  if (s.startsWith('/')) return path.join(CORE, s.slice(1));
  // 裸相对路径（历史形态）：优先按 data/ 下找
  return path.join(DATA, s);
}

function openReadonly() {
  const require = createRequire(path.join(CORE, 'package.json'));
  const Database = require(path.join(CORE, 'node_modules', 'better-sqlite3'));
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[dead-image] 数据库不存在：${DB_PATH}`);
    process.exit(2);
  }
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function scan() {
  const db = openReadonly();

  // 哪些列看起来像"存图片路径"？按列名筛（path/image/url/cover/avatar/standing…），
  // 并且只扫 TEXT 列 —— 避免把 BLOB 里的二进制当字符串处理。
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  const candidates = [];
  for (const t of tables) {
    let cols;
    try { cols = db.prepare(`PRAGMA table_info("${t}")`).all(); } catch { continue; }
    for (const c of cols) {
      const isText = /TEXT|CHAR|CLOB|^$/i.test(c.type || '');
      const looksImagey = /path|image|url|avatar|standing|cover|photo|pic/i.test(c.name);
      if (isText && looksImagey) candidates.push({ table: t, column: c.name });
    }
  }

  const dead = [];         // {table, column, value, disk}
  const alive = [];
  const scannedColumns = [];

  for (const { table, column } of candidates) {
    let rows;
    try {
      rows = db.prepare(
        `SELECT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" != ''`
      ).all();
    } catch { continue; }
    let hits = 0;
    for (const { v } of rows) {
      const s = String(v);

      // ① 整列值就是一条路径（历史行为）
      if (IMAGE_EXT.test(s.split('?')[0]) && LOOKS_LIKE_ASSET.test(s)) {
        hits++;
        const disk = resolveToDisk(s);
        (fs.existsSync(disk) ? alive : dead).push({ table, column, value: s, disk });
        continue;
      }

      // ② JSON 数组列：把数组里每条路径都算进来。
      //   2026-10-18 实测踩到：`messages.images = ["/images/chat/xxx.png"]` 整列以 `"]` 结尾，
      //   过不了上面的 IMAGE_EXT 判定 ⇒ **整个 JSON 列被静默跳过**。
      //   于是脚本只报 103 条死图，而真实是 624 个文件 / 976 处引用（浏览器侧表现为一片图片 404）。
      //   这里用「值里含本项目资源前缀 + 图片扩展名」做二次提取，散文列（如 messages.content
      //   里提到的路径）也会被提取到 —— 那是叙述文本而非引用，但**报出来**比漏掉安全。
      const first = s.trim()[0];
      if (first !== '[' && first !== '{') continue;
      const found = s.match(/\/?(?:images|avatars|town-assets)\/[A-Za-z0-9_\-./%]+\.(?:png|jpe?g|webp|gif|bmp|avif)/gi);
      if (!found) continue;
      for (const raw of found) {
        const p = raw.startsWith('/') ? raw : '/' + raw;
        if (!LOOKS_LIKE_ASSET.test(p)) continue;
        hits++;
        const disk = resolveToDisk(p);
        (fs.existsSync(disk) ? alive : dead).push({ table, column, value: p, disk });
      }
    }
    if (hits) scannedColumns.push({ table, column, refs: hits });
  }

  db.close();

  // 按列汇总
  const byColumn = {};
  for (const d of dead) {
    const k = `${d.table}.${d.column}`;
    byColumn[k] = (byColumn[k] || 0) + 1;
  }

  return {
    db: DB_PATH,
    dataDir: DATA,
    scannedColumns: scannedColumns.sort((a, b) => b.refs - a.refs),
    counts: { refs: alive.length + dead.length, alive: alive.length, dead: dead.length },
    byColumn,
    dead,
  };
}

function main() {
  const r = scan();

  if (asJson) {
    console.log(JSON.stringify({
      db: r.db,
      counts: r.counts,
      byColumn: r.byColumn,
      dead: r.dead,
    }, null, 2));
    return r.counts.dead ? 1 : 0;
  }

  console.log(`[dead-image] 库：${r.db}`);
  console.log(`[dead-image] 资源根：${r.dataDir}`);
  console.log(`[dead-image] 扫到图片引用的列：${r.scannedColumns.map((c) => `${c.table}.${c.column}(${c.refs})`).join(', ') || '（无）'}`);
  console.log(`[dead-image] 引用 ${r.counts.refs} 条 | 文件在 ${r.counts.alive} | **死图 ${r.counts.dead}**`);

  if (r.counts.dead === 0) {
    console.log('\n✓ 没有死图引用。');
    return 0;
  }

  console.log('\n按列分布（死图数）：');
  for (const [k, n] of Object.entries(r.byColumn).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${k}`);
  }

  if (byColumnOnly) {
    console.log('\n（--by-column：只出汇总。要看逐条清单去掉这个开关）');
  } else {
    console.log('\n逐条清单：');
    for (const d of r.dead) {
      console.log(`   ${d.table}.${d.column}`);
      console.log(`      ${d.value}`);
    }
  }

  console.log('\n⚠️ 本脚本只报告，不删任何东西。');
  console.log('   清理要改**真实库**（删悬空引用或补回文件），属数据决策 ——');
  console.log('   先把这份清单给人确认；其中「文件确实不该存在」的才考虑删引用，');
  console.log('   「文件本该存在」的应优先找回文件（可查 data/backups 或历史交付包）。');
  return 1;
}

process.exit(main());
