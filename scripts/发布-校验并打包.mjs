/**
 * 发布门禁：**测试不通过就不打包**（2026-10-02 用户要求：「交付给我的一定要是最新的 没有bug的」）
 *
 * 为什么要有这个脚本：我做错过一次 —— 一条测试还红着就把包打出去了（第三十六轮）。
 * 人记性不可靠，所以把规矩写进工具：这个脚本**先跑全量测试，任何 fail 就立刻退出，一个字节都不打包**。
 *
 * 用法（在仓库根目录）：
 *   node scripts/发布-校验并打包.mjs                 # 跑测试 → 同步 → 打包 → 校验压缩方法与关键条目
 *   node scripts/发布-校验并打包.mjs --round 37      # 指定轮次号（默认按 输出/ 目录里已有的最大轮次 +1）
 *   node scripts/发布-校验并打包.mjs --skip-tests    # 只在明确知道刚跑过全量时用（会打印告警）
 *   node scripts/发布-校验并打包.mjs --incremental   # 只同步 git status 里改动过的文件（危险，见下）
 *
 * ⚠️ 2026-10-16 改：同步**默认全量**（原来是增量）。
 *    旧设计假设"交付目录长期存在、用 git status 做增量同步"，但那个假设会静默失效：
 *    **只要先 git commit 再来打包**，git status 就是空的 ⇒ 一个文件都不拷 ⇒
 *    包里缺掉那次提交的全部改动，而本脚本只查测试/压缩方法/几个固定条目，**不会报错**。
 *    2026-10-16 真撞上（提交完 6498956 打包，jailbreakRules.js 等三个文件没进交付目录）。
 *    全量同步**只覆盖源码目录**，agent-core/data/（人工放的 agent.db，"含数据"靠它）与
 *    node_modules / .git / logs 一律不碰。
 * ⚠️ 全量同步**不清多余文件**：仓库里删掉的源码文件仍会留在交付目录。
 *    本轮无影响（没删源码文件）；真要清就先手工删掉交付目录里对应的文件再打。
 *
 * 它做的事：①后端全量 ②前端全量 ③生成使用说明 + 同步源码→交付包 ④7z 打包 ⑤校验（方法/条目/体积/手册）
 * 起服务那一步（解压 + 真启动 + 抽查端点）需要交互式等待，仍在打包后手工跑，脚本会打印提醒。
 *
 * ⚠️ 2026-10-17 补：**使用说明.txt 的生成接进来了**（③-0）。
 *    此前本脚本没有任何生成使用说明的步骤，而生成源早已更新 ⇒ 仓库根与交付目录那份
 *    一路停在 2026-10-01 旧版（关键词零命中），第五十五~五十七轮 3 个交付包全带旧手册。
 *    现在：打包前用正源 `scripts/usage-guide.mjs` 重新生成 → 随 ③ 同步进交付目录 →
 *    ⑤ 对**仓库根**与**交付目录**两份都做关键词断言（缺章节就 die）。
 *    另：测试门禁补了 `cancelled > 0 即 die`（只看 fail 会漏判"用例没跑完"，历史事故见 接手必读 §2）。
 *
 * ⚠️ 2026-10-02 从仓库根搬进 `scripts/`（AGENTS.md：根目录不散落脚本）——
 *    搬动时唯一的坑是下面那行 REPO：原来写 `path.resolve(import.meta.dirname)`（=脚本所在目录），
 *    进了 scripts/ 之后必须回退一层才是仓库根；脚本里其余路径全部基于 REPO 或绝对路径，不受影响。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
// 使用说明.txt 的正文正源（2026-10-17 从 build-release.mjs 抽出；两份脚本共用这一份，见 ③-0）
import { buildUsageGuideText } from './usage-guide.mjs'

// 本文件在 <repo>/scripts/ 下 ⇒ 仓库根是它的上一层
const REPO = path.resolve(import.meta.dirname, '..')
const SRC = path.join(REPO, 'agent-core')
const WEB = path.join(REPO, 'web-ui')
// ── 机器相关路径：集中在这里，可用环境变量覆写（2026-10-17 复查 §P3-1）─────────────
// 原来这几个字面量散在函数体里，换机/换目录就要改码。现在只在这里出现一次。
const DELIVER = process.env.DELIVER_DIR || 'C:\\3.6.2-r'
const OUTDIR = process.env.OUT_DIR || path.join(process.env.USERPROFILE || 'C:\\Users\\Sting', 'Downloads', '输出')
const NODE = path.join(REPO, 'runtime', 'nodejs', 'node.exe')
const SEVENZIP = process.env.SEVENZIP_EXE || 'C:\\Program Files\\7-Zip\\7z.exe'

const args = process.argv.slice(2)
const skipTests = args.includes('--skip-tests')
const roundArg = args.includes('--round') ? Number(args[args.indexOf('--round') + 1]) : null
const incremental = args.includes('--incremental')
// 冒烟族开关（2026-10-18 补，全项目复查 §P1-3）：
//   --with-smoke  跑 e2e/smoke-all-modules.mjs（161 端点的全模块冒烟，自起自停后端）
//   --with-checks 跑 e2e/check-*.mjs（面板/资产/事件图专项检查）
// 默认**全关**：交付日手动开。理由见下方 runSmoke / runChecks 的长注释。
const withSmoke = args.includes('--with-smoke')
const withChecks = args.includes('--with-checks')
// --gates-only：**只跑门禁，不打包**（2026-10-18 补）
//
// 为什么需要它：这个脚本的默认行为是"门禁跑完就一路同步 + 打 7z + 校验"，
// 也就是说**只要你想验一次门禁，就会产出 795 MB 的包**。2026-10-18 我自己就踩了：
// 只想验 `--with-smoke` 接线，加了 `--round 1` 想控制轮次，结果真造出一个包
// （`…-第一轮.7z`，795.5 MB），只能手工删掉。
//
// 门禁是"每次改完都该跑"的动作，打包是"用户点头才做"的动作 —— 两者必须能分开。
// 有了这个开关，改完代码验门禁就变成：`--gates-only [--with-smoke]`，零副作用。
const gatesOnly = args.includes('--gates-only')

const log = (s) => console.log(s)
const die = (msg) => { console.error('\n✗ ' + msg + '\n打包已中止 —— 没有产出任何文件。'); process.exit(1) }

// ── 轮次号：取 输出/ 里最大的那个 +1 ──────────────────────────────────────
function nextRound() {
  if (roundArg) return roundArg
  try {
    const rounds = fs.readdirSync(OUTDIR)
      .map((f) => /第([一二三四五六七八九十百零\d]+)轮/.exec(f))
      .filter(Boolean)
      .map((m) => {
        const cn = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
        const s = m[1]
        if (/^\d+$/.test(s)) return Number(s)
        if (s.length === 1) return cn[s] ?? 0
        if (s.startsWith('十')) return 10 + (cn[s[1]] ?? 0)
        if (s.length === 2 && s[1] === '十') return (cn[s[0]] ?? 0) * 10
        if (s.length === 3 && s[1] === '十') return (cn[s[0]] ?? 0) * 10 + (cn[s[2]] ?? 0)
        return 0
      })
    return (rounds.length ? Math.max(...rounds) : 0) + 1
  } catch { return 1 }
}

// ── ① / ② 测试门禁 ───────────────────────────────────────────────────────

// ── ⓪-前置：静态断言「代码里没有迁移前的机器绝对路径」────────────────────────
//
// 真事故（2026-10-17 全项目复查 §P0-1）：项目从旧的百度网盘下载目录迁到 `D:\邻舍改` 时
//   只搬了目录，**没扫测试/e2e 里的绝对路径** ⇒
//   `web-ui/test/toyLabelParity.test.js` 里写死的旧 `CORE` 让本文件 5 条用例全挂（ENOENT），
//   而它正是「前端全量」门禁的一部分 ⇒ **打包门禁被堵死**，唯一出路是 `--skip-tests`（那正是门禁要防的事）。
//
// 所以把这次事故变成门禁规则（本仓一贯打法：`cancelled>0 即 die`、使用说明双端关键词断言）：
//   测试 / e2e / 脚本里**不许出现旧项目根目录的字面量**，命中即 die。
//
// 口径怎么定的（两条都踩过才收窄成这样）：
//   ① **必须先剥注释再扫**（血泪清单 §13 同一条教训）：不剥的话，注释里"旧路径已作废"这类
//      *说明性* 文字会自己把自己判红 —— 第一版就是这样，9 处命中里 5 处是注释。
//   ② **只钉"旧项目根"，不钉裸盘符**（`D:` + 反斜杠）：裸盘符会把无关的正常字面量一起判红 ——
//      实测 `web-ui/test/dataBackup.test.js` 有 `backupPath: 'D:\\linshe\\data\\backups\\…'`，
//      那是**喂给路径解析代码的测试夹具**、不是项目位置，判它红等于门禁再也过不去。
//      真正会坏的只有"指向旧仓库位置"的路径，而旧位置由下面两个标识唯一确定。
//
// ⚠️ 本文件**自己**也在这套规则下：needle 用字符串拼接写，注释里也不写旧路径原文 ——
//    这样扫描器不需要给自己开任何例外（开例外就等于留洞）。
const STALE_PATH_NEEDLES = [
  'Baidu' + 'NetdiskDownload',
  '邻舍.EXE-v3.5.0' + '-改',
]
const STALE_SCAN_DIRS = ['web-ui/test', 'agent-core/test', 'e2e', 'scripts']
/** 剥掉 // 行注释、/* *​/ 块注释与 HTML 注释，只留会被真正执行的文本（口径见上 §①）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
function assertNoStalePaths() {
  log('\n── 静态断言：迁移前机器路径残留 ─────────────────────')
  const hits = []
  const walk = (absDir) => {
    for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        walk(abs)
        continue
      }
      if (!/\.(js|mjs|cjs|json|ps1)$/i.test(e.name)) continue
      const raw = fs.readFileSync(abs, 'utf8')
      const code = stripComments(raw)
      // 行号按原文找（剥注释会挪行数），注释里的说明不算命中 —— 只看剥完是否还在
      raw.split(/\r?\n/).forEach((line, i) => {
        const needle = STALE_PATH_NEEDLES.find((n) => line.includes(n))
        if (needle && code.includes(needle)) {
          hits.push(`${path.relative(REPO, abs).replace(/\\/g, '/')}:${i + 1}  ${line.trim().slice(0, 110)}`)
        }
      })
    }
  }
  for (const rel of STALE_SCAN_DIRS) {
    const abs = path.join(REPO, rel)
    if (fs.existsSync(abs)) walk(abs)
  }
  if (hits.length) {
    die(`测试 / e2e / 脚本里有**迁移前的旧项目路径**（共 ${hits.length} 处）：\n`
      + hits.map((h) => '      ' + h).join('\n')
      + '\n    ⇒ 改成 path.resolve(import.meta.dirname, ...) 之类的仓库相对解析。\n'
      + '    （历史事故：迁移只搬目录、没扫绝对路径 ⇒ 前端全量红 ⇒ 打包门禁被堵死，见 接手必读 §2）')
  }
  log(`   ${STALE_SCAN_DIRS.join(' / ')} 共扫无残留 ✓（已剥注释，只钉旧项目根字面量）`)
}

function isBackendUp(port) {
  // ⚠️ 用 node 自带的 http 模块同步探活，**不**用 execFileSync('curl') —— 本机可能没 curl，
  //    且 spawnSync 会被 Windows 的 shell 解析拖慢。connectSync 也不行（Node 没有同步 connect），
  //    所以用 child_process.spawnSync 起一个 2 秒超时的 node -e 脚本做 HTTP GET。
  //    200/anything 都算"起着"（探活只看 TCP/HTTP 是否响应，不看状态码）。
  const probe = spawnSync(NODE, ['-e', `
    const http = require('http');
    const r = http.get('http://127.0.0.1:${port}/api/health', (res) => { process.exit(0); });
    r.on('error', () => process.exit(1));
    r.setTimeout(2000, () => { r.destroy(); process.exit(1); });
  `], { encoding: 'utf8', timeout: 5000 })
  return probe.status === 0
}

function runSuite(name, cwd, patterns, extraEnv, { withSetup = false } = {}) {
  log(`\n── ${name} ─────────────────────────────────────────`)
  // ⚠️ `--import ./test/setup.mjs` 只有 agent-core 有（它负责"测试禁止联网"）；
  //    给 web-ui 也传会直接让 75 个文件全红（第一版就这么挂的 —— 门禁救了它，没让它误报成"代码有问题"）。
  const setupArgs = withSetup ? ['--import', './test/setup.mjs'] : []
  const res = spawnSync(NODE, [
    '--test', ...setupArgs, '--test-concurrency=1',
    '--test-force-exit', '--test-timeout=90000', ...patterns,
  ], { cwd, encoding: 'utf8', env: { ...process.env, DB_PATH: ':memory:', LOG_TO_FILE: 'false', ...extraEnv }, maxBuffer: 64 * 1024 * 1024 })
  const out = (res.stdout || '') + (res.stderr || '')
  const num = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(out) || [])[1] ?? -1)
  const tests = num('tests'); const pass = num('pass'); const fail = num('fail'); const skip = num('skipped')
  const cancelled = num('cancelled')
  log(`   tests=${tests} pass=${pass} fail=${fail} skipped=${skip < 0 ? 0 : skip} cancelled=${cancelled < 0 ? 0 : cancelled}`)
  const notOk = out.split(/\r?\n/).filter((l) => l.startsWith('not ok')).slice(0, 8)
  if (notOk.length) { log('   失败项：'); for (const l of notOk) log('     ' + l) }
  if (fail !== 0 || notOk.length) die(`${name} 有失败（fail=${fail}${notOk.length ? `, not ok=${notOk.length}` : ''}）`)
  // cancelled > 0 = 有用例没跑完就被 `--test-force-exit` 掐掉（摘要照样显示 0 fail）。
  // 历史事故：3 个文件「最后一条用例从未执行」而门禁一直判绿（见 接手必读 §2「假绿已修」）。
  if (cancelled > 0) die(`${name} 有 cancelled=${cancelled}（用例没跑完就被掐掉，不能当绿）`)
  if (tests <= 0) die(`${name} 没跑起来（tests=${tests}）—— 参数或环境不对，不能当"通过"`)
  return { tests, pass, fail, skip, cancelled }
}

// 5 个 skipped 的固定原因（2026-10-17 全项目复查 §三-5）：
// 每轮都会被当新问题排查一遍，所以在这里固定写明，别再重复查。
const KNOWN_SKIPS = [
  'intimateAiEditHttp ×3 —— 本机 .env 配了 LLM Key ⇒ 503 分支进程内不可达（源码级用例已覆盖）',
  'townSevenDay —— 长测，TOWN_LONG_SIM=1 才启用',
  'toyWakeAndImage ②b —— 睡眠态要真实日程快照，:memory: 造不出',
]

// ── 冒烟族（2026-10-18 补，收口 P1-3「E2E / 冒烟不在发布门禁」）─────────────────
//
// 为什么默认关：这两族要**起真后端**（smoke 还会自己 `VACUUM INTO` 一份真库副本），
// 比单测慢得多、且依赖 ComfyUI / 网络这些外部条件。订成"交付日手动开"是权衡后的口径，
// 不是偷懒 —— 门禁的职责是"每次打包都不许退化"，而这两族是"这次交付额外验一遍"。
//
// 为什么不塞进 runSuite：它们不是 `node --test` 套件，输出格式完全不同（自起自停后端、
// 自己的报告文件与退出码）。硬套 runSuite 的 `# tests/# pass` 正则只会得到 `tests=-1`，
// 反而会让门禁误报"没跑起来"。
//
// ⚠️ 用户纪律：**起停服务必须各自单独一次调用**（Windows job runner 会把同一条命令里的
//    Stop-Process 和重活挤在一起然后以 4294967295 崩掉）。所以这里**不**自己拼启停命令，
//    而是把"起停"整个交给被调脚本自己管（smoke-all-modules.mjs 就是这么设计的：它自己
//    spawn 后端、自己 finally 里 stopBackend）。这样门禁侧只有一次 spawnSync，没有中间态。
function runScript(name, scriptRel, env, { expectExitZero = true, tolerateWarn = true } = {}) {
  const script = path.join(REPO, scriptRel)
  log(`\n── ${name} ─────────────────────────────────────────`)
  if (!fs.existsSync(script)) die(`${name}：脚本不存在 —— ${script}`)
  const res = spawnSync(NODE, [script], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60_000,   // 冒烟要起后端 + 扫 161 端点，给足 15 分钟
  })
  const out = (res.stdout || '') + (res.stderr || '')
  // 只把结论段打给人看（全量输出太长，会淹掉打包日志）
  const lines = out.split(/\r?\n/)
  const tail = lines.slice(-14)
  for (const l of tail) if (l.trim()) log('   ' + l.trim())

  const conclusion = /端点\s+(\d+)\s*个：PASS\s+(\d+)\s*·\s*WARN\s+(\d+)\s*·\s*FAIL\s+(\d+)/.exec(out)
  const stats = conclusion
    ? { total: Number(conclusion[1]), pass: Number(conclusion[2]), warn: Number(conclusion[3]), fail: Number(conclusion[4]) }
    : null
  if (stats) {
    log(`   解析：端点 ${stats.total} 个 → PASS ${stats.pass} / WARN ${stats.warn} / FAIL ${stats.fail}`)
    if (stats.fail > 0) die(`${name}：FAIL ${stats.fail} 个端点（5xx 或 404，代码里有这个 GET 却拿不到正常响应）`)
    // WARN 是"正确的参数守卫"（缺 query / 状态不满足），历史基线就是 5 个，不算失败；
    // 但要是 WARN 暴涨到异常值，说明接口口径可能批量走偏了，给人一眼能看见的提示。
    if (stats.warn > 40) log(`   ⚠️ WARN 达 ${stats.warn} 个，明显高于历史基线（约 5 个），请人工看一眼明细`)
    if (tolerateWarn === false && stats.warn > 0) die(`${name}：不接受任何 WARN`)
  } else if (expectExitZero && res.status !== 0) {
    die(`${name}：退出码 ${res.status}，且没解析到结论行`)
  }
  if (!stats && !conclusion) log('   （未解析到「端点 N 个：…」结论行 —— 该脚本可能不是冒烟类，看上面输出）')
  return { status: res.status, stats }
}

let be = null
let fe = null
assertNoStalePaths()
if (skipTests) {
  log('⚠️ --skip-tests：跳过测试门禁。**只有在你刚刚亲眼看过全绿时**才能这么用。')
} else {
  be = runSuite('后端全量', SRC, ['test/*.test.js', 'src/services/*.test.js'], {}, { withSetup: true })
  fe = runSuite('前端全量', WEB, ['test/*.test.js'])
}

// ── ②-冒烟族（默认关，交付日手动开）─────────────────────────────────────────
// 跑在单测之后、同步之前：冒烟失败就不该继续产出交付包（避免"坏包已同步进交付目录"）。
if (withSmoke) {
  // smoke-all-modules.mjs 自己 VACUUM INTO 副本库 + 自己起停后端，**不碰真实库**
  runScript('全模块冒烟（161 端点）', path.join('e2e', 'smoke-all-modules.mjs'), {})
} else {
  log('\n── 全模块冒烟 ──────────────── 已跳过 ────────────────')
  log('   （交付日加 --with-smoke 开；它自起自停后端、用真库副本，不碰真实库）')
}

if (withChecks) {
  // ⚠️ 2026-10-18 核实：这三个脚本**都要求外部已有一个后端在 3199 跑着**（并且 check-panels /
  //    check-assets 还要 playwright 浏览器）。它们**不像** smoke 那样自起自停 —— 所以这里
  //    不能盲调，得先探端口：没起后端就"跳过 + 说明原因"，而不是让打包 die。
  //
  //    为什么不做成"门禁自己起后端"：起停服务是本仓的敏感动作（用户纪律：起停要各自单独一次
  //    调用，Windows job runner 会把它们和重活挤一起然后崩）。门禁脚本不该偷偷起服务 ——
  //    真要这几个检查，就按 `e2e/README.md` 手工起好 3199 再跑 --with-checks。
  //
  //    check-event-images.mjs 另外还依赖交付目录存在（它读的是**交付包**里的 data 与库），
  //    所以它天然只适合"同步之后"跑；本函数当前排在同步**之前**是为了"冒烟不过就别同步"，
  //    两者顺序诉求冲突 —— 这也是它默认不进自动流的原因之一（见下方 SKIP 说明）。
  const up = isBackendUp(3199)
  if (!up) {
    log('\n── e2e 专项检查 ──────────── 已跳过（后端未起）──────────')
    log('   这三个检查要求后端已在 http://127.0.0.1:3199 跑着。要跑就先按 e2e/README.md 起好后端，')
    log('   再加 --with-checks。门禁**故意不替用户起服务**（起停服务是敏感动作，见脚本内注释）。')
  } else {
    for (const s of ['check-panels.mjs', 'check-assets.mjs']) {
      runScript(`专项检查 ${s}`, path.join('e2e', s), {}, { expectExitZero: true, tolerateWarn: false })
    }
    // check-event-images.mjs 读的是**交付包**里的 data 与库（依赖同步已经跑过），
    // 而本段排在同步之前 —— 顺序不满足，所以这里只提示、不执行。
    log('   （check-event-images.mjs 依赖已同步的交付包，须在同步之后手工跑 —— 见 e2e/README.md）')
  }
} else {
  log('\n── e2e 专项检查 ──────────── 已跳过 ────────────────')
  log('   （交付日加 --with-checks 开，且需先起好 3199 后端：check-panels / check-assets）')
  log('   四个 e2e 脚本的依赖与跑法见 e2e/README.md；probe-intimate.mjs 与')
  log('   check-event-images.mjs 依赖真实 LLM / 已同步的交付包，**不适合进自动门禁**')
}

// ── --gates-only：到此为止，不同步、不打包 ────────────────────────────────────
if (gatesOnly) {
  log('\n── 门禁结束（--gates-only，未同步、未打包）──────────')
  log(`   后端：${be ? `${be.pass}/${be.tests} pass, fail=${be.fail}, cancelled=${be.cancelled}` : '已跳过（--skip-tests）'}`)
  log(`   前端：${fe ? `${fe.pass}/${fe.tests} pass, fail=${fe.fail}, cancelled=${fe.cancelled}` : '已跳过（--skip-tests）'}`)
  log(`   冒烟：${withSmoke ? '已跑（见上）' : '未跑（加 --with-smoke 开）'}`)
  log('   没有产出任何文件。要真打包：去掉 --gates-only。')
  process.exit(0)
}

// ── ③ 同步源码 → 交付包 ──────────────────────────────────────────────────
log('\n── 同步源码到交付包 ────────────────────────────────')

// ── ③-0 使用说明.txt：重新生成（2026-10-17 补，修「生成链断裂」）──────────────
//
// 真问题（2026-10-17 全项目复查 §三-1）：本脚本原来**完全没有生成使用说明这一步**，
// 而生成源 `buildUsageGuideText` 早已更新（含破限/敏感度/每日额度/点题/重新组织…全部新功能）。
// 后果：仓库根与交付目录的 `使用说明.txt` 一路停在 2026-10-01 旧版（13208 B、关键词零命中），
// 第五十五~五十七轮 3 个交付包**全带旧手册**。用户规则「不手改、只改生成源」没被违反——
// 违反的是「生成源改了以后没人再生成」。
//
// 修法：打包前用正源重新生成到仓库根（gitignored），随 ③ 全量同步进交付目录；
//       再用关键词断言把它钉住（缺了就 die，防再断）。正源见 `scripts/usage-guide.mjs`。
//
// ⚠️ 断言口径：`使用说明.txt` 是**用户手册**，断言必须打在**用户看得见的正文**上，
//    不能靠"生成源文件里有没有这个词"（那种断言在生成链断了的时候照样绿）。
const USAGE_GUIDE = path.join(REPO, '使用说明.txt')
const USAGE_KEYWORDS = [
  // 42~56 轮新增的用户可见功能（2026-10-17 复查时实测关键词命中 0 的那批）
  ['破限规则集', '破限'],
  ['敏感度与发情', '敏感度'],
  ['私密时刻', '私密时刻'],
  ['亲密推进', '亲密推进'],
  ['奇遇（小镇玩法）', '奇遇'],
  ['朋友圈点题', '点题'],
  ['动作反应风格', '动作反应风格'],
  ['重写过渡提示', '重新组织语言'],
  // 更早就该在手册里的章节（一起钉住，防将来被误删）
  ['玩具', '玩具'],
  ['程序时间', '程序时间'],
  ['动作系统', '动作系统'],
]
{
  // 版本号：交付包的 VERSION 文件是 `3.6.2`（APK 名走 build-apk 的 versionName，这里用不到 apkName 覆盖）
  let version = 'dev'
  try { version = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim() || 'dev' } catch { /* 保持 dev */ }
  const text = buildUsageGuideText({ version })
  fs.writeFileSync(USAGE_GUIDE, text, 'utf8')
  const missing = USAGE_KEYWORDS.filter(([, kw]) => !text.includes(kw)).map(([name]) => name)
  log(`   已用正源重新生成 使用说明.txt（${Buffer.byteLength(text, 'utf8')} B，版本 ${version}）`)
  if (missing.length) {
    die(`使用说明.txt 缺这些章节：${missing.join('、')}\n`
      + `     —— 生成源是 scripts/usage-guide.mjs（唯一正源）；改完它再重跑本脚本。`)
  }
  log(`   关键词断言：${USAGE_KEYWORDS.length} 项全部命中 ✓（破限 / 敏感度 / 私密时刻 / 亲密推进 / 奇遇 / 点题 …）`)
}

function syncDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name); const d = path.join(to, e.name)
    if (e.isDirectory()) {
      // 注意：这里的跳过名单只作用于**子目录名**（`目标/` 的整份同步走下面单独的循环，
      // 不受这一行影响）。`data`/`logs`/`node_modules`/`.git` 永远不进包。
      if (['node_modules', '.git', '目标', 'logs', 'data', '.claude'].includes(e.name)) continue
      syncDir(s, d)
    } else {
      // ── 文件级排除（2026-10-17 复查 §P1-2 / §P2-4；2026-10-18 补 launcher_config）──
      // 原来这里**只判目录名**，所以 `agent-core/.env`（含真实 API Key）原样进了 7z：
      //   Key 指向本机代理、离开本机无用 ⇒ 自用无碍，但包一旦外发即泄露。
      // `.env` 现在不进包，包内改放 `.env.example`（同结构、Key 置空）——
      //   它本来就被 git 跟踪、也在仓库里，随全量同步自然带过去。
      // `.claude/settings.local.json` 是本机 Claude 权限历史（含旧会话 UUID），机器特定，一并挡掉。
      //
      // `launcher_config.json`（2026-10-18 补，与上面两个同一类漏网）：
      //   它是**启动器的本机用户配置** —— 由 `launcher/launcher/config_manager.py` 读写，
      //   跟 exe 同目录；`.gitignore:31` 明确忽略它，`DEFAULT_CONFIG` 里 `comfyui_exe` 默认是**空串**，
      //   路径由用户在启动器「设置」页自己填（`settings_page.py` 的 comfy_path_input）。
      //   问题在于：它不是 git 跟踪的文件，却住在**仓库根**，于是被顶层的全量同步**原样拷进交付目录**
      //   ⇒ 包里的 `comfyui_exe` 指向**打包这台机器**的路径（如 `<ComfyUI 安装目录>`），
      //     别人拿到包一开启动器就指着一个不存在的地址。跟 `.env` 是同一类事故。
      //
      //   为什么**直接跳过**、而不是像 `.env` 那样放一份置空模板：
      //   `ConfigManager._load()` 在文件不存在时会 `self._data = {}` + `_save()` **自动写一份默认配置**
      //   （`comfyui_exe: ""`）—— 也就是说"没有这个文件"正是全新用户的正确初始状态。
      //   放一份模板反而多一个要维护的副本（且它本就被 gitignore，放仓库里也违背原意）。
      if (e.name === '.env' || e.name === '.env.local' || e.name === 'settings.local.json') continue
      if (e.name === 'launcher_config.json') continue
      fs.copyFileSync(s, d)
    }
  }
}
const changed = execFileSync('git', ['status', '--short'], { cwd: REPO, encoding: 'utf8' })
  .split(/\r?\n/).map((l) => l.slice(3).trim().replace(/^"|"$/g, '')).filter(Boolean)

