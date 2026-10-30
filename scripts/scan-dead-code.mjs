/**
 * 死代码扫描器（正式工具，2026-10-15 建）
 *
 * ## 为什么要有它
 * `git show HEAD:目标/接手必读.md` §6.3-18 挂着一句「15 个死导出、7 个 `stop*Scheduler`、`embedText`、3 个死列
 * （**只标注不删**，别顺手清）」—— 但**那个数字是若干轮前的快照，而且从没记录是哪几个**。
 * 结果每一轮接手的人都得凭感觉找，找出来的还不一样（本轮实测：死导出候选 **37 个**、死列 **8 个**，
 * 与文档写的 15 / 3 都对不上）。
 *
 * 所以把它做成**可复跑**的脚本：口径写死在代码里，结论可复现，新发现的就加进白名单/黑名单。
 *
 * ## 用法
 * ```
 * cd agent-core
 * & "<repo>\runtime\nodejs\node.exe" ../scripts/scan-dead-code.mjs
 * ```
 * 输出：疑似死导出 / 疑似死列两份清单（**候选**，不是结论 —— 见下面的假阳性说明）。
 *
 * ## ⚠️ 三个必须知道的假阳性来源（都真踩过）
 * 1. **必须把 `agent-core/app.js` 算进"使用者"** —— 所有 `startXxxScheduler` / `stopXxxScheduler`
 *    的调用都在那里。漏了它，二十多个调度器函数会集体变成"死导出"（本轮第一版扫描就是这个结果）。
 * 2. **`__test` 这类测试钩子不算死导出** —— 它们由测试按约定名字取用。
 * 3. **常量表（`DEFAULT_RULES` / `PERIODS` / `INTIMATE_REJECT_CODES` …）可能是"文档性常量"** ——
 *    给人和测试看的、代码不引用。判死前先看一眼它上方的注释在说什么。
 *
 * ## 判定口径
 * 死导出 = 名字在**其它文件**（含 `app.js` 与 `test/`）零出现，且**本文件内也只出现在定义处**。
 *          （"本文件内还用了一次"说明导出只是顺手，不算死代码。）
 * 死列   = schema 里 `CREATE TABLE` 定义了，但全仓（`src/` + `app.js` + `test/`）只出现 1 次。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 别用 `new URL(import.meta.url).pathname` —— 中文/空格路径会带回 URL 编码（%E9%82%BB…），
//    在 Windows 上直接 ENOENT（本仓路径含中文，踩过）。`fileURLToPath` 才是正解。
const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-core');
const SKIP_DIRS = new Set(['node_modules', 'public', 'data', '.git', 'dist']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const srcFiles = walk(path.join(AGENT, 'src'));
const testFiles = walk(path.join(AGENT, 'test'));
// ⚠️ app.js 必须算进去（见文件头 §假阳性 1）
const appEntry = path.join(AGENT, 'app.js');

/**
 * 扫描器**自己的**自检测试要从"使用者"里排除 —— 否则形成自指循环：
 * 自检测试里写着"哪些是死导出"（断言清单内容）⇒ 那些名字在测试里出现 ⇒ 扫描器认为"有人用" ⇒
 * 它们从清单里消失 ⇒ 自检测试反而失败（本轮实测踩到：加了标注的 5 个全部消失）。
 * 扫描器是工具，工具的自检不该被当成业务代码的引用。
 */
const SELF_TEST = path.join(AGENT, 'test', 'scanDeadCodeTool.test.js');

const others = [...srcFiles, ...testFiles, ...(fs.existsSync(appEntry) ? [appEntry] : [])]
  .filter(f => f !== SELF_TEST);

