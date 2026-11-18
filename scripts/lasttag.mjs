/**
 * lasttag.mjs — 查看最近一个 tag，确认后本地与远端一起删除（打错了用）
 *
 * 远端走 lib/pushRemote.mjs 的统一口径（默认 mine，PUSH_REMOTE 可覆盖）。
 * 旧版写死 origin = 上游只读镜像，删除远端 tag 那一步必然失败，
 * 结果本地 tag 没了、远端还在，两边对不上。
 */

import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { resolvePushRemote } from './lib/pushRemote.mjs';

const run = (cmd) => execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();

let remote;
try {
  remote = resolvePushRemote();
} catch (e) {
  console.error(`[ERROR] ${e.message}`);
  process.exit(1);
}

// 1. 从推送目标拉取远端 tags（上游 origin 上没有本仓的迭代 tag）
execSync(`git fetch ${remote.name} --tags --quiet`, { stdio: 'inherit' });

// 2. 获取最近一个 tag（纯 Node.js，不依赖 head）
const tags = run('git tag --sort=-creatordate').split('\n').filter(Boolean);
const tag = tags[0];

if (!tag) {
  console.log('没有找到任何 tag。');
  process.exit(0);
}

console.log(`Tag: ${tag}`);
console.log(`远端: ${remote.name} (${remote.url})`);

// 3. 显示 tag message
const msg = run(`git tag -l --format="%(contents)" "${tag}"`);
if (msg) console.log(msg);

// 4. 交互确认
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question(`Delete this tag locally and on ${remote.name}? (y/n) `, (answer) => {
  rl.close();
  if (answer.toLowerCase() === 'y') {
    execSync(`git tag -d "${tag}"`, { stdio: 'inherit' });
    execSync(`git push ${remote.name} ":refs/tags/${tag}"`, { stdio: 'inherit' });
    console.log(`已删除 tag: ${tag}`);
  } else {
    console.log('已取消。');
  }
});
