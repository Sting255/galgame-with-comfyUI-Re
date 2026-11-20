#!/usr/bin/env node
/**
 * 上游同步（2026-11-06）
 *
 * 背景：本仓库的 git 历史曾被重建，与上游没有共同祖先，所以每次跟上游都只能
 * `git diff 旧tag..新tag` 打补丁，14 个文件 24 处冲突全靠手工挑边。2026-11-06 已经
 * 把结构改成「upstream 纯净跟踪 + local 叠加本地改动」，两者有共同祖先，
 * 以后正常 `git merge` 即可。
 *
 * 分支约定：
 *   upstream  只读镜像，永远等于上游某个发布标签，不改
 *   local     本地改动，父提交链挂在上游标签之上
 *   archive/* 历史存档，不参与日常流程
 *
 * 用法：
 *   node scripts/上游-同步.mjs              拉取上游最新标签并合进 local
 *   node scripts/上游-同步.mjs --tag v4.2.2  指定标签
 *   node scripts/上游-同步.mjs --dry-run     只看会做什么，不动仓库
 *
 * 冲突时脚本会停下并打印冲突文件；解决后 `git add` + `git commit` 收尾。
 * 不懂 git 时**不要**在这个状态下继续执行本脚本。
 */

import { execFileSync } from 'node:child_process';

const UPSTREAM_BRANCH = 'upstream';
const LOCAL_BRANCH = 'local';
const UPSTREAM_REMOTE = 'origin';

function git(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.stdout || '').toString().trim();
    throw new Error(`git ${args.join(' ')} 失败：${detail || err.message}`);
  }
}

function say(msg) { console.log(`[上游同步] ${msg}`); }
function warn(msg) { console.log(`[上游同步] ⚠ ${msg}`); }

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const tagIdx = argv.indexOf('--tag');
const wantedTag = tagIdx >= 0 ? argv[tagIdx + 1] : '';

/**
 * 预览只读查询远端的正式发布标签（2026-11-09 方案 A14）。
 *
 * 原来从**本地全部标签**里筛最新 —— 本地可能残留自己打过、上游根本没有的标签
 * （本仓历史上有过 v4.2.2-a 这类 fork 标签），把它当上游发布就会瞄错目标。
 * 现在优先问远端；问不到才退回本地，并明确说明用的是缓存信息。
 *
 * @returns {{tag:string, commit:string, source:'remote'|'cache'|'local', note:string}}
 */
