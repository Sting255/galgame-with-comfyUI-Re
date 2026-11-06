/**
 * worktree-remove.mjs — **安全地**移除 git 工作树（2026-10-19 补，为一次真实事故）
 *
 *   $ node scripts/worktree-remove.mjs <worktree-path>          # 干跑（默认，只看不动）
 *   $ node scripts/worktree-remove.mjs <worktree-path> --yes    # 真删
 *
 * ── 为什么必须用它，而不是直接 `git worktree remove` ──────────────────────
 *
 * **2026-10-19 事故（真实发生，代价约 40 分钟 + 一次全项目排查）**：
 *   我在收口 C4 工作树时执行 `git worktree remove .c4-merge-v391 --force`，
 *   随后**主树的 `agent-core/node_modules` 与 `web-ui/node_modules` 双双被清空**
 *   （时间戳 08:14:33 / 08:14:37，正好是那条命令的时刻）。
 *   全量测试立刻从 `2319 / 0 fail` 掉到 `556 tests / 295 fail`，
 *   前端 `591 tests / 63 fail` —— **全是文件级加载失败**（`Cannot find package
 *   'better-sqlite3'`），而不是代码回归（当时 HEAD 未变、测试文件未变）。
 *
 * 恢复过程本身也是个坑：`npm ci` 之后 prebuilt 的 `better_sqlite3.node` 是按
 * PATH 上的 node v25 下载的（`NODE_MODULE_VERSION 141`），与 runtime 的 v22.18
 * （`127`）不符 ⇒ 还要再 `npm.cmd rebuild better-sqlite3`，
 * 且 **npm 必须在「runtime node 优先」的 PATH 下跑**。
 *
 * ── 这个脚本防什么 ────────────────────────────────────────────────────────
 *
 * 不假设事故的确切机制（当时的 junction 已随工作树一起消失，无法事后取证），
 * 而是做成**对任何机制都成立**的三道闸：
 *
 *   **闸 1 · 删前快照**：列出工作树里的 `node_modules`，逐个判定它是不是
 *     junction / symlink，并**解析出真实目标**。只要发现**任何一个指向工作树之外**
 *     （尤其指向主树），立刻停手并打印该怎么办 —— 因为删它极可能连带毁掉目标。
 *
 *   **闸 2 · 拒绝 force**：`--force` 正是当年那条命令里的开关。本脚本**不提供**
 *     force 语义：工作树脏就报错并列出脏文件，让人自己决定（而不是替人下决心）。
 *
 *   **闸 3 · 删后校验**：删完立刻检查**主树的依赖树还在不在**
 *     （`agent-core/node_modules/better-sqlite3` 与 `web-ui/node_modules/vue`），
 *     少一个就红着脸告诉你恢复命令。
 *
 * ── 为什么闸 3 是必要的（闸 1 不够）────────────────────────────────────────
 *
 * 闸 1 只看得见"能看见的链接"。如果事故机制是 git 自己按 `.git` 里的记录去删
 * （不经过我们的遍历），闸 1 就漏了。所以**删完必须回头验主树** ——
 * 这是唯一能对"未知机制"兜底的办法，也正是我当年事后才发现问题的地方。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dirname, '..')

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m',
}
const log = (s = '') => console.log(s)
const die = (msg) => { log(`\n${C.red}${msg}${C.reset}\n`); process.exit(1) }

/** 找仓库自带的 git */
function resolveGit() {
  const exe = process.platform === 'win32' ? 'git.exe' : 'git'
  for (const rel of [join('runtime', 'git', 'cmd', exe), join('runtime', 'git', 'bin', exe)]) {
    const p = join(ROOT, rel)
    if (existsSync(p)) return p
  }
  return 'git'
}
const GIT = resolveGit()

