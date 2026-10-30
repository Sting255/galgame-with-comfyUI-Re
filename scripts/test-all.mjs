/**
 * test-all.mjs — **串行**跑后端 + 前端两套全量测试，并给出统一判定（2026-10-19 补）
 *
 *   $ npm test          (在项目根目录)
 *
 * ── 为什么需要它（本仓踩过的两个坑）──────────────────────────────────────
 *
 * **坑 1：两套件并发跑会互相抢资源 ⇒ 假失败。**
 *   R0 收口轮实测：后端 + 前端同时跑，后端报 `2272 tests / 1 fail`
 *   （比正常的 2319 少 47 条，且多出 1 个 fail —— 有长用例撞上 90s 超时被掐）。
 *   串行重跑立刻 `2319 / 0 fail`。**结论：两套件必须串行。**
 *
 * **坑 2：`agent-core` 的隔离靠 `--import ./test/setup.mjs`，漏打就假红/假绿。**
 *   本仓踩过两次（迁移收尾轮 4 个假失败；R0 轮我自己又踩一次）。
 *   本脚本把它**写死**在命令行里，不给人漏打的机会。
 *   （另有 `agent-core/test/setupIsolationGuard.test.js` 兜底：裸跑会直接红。）
 *
 * ── 判定口径（为什么不只看 `# fail`）──────────────────────────────────────
 *
 *   · `fail > 0`  ⇒ 红
 *   · `cancelled > 0` ⇒ **红**。`--test-force-exit` 会掐掉句柄没释放的文件，
 *     摘要照样显示 `0 fail` —— 只看 fail 会漏判"用例根本没跑完"。
 *   · `tests <= 0` ⇒ 红（参数或环境不对，不能当"通过"）
 *   · `tests` 比基准少 ⇒ **黄**（提示可能是并发/资源问题，不直接判红，
 *     因为上游合并本来就会让条数变多；但少了就值得看一眼）
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/test-all.mjs              # 两套都跑
 *   node scripts/test-all.mjs --backend    # 只跑后端
 *   node scripts/test-all.mjs --frontend   # 只跑前端
 *   node scripts/test-all.mjs --baseline   # 跑完顺便打印新的基准数字（便于更新文档）
 *
 * ⚠️ 真库保护：后端一律 `DB_PATH=':memory:'`（脚本里写死，不接受外部覆盖）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ── 基准数字（2026-10-29 实测）────────────────────────────────────────
// 少了只是**黄牌提示**，不判红 —— 上游合并会让条数增长，硬断言会天天误报。
//
// 2290 / 930 是**小镇剥离后**的真实基线。此前写死的 2483 / 1025（2026-10-19 实测）
// 已不可达：两次提交之间删掉了 82 个后端测试文件与 16 个前端测试文件，全部是 town*
// （后端 −193 条、前端 −95 条，逐文件核对过），小镇功能随之移除。
// 基准不跟着改的后果是：每跑一次全量都报「少于基准」，把真异常埋在噪声里。
//
// 前端 930 = 剥离后实测；若后续恢复上游整文件 skip 的那几个测试，需要同步上调。
//
// ⚠️ 后端 skipped 8：
//   5 = 既有（intimateAiEditHttp ×3 / townSevenDay / toyWakeAndImage ②b）
//   3 = 合并时判定 skip（llmOutputTokens ×2、chatImageRagQuery 路径A ×1，各有注释说明）
//   📌 合并前是 23 —— 其中 18 条是「依赖上游 v3.10.0 模块」的守卫测试，
//      合并后模块到位，它们**恢复了正常运行**（本轮的重要正向信号）。
//
// ⚠️ 前端 skipped 11：
//   2 = Hd2dTownRenderer 分包测试（小镇软关后该分包不进产物，见 townGating 说明）
//   9 = 3 个上游测试文件整文件 skip（llmSettings ×4 / momentFrequencySettings ×2 /
//       newspaperOpen ×3），原因统一是「上游测试先到、前端 CONFLICT 批次尚未合并」，
//       详见各文件头注释。前端合并完成后删掉 skip 包装即可恢复。
const BASELINE = {
  backend: 2317,
  frontend: 942,
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m',
}

/**
 * 找仓库自带的 node。
 *
 * ⚠️ 必须用 `runtime/nodejs/node.exe`（v22.18，ABI 127）。
 *    PATH 上是 v25.9.0，用它跑任何 import 了 `better-sqlite3` 的测试
 *    会 `ERR_DLOPEN_FAILED`（原生模块 ABI 不匹配）—— 本仓踩过。
 */
function resolveNode() {
  const bundled = join(ROOT, 'runtime', 'nodejs',
    process.platform === 'win32' ? 'node.exe' : 'node')
  if (existsSync(bundled)) return bundled
  return process.execPath
}

const NODE = resolveNode()