const read = f => fs.readFileSync(f, 'utf8');
const rel = f => path.relative(AGENT, f).replace(/\\/g, '/');
const countIn = (text, name) => (text.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;

// ⚠️ 性能：必须**每份文件只读一次**。第一版把 `read(f)` 写在"每个导出 × 每个文件"的内层循环里，
//    ≈1500 导出 × 600 文件 = 90 万次磁盘读 ⇒ 单次扫描 35 秒（还因此把自检用例顶到 90 秒超时）。
//    缓存之后是秒级。改这个循环时别把 read 挪回内层。
const CONTENT = new Map();
for (const f of others) CONTENT.set(f, read(f));

/**
 * 剥掉注释后的源码 —— **计数一律用这个**。
 *
 * ⚠️ 为什么必须剥注释（本轮踩的坑）：给死导出加"⚠️ 死导出"标注时，注释里会**写出它的名字**，
 *    于是那个名字在文件里出现 2 次 ⇒ 扫描器认为"本文件自己也用了" ⇒ **它从清单里消失**。
 *    结果就是"标一个、少一个"，越标注清单越短（本轮实测 45 → 40 就是这么来的）。
 *    剥掉注释后，"标注"不会影响判定 —— 这正是我们要的：标注是给人看的，不是给扫描器看的。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（`//`，但不误伤 `http://`）
}

const STRIPPED = new Map();
for (const [f, text] of CONTENT) STRIPPED.set(f, stripComments(text));
const contentOf = f => CONTENT.get(f) ?? '';
const strippedOf = f => STRIPPED.get(f) ?? '';

// ── 一、死导出 ────────────────────────────────────────────────────────────
const exportsList = [];
for (const f of srcFiles) {
  const src = read(f);
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    exportsList.push({ file: f, kind: m[1], name: m[2] });
  }
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exportsList.push({ file: f, kind: 'reexport', name });
    }
  }
}

const deadExports = [];
for (const ex of exportsList) {
  if (ex.name === 'default') continue;
  if (/^__/.test(ex.name)) continue;                       // 假阳性 2：测试钩子
  const own = countIn(strippedOf(ex.file), ex.name);        // 剥注释后计数（见 stripComments 的说明）
  if (own > 1) continue;                                    // 本文件内自己也用 ⇒ 导出只是顺手
  let usedElsewhere = 0;
  for (const f of others) {
    if (f === ex.file) continue;
    if (countIn(strippedOf(f), ex.name) > 0) { usedElsewhere++; break; }
  }
  if (usedElsewhere === 0) deadExports.push({ ...ex, rel: rel(ex.file) });
}

// ── 二、死列 ──────────────────────────────────────────────────────────────
const allSrc = others.map(strippedOf).join('\n');
const schemaTables = [];
for (const f of srcFiles) {
  const text = contentOf(f);
  if (!/CREATE\s+TABLE/i.test(text)) continue;
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?\s*\(([\s\S]*?)\n\s*\)/gi;
  for (const m of text.matchAll(re)) {
    const cols = [];
    for (const rawLine of m[2].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;
      if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const cm = /^[`"[]?(\w+)[`"\]]?\s+[A-Za-z]/.exec(line);
      if (cm) cols.push(cm[1]);
    }
    if (cols.length) schemaTables.push({ table: m[1], cols, file: rel(f) });
  }
}

const seenTables = new Set();
const deadColumns = [];
for (const { table, cols, file } of schemaTables) {
  if (seenTables.has(table)) continue;                      // 同表只算一次（迁移里会重复 CREATE）
  seenTables.add(table);
  for (const col of cols) {
    if (countIn(allSrc, col) <= 1) deadColumns.push({ table, column: col, file });
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────────
console.log(`扫描：src ${srcFiles.length} 文件 / test ${testFiles.length} 文件${fs.existsSync(appEntry) ? ' + app.js' : ''}\n`);

console.log(`═══ 一、疑似死导出（${deadExports.length} 个）═══`);
for (const d of deadExports.sort((a, b) => a.rel.localeCompare(b.rel))) {
  console.log(`  ${d.rel}  [${d.kind}] ${d.name}`);
}

console.log(`\n═══ 二、疑似死列（${deadColumns.length} 个）═══`);
for (const d of deadColumns.sort((a, b) => a.table.localeCompare(b.table))) {
  console.log(`  ${d.table}.${d.column}   (schema: ${d.file})`);
}

console.log('\n提醒：以上是**候选**，不是结论。判死前先看：');
console.log('  · 常量表很可能是"文档性常量"（给人与测试看，代码不引用）—— 见文件头 §假阳性 3');
console.log('  · 动态调用（按字符串拼名字）扫不出来');
console.log('  · 结论一律「只标注不删」：改 schema 要迁移，删导出会让脚本作者少一个抓手');
process.exit(0);