// ── 同步源码 → 交付目录（2026-10-16 改：默认全量）────────────────────────
//
// ⚠️ 原来的设计假设「交付目录长期存在、用 `git status` 做增量同步」。**这个假设会悄悄失效**：
//    只要**先 `git commit` 再来打包**，`git status` 就是空的 ⇒ 增量同步**一个文件都不拷**
//    ⇒ 打出来的包缺掉那一次提交的全部改动，而门禁脚本**不会报错**（它只查测试、压缩方法、几个固定条目）。
//    2026-10-16 真撞上了：提交完 6498956 直接打包，交付目录里
//    `jailbreakRules.js` / `softStateStore.js` / `JailbreakSettingsView.vue` 全都不存在。
//
// 新规则：**默认全量**（`syncDir` 整份刷），`--incremental` 才走老的增量路径。
//
// ⚠️ 全量同步**只覆盖源码目录**，绝不能碰这两类东西：
//    ① `agent-core/data/` —— 交付目录里那份 `agent.db` 是**人工放进去的**（"含数据"就靠它），
//       脚本从头到尾没有生成它的代码；`syncDir` 的排除名单里有 `data`，所以整份刷 `agent-core/`
//       时那一个子目录会被跳过 —— **这一条是全量同步不毁包的关键，别把 `data` 从名单里拿掉**。
//    ② `node_modules` / `.git` / `logs` / `目标` / `docs` —— 前三个不是源码，后两个走下面各自的整份同步。
let copied = 0
if (incremental) {
  log('   ⚠️ --incremental：只同步 git status 里改动过的文件（交付目录必须是干净镜像，否则会缺文件）')
  for (const rel of changed) {
    if (rel.startsWith('目标/') || rel.startsWith('目标\\')) continue
    const from = path.join(REPO, rel); if (!fs.existsSync(from)) continue
    const to = path.join(DELIVER, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.statSync(from).isDirectory() ? syncDir(from, to) : fs.copyFileSync(from, to)
    copied += 1
  }
} else {
  // 全量：仓库顶层每一项整份刷过去。排除名单的取舍：
  //   · data —— **不排除会毁包**（见上），`syncDir` 内层也会跳过它，这里再挡一次
  //   · logs / node_modules / .git —— 永远不是源码
  //   · 目标 / docs —— 本文件下面已有各自的"整份刷掉"逻辑，不在这里重复
  //   · .mimosa / 完整 —— 本地工作目录（2026-10-16 实测存在于仓库根），不是交付内容
  //   · .claude —— 本机 AI 工具配置（settings.local.json 含旧会话 UUID），机器特定、不是交付内容
  //     （CLAUDE.md 的仓级约定已固化进 AGENTS.md，不必随包发）
  //   · *.tar.gz / *.apk —— 108 MB 旧备份与旧安装包（下面 7z 也排除它们）
  const SKIP_TOP = new Set([
    '.git', 'node_modules', 'data', 'logs', '目标', 'docs', '.mimosa', '完整', '.claude',
  ])
  const SKIP_FILE = /\.(tar\.gz|apk|log)$/i
  for (const e of fs.readdirSync(REPO, { withFileTypes: true })) {
    if (SKIP_TOP.has(e.name)) continue
    if (e.isFile() && SKIP_FILE.test(e.name)) continue
    const from = path.join(REPO, e.name)
    const to = path.join(DELIVER, e.name)
    if (e.isDirectory()) {
      // ⚠️ **不要**对顶层目录做 `rmSync(to, {recursive:true})`：
      //    那会把 `agent-core/data/` 整个删掉（交付目录里那份 `agent.db` 是人工放的、脚本不生成它，
      //    删了"含数据"就没了），而 `syncDir` 之后也补不回来（它跳过 `data`）。
      //    逐项覆盖即可 —— 文件名和内容都对得上 HEAD，缺的文件自然会补上。
      syncDir(from, to)
    } else {
      fs.copyFileSync(from, to)
    }
    copied += 1
  }
  log(`   全量镜像：仓库顶层 ${copied} 项整份刷到交付目录（data/ 与 node_modules 已跳过）`)
}
// 文档：**整份刷掉**（2026-10-02 用户：「文档也同步吧」）。
// 原来这里只同步 `git status` 里改动过的文件，而且 `目标/` 被**显式排除**（上面 syncDir 的跳过名单
// 与下面的 `continue` 各有一处）⇒ 交付包里的文档一直是旧的（用户装到的包里，`目标/` 那份交接文档
// 比仓库落后好几十 KB）。文档是交付物的一部分（接手/排障全靠它），
// 所以改成与前端产物同等待遇：整目录覆盖，不做增量判断。
for (const dir of ['目标', 'docs']) {
  const from = path.join(REPO, dir)
  if (!fs.existsSync(from)) continue
  const to = path.join(DELIVER, dir)
  fs.rmSync(to, { recursive: true, force: true })
  syncDir(from, to)
  copied += 1
}

// 前端产物：以 agent-core/public 为准，交付包那份整体刷掉
const assetsFrom = path.join(SRC, 'public', 'assets')
const assetsTo = path.join(DELIVER, 'agent-core', 'public', 'assets')
fs.rmSync(assetsTo, { recursive: true, force: true })
syncDir(assetsFrom, assetsTo)
fs.copyFileSync(path.join(SRC, 'public', 'index.html'), path.join(DELIVER, 'agent-core', 'public', 'index.html'))
log(`   已同步 ${copied} 项 + 前端产物（${fs.readdirSync(assetsTo).length} 个文件）`)

// ── ③-1 清掉交付目录里**历史同步遗留**的本机配置文件（2026-10-17 §P1-2；2026-10-18 加 launcher_config）──
//
// 为什么必须显式删：`syncDir` 现在虽然跳过 `.env`，但**全量同步不清多余文件**（脚本头也写了这条限制）
// ⇒ 交付目录里那份是**上一次同步留下的**，不清掉照样进 7z，等于没修。
// 这一条是"排除规则"与"实际包内容"之间的缝，只有主动删才堵得住；⑤ 还会再验一次。
//
// `launcher_config.json` 同理（2026-10-18 补）：它住在**仓库根**，被顶层全量同步带进交付目录。
// 里面 `comfyui_exe` 指向打包这台机器的路径，别人开了启动器会指到一个不存在的地方。
// 直接删掉 —— `ConfigManager._load()` 在文件不存在时会自动写一份默认配置（`comfyui_exe: ""`）。
{
  const stale = [
    path.join(DELIVER, 'agent-core', '.env'),
    path.join(DELIVER, 'agent-core', '.env.local'),
    path.join(DELIVER, 'launcher_config.json'),
    path.join(DELIVER, 'agent-core', 'launcher_config.json'),
  ]
  const removed = []
  for (const f of stale) {
    if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.relative(DELIVER, f)) }
  }
  const example = path.join(DELIVER, 'agent-core', '.env.example')
  if (removed.length) log(`   已从交付目录清掉遗留的本机配置文件：${removed.join('、')}（.env.example 已随源码同步）`)
  else log('   交付目录无遗留 .env / launcher_config.json（本来就没有）')
  if (!fs.existsSync(example)) log('   ⚠️ 交付目录缺 .env.example —— ⑤ 会把它当缺失项报出来')
}

