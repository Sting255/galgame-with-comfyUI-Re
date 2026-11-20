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
// 文档检查是可选的：兼容历史上不包含 docs/ 的源码树；存在时必须验证导航与链接。
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

// 小镇冻结（2026-11-20）：冻结目录外引用冻结代码的文件只许减少、不许增加。
// 只提示不阻断：新增依赖时请先确认是否真的需要复用冻结代码，再更新这里的基线。
const FROZEN_DIRS = ['agent-core/src/services/town/', 'web-ui/src/components/town/'];
const FROZEN_FILES = ['agent-core/src/db/townSchema.js', 'web-ui/src/api/townLife.js', 'web-ui/src/api/townBuildingFeatures.js'];
const FROZEN_IMPORT = /\bfrom\s+['"][^'"]*(?:services\/town\/|components\/town\/|\/town\/|api\/townLife|api\/townBuildingFeatures|townSchema)[^'"]*['"]|import\(\s*['"][^'"]*(?:services\/town\/|components\/town\/)[^'"]*['"]\s*\)/;
const FROZEN_DEPENDENT_BASELINE = 20;
const frozenDependents = sizes.map(item => item.file)
  .filter(file => !FROZEN_DIRS.some(dir => file.startsWith(dir)) && !FROZEN_FILES.includes(file))
  .filter(file => FROZEN_IMPORT.test(fs.readFileSync(path.join(root, file), 'utf8')));
console.log(`小镇冻结：冻结目录外仍引用冻结代码的文件 ${frozenDependents.length} 个（基线 ${FROZEN_DEPENDENT_BASELINE}，只许减少）`);
if (frozenDependents.length > FROZEN_DEPENDENT_BASELINE) {
  console.warn('  ⚠ 新增了对冻结小镇代码的依赖，请确认是否必要：');
  for (const file of frozenDependents) console.warn(`    ${file}`);
}
for (const error of errors) console.error(`  ${error}`);
if (errors.length) process.exitCode = 1;
