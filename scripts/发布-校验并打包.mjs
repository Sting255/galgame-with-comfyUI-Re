/**
 * 发布门禁：静态检查、生产构建或显式生图冒烟失败就不打包。
 *
 * 用法（在仓库根目录）：
 *   node scripts/发布-校验并打包.mjs                 # 静态检查 + 构建 → 同步 → 打包 → 校验
 *   node scripts/发布-校验并打包.mjs --with-smoke    # 另外在隔离目录真实出图（交付前必开）
 *   node scripts/发布-校验并打包.mjs --round 37      # 指定轮次号（默认按 输出/ 目录里已有的最大轮次 +1）
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
 * 它做的事：①静态检查与前端构建 ②可选隔离生图冒烟 ③生成使用说明 + 同步源码→交付包
 *          ④7z 打包 ⑤校验（方法/条目/体积/手册）
 * 起服务那一步（解压 + 真启动 + 抽查端点）需要交互式等待，仍在打包后手工跑，脚本会打印提醒。
 *
 * ⚠️ 2026-10-17 补：**使用说明.txt 的生成接进来了**（③-0）。
 *    此前本脚本没有任何生成使用说明的步骤，而生成源早已更新 ⇒ 仓库根与交付目录那份
 *    一路停在 2026-10-01 旧版（关键词零命中），第五十五~五十七轮 3 个交付包全带旧手册。
 *    现在：打包前用正源 `scripts/usage-guide.mjs` 重新生成 → 随 ③ 同步进交付目录 →
 *    ⑤ 对**仓库根**与**交付目录**两份都做关键词断言（缺章节就 die）。
 *    另：测试收集链已移除；当前门禁为项目健康、未定义符号、生产构建与可选真生图。
 *
 * ⚠️ 2026-10-02 从仓库根搬进 `scripts/`（AGENTS.md：根目录不散落脚本）——
 *    搬动时唯一的坑是下面那行 REPO：原来写 `path.resolve(import.meta.dirname)`（=脚本所在目录），
 *    进了 scripts/ 之后必须回退一层才是仓库根；脚本里其余路径全部基于 REPO 或绝对路径，不受影响。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
// 使用说明.txt 的正文正源（2026-10-17 从 build-release.mjs 抽出；两份脚本共用这一份，见 ③-0）
import { buildUsageGuideText } from './usage-guide.mjs'
import { syncReleaseEnv, inspectReleaseEnv } from './lib/releaseLocalConfig.mjs'
import { resolveServicePort } from '../agent-core/src/utils/servicePort.js'
import { resolveEnvPath } from '../agent-core/src/utils/envFile.js'

// 本文件在 <repo>/scripts/ 下 ⇒ 仓库根是它的上一层
const REPO = path.resolve(import.meta.dirname, '..')
const SRC = path.join(REPO, 'agent-core')
const WEB = path.join(REPO, 'web-ui')
// ── 机器相关路径：集中在这里，可用环境变量覆写（2026-10-17 复查 §P3-1）─────────────
// 原来这几个字面量散在函数体里，换机/换目录就要改码。现在只在这里出现一次。
const DELIVER = process.env.DELIVER_DIR || 'C:\\3.6.2-r'
const DELIVER_NAME = path.basename(DELIVER)
const DELIVER_PARENT = path.dirname(DELIVER)
const OUTDIR = process.env.OUT_DIR || path.join(process.env.USERPROFILE || 'C:\\Users\\Sting', 'Downloads', '输出')
const NODE = path.join(REPO, 'runtime', 'nodejs', 'node.exe')
const SEVENZIP = process.env.SEVENZIP_EXE || 'C:\\Program Files\\7-Zip\\7z.exe'
const API_PORT = resolveServicePort()
const VECTOR_SERVICE_URL = process.env.VECTOR_SERVICE_URL || 'http://localhost:8765'
const coreRequire = createRequire(path.join(SRC, 'package.json'))
// 压缩级别（2026-11-03 用户：「要最高压缩的」）：默认 3 与既有行为一致，交付时用 SEVENZIP_LEVEL=9。
// 级别 >=7 时把 LZMA2 的 fb / 字典一起放大（低级别配大字典只是白烧内存）。
const LEVEL = Number(process.env.SEVENZIP_LEVEL || 3) || 3
const HIGH = LEVEL >= 7
// 包名标签：原来是写死的 '3.6.2-r' + 写死日期 20261002，交付包名字会一直停在旧版本上。
const PACK_LABEL = process.env.PACK_LABEL || (() => {
  // 2026-11-06：原来硬编码 '3.6.2-r'，打出来的包名跟 VERSION（4.2.0）对不上，用户分不清是哪个版本
  try {
    const version = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim()
    return version || '3.6.2-r'
  } catch {
    return '3.6.2-r'
  }
})()
// 是否把玩家数据（agent-core/data/agent.db）打进交付包。
// 2026-11-03 用户口径：「以后不要把玩家数据一起打包 打包程序就行」⇒ **默认 false**。
// 需要"含数据"的备份包时显式 PACK_WITH_DATA=1（那种包只能自用，里面有全部聊天记录）。
const WITH_DATA = process.env.PACK_WITH_DATA === '1'

const args = process.argv.slice(2)
const skipTests = args.includes('--skip-tests')
const roundArg = args.includes('--round') ? Number(args[args.indexOf('--round') + 1]) : null
const incremental = args.includes('--incremental')
// --with-smoke 执行隔离的 scripts/smoke-image-isolated.mjs。
// 它是真实生图（需要 ComfyUI）；默认关闭，正式交付必须显式开启。
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
let packageCreated = false
const die = (msg) => {
  const outcome = packageCreated
    ? '已生成的候选包不可交付；请检查错误并重新打包'
    : '打包已中止 —— 没有产出可交付包'
  console.error('\n✗ ' + msg + '\n' + outcome)
  process.exit(1)
}

if (skipTests) {
  die('--skip-tests 已移除：项目不再维护自动化测试收集链。静态检查与前端构建始终执行；交付日请另加 --with-smoke 跑真实生图。')
}
if (withChecks) {
  die('--with-checks 已移除：e2e/check-*.mjs 入口不存在。请使用 --with-smoke 做真实生图，并按验收记录手工检查页面与包内启动。')
}

/** Node 流式 SHA256，不依赖 PowerShell / certutil，也不把大文件整体读入内存。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function isSameOrInside(parent, candidate) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  // 必须比较规范路径；`C:\foo` 与 `C:\foobar` 不能被当成父子。
  const rel = path.relative(normalize(path.resolve(parent)), normalize(path.resolve(candidate)))
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

function sameAbsolutePath(left, right) {
  const normalize = value => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

/** 解析最近一个已存在的祖先；不跟随尚不存在的最终 DELIVER 本身。 */
function realpathNearestExisting(target) {
  let cursor = path.resolve(target)
  const missingParts = []
  for (;;) {
    if (fs.existsSync(cursor)) {
      const real = fs.realpathSync.native(cursor)
      return path.resolve(real, ...missingParts.slice().reverse())
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return path.resolve(cursor, ...missingParts.slice().reverse())
    missingParts.push(path.basename(cursor))
    cursor = parent
  }
}

/**
 * DELIVER 默认允许清空既有镜像，但必须在结构上与其他关键目录完全隔离。
 * 这项检查不增加交互确认，只拒绝根盘、仓库自身/祖先、源码依赖、玩家数据和输出目录重叠。
 */
function assertSafeDeliverPath() {
  if (!path.isAbsolute(DELIVER)) die(`DELIVER_DIR 必须是绝对路径：${DELIVER}`)
  const resolvedDeliver = path.resolve(DELIVER)
  if (resolvedDeliver === path.parse(resolvedDeliver).root) die(`拒绝清空磁盘根目录：${resolvedDeliver}`)

  // 已存在的目录/文件可能是指向外部的 junction、symlink 或其它重解析点。
  // 递归删除之前，解析 DELIVER 自身或其最近已存在祖先的真实目的路径。
  let finalDeliver
  try {
    finalDeliver = realpathNearestExisting(resolvedDeliver)
  } catch (error) {
    die(`无法解析 DELIVER_DIR 的真实路径：${resolvedDeliver}（${error.message}）`)
  }
  // 递归删除只接受路径自身就是最终真实路径；目标或任一已存在祖先经过
  // symlink/junction 时，即使最后仍落在父目录内，也拒绝，避免 Windows 重解析点语义差异。
  if (!sameAbsolutePath(finalDeliver, resolvedDeliver)) {
    die(`DELIVER_DIR 经过 symlink/junction，拒绝递归清理：${resolvedDeliver} → ${finalDeliver}`)
  }
  if (finalDeliver === path.parse(finalDeliver).root) die(`拒绝清空磁盘根目录的真实路径：${finalDeliver}`)

  const protectedPaths = [
    REPO,
    SRC,
    WEB,
    path.join(SRC, 'data'),
    path.join(REPO, 'runtime'),
    OUTDIR,
  ].map(value => {
    try {
      return realpathNearestExisting(value)
    } catch (error) {
      // 保护路径无法规范化时必须 fail-closed；不能退回未校验路径后继续递归删除。
      die(`无法解析受保护路径，拒绝清空交付目录：${value}（${error.message}）`)
    }
  })

  for (const protectedPath of protectedPaths) {
    if (isSameOrInside(finalDeliver, protectedPath) || isSameOrInside(protectedPath, finalDeliver)) {
      die(`DELIVER_DIR 与受保护目录重叠，拒绝清空：${resolvedDeliver} → ${finalDeliver} ↔ ${protectedPath}`)
    }
  }
  // 使用输入解析后的路径执行清理；上面已确认其真实路径没有重解析点。
  return resolvedDeliver
}

/**
 * 真实生图冒烟的父进程运行环境。
 * 现有配置只读合并到子进程环境；临时 LINSHE_ENV_PATH 只用于容纳将来可能发生的
 * 配置写入，位于系统临时根，不复制进仓库或交付包，不打印任何值。
 */
function prepareIsolatedSmokeEnvironment() {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-publish-smoke-'))
  try {
    const dirs = Object.fromEntries(
      ['images', 'audio', 'data', 'comfy-output', 'tmp'].map(name => [name, path.join(smokeRoot, name)]),
    )
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })

    const sourceEnv = resolveEnvPath()
    const verificationEnv = path.join(smokeRoot, 'verification.env')
    if (fs.existsSync(sourceEnv)) fs.copyFileSync(sourceEnv, verificationEnv)
    else fs.writeFileSync(verificationEnv, '', 'utf8')

    let fileValues = {}
    if (fs.existsSync(sourceEnv)) {
      try {
        fileValues = coreRequire('dotenv').parse(fs.readFileSync(sourceEnv))
      } catch (error) {
        throw new Error(`读取现有 .env 失败：${error.message}`)
      }
    }

    const childEnv = { ...process.env }
    for (const [key, value] of Object.entries(fileValues)) {
      if (childEnv[key] === undefined) childEnv[key] = value
    }
    Object.assign(childEnv, {
      DB_PATH: ':memory:',
      LOG_TO_FILE: 'false',
      IMAGES_DIR: dirs.images,
      TTS_AUDIO_DIR: dirs.audio,
      LINSHE_DATA_DIR: dirs.data,
      COMFYUI_OUTPUT_DIR: dirs['comfy-output'],
      LINSHE_ENV_PATH: verificationEnv,
      LINSHE_SMOKE_ROOT: smokeRoot,
      TEMP: dirs.tmp,
      TMP: dirs.tmp,
      LLM_MODEL: 'cn:deepseek-v4.1-flash',
    })
    return { smokeRoot, env: childEnv }
  } catch (error) {
    try {
      cleanupIsolatedSmokeRoot(smokeRoot)
    } catch (cleanupError) {
      throw new Error(`${error.message}；冒烟临时目录清理失败：${cleanupError.message}`)
    }
    throw error
  }
}