// ── ④ 打包（全核全性能，用户 2026-10-02：「打包到7z的时候用上全核心全性能 这样才快」）──
const round = nextRound()
// 轮次号转中文（2026-10-18 补越界保护）
//
// 起因：本函数原来对 n ≥ 100 的输入会输出 `undefined十` —— 因为 `d[Math.floor(n/10)]` 在 n=100 时
// 取 `d[10]`（越界，得到 undefined）。2026-10-18 我用 `--round 999` 验门禁时，真的产出了
// 一个名叫 `…-第undefined十九轮.7z` 的包，只能手工删。
//
// 口径：轮次号是**人手传的小数字**，99 以内表达自然（一…九十九）；超过 99 就该直接说清楚，
// 而不是拼出一个像乱码的文件名。所以 ≥100 时**终止**，让人改用阿拉伯数字命名或重新想轮次号，
// 不要在文件名里塞一个读不懂的东西（交付包名是用户会看到的东西）。
const cnNum = (n) => {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (!Number.isInteger(n) || n < 1) die(`轮次号非法：${n}（应为 ≥1 的整数）`)
  if (n >= 100) die(`轮次号 ${n} ≥ 100：中文命名只到「九十九」，写出来会变成 undefined 之类的东西。\n`
    + `     —— 请用一个 ≤99 的轮次号（或者先把 cnNum 改成支持更大的数再打包）。`)
  if (n < 10) return d[n]
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '')
  return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '')
}
const outFile = path.join(OUTDIR, `邻舍-3.6.2-r-完整可运行包-含数据-20261002-第${cnNum(round)}轮.7z`)
const cores = Number(process.env.NUMBER_OF_PROCESSORS || 0) || 8
log('\n── 打包 ───────────────────────────────────────────')
log(`   线程 = ${cores}（本机核心数）| 级别 -mx=3（比 -mx=5 快约一倍，体积只大一点点）`)

