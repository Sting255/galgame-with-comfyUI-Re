/**
 * tag.mjs — 本地候选与公开推送分开执行
 *
 *   $ npm run tag:local -- v4.5.0-f        # 创建本地候选，不联网
 *   $ npm run tag:local -- --dry-run       # 只打印本地计划
 *   $ npm run tag -- --push-only v4.5.0-f  # 验收后显式公开已有候选
 *   $ npm run tag                          # 默认也只创建本地候选
 *
 * 自动版本号：本仓 tag 有两段结构 —— 上游带来的 `vX.Y.Z`，和本地迭代的
 * `vX.Y.Z-<字母>`（v4.3.1-a … v4.3.1-j）。最新 tag 带字母后缀时自动 +1 个字母
 * （i → j），否则 patch+1。以前这里只做 patch+1，从 v4.3.1-i 会跳到 v4.3.2，
 * 与上游 base 版本脱节。
 *
 * 推送目标：自己的 fork（remote `mine`），可用 PUSH_REMOTE 覆盖。上游 `origin`
 * 是只读镜像，本机没有写权限：旧版脚本写死 origin，每次都在最后一步失败，
 * v4.3.1-a ~ -j 实际全靠手工 `git push mine`。分支映射见 lib/pushRemote.mjs
 * （`local` → fork 的 `main`，其余同名）。
 *
 * 流程:
 *   0. 检查更新说明是否变化 → 变化则刷新标志位
 *   1. vite build 打包前端
 *   2. 解析版本号（自动接续或手动指定）
 *   3. 工作区脏 → 自动提交；工作区干净 → 直接打 tag
 *   4. 创建附注 tag；发布必须另外执行 --push-only，不 fetch、不隐式推送
 *
 * 关于更新说明标志位:
 *   web-ui/src/data/changelog.js 里有一行 `export const CHANGELOG_FLAG = '...'`。
 *   本脚本对「该文件除标志位行以外的内容」取哈希，与当前标志位比对，
 *   不一致就改写标志位。前端据此判断：标志位和浏览器里存的不一样 → 弹一次更新说明。
 *   所以想让用户重新看到弹窗，只需要改 changelog.js 的文案，不必手动碰标志位。
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePushRemote, resolvePushRefspec } from "./lib/pushRemote.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const C = {
  reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

function sh(cmd, opts = {}) {
  try {
    const result = execSync(cmd, {
      cwd: ROOT, encoding: "utf8", windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"], ...opts,
    });
    return result ? result.trim() : "";
  } catch (e) {
    die(`命令执行失败: ${cmd}\n  ${e.stderr?.trim() || e.message}`);
  }
}

function exec(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT, encoding: "utf8", windowsHide: true,
    stdio: "inherit",
  });
  if (result.error) die(`${cmd} 执行失败: ${result.error.message}`);
  if (result.status !== 0) die(`${cmd} 退出码 ${result.status}`);
}

function execShell(cmdStr) {
  try {
    execSync(cmdStr, {
      cwd: ROOT, encoding: "utf8", windowsHide: true,
      stdio: "inherit",
    });
  } catch {
    die(`执行失败: ${cmdStr}`);
  }
}

function log(msg)  { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ${C.green}✓ ${msg}${C.reset}`); }
function die(msg)  { console.error(`  [ERROR] ${msg}`); process.exit(1); }

// ── 解析参数 ──

const args = process.argv.slice(2);
let manualVersion = null;
let manualMessage = null;
let dryRun = false;
let local = false;
let pushOnly = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--dry-run" || arg === "-n") {
    dryRun = true;
  } else if (arg === "--local") {
    local = true;
  } else if (arg === "--push-only") {
    pushOnly = args[++i];
    if (!/^v?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/.test(pushOnly || "")) {
      die("--push-only 后必须指定已有的版本 tag");
    }
    if (!pushOnly.startsWith("v")) pushOnly = `v${pushOnly}`;
  } else if (arg.startsWith("-")) {
    die(`未知参数: ${arg}`);
  } else if (/^v?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/i.test(arg)) {
    // 只有「长得像版本号」的参数才当版本：旧判定是 startsWith('v') || 数字开头，
    // 于是任何以 v 开头的注释（如 "v4.3.1-k：发布链改推 fork"）都被当成版本号，
    // git tag 直接报 not a valid tag name。
    manualVersion = arg.startsWith("v") ? arg : `v${arg}`;
  } else {
    manualMessage = arg;
  }
}

if (pushOnly && (local || manualVersion || manualMessage)) {
  die("--push-only 不能与 --local、候选版本号或注释混用");
}

if (pushOnly) {
  // 公开动作不刷新文案、不构建、不自动提交；只发布已经验收过的同一个提交。
  const branch = sh("git rev-parse --abbrev-ref HEAD");
  if (branch !== "local") die("发布必须在 local 分支执行");
  if (sh("git status --porcelain")) die("工作区不干净，拒绝公开推送");
  const head = sh("git rev-parse HEAD");
  const tagged = sh(`git rev-parse --verify "refs/tags/${pushOnly}^{commit}"`);
  if (tagged !== head) die(`${pushOnly} 不指向 local 的 HEAD，拒绝推送`);
  let target;
  try { target = resolvePushRemote(ROOT); } catch (error) { die(error.message); }
  const refspec = resolvePushRefspec(branch);
  if (dryRun) {
    log(`(dry-run) 将原子推送 ${refspec} 和 ${pushOnly} → ${target.name}`);
  } else {
    // 同时成功或同时失败；不会出现分支已公开而 tag 推送失败的半发布状态。
    pushWithRetry(["--atomic", target.name, refspec, `refs/tags/${pushOnly}:refs/tags/${pushOnly}`], "版本");
    ok(`${pushOnly} 已推送到 ${target.name}`);
  }
  process.exit(0);
}

if (dryRun) log(`${C.yellow}--dry-run：只打印本地计划，不做任何改动${C.reset}`);

// ── 0. 更新说明标志位 ──
// 必须早于 vite build（标志位会被打进前端包），也必须早于下面的自动提交（改动要进版本库）。

const CHANGELOG_FILE = resolve(ROOT, "web-ui/src/data/changelog.js");
const CHANGELOG_SKIP = Symbol("skip");
const FLAG_LINE_RE = /^export const CHANGELOG_FLAG = .*$/m;
const FLAG_VALUE_RE = /^export const CHANGELOG_FLAG = ['"]([^'"]*)['"]/m;

console.log();
log("检查更新说明...");

let changelogSource = CHANGELOG_SKIP;
try {
  changelogSource = readFileSync(CHANGELOG_FILE, "utf-8");
} catch {
  log(`${C.dim}未找到 web-ui/src/data/changelog.js，跳过标志位检查${C.reset}`);
}

if (changelogSource !== CHANGELOG_SKIP) {
  // 哈希口径：剔掉标志位行本身，统一换行符、去掉行尾空白。
  // 这样只有文案真的变了才换标志位 —— 编辑器换行风格差异、文件末尾增减空行都不算。
  const content = changelogSource
    .replace(/\r\n/g, "\n")
    .replace(FLAG_LINE_RE, "")
    .replace(/[ \t]+$/gm, "")
    .trim();

  const nextFlag = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
  const currentFlag = changelogSource.match(FLAG_VALUE_RE)?.[1] || "";

  if (nextFlag === currentFlag) {
    ok(`更新说明未变化，标志位保持 ${currentFlag}`);
    log(`${C.dim}（本次如果有面向用户的改动，记得往 changelog.js 里补一条）${C.reset}`);
  } else if (dryRun) {
    log(`(dry-run) 更新说明有变化，标志位 ${currentFlag || "(空)"} → ${nextFlag}（未写入）`);
  } else {
    writeFileSync(
      CHANGELOG_FILE,
      changelogSource.replace(FLAG_LINE_RE, `export const CHANGELOG_FLAG = '${nextFlag}'`),
      "utf-8",
    );
    ok(`更新说明有变化，标志位 ${currentFlag || "(空)"} → ${nextFlag}`);
    log(`${C.dim}老用户下次打开会看到更新说明弹窗${C.reset}`);
  }
}

// ── 1. vite build ──

console.log();
if (dryRun) {
  log("(dry-run) 跳过 vite build");
} else {
  log("vite build...");
  execShell("cd web-ui && npm run build");
  ok("vite build 完成");
}

// ── 2. 获取最新 tag ──

let latestTag = "";
try {
  latestTag = execSync("git describe --tags --abbrev=0", {
    cwd: ROOT, encoding: "utf8", windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {
  latestTag = "v0.0.0";
}

const match = latestTag.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([a-z]))?$/i);
let major = 1, minor = 0, patch = 0;
let suffix = "";
if (match) {
  major = parseInt(match[1]);
  minor = parseInt(match[2]);
  patch = parseInt(match[3]);
  suffix = (match[4] || "").toLowerCase();
}

// 最新 tag 带字母后缀 → 接下一个字母（i → j）；否则 patch+1。
// 后缀到 z 时退回 patch+1（不会生成 `v4.3.1-{` 这种非法 tag）。
const autoVersion = (suffix && suffix < "z")
  ? `v${major}.${minor}.${patch}-${String.fromCharCode(suffix.charCodeAt(0) + 1)}`
  : `v${major}.${minor}.${patch + 1}`;

const newVersion = manualVersion || autoVersion;
log(`版本: ${latestTag} → ${C.cyan}${newVersion}${C.reset}`);

// ── 3. 获取注释 ──

const tagMessage = manualMessage || sh("git log -1 --format=%s");
log(`注释: ${tagMessage}`);

// ── 写入 VERSION 文件 ──
// VERSION 只写 base x.y.z：发布门禁（build-release 预检）要求它和启动器 __version__
// 都是纯 x.y.z，本地迭代后缀只存在于 tag 名。旧版这里写整串 "4.3.1-j"，
// 打完 tag 再打包会被预检直接拒掉。精确版本号由发布包里的 BUILD_TAG 承担。
const baseVersion = newVersion.match(/^v?(\d+\.\d+\.\d+)/)?.[1] || newVersion.replace(/^v/, "");
if (dryRun) {
  log(`(dry-run) VERSION 将写为 ${baseVersion}（tag 为 ${newVersion}）`);
} else {
  writeFileSync(resolve(ROOT, "VERSION"), baseVersion + "\n", "utf-8");
  log(`VERSION 文件已更新: ${baseVersion}（tag: ${newVersion}）`);
}

// ── 4. 检查工作区状态 ──

const status = sh("git status --porcelain");
const isDirty = status.length > 0;

if (isDirty) {
  const commitMsg = `【${newVersion}】${tagMessage}`;
  if (dryRun) {
    log(`(dry-run) 工作区有 ${status.split("\n").length} 项变更，将自动提交: ${commitMsg}`);
  } else {
    log(`工作区有变更，自动提交: ${commitMsg}`);
    exec("git", ["add", "."]);
    exec("git", ["commit", "-m", commitMsg]);
    ok("提交完成");
  }
} else {
  ok("工作区干净，跳过提交");
}

// ── 5. 只创建本地 tag ──

if (dryRun) {
  log(`(dry-run) 将创建 tag: ${newVersion}`);
} else {
  log(`创建 tag: ${newVersion}`);
  exec("git", ["tag", "-a", newVersion, "-m", tagMessage]);
  ok(`tag ${newVersion} 创建完成`);
}

// ── 显式公开推送时的重试机制 ──

function pushWithRetry(pushArgs, label) {
  // 3 次：本机走 Clash 代理，偶发 TLS 握手失败，2 次（5s/10s）窗口太窄
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = spawnSync("git", [
        "-c", "http.postBuffer=524288000",
        "push", ...pushArgs,
      ], {
        cwd: ROOT, encoding: "utf8", windowsHide: true,
        stdio: "inherit",
      });
      if (result.status === 0) return;
      throw new Error(`退出码 ${result.status}`);
    } catch (e) {
      if (attempt < maxRetries) {
        const wait = attempt === 1 ? 5 : 10;
        log(`${label} 推送失败 (${e.message})，${wait} 秒后重试...`);
        execSync(`ping -n ${wait} 127.0.0.1 >nul`, { stdio: "ignore" });
      } else {
        die(`${label} 推送失败，已重试 ${maxRetries - 1} 次`);
      }
    }
  }
}

if (dryRun) {
  log(`${C.yellow}--dry-run 结束，未做任何改动${C.reset}`);
  process.exit(0);
}

console.log();
console.log(`  ${C.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
console.log(`  ${C.green}  ${newVersion}  本地候选已创建${C.reset}`);
console.log(`  ${C.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
console.log();
console.log(`  下一步: ${C.yellow}npm run release${C.reset}`);
console.log(`  验收后推送命令: npm run tag -- --push-only ${newVersion}`);
console.log();