function cleanupIsolatedSmokeRoot(smokeRoot) {
  if (!smokeRoot) return
  const base = path.resolve(os.tmpdir())
  const resolved = path.resolve(smokeRoot)
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('linshe-publish-smoke-')) {
    throw new Error(`拒绝清理非预期冒烟目录：${resolved}`)
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

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

// ── 静态门禁与迁移路径断言 ────────────────────────────────────────────────

// ── ⓪-前置：静态断言「代码里没有迁移前的机器绝对路径」────────────────────────
//
// 真事故（2026-10-17 全项目复查 §P0-1）：项目从旧的百度网盘下载目录迁到 `D:\邻舍改` 时
//   只搬了目录，**没扫测试/e2e 里的绝对路径** ⇒
//   `web-ui/test/toyLabelParity.test.js` 里写死的旧 `CORE` 让本文件 5 条用例全挂（ENOENT），
//   而它当时正是旧前端测试门禁的一部分 ⇒ 曾把打包门禁堵死；现在测试收集链已移除，
//   这项扫描继续防脚本/测试夹具引用迁移前路径。
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

let smokeStatus = '未执行'
assertNoStalePaths()
// 2026-11-06 用户决定移除全部自动化测试：门禁改为「前端能构建」。
// 代码正确性靠真机验收（解压 → 真启动 → 抽端点），这一步在打包后手工做。
{
  log('\n── 项目健康与本地链接 ──────────────────────────')
  const health = spawnSync(NODE, [path.join(REPO, 'scripts', 'project-health.mjs')], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  if (health.status !== 0) {
    log(String((health.stdout || '') + (health.stderr || '')).slice(-3000))
    die('项目健康检查未通过')
  }
  log(`  ✓ ${String(health.stdout || '').split(/\r?\n/).find(line => line.includes('本地链接')) || '项目健康检查通过'}`)
}
{
  log('\n── 前端生产构建 ────────────────')
  const build = spawnSync(NODE, ['build.mjs'], { cwd: WEB, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (build.status !== 0) {
    die('前端生产构建失败：' + String((build.stderr || build.stdout || '')).slice(-600))
  }
  log('   前端生产构建通过 ✓')
}

// ── ②-未定义符号（2026-11-08 加，永远跑）───────────────────────────────────
// 真机上出过两次 `ReferenceError: xxx is not defined`（chat.js 的 getWorldIntegrationRule、
// expressionStandingService.js 的 buildCharacterPersona），都是「函数用了但忘了 import」。
// node --check 只能验语法，这类错误要运行到那一行才炸，而它们又都在低频分支上 ——
// 于是能一路混进交付包。这个检查用 AST 找「调用了但没有导入/定义的函数」，几秒钟跑完，
// 失败就不该打包。
{
  log('\n── 未定义符号检查 ──────────────────────────')
  const check = spawnSync(NODE, [path.join(REPO, 'scripts', 'check-imports.mjs')], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  const output = `${check.stdout || ''}${check.stderr || ''}`.trim()
  if (check.status !== 0) {
    log('  ✗ 有文件调用了未定义的函数，见下（这类错误 node --check 查不出来）：')
    log(output.split(/\r?\n/).map(line => '    ' + line).join('\n'))
    die('未定义符号检查未通过：先修完再打包，别把 ReferenceError 打进交付包')
  }
  log(`  ✓ ${output.split(/\r?\n/).pop()}`)
}

// ── ②-真实生图冒烟（交付日显式开启）──────────────────────────────────────────
// helper 会先切出本次生图直接依赖的内存库、图片目录和临时配置副本，再导入真实链路。
// 0=出图成功；2=ComfyUI 未开/不可达，必须视为环境阻塞；其它退出码=代码失败。
if (withSmoke) {
  log('\n── 隔离生图冒烟 ────────────────────────────────')
  const smokeScript = path.join(REPO, 'scripts', 'smoke-image-isolated.mjs')
  if (!fs.existsSync(smokeScript)) die(`生图冒烟入口不存在：${smokeScript}`)
  let smokeRoot = null
  let smokeStatusAfter = null
  try {
    const prepared = prepareIsolatedSmokeEnvironment()
    smokeRoot = prepared.smokeRoot
    log(`   父进程环境：DB_PATH=:memory: / 隔离根=${smokeRoot}`)
    const smoke = spawnSync(NODE, [smokeScript], {
      cwd: REPO,
      encoding: 'utf8',
      env: prepared.env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 5 * 60_000,
    })
    const output = `${smoke.stdout || ''}${smoke.stderr || ''}`
    for (const line of output.trim().split(/\r?\n/).slice(-24)) log(`   ${line}`)
    if (smoke.error) throw new Error(`生图冒烟进程启动失败：${smoke.error.message}`)
    if (smoke.status === 0) smokeStatusAfter = 'PASS（真实出图）'
    else if (smoke.status === 2) {
      throw new Error('生图冒烟被环境阻塞：ComfyUI 未开或不可达。退出码 2 不能当作通过。')
    } else throw new Error(`生图冒烟失败：退出码 ${smoke.status ?? '未知'}`)
  } catch (error) {
    // 必须让 finally 先删除含临时配置的冒烟根；process.exit 不会执行 finally。
    smokeStatusAfter = null
    smokeStatus = error.message
  } finally {
    try {
      cleanupIsolatedSmokeRoot(smokeRoot)
    } catch (error) {
      smokeStatusAfter = null
      smokeStatus = `冒烟临时目录清理失败：${error.message}`
    }
  }
  if (smokeStatusAfter) smokeStatus = smokeStatusAfter
  else die(smokeStatus)
} else {
  smokeStatus = '未执行（正式交付请加 --with-smoke）'
  log('\n── 隔离生图冒烟 ──────────────── 未执行 ────────────────')
}

// ── --gates-only：到此为止，不同步、不打包 ────────────────────────────────────
if (gatesOnly) {
  log('\n── 门禁结束（--gates-only，未同步、未打包）──────────')
  log(`   静态检查：project-health + check-imports`)
  log(`   前端：生产构建通过`)
  log(`   冒烟：${smokeStatus}`)
  log('   没有产出任何文件。要真打包：去掉 --gates-only。')
  process.exit(0)
}

// ── ③ 同步源码 → 交付包 ──────────────────────────────────────────────────
log('\n── 同步源码到交付包 ────────────────────────────────')
const SAFE_DELIVER = assertSafeDeliverPath()

// ── ③-0 先把交付目录清空（2026-11-08）──────────────────────────────────
// 为什么必须清：交付目录是**跨轮复用的固定路径**（默认 C:\3.6.2-r），同步全是增量。
// 于是「上一轮打进包、这一轮才被排除」的文件会原地留着 —— 本轮实测：加了 `.mimosa`
// 排除规则后重新打包，`web-ui/.mimosa` 仍然跟着进了 993MB 的包，因为它是上一轮留下的。
// 清理后每次都是从零同步，「排除规则生效」这件事才可验证。
// 注意只清交付目录本身（DELIVER），不动它的父目录。
fs.rmSync(SAFE_DELIVER, { recursive: true, force: true })
log(`   已清空交付目录（${DELIVER}），本次从零同步`)

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
// 发布验证可指定独立副本；默认仍写仓库根的正源产物。
const USAGE_GUIDE = process.env.LINSHE_USAGE_GUIDE_PATH
  ? path.resolve(process.env.LINSHE_USAGE_GUIDE_PATH)
  : path.join(REPO, '使用说明.txt')
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
  fs.mkdirSync(path.dirname(USAGE_GUIDE), { recursive: true })
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
      // ⚠️ 2026-11-03 事故：这里原来按**目录名**跳过 `data`
      // ⇒ `agent-core/src/data/`（体位数据库 sexPositions.js / sexPositionsExtra.js /
      //   positionPoseSkeletons.js）被一起跳过，打出来的包一启动就
      //   `ERR_MODULE_NOT_FOUND: src/data/sexPositions.js`。只有**数据库目录**
      //   `agent-core/data` 该跳过，其余同名目录都是源码。
      // ⚠️ 2026-11-06 事故：这里按**目录名**跳过 `logs`，把 Python 依赖里的
      // `opentelemetry/proto/collector/logs` 一起跳掉了 ⇒ 换机启动向量服务直接
      // `ModuleNotFoundError: No module named 'opentelemetry.proto.collector.logs'`。
      // 只有**仓库自己的日志目录**该跳过，第三方包里的同名目录是代码。
      const isThirdParty = s.includes('site-packages')
      if (!isThirdParty && ['node_modules', '.git', '目标', 'logs', '.claude',
        // `.mimosa/`：第三方编辑器插件的 hook 状态（hook-state/hook-status），
        // 里面记着**本机绝对路径**（2026-11-08 复查发现它混进了待发包，
        // 内容形如「盘符:\网盘下载目录\……\web-ui\src\...」）。顶层名单里有它，
        // 但嵌套目录（web-ui/.mimosa）走的是这里，以前漏了。
        '.mimosa',
        // `.pai/` 是项目级临时资产目录（计划/报告/工作树/临时副本），
        // 里面还留着上游合并时的 node_modules junction —— 被当文件复制会 EPERM，且绝不该进包。
        '.pai'].includes(e.name)) continue
      if (path.relative(REPO, s).split(path.sep).join('/') === 'agent-core/data') continue
      // 2026-11-07 事故：`launcher/build_cache/` 是 PyInstaller 虚拟环境与下载的工具链（≈800 MB），
      // `launcher/build/` 与 `launcher/dist/` 是构建中间产物和旧 exe（各 ≈50 MB）。
      // 三者都被 .gitignore 忽略（launcher/.gitignore / 根 .gitignore:39），但**顶层镜像是
      // robocopy 直拷、不看 gitignore** ⇒ 整份进包，包体积从 1.1 GB 涨到 2.3 GB。
      // 启动器真正要交付的是仓库根那份 `邻舍.EXE.exe`（build_launcher.py 的 --output）。
      const rel = path.relative(REPO, s).split(path.sep).join('/')
      if (rel === 'launcher/build_cache' || rel === 'launcher/build' || rel === 'launcher/dist') continue
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
const changed = incremental
  ? execFileSync('git', ['status', '--short'], { cwd: REPO, encoding: 'utf8' })
    .split(/\r?\n/).map((l) => l.slice(3).trim().replace(/^"|"$/g, '')).filter(Boolean)
  : []

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
    '.git', 'node_modules', 'data', 'logs', '目标', 'docs', '.mimosa', '完整', '.claude', '方案',
    // 2026-11-07 用户："AGENTS 怎么还在包里" —— 这些是仓库的**开发/维护资产**，
    // 用户拿到只会困惑（而且 AGENTS.md 里写着本机路径与协作约定，不该外发）：
    '.github', '.learnings', '.playwright-cli',
    // 2026-11-03 事故：`.pai/` 是项目级临时资产目录（计划 / 报告 / 参考仓库 / 工作树 / 临时副本），
    // 里面还留着上游合并时的 **node_modules junction**。顶层镜像是逐个目录直传、**不走**
    // syncDir 的子项跳过名单 ⇒ 整个 .pai 被搬过去，而 junction 的 isDirectory() 为 false
    // ⇒ 被当文件复制 ⇒ EPERM，打包直接崩（本轮连崩两次都是它）。
    '.pai',
  ])
  const SKIP_FILE = /\.(tar\.gz|apk|log)$/i
  // 顶层的维护文件同样不该进用户包（AGENTS.md 里还写着本机路径与协作约定）
  const SKIP_TOP_FILE = /^(AGENTS\.md|\.gitattributes|\.gitignore|\.zcodeignore)$/i
  for (const e of fs.readdirSync(REPO, { withFileTypes: true })) {
    if (SKIP_TOP.has(e.name)) continue
    if (e.isFile() && SKIP_FILE.test(e.name)) continue
    if (e.isFile() && SKIP_TOP_FILE.test(e.name)) continue
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

// 运行依赖：上面的镜像**故意跳过 node_modules**（否则每次全量同步都要搬几万文件），
// 但包里没有它后端就起不来（`Cannot find package 'express'`）。所以单独补一步：
// robocopy 增量镜像，已存在时只补差异，几十秒就能完成。
{
  const nmSrc = path.join(SRC, 'node_modules')
  const nmDst = path.join(DELIVER, 'agent-core', 'node_modules')
  if (fs.existsSync(nmSrc)) {
    fs.mkdirSync(nmDst, { recursive: true })
    const rc = spawnSync('robocopy', [
      nmSrc, nmDst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1',
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    // robocopy 的退出码语义：0/1/2/3 都算成功（1=复制了文件，2=有额外项，3=两者都有）
    if ((rc.status ?? 1) > 3) {
      throw new Error(`复制 agent-core/node_modules 失败（robocopy 退出码 ${rc.status}）`)
    }
    log('   已补入 agent-core/node_modules（后端运行依赖）')
  } else {
    log('   ⚠️ 仓库缺 agent-core/node_modules —— 包里不会有依赖，换机能启动才怪')
  }
}

// 便携 Node 的 **npm 本体**（runtime/nodejs/node_modules）。
// 真机 2026-11-07：启动器「切换版本」后要自己跑 npm install 重建，用的就是
// `<包>/runtime/nodejs/node.exe` + `<包>/runtime/nodejs/node_modules/npm`。
// 而上面的全量镜像按目录名跳过所有 node_modules ⇒ npm 本体没进包 ⇒ 重建第一步就报
// `Cannot find module '...\runtime\nodejs\node_modules\npm\bin\npm-cli.js'`，
// 整个更新流程断在这里。npm 本体只有十几 MB，必须随包带。
{
  const npmSrc = path.join(REPO, 'runtime', 'nodejs', 'node_modules')
  const npmDst = path.join(DELIVER, 'runtime', 'nodejs', 'node_modules')
  if (fs.existsSync(npmSrc)) {
    fs.mkdirSync(path.dirname(npmDst), { recursive: true })
    const rc = spawnSync('robocopy', [
      npmSrc, npmDst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1',
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    if ((rc.status ?? 1) > 3) {
      throw new Error(`复制 runtime/nodejs/node_modules 失败（robocopy 退出码 ${rc.status}）`)
    }
    // npm 入口脚本也要在（有的 Node 发行版把它放在 node_modules 外）
    const npmCmd = path.join(REPO, 'runtime', 'nodejs', 'npm.cmd')
    if (fs.existsSync(npmCmd)) fs.copyFileSync(npmCmd, path.join(DELIVER, 'runtime', 'nodejs', 'npm.cmd'))
    log('   已补入 runtime/nodejs/node_modules（便携 npm，更新重建要用）')
  } else {
    log('   ⚠️ 仓库缺 runtime/nodejs/node_modules —— 启动器更新后的自动重建会失败')
  }
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
// 2026-11-03 用户口径：「完整包，我不想看到又有报错」—— 自用测试包**必须带上 .env**，
// 否则 LLM 全线报 "OPENAI_API_KEY is missing"（真机验证过：日程/朋友圈/事件全挂）。
// 所以保留开关：PACK_KEEP_ENV=1 时同步当前 .env（仍然删 launcher_config.json，它指向打包机的
// ComfyUI 路径，别人拿去反而更坑）；不设该变量时保持原有防泄露行为 —— 外发场景不要开它。
const keepEnv = process.env.PACK_KEEP_ENV === '1'
{
  const envSync = syncReleaseEnv(SRC, path.join(DELIVER, 'agent-core'), keepEnv)
  const stale = [
    path.join(DELIVER, 'launcher_config.json'),
    path.join(DELIVER, 'agent-core', 'launcher_config.json'),
  ]
  const removed = envSync.removed.map(name => `agent-core/${name}`)
  for (const f of stale) {
    if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.relative(DELIVER, f)) }
  }
  if (keepEnv) log(`   ⚠ PACK_KEEP_ENV=1：已同步当前配置 ${envSync.copied.join('、') || '（源目录无配置）'}，含 Key 的自用包不要外发`)
  const example = path.join(DELIVER, 'agent-core', '.env.example')
  if (removed.length) log(`   已从交付目录清掉遗留的本机配置文件：${removed.join('、')}（.env.example 已随源码同步）`)
  else log('   无需清理遗留本机配置')
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
const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` })()
const outFile = path.join(OUTDIR, `邻舍-${PACK_LABEL}-完整可运行包-${WITH_DATA ? '含数据' : '不含数据'}-${today}-第${cnNum(round)}轮.7z`)
const cores = Number(process.env.NUMBER_OF_PROCESSORS || 0) || 8
log('\n── 打包 ───────────────────────────────────────────')
log(`   线程 = ${cores}（本机核心数）| 级别 -mx=${LEVEL}（交付日设 SEVENZIP_LEVEL=9 走最高压缩）`)

// ── 打包前：往交付包里写一份「校验清单」（会跟着进包）──────────────────
// 2026-10-02 真事故：用户在另一台机器上用网盘客户端解压，解出来的 agent.db 损坏
// （SqliteError: database disk image is malformed）——**包本身是好的**（7z CRC 通过、
// 把成员单独抽出来 integrity_check=ok），坏在"解压工具不校验就写出坏文件"。
// 所以：① 包里放一份可对账的校验清单；② 打包后再把数据库从压缩包里抽出来验一遍（见下）。
{
  const dbPath = path.join(DELIVER, 'agent-core', 'data', 'agent.db')
  const dbLine = WITH_DATA
    ? `   期望：${await sha256File(dbPath)}`
    : '   本包不含玩家数据库，无需校验 agent-core\\data\\agent.db。'
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
    '【第二步】用 7-Zip 解压后，验关键文件：',
    dbLine,
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

  if (fs.existsSync(outFile)) {
    die(`输出包已存在，拒绝覆盖：${outFile}\n     —— 请换一个尚未使用的轮次号或输出目录。`)
  }
const t0 = Date.now()
const zip = spawnSync(SEVENZIP, [
  'a', '-t7z', `-mx=${LEVEL}`, `-mmt=${cores}`,
  HIGH ? `-m0=LZMA2:mt=${cores}:fb=273:d=256m` : `-m0=LZMA2:mt=${cores}:fb=32`, '-mf=off',
  outFile, DELIVER_NAME,
  // 2026-10-02 用户：「文档也同步吧」。原来这里有一条 `-xr!3.6.2-r\目标\*`，
  // 把整个 `目标/` 排除在包外 ⇒ 交付包里的开发文档一直是旧的、甚至缺文件（前面好几版包都这样）。
  // 文档是交付物的一部分 ⇒ 取消这条排除；上面的同步段会整份刷 `目标/` 与 `docs/`，这里照实打进去。
  // （2026-10-13：`目标/` 已从 19 份精简为 3 份 —— 接手必读 / 历史与教训 / 编程模式，别再往里堆逐轮流水。）
  // 2026-10-02 用户：「文档也同步吧」⇒ 取消对 `docs/` 的排除。
  // 2026-11-08 复查：`目标/`（逐轮规划与盘点的开发笔记）里写着本机绝对路径等私人信息，
  // 发布到公开 Release 属于外泄 ⇒ 只排除 `目标/`，`docs/` 仍然照常进包。
  `-xr!${DELIVER_NAME}\\目标\\*`,
  `-xr!${DELIVER_NAME}\\web-ui\\node_modules\\*`, '-xr!*.log',
  // 2026-11-03 用户：「打包程序就行，不要带玩家数据」⇒ 默认把数据库整份排除在包外。
  // 包内仍随源码带上 `agent-core/data/` 目录本身（首次启动会自动建空库），只是不带 agent.db 及其日志。
  ...(WITH_DATA ? [] : [`-xr!${DELIVER_NAME}\\agent-core\\data\\*`]),
  // 2026-10-02 交付前审计发现：交付包顶层躺着一个 103 MB 的旧备份
  // （`linshe-backup-20260930-1405.tar.gz`）+ 一个 2.5 MB 的 apk ⇒ 它们**不是运行所需**，
  // 排除后包体积立省约 1/8。（用户磁盘上那两个文件不动，只是不进包。）
  '-xr!*.tar.gz', '-xr!.access-token',
  // 2026-11-07 真机：包体积从 733 MB 涨到 2.4 GB（GitHub 单资产上限 2 GiB，直接传不上去）。
  // 查出来是三个非运行内容被打了进去，全部排除：
  //   · release/ —— build-release.mjs 的历史产物（1.9 GB，含上一版 exe 与 zip）
  //   · launcher/build_cache/ —— PyInstaller 与便携运行时下载缓存（697 MB）
  //   · launcher/build/ —— PyInstaller 中间产物（57 MB，成品在 dist/）
  `-xr!${DELIVER_NAME}\\release\\*`,
  `-xr!${DELIVER_NAME}\\launcher\\build_cache\\*`,
  `-xr!${DELIVER_NAME}\\launcher\\build\\*`,
  `-xr!${DELIVER_NAME}\\方案\\*`,
], { cwd: DELIVER_PARENT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (zip.status !== 0) die(`7z 退出码 ${zip.status}：${(zip.stderr || '').slice(0, 300)}`)
packageCreated = true
const secs = Math.round((Date.now() - t0) / 1000)
log('   ' + (zip.stdout || '').split(/\r?\n/).filter((l) => l.includes('Everything is Ok') || l.includes('Archive size')).join(' | '))
log(`   用时 ${secs} 秒（${(secs / 60).toFixed(1)} 分钟）`)

// 压缩成功不等于归档可读；用 7-Zip 自身完整测试 CRC/内容结构。
{
  const test = spawnSync(SEVENZIP, ['t', outFile], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (test.status !== 0 || !String(test.stdout || '').includes('Everything is Ok')) {
    die(`候选包 7z 完整性测试失败：${(test.stdout || '') + (test.stderr || '')}`)
  }
  log('   7z 完整性测试：Everything is Ok ✓')
}

// ── 打包后：把数据库从压缩包里抽出来验一遍 ────────────────────────────────
// 2026-10-02 真事故后补的：我原本只验了"打包前的 DB"（integrity_check=ok），
// 结果用户在另一台机器上解压出损坏的 agent.db ⇒ 现在改成"打到包里再抽出来验"，
// 这样"包内真的可用"这件事每次交付都有机器证据（而不是靠我打包前那一眼）。
// 2026-11-05：默认已改成「只打包程序、不带玩家数据」⇒ 包里根本没有 agent.db，
// 这一步只在 PACK_WITH_DATA=1 的含数据备份包里才做，否则会把自己的排除项当成损坏。
if (WITH_DATA) {
  const tmp = path.join(process.env.TEMP || process.env.TMP || '.', 'pkgdbverify')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const ex = spawnSync(SEVENZIP, ['e', outFile, `${DELIVER_NAME}\\agent-core\\data\\agent.db`, `-o${tmp}`, '-y'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
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
// 这条只防「7z 的排除规则误伤了本该进包的空目录」。
// 全新交付目录（不含 .git、还没跑过服务）本来就没有这些目录，不能当成误伤。
const hasCollectorLogs = fs.existsSync(path.join(DELIVER, 'collector', 'logs'))
const hasGitLogs = fs.existsSync(path.join(DELIVER, '.git', 'logs'))
if (hasCollectorLogs && !needCollectorLogs) die('包内缺少 collector\\logs（交付目录里有，却被排除规则误伤）')
if (hasGitLogs && !needGitLogs) die('包内缺少 .git\\logs（交付目录里有，却被排除规则误伤）')

// 2026-11-03 事故：打包脚本按**目录名**跳过 `data`，把 `agent-core/src/data/`（体位数据）一起跳掉了，
// 包一启动就 ERR_MODULE_NOT_FOUND，而当时所有校验都是绿的（只查固定条目 + DB + 使用说明）。
// 这里改成"**源码模块必须在包内**"的硬断言：这些是启动链路上真实 import 的文件，缺一个就拒绝交付。
{
  // ⚠️ 统一用**正斜杠**比较：7z 的 listing 用反斜杠，写成 'agent-core\src\data\x.js' 时
  // `\s` `\d` `\n` 在 JS 字符串里是转义序列，会把反斜杠吃掉 ⇒ 断言永远找不到文件、
  // 明明包是好的却被判死（2026-11-03 真踩：误报"包内缺少启动必需的源码"）。
  const plainSlash = plain.split('\\').join('/')
  const requiredSources = [
    'agent-core/src/data/sexPositions.js',
    'agent-core/src/data/sexPositionsExtra.js',
    'agent-core/src/data/positionPoseSkeletons.js',
    'agent-core/src/services/positionPose.js',
    'agent-core/src/services/poseControl.js',
    'agent-core/app.js',
    'runtime/nodejs/node.exe',
  ]
  const missing = requiredSources.filter((f) => !plainSlash.includes(f))
  if (missing.length) die(`包内缺少启动必需的源码/运行时（${missing.join('、')}）⇒ 解压后必然起不来，拒绝交付`)
  log(`   启动必需文件：${requiredSources.length} 项全在包内 ✓`)
}

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
  let envCheck
  try { envCheck = inspectReleaseEnv(plain, keepEnv) } catch (error) { die(error.message) }
  const { envInPkg, exampleInPkg } = envCheck
  if (envInPkg) {
    // 2026-11-04：PACK_KEEP_ENV=1 是**明确的"我要带 Key 的自用包"**，此时不该中止 ——
    // 不带 .env 的话 LLM 全线报 OPENAI_API_KEY is missing，那才是用户说的"又有报错"。
    // 但仍要**大声警告**：这种包绝不能外发。
    if (keepEnv) {
      log('   ⚠️ 包内含 agent-core\\.env（真实 API Key）—— PACK_KEEP_ENV=1 的自用包，**不要外发**')
    } else {
      die('包内含 agent-core\\.env（真实 API Key）⇒ 交付链剥离失败，拒绝交付')
    }
  } else {
    log(`   agent-core\\.env 不在包内 ✓（.env.example 在包内=${exampleInPkg}）`)
  }
  if (!exampleInPkg) log('   ⚠️ 包内没有 .env.example —— 换机器的人没有配置模板可参考（不阻断，建议补）')

  // `launcher_config.json`（2026-10-18 补）：它是启动器的本机用户配置，`comfyui_exe` 指向
  // **打包这台机器**的路径。包内若带它，别人一开启动器就指到不存在的地址。
  // 匹配 `3.6.2-r\launcher_config.json`（仓库根那份）；顺带挡 `agent-core\` 下的误放。
  const esc = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lcInPkg = new RegExp(`${esc(DELIVER_NAME)}\\\\launcher_config\\.json(?:\\s|$)`, 'm').test(plain)
    || new RegExp(`${esc(DELIVER_NAME)}\\\\agent-core\\\\launcher_config\\.json(?:\\s|$)`, 'm').test(plain)
  if (lcInPkg) die('包内含 launcher_config.json（含打包机器的 ComfyUI 绝对路径）⇒ 交付链剥离失败，拒绝交付')
  log('   launcher_config.json 不在包内 ✓（缺失即全新用户初始状态：启动器会自动写默认配置）')
}

const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1)
let sha
try {
  sha = await sha256File(outFile)
} catch (error) {
  log(`   候选包已生成但 SHA256 读取失败：${error.message}`)
  die('最终包哈希未取得，不能交付')
}
log('\n══════════════════════════════════════════════════════')
log(` 产出：${path.basename(outFile)}`)
log(` 体积：${sizeMb} MB`)
log(` SHA256：${sha}`)
log(` 静态检查：project-health + check-imports ✓`)
log(` 前端构建：生产构建 ✓`)
log(` 生图冒烟：${smokeStatus}`)
log('══════════════════════════════════════════════════════')
log('\n⚠️ 还剩最后一步（手跑，需要等解压与启动）：')
log(`   解压 → 起 vector-service(${VECTOR_SERVICE_URL}) 与 agent-core(:${API_PORT}) → 抽查 /api/health 与 /api/characters`)
log('   隔离验收请显式使用独立的 DELIVER_DIR / OUT_DIR / TEMP、:memory: 与临时媒体目录；不要写入玩家实例。')
// 2026-11-06：第 69 轮包曾经把「每张图都 opts is not defined」的回归打出去过 ——
// 上面所有校验都只看文件与接口，没有一步真的生成一张图。生图冒烟必须单独跑。
log('   另外务必跑一次生图冒烟（十几秒，能挡住"接口全活、生图全挂"这类回归）：')
log('     node scripts/发布-校验并打包.mjs --gates-only --with-smoke')
log('     退出码 0=真实出图 / 2=ComfyUI 未开（环境阻塞）/ 1=代码链路有错')