function git(args, opts = {}) {
  return spawnSync(GIT, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

/**
 * 判定一个路径是不是链接（junction / symlink），并返回解析后的真实目标。
 * Windows 上 junction 的 Attributes 含 ReparsePoint，lstatSync 能看出
 * 它是链接而不是普通目录。
 */
function inspectLink(abs) {
  try {
    const st = lstatSync(abs)
    const isLink = st.isSymbolicLink()
      || Boolean(st.attributes && (st.attributes & 0x400))   // FILE_ATTRIBUTE_REPARSE_POINT
    let target = null
    if (isLink) {
      try { target = readlinkSync(abs) } catch { target = null }
    }
    return { exists: true, isLink, target, isDir: st.isDirectory() }
  } catch {
    return { exists: false, isLink: false, target: null, isDir: false }
  }
}

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const doIt = argv.includes('--yes')
const targetArg = argv.find((a) => !a.startsWith('--'))

if (!targetArg) {
  die(`用法：\n  node scripts/worktree-remove.mjs <worktree-path>          # 干跑（默认）\n`
    + `  node scripts/worktree-remove.mjs <worktree-path> --yes    # 真删\n\n`
    + `当前工作树：\n${(git(['worktree', 'list']).stdout || '').trim().split('\n').map((l) => '  ' + l).join('\n')}`)
}

const target = resolve(ROOT, targetArg)
const targetName = basename(target)

log(`${C.bold}安全移除工作树${C.reset}  ${C.dim}${doIt ? '（真删模式）' : '（干跑——什么都不会动）'}${C.reset}`)
log(`  目标：${target}`)
log(`  主树：${ROOT}`)
log()

// ── 前置：目标必须在 git 的工作树清单里 ───────────────────────────────────
const wl = git(['worktree', 'list', '--porcelain'])
if (wl.status !== 0) die(`git worktree list 失败：\n${wl.stderr}`)
const worktrees = (wl.stdout || '').split(/\r?\n\r?\n/)
  .map((blk) => (blk.match(/^worktree (.+)$/m) || [])[1])
  .filter(Boolean)
  .map((p) => resolve(p))

const isMain = resolve(worktrees[0] || '') === target
if (isMain) die(`❌ 拒绝：${target} 是**主工作树**，不能删。`)

if (!worktrees.includes(target)) {
  log(`${C.yellow}⚠ 目标不在 git 的工作树清单里。${C.reset}`)
  log(`${C.dim}  已知工作树：${worktrees.join(' / ')}${C.reset}`)
  if (!existsSync(target)) die(`❌ 目标目录也不存在，没什么可删的。`)
  log(`${C.yellow}  目录存在但 git 不认识它 ⇒ 可能是残留目录，请人工确认后再处理。${C.reset}`)
  process.exit(1)
}

log(`${C.cyan}── 闸 1：删前快照 · 找依赖链接 ────────────────────────${C.reset}`)

/**
 * 在工作树里找所有 node_modules（限定深度，避免遍历整棵树）。
 * 同时把「它是不是指向外面的链接」判定出来。
 */
function findNodeModules(worktree) {
  const found = []
  const roots = ['', 'agent-core', 'web-ui', 'e2e', 'vector-service', 'launcher']
  for (const rel of roots) {
    const nm = join(worktree, rel, 'node_modules')
    const info = inspectLink(nm)
    if (info.exists) found.push({ rel: rel || '.', abs: nm, ...info })
  }
  return found
}

const depLinks = findNodeModules(target)
if (!depLinks.length) {
  log(`${C.dim}  工作树里没有 node_modules（无依赖链接）${C.reset}`)
} else {
  log(`  发现 ${depLinks.length} 个 node_modules：`)
  for (const d of depLinks) {
    const kind = d.isLink ? `${C.red}${C.bold}链接${C.reset}` : '普通目录'
    const cnt = (() => {
      try { return readdirSync(d.abs).length } catch { return '?' }
    })()
    log(`    ${d.rel.padEnd(18)} ${kind}  条目=${cnt}`)
    if (d.isLink) {
      log(`      ${C.red}→ 目标：${d.target}${C.reset}`)
      const escapes = d.target && !resolve(d.target).startsWith(target)
      log(`      ${escapes
        ? `${C.red}${C.bold}⚠ 指向工作树之外！删除它极可能连带毁掉目标（这正是 2026-10-19 事故的形态）${C.reset}`
        : `${C.dim}指向工作树内部${C.reset}`}`)
    }
  }
}

const risky = depLinks.filter((d) => d.isLink && d.target && !resolve(d.target).startsWith(target))
if (risky.length) {
  die(`${C.red}❌ 闸 1 拦截：工作树里有 ${risky.length} 个依赖链接指向外部：${C.reset}\n`
    + risky.map((d) => `     ${d.rel}/node_modules  →  ${d.target}`).join('\n')
    + `\n\n${C.bold}怎么办（任选，按推荐排序）：${C.reset}\n`
    + `  1) ${C.green}先删链接、再删工作树${C.reset}（最稳）：\n`
    + risky.map((d) => `       cmd /c rmdir "${d.abs}"`).join('\n')
    + `\n     然后再跑本脚本（此时闸 1 会放行）\n`
    + `  2) 直接删工作树目录而不是用 git（绕开 git 的清理逻辑）：\n`
    + `       ${C.dim}仅在你确认不需要 git 清理缓存时使用${C.reset}\n`
    + `  3) 若你确信链接目标是可再生的（如 node_modules 随时可 npm ci 重装），\n`
    + `     也仍建议走 1) —— 重装要跑 npm ci + rebuild，比重建链接慢得多。\n`)
}

log(`${C.green}  ✓ 闸 1 通过${C.reset}（没有指向外部的依赖链接）`)

// ── 闸 2：不提供 force。脏就停下来让人看 ──────────────────────────────────
log(`\n${C.cyan}── 闸 2：工作树必须干净（本脚本不提供 --force）─────────${C.reset}`)
const st = spawnSync(GIT, ['-C', target, 'status', '--porcelain'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const dirty = (st.stdout || '').split(/\r?\n/).filter((l) => l.trim())
if (dirty.length) {
  log(`${C.yellow}  工作树有 ${dirty.length} 条未提交改动：${C.reset}`)
  for (const l of dirty.slice(0, 15)) log(`    ${l}`)
  if (dirty.length > 15) log(`    ${C.dim}… 其余 ${dirty.length - 15} 条${C.reset}`)
  die(`${C.red}❌ 闸 2 拦截：工作树不干净。${C.reset}\n`
    + `  本脚本**故意不提供 --force**：${C.bold}--force 正是 2026-10-19 事故那条命令里的开关${C.reset}。\n`
    + `  请先决定这些改动怎么办（提交 / 挑出来 / 确实要丢弃），再回来删。\n`
    + `  ${C.dim}若这些改动你已经处理过，用 git -C "${target}" stash 或 commit 清干净即可。${C.reset}\n`)
}
log(`${C.green}  ✓ 闸 2 通过${C.reset}（工作树干净）`)

// ── 干跑到此为止 ──────────────────────────────────────────────────────────
if (!doIt) {
  log(`\n${C.bold}干跑结束 —— 三个闸都放行了。${C.reset}`)
  log(`  要真删，重跑并加 ${C.green}--yes${C.reset}：`)
  log(`    ${C.dim}node scripts/worktree-remove.mjs "${targetArg}" --yes${C.reset}`)
  log(`\n  ${C.dim}注意：真删时若 git 自带清理失败，脚本会退到「只删目录、保留 git 登记」，${C.reset}`)
  log(`  ${C.dim}并提示你用 git worktree prune 收尾。${C.reset}`)
  process.exit(0)
}

// ── 真删 ──────────────────────────────────────────────────────────────────
log(`\n${C.cyan}── 执行删除 ──────────────────────────────────────────${C.reset}`)
// ⚠️ 不用 `--force`：上面闸 2 已经保证干净，正常删应当成功。
let rm = git(['worktree', 'remove', target])
if (rm.status !== 0) {
  log(`${C.yellow}  git worktree remove 失败，改为「只删目录」：${C.reset}`)
  log(`    ${C.dim}${(rm.stderr || '').trim().split('\n')[0]}${C.reset}`)
  rm = spawnSync(process.platform === 'win32' ? 'cmd' : 'rm',
    process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', target] : ['-rf', target],
    { encoding: 'utf8' })
  if (rm.status !== 0) die(`❌ 目录也没删掉：\n${rm.stderr || ''}`)
  const pr = git(['worktree', 'prune'])
  log(`  ${C.dim}git worktree prune → ${pr.status === 0 ? 'ok' : (pr.stderr || '').trim()}${C.reset}`)
}
log(`${C.green}  ✓ 已删除：${target}${C.reset}`)

// ── 闸 3：删后校验主树依赖还在 ────────────────────────────────────────────
log(`\n${C.cyan}── 闸 3：删后校验主树依赖树 ──────────────────────────${C.reset}`)
const MAIN_CHECKS = [
  { rel: 'agent-core/node_modules/better-sqlite3', why: '主树后端原生依赖（事故就是它没了）' },
  { rel: 'agent-core/node_modules/express', why: '主树后端依赖' },
  { rel: 'web-ui/node_modules/vue', why: '主树前端依赖（事故也波及它）' },
  { rel: 'web-ui/node_modules/vite', why: '主树前端构建链' },
]
const missing = MAIN_CHECKS.filter((c) => !existsSync(join(ROOT, c.rel)))
for (const c of MAIN_CHECKS) {
  const ok = !missing.includes(c)
  log(`  ${ok ? `${C.green}✓` : `${C.red}✗`}${C.reset} ${c.rel}  ${C.dim}${c.why}${C.reset}`)
}

if (missing.length) {
  die(`${C.red}${C.bold}❌ 闸 3 拦截：删完工作树后，主树依赖树缺了 ${missing.length} 项！${C.reset}\n`
    + `   这说明删除动作**破坏了主树**（与 2026-10-19 事故同一形态）。\n\n`
    + `${C.bold}立即恢复（按顺序，别跳）：${C.reset}\n`
    + `  1) 让 PATH 里的 runtime node 优先（否则原生模块会按错误的 ABI 下载）：\n`
    + `       ${C.dim}$env:PATH = "${join(ROOT, 'runtime', 'nodejs')};$env:PATH"${C.reset}\n`
    + `  2) 装回依赖：\n`
    + `       ${C.dim}cd agent-core; <runtime>/nodejs/npm.cmd ci --no-audit --no-fund${C.reset}\n`
    + `       ${C.dim}cd web-ui;     <runtime>/nodejs/npm.cmd ci --no-audit --no-fund${C.reset}\n`
    + `  3) ${C.bold}重建原生模块${C.reset}（npm ci 下到的 prebuilt 可能是别的 ABI）：\n`
    + `       ${C.dim}cd agent-core; <runtime>/nodejs/npm.cmd rebuild better-sqlite3${C.reset}\n`
    + `  4) 验一次加载（别只看 exit 0）：\n`
    + `       ${C.dim}<runtime>/nodejs/node.exe -e "require('better-sqlite3')"${C.reset}\n`
    + `  5) 跑全量：\n`
    + `       ${C.dim}npm test${C.reset}\n`)
}

log(`${C.green}  ✓ 闸 3 通过${C.reset}（主树依赖树完整）`)
log(`\n${C.green}${C.bold}工作树已安全移除，主树完好。${C.reset}`)
log(`  ${C.dim}建议再跑一次 npm test 确认全量仍绿。${C.reset}\n`)