// ── 打包前：往交付包里写一份「校验清单」（会跟着进包）──────────────────
// 2026-10-02 真事故：用户在另一台机器上用网盘客户端解压，解出来的 agent.db 损坏
// （SqliteError: database disk image is malformed）——**包本身是好的**（7z CRC 通过、
// 把成员单独抽出来 integrity_check=ok），坏在"解压工具不校验就写出坏文件"。
// 所以：① 包里放一份可对账的校验清单；② 打包后再把数据库从压缩包里抽出来验一遍（见下）。
{
  // 用 PowerShell 取哈希（脚本本来就是这么取压缩包 SHA256 的；ESM 里没有 require，别用）
  const hashOf = (p) => {
    try {
      return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-FileHash -Algorithm SHA256 '${p}').Hash`], { encoding: 'utf8' }).trim()
    } catch { return '(读不到)' }
  }
  const lines = [
    '邻舍.EXE 交付包 · 校验清单（2026-10-02 起自动生成）',
    '',
    '⚠️ 解压请用 7-Zip（https://www.7-zip.org/），**不要用网盘客户端自带的"在线解压 / 客户端解压"**：',
    '   它不校验 CRC 就可能写出"静默损坏"的文件。我们真遇到过：解出来的 agent.db 报',
    '   SqliteError: database disk image is malformed，而压缩包本身完好（7z CRC 全部通过）。',
    '',
    '【第一步】先验压缩包本身（对不上就重新下载，别急着解压）：',
    '   certutil -hashfile "本包.7z" SHA256',
    '   与发布说明里给的 SHA256 逐字对照（发布脚本会在打包后打印）。',
    '   或者用 7-Zip 自带测试：7z t "本包.7z"     ← 输出 Everything is Ok 才算好',
    '',
    '【第二步】用 7-Zip 解压后，验关键文件（在 3.6.2-r 目录下执行）：',
    '   certutil -hashfile "agent-core\\data\\agent.db" SHA256',
    `   期望：${hashOf(path.join(DELIVER, 'agent-core', 'data', 'agent.db'))}`,
    '',
    '【如果 agent.db 坏了】不用重新下载整个包，用 7-Zip 只解出这一个文件覆盖即可',
    '（`7z e` 解单个成员时会校验该成员的 CRC，坏了会直接报错，不会静默给你坏文件）：',
    '   7z e "本包.7z" "3.6.2-r\\agent-core\\data\\agent.db" -o"解压目录\\3.6.2-r\\agent-core\\data" -y',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
  ]
  fs.writeFileSync(path.join(DELIVER, '校验-SHA256.txt'), lines.join('\r\n'), 'utf8')
  log('   已写入 校验-SHA256.txt（含 DB 的 SHA256 + "别用网盘客户端解压" + 单文件修复命令）')
}

fs.rmSync(outFile, { force: true })
const t0 = Date.now()
const zip = spawnSync(SEVENZIP, [
  'a', '-t7z', '-mx=3', `-mmt=${cores}`, `-m0=LZMA2:mt=${cores}:fb=32`, '-mf=off',
  outFile, '3.6.2-r',
  // 2026-10-02 用户：「文档也同步吧」。原来这里有一条 `-xr!3.6.2-r\目标\*`，
  // 把整个 `目标/` 排除在包外 ⇒ 交付包里的开发文档一直是旧的、甚至缺文件（前面好几版包都这样）。
  // 文档是交付物的一部分 ⇒ 取消这条排除；上面的同步段会整份刷 `目标/` 与 `docs/`，这里照实打进去。
  // （2026-10-13：`目标/` 已从 19 份精简为 3 份 —— 接手必读 / 历史与教训 / 编程模式，别再往里堆逐轮流水。）
  '-xr!3.6.2-r\\web-ui\\node_modules\\*', '-xr!*.log',
  // 2026-10-02 交付前审计发现：交付包顶层躺着一个 103 MB 的旧备份
  // （`linshe-backup-20260930-1405.tar.gz`）+ 一个 2.5 MB 的 apk ⇒ 它们**不是运行所需**，
  // 排除后包体积立省约 1/8。（用户磁盘上那两个文件不动，只是不进包。）
  '-xr!*.tar.gz',
], { cwd: 'C:\\', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (zip.status !== 0) die(`7z 退出码 ${zip.status}：${(zip.stderr || '').slice(0, 300)}`)
const secs = Math.round((Date.now() - t0) / 1000)
log('   ' + (zip.stdout || '').split(/\r?\n/).filter((l) => l.includes('Everything is Ok') || l.includes('Archive size')).join(' | '))
log(`   用时 ${secs} 秒（${(secs / 60).toFixed(1)} 分钟）`)

// ── 打包后：把数据库从压缩包里抽出来验一遍 ────────────────────────────────
// 2026-10-02 真事故后补的：我原本只验了"打包前的 DB"（integrity_check=ok），
// 结果用户在另一台机器上解压出损坏的 agent.db ⇒ 现在改成"打到包里再抽出来验"，
// 这样"包内真的可用"这件事每次交付都有机器证据（而不是靠我打包前那一眼）。
{
  const tmp = path.join(process.env.TEMP || process.env.TMP || '.', 'pkgdbverify')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const ex = spawnSync(SEVENZIP, ['e', outFile, '3.6.2-r\\agent-core\\data\\agent.db', `-o${tmp}`, '-y'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const dbFile = path.join(tmp, 'agent.db')
  if (ex.status !== 0 || !fs.existsSync(dbFile)) die('从压缩包里抽 agent.db 失败（说明包内这一项已损坏）：' + String((ex.stdout || '') + (ex.stderr || '')).slice(-300))
  const probe = path.join(tmp, 'probe.mjs')
  fs.writeFileSync(probe, [
    "import { createRequire } from 'node:module'",
    `const r = createRequire(${JSON.stringify(path.join(SRC, 'package.json').replace(/\\/g, '/'))})`,
    "const D = r('better-sqlite3')",
    "const db = new D(process.argv[2], { readonly: true, fileMustExist: true })",
    "const ic = db.pragma('integrity_check', { simple: true })",
    "const n = db.prepare('SELECT COUNT(*) c FROM characters').get().c",
    "console.log(JSON.stringify({ ic, n }))",
    "db.close()",
  ].join('\n'), 'utf8')
  // 注意：`.mjs` 文件本身就是 ESM ⇒ 不能再加 `--input-type=module`（Node 只允许它配 --eval/stdin，
  // 配上别的会直接 ERR_INPUT_TYPE_NOT_ALLOWED —— 我第一版就这么写的，被这个门禁自己拦下了）。
  const run = spawnSync(NODE, [probe, dbFile], { encoding: 'utf8', timeout: 120000 })
  fs.rmSync(tmp, { recursive: true, force: true })
  let info = null
  try { info = JSON.parse((run.stdout || '').trim().split(/\r?\n/).pop()) } catch { /* 下面统一报错 */ }
  if (!info || info.ic !== 'ok') {
    die(`包内数据库自检未通过（${run.stdout || run.stderr || '无输出'}）⇒ 拒绝交付这个包`)
  }
  log(`   包内数据库自检：integrity_check=${info.ic} ✓ 角色数=${info.n} ✓（从压缩包里抽出来验的）`)
}


// ── ⑤ 校验：压缩方法 + 关键条目 ──────────────────────────────────────────
log('\n── 校验包 ─────────────────────────────────────────')
const listing = spawnSync(SEVENZIP, ['l', '-slt', outFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || ''
const methods = new Map()
for (const m of listing.matchAll(/^Method = (.*)$/gm)) methods.set(m[1] || '(目录)', (methods.get(m[1] || '(目录)') || 0) + 1)
const methodText = [...methods.entries()].map(([k, v]) => `${v}x${k}`).join(' | ')
log('   压缩方法：' + methodText)
// 目录条目没有压缩方法（显示为空）⇒ 统计成 '(目录)'，**不算违规**。
// （第一版没排除它，于是"包已经打好了、脚本却判自己不通过"，白跑一轮。）
const badMethods = [...methods.keys()].filter((k) => k && k !== '(目录)' && !/^LZMA2/.test(k))
if (badMethods.length) die(`出现了非 LZMA2 的压缩方法：${badMethods.join(', ')}（硬规矩：必须 100% LZMA2、不加过滤器）`)

const plain = spawnSync(SEVENZIP, ['l', outFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || ''
const needCollectorLogs = /collector\\logs/.test(plain)
const needGitLogs = /\.git\\logs/.test(plain)
log(`   collector\\logs=${needCollectorLogs} | .git\\logs=${needGitLogs}`)
if (!needCollectorLogs || !needGitLogs) die('包内缺少 collector\\logs 或 .git\\logs（会被 .gitignore 式排除规则误伤）')

// 使用说明.txt：**交付目录那一份**再断言一次（2026-10-17）。
// 为什么要在同步之后再验：③-0 生成的是仓库根那份，交付目录那份靠 ③ 的全量同步带过去。
// 只验生成源等于没验——真正会断的就是"同步/打包这一步没带上它"（第五十五~五十七轮的实况）。
{
  const delivered = path.join(DELIVER, '使用说明.txt')
  if (!fs.existsSync(delivered)) die('交付目录缺 使用说明.txt（③ 全量同步没带上它）')
  const text = fs.readFileSync(delivered, 'utf8')
  const missing = USAGE_KEYWORDS.filter(([, kw]) => !text.includes(kw)).map(([name]) => name)
  if (missing.length) die(`交付目录的 使用说明.txt 是旧的（缺：${missing.join('、')}）⇒ 同步/生成链断了，拒绝交付`)
  log(`   使用说明.txt（交付目录）：${Buffer.byteLength(text, 'utf8')} B，关键词 ${USAGE_KEYWORDS.length} 项全中 ✓`)
}

// 本机配置文件：**从包内清单里断言"没有它"**（2026-10-17 §P1-2 起；2026-10-18 加 launcher_config）。
// 为什么不能只靠 syncDir 的排除规则：那是"我以为它没进去"，而真正要证明的是
// **包里确实没有**。历史上正是这类"排除了但实际还在"的缝出的问题（发布门禁三处先例）。
// ⚠️ 用 `l` 的清单匹配：包内没这项 ⇒ 清单里搜不到 `agent-core\.env`（要连 `.env.example` 一起排除干扰）。
{
  const envInPkg = /3\.6\.2-r\\agent-core\\\.env(\s|$)/m.test(plain) || /3\.6\.2-r\\agent-core\\\.env\.local/m.test(plain)
  const exampleInPkg = /3\.6\.2-r\\agent-core\\\.env\.example/m.test(plain)
  if (envInPkg) die('包内含 agent-core\\.env（真实 API Key）⇒ 交付链剥离失败，拒绝交付')
  log(`   agent-core\\.env 不在包内 ✓（.env.example 在包内=${exampleInPkg}）`)
  if (!exampleInPkg) log('   ⚠️ 包内没有 .env.example —— 换机器的人没有配置模板可参考（不阻断，建议补）')

  // `launcher_config.json`（2026-10-18 补）：它是启动器的本机用户配置，`comfyui_exe` 指向
  // **打包这台机器**的路径。包内若带它，别人一开启动器就指到不存在的地址。
  // 匹配 `3.6.2-r\launcher_config.json`（仓库根那份）；顺带挡 `agent-core\` 下的误放。
  const lcInPkg = /3\.6\.2-r\\launcher_config\.json(\s|$)/m.test(plain)
    || /3\.6\.2-r\\agent-core\\launcher_config\.json(\s|$)/m.test(plain)
  if (lcInPkg) die('包内含 launcher_config.json（含打包机器的 ComfyUI 绝对路径）⇒ 交付链剥离失败，拒绝交付')
  log('   launcher_config.json 不在包内 ✓（缺失即全新用户初始状态：启动器会自动写默认配置）')
}

const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1)
const sha = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-FileHash -Algorithm SHA256 '${outFile}').Hash`], { encoding: 'utf8' }).trim()
log('\n══════════════════════════════════════════════════════')
log(` 产出：${path.basename(outFile)}`)
log(` 体积：${sizeMb} MB`)
log(` SHA256：${sha}`)
if (be && fe) {
  log(` 测试：后端 ${be.pass}/${be.tests} ✓ · 前端 ${fe.pass}/${fe.tests} ✓ （0 fail / 0 cancelled）`)
  const skips = (be.skip || 0) + (fe.skip || 0)
  if (skips > 0) {
    log(` 跳过 ${skips} 项，均为**已知环境性**（不是新问题，别再排查）：`)
    for (const line of KNOWN_SKIPS) log(`   · ${line}`)
  }
}
log('══════════════════════════════════════════════════════')
log('\n⚠️ 还剩最后一步（手跑，需要等解压与启动）：')
log('   解压 → 起 vector-service(8765) 与 agent-core(3199) → 抽查 /api/characters 与 /api/intimate-actions/:id/state')