function resolveLatestVTag({ allowFetch = true } = {}) {
  const parse = (raw) => {
    const tags = String(raw || '').split('\n')
      .map(line => line.trim().split(/\s+/).pop() || '')
      .filter(t => /^v\d+\.\d+\.\d+$/.test(t.replace(/^refs\/tags\//, '')))
      .map(t => t.replace(/^refs\/tags\//, ''));
    if (tags.length === 0) return '';
    tags.sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number);
      const pb = b.slice(1).split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    });
    return tags[tags.length - 1];
  };

  // 1) 直接问远端有哪些发布标签（只读，不改本地 refs）
  if (allowFetch) {
    const remoteTags = git(['ls-remote', '--tags', UPSTREAM_REMOTE, 'v*'], { allowFail: true });
    const tag = parse(remoteTags);
    if (tag) {
      const remoteCommit = git(['rev-parse', `${UPSTREAM_REMOTE}/${tag}^{commit}`], { allowFail: true });
      return { tag, commit: remoteCommit || '', source: remoteCommit ? 'remote' : 'cache',
        note: remoteCommit ? '来自远端' : '远端标签已拿到，但本地还没有对应提交（fetch 被标签冲突挡住？）' };
    }
    // 远端问不到（离线 / 网络故障）→ 用本地标签，并说明是缓存
    const localTag = parse(git(['tag', '-l', 'v*'], { allowFail: true }));
    if (localTag) return { tag: localTag, commit: '', source: 'cache', note: '远端不可达，用的是本地缓存标签' };
    return { tag: '', commit: '', source: 'local', note: '' };
  }
  const localTag = parse(git(['tag', '-l', 'v*'], { allowFail: true }));
  return { tag: localTag, commit: '', source: 'local', note: 'dry-run 未查询远端' };
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || '';
}

// ── 前置检查 ──
const dirty = git(['status', '--porcelain'], { allowFail: true });
if (dirty && !dryRun) {
  warn('工作区有未提交改动，先提交或 stash 再跑，避免把无关改动卷进合并提交');
  console.log(dirty.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}

for (const branch of [UPSTREAM_BRANCH, LOCAL_BRANCH]) {
  if (!git(['rev-parse', '--verify', branch], { allowFail: true })) {
    warn(`没有 ${branch} 分支。首次使用请按 AGENTS.md「分支结构与上游同步」初始化`);
    process.exit(1);
  }
}

// ── 1. 拉上游 ──
say(`fetch ${UPSTREAM_REMOTE} --tags${dryRun ? '（dry-run 跳过）' : ''}`);
if (!dryRun) {
  git(['fetch', UPSTREAM_REMOTE, '--tags']);
  // 标签冲突（本地已存在同名但内容不同的标签）不致命，提示一下继续
}

const target = wantedTag || (() => {
  const resolved = resolveLatestVTag({ allowFetch: !dryRun });
  if (resolved.note) say(`版本基线来源：${resolved.note}`);
  return resolved.tag;
})();
if (!target) {
  warn('没有找到 vX.Y.Z 形式的发布标签');
  process.exit(1);
}
const targetCommit = git(['rev-parse', `${target}^{commit}`], { allowFail: true });
if (!targetCommit) {
  warn(`标签 ${target} 在本地不存在（fetch 可能被标签冲突挡住了）`);
  process.exit(1);
}

const upstreamHead = git(['rev-parse', UPSTREAM_BRANCH]);
const localHead = git(['rev-parse', LOCAL_BRANCH]);
say(`目标 ${target} (${targetCommit.slice(0, 8)})，upstream 当前 ${upstreamHead.slice(0, 8)}，local 当前 ${localHead.slice(0, 8)}`);

if (upstreamHead === targetCommit) {
  say('upstream 已经是这个版本，无需更新');
}

// ── 2. 对齐 upstream 分支 ──
const startBranch = currentBranch();
if (!dryRun) {
  git(['checkout', UPSTREAM_BRANCH]);
  // upstream 是只读镜像：直接对齐到目标标签，不做 merge
  git(['reset', '--hard', targetCommit]);
  say(`upstream 已对齐到 ${target}`);
}

// ── 3. 比较 local 与**目标提交**（2026-11-09 方案 A14）──
// 原来比较的是 `local..upstream`：dry-run 不 fetch 也不 reset upstream，
// 于是 upstream 还停在旧位置 —— 指定一个新标签时会被判成"无需合并"，
// 而实际上 local 根本还没有那个标签的提交。现在直接比 local 与已解析的目标提交。
// `git cat-file -e` 成功时输出为空串（trim 后为 ''），失败返回 null ——
// 不能用 `!!git(...)` 判断，会恒为 false。以"是否为 null"为准。
const targetExists = git(['cat-file', '-e', `${targetCommit}^{commit}`], { allowFail: true }) !== null;
let behind = '0';
if (!targetExists) {
  // 目标对象本地没有（dry-run 未 fetch 时的常见情形）：如实说明无法做祖先判断，
  // 不拿旧 upstream 冒充目标得出"无需合并"的假结论。
  warn(`目标提交 ${targetCommit.slice(0, 8)} 在本地不存在，无法判断 local 是否已包含它`);
  warn('要拿到准确结论，请去掉 --dry-run 先 fetch（或手动 git fetch origin --tags）');
  if (!dryRun) git(['checkout', startBranch === LOCAL_BRANCH ? LOCAL_BRANCH : startBranch]);
  process.exit(0);
}
behind = git(['rev-list', '--count', `${LOCAL_BRANCH}..${targetCommit}`], { allowFail: true }) || '0';
if (behind === '0') {
  say(`local 已包含目标 ${target} 的全部提交，无需合并`);
  if (!dryRun) git(['checkout', startBranch === LOCAL_BRANCH ? LOCAL_BRANCH : startBranch]);
  process.exit(0);
}
say(`local 落后目标 ${target} ${behind} 个提交，开始合并`);

if (dryRun) {
  say(`dry-run：将执行 git checkout ${UPSTREAM_BRANCH} && git reset --hard ${target}，再 merge 到 ${LOCAL_BRANCH}`);
  process.exit(0);
}

git(['checkout', LOCAL_BRANCH]);
try {
  git(['merge', UPSTREAM_BRANCH, '--no-edit']);
  say('合并完成且无冲突');
} catch (err) {
  const conflicted = (git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true }) || '')
    .split('\n').filter(Boolean);
  console.log('');
  warn('合并有冲突，已停在这里。冲突文件：');
  for (const f of conflicted) console.log(`  - ${f}`);
  console.log('');
  console.log('处理方式：');
  console.log('  1. 逐个打开冲突文件，解决 <<<<<<< / ======= / >>>>>>> 标记');
  console.log('  2. 判断口径见 AGENTS.md「分支结构与上游同步」——本地特性优先保留，上游新增能力必须吸收');
  console.log('  3. git add <文件> 逐个标记已解决');
  console.log('  4. git commit 收尾（提交信息沿用脚本给的 merge 说明即可）');
  console.log('  5. 验证：前端 vite build、后端临时库启动 health=200，再推 fork');
  console.log('');
  warn('不要在这个状态下重复执行本脚本');
  process.exit(2);
}

console.log('');
say('下一步建议：');
console.log('  1) 跑一次验证：cd web-ui && npx vite build');
console.log('  2) 后端用临时库启动一次，确认 /api/health 返回 200');
console.log('  3) 推到自己的 fork：git push mine local:main --force-with-lease');
