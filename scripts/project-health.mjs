import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relative = file => path.relative(root, file).split(path.sep).join('/');
function files(directory, pattern) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? files(file, pattern) : pattern.test(entry.name) ? [file] : [];
  });
}
// 文档检查是可选的：本仓已把 docs/ 目录剥离（2026-11-06），没有文档时跳过这一层，
// 不要让它把整个健康检查带崩（CI 报 ENOENT: scandir .../docs）。
const docsDir = path.join(root, 'docs');
const docs = fs.existsSync(docsDir) ? files(docsDir, /\.md$/) : [];
const errors = [];
const index = docs.length ? fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8') : '';
for (const file of docs) {
  const name = relative(file).slice('docs/'.length);
  if (name !== 'README.md' && !index.includes(`](${name})`)) errors.push(`文档没有导航入口：${name}`);
  // 只验证 Markdown 本地链接；代码示例与历史记录中的路径不是链接。
  const body = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of body.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    let target = match[1].trim().replace(/^<([^>]+)>.*$/, '$1').replace(/\s+["'][\s\S]*$/, '');
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target)) continue;
    target = decodeURIComponent(target.split(/[?#]/)[0]);
    if (!target) continue;
    const resolved = target.startsWith('/') ? path.join(root, target.slice(1)) : path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) errors.push(`${relative(file)} → ${target}`);
  }
}
const source = ['agent-core/src', 'web-ui/src'].flatMap(dir => files(path.join(root, dir), /\.(?:js|mjs|ts|vue)$/));
const sizes = source.map(file => ({ file: relative(file), lines: fs.readFileSync(file, 'utf8').split('\n').length }));
console.log('检查范围：程序源码与文档；排除玩家数据、素材、依赖及分发包。');
console.log(`源码 ${source.length} 个文件；文档 ${docs.length} 份；本地链接与导航 ${errors.length ? '未通过' : '通过'}`);
console.log('体积最大的源码（仅用于安排拆分，不代表可删除）：');
for (const item of sizes.sort((a, b) => b.lines - a.lines).slice(0, 10)) console.log(`  ${String(item.lines).padStart(5)} 行  ${item.file}`);
for (const error of errors) console.error(`  ${error}`);
if (errors.length) process.exitCode = 1;