/** 跑一套测试，解析 TAP 摘要 */
function runSuite({ name, cwd, patterns, env = {}, withSetup = false }) {
  const setupArgs = withSetup ? ['--import', './test/setup.mjs'] : []
  const args = [
    '--test', ...setupArgs,
    '--test-concurrency=1',      // 单文件内也串行 —— 与既有门禁口径一致
    '--test-force-exit',
    '--test-timeout=90000',
    ...patterns,
  ]

  console.log(`\n${C.cyan}${'─'.repeat(66)}${C.reset}`)
  console.log(`${C.bold}▶ ${name}${C.reset}  ${C.dim}${cwd}${C.reset}`)
  console.log(`${C.dim}  node ${NODE}${C.reset}`)
  console.log(`${C.dim}  --test ${[...setupArgs, ...patterns].join(' ')}${C.reset}`)
  console.log(`${C.cyan}${'─'.repeat(66)}${C.reset}`)

  const t0 = Date.now()
  const res = spawnSync(NODE, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      // ⚠️ 写死隔离，不给外部覆盖的机会（真库保护是铁律）
      DB_PATH: ':memory:',
      LOG_TO_FILE: 'false',
      ...env,
    },
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(0)

  const out = (res.stdout || '') + (res.stderr || '')
  const num = (k) => {
    const m = new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)
    return m ? Number(m[1]) : -1
  }
  const stats = {
    tests: num('tests'),
    pass: num('pass'),
    fail: num('fail'),
    skipped: Math.max(0, num('skipped')),
    cancelled: Math.max(0, num('cancelled')),
    // 文件级失败（模块加载失败会表现为 `not ok <n> - <文件>`）
    fileLevel: out.split(/\r?\n/).filter((l) => /^not ok \d+ - .*(\.test\.js|\.[jt]s)$/.test(l)),
    notOk: out.split(/\r?\n/).filter((l) => l.startsWith('not ok')).slice(0, 10),
    secs,
    raw: out,
  }
  return stats
}

/** 打印一套结果并给出判定 */
function report({ name, key, stats }) {
  const { tests, pass, fail, skipped, cancelled, secs, fileLevel, notOk } = stats
  const base = BASELINE[key]

  console.log(`\n${C.bold}${name} 结果${C.reset}  ${C.dim}（${secs}s）${C.reset}`)
  console.log(`  tests=${tests}  pass=${pass}  fail=${fail}  skipped=${skipped}  cancelled=${cancelled}`)

  const problems = []
  if (fail > 0) problems.push(`fail=${fail}`)
  if (cancelled > 0) {
    // 这是本仓最容易被漏判的一项：摘要 0 fail 但用例没跑完
    problems.push(`cancelled=${cancelled}（有用例没跑完就被掐掉，不能当绿）`)
  }
  if (tests <= 0) problems.push('tests<=0（没跑起来，参数或环境不对）')

  if (fileLevel.length) {
    console.log(`\n  ${C.red}文件级失败（多半是模块加载不出来 ⇒ 依赖缺失或路径错）${C.reset}`)
    for (const l of fileLevel) console.log(`    ${C.red}${l}${C.reset}`)
  }
  if (notOk.length) {
    console.log(`\n  ${C.dim}失败项（最多列 10 条）${C.reset}`)
    for (const l of notOk) console.log(`    ${l}`)
  }

  if (problems.length) {
    console.log(`\n  ${C.red}✗ ${name} 未通过：${problems.join(' / ')}${C.reset}`)
    return { ok: false, problems }
  }

  // 条数比对（黄牌，不判红）
  const warnings = []
  if (base && tests < base) {
    warnings.push(`tests=${tests} 少于基准 ${base}（差 ${base - tests}）`
      + ` —— 先怀疑并发抢资源或超时掐断，串行复跑一次再定性`)
  }
  if (warnings.length) {
    console.log(`\n  ${C.yellow}⚠ 提示${C.reset}`)
    for (const w of warnings) console.log(`    ${C.yellow}${w}${C.reset}`)
    console.log(`    ${C.dim}（这不是失败，但别直接当绿 —— 先核对差额是删了测试文件，还是被超时掐断）${C.reset}`)
  }

  console.log(`  ${C.green}✓ ${name} 通过${C.reset}`)
  return { ok: true, warnings }
}

// ── main ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const onlyBackend = argv.includes('--backend')
const onlyFrontend = argv.includes('--frontend')
const showBaseline = argv.includes('--baseline')

const suites = []
if (!onlyFrontend) {
  suites.push({
    key: 'backend',
    name: '后端 agent-core',
    cwd: join(ROOT, 'agent-core'),
    patterns: ['test/*.test.js', 'src/services/*.test.js'],
    withSetup: true,   // ⚠️ 不能省：DB 内存库 + 断网 + LLM 死端口 + 素材目录隔离
  })
}
if (!onlyBackend) {
  suites.push({
    key: 'frontend',
    name: '前端 web-ui',
    cwd: join(ROOT, 'web-ui'),
    patterns: ['test/*.test.js'],
    withSetup: false,  // web-ui 没有 setup.mjs；给它传会整片红（门禁脚本注释里记过）
  })
}

console.log(`${C.bold}邻舍 · 全量测试（串行）${C.reset}`)
console.log(`${C.dim}⚠️ 两套件必须串行跑 —— 并发会互相抢资源，制造假失败（R0 轮实测）${C.reset}`)

const results = []
for (const s of suites) {
  const stats = runSuite(s)
  results.push({ ...s, stats, verdict: report({ ...s, stats }) })
}

// ── 总结 ─────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}${'═'.repeat(66)}${C.reset}`)
console.log(`${C.bold}总结${C.reset}`)
for (const r of results) {
  const v = r.verdict
  const mark = v.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
  const extra = v.ok
    ? (v.warnings?.length ? `${C.yellow}(有提示)${C.reset}` : '')
    : `${C.red}${v.problems.join(' / ')}${C.reset}`
  console.log(`  ${mark} ${r.name} ${extra}`)
}

if (showBaseline) {
  console.log(`\n${C.dim}基准数字（用于更新 scripts/test-all.mjs 的 BASELINE）${C.reset}`)
  for (const r of results) {
    console.log(`  ${r.key}: ${r.stats?.tests ?? '?'}`)
  }
}

const allOk = results.every((r) => r.verdict.ok)
console.log(`\n${allOk ? `${C.green}全部通过${C.reset}` : `${C.red}有未通过项${C.reset}`}`)
process.exitCode = allOk ? 0 : 1
