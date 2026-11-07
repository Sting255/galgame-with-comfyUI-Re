/**
 * check-imports.mjs —— 打包前的「未定义符号」检查（2026-11-08）
 *
 * 为什么要：真机上出现过两次 `ReferenceError: xxx is not defined`
 * （chat.js 的 getWorldIntegrationRule、expressionStandingService.js 的 buildCharacterPersona），
 * 都是「函数用了但忘了 import」。`node --check` 发现不了 —— 它只验语法，
 * 而这类代码在跑到那一行之前完全合法，又都落在低频分支上。
 *
 * 做法：用 acorn 解析成 AST —— 先用正则做过一版，`match` / `refresh` 这类常见词
 * 被误报成缺失导入（149 条噪音），没法当门禁。AST 版只认「真的在调用的标识符」：
 * 收集 import 绑定、变量声明、函数参数、catch 参数、类名，再找 CallExpression 里
 * 未被这些绑定覆盖、也不是语言/运行时全局的名字。
 *
 * 已知取舍：不做真正的词法作用域分析（全文件一个绑定集合）。
 * 这会把"某个作用域里声明过、另一个作用域里误用"漏掉 —— 可以接受：
 * 这类问题属于逻辑 bug，不是忘记 import；本脚本只守「忘记 import」这一道。
 *
 * 用法：node scripts/check-imports.mjs
 * 退出码：0 干净；1 有问题（打包脚本据此中止打包）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const acorn = require(path.resolve(import.meta.dirname, '..', 'web-ui', 'node_modules', 'acorn'));

const ROOT = path.resolve(import.meta.dirname, '..', 'agent-core', 'src');

// 语言 / 运行时 / 常见宿主全局：不要求 import
const GLOBAL_WHITELIST = new Set([
  'console', 'require', 'module', 'exports', 'process', 'global', 'globalThis', 'window', 'document',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'fetch', 'Blob', 'File', 'FormData', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'TextEncoder', 'TextDecoder', 'Buffer', 'atob', 'btoa', 'structuredClone', 'performance',
  'JSON', 'Math', 'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'Function', 'BigInt', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape', 'eval',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'SharedArrayBuffer', 'BigInt64Array',
]);

// 测试框架 / node 内建（在这些文件里出现不算缺 import 的常见形态）
const EXTRA_OK = new Set(['describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 递归收集一个 pattern（解构）里声明的所有名字 */
function collectPatternNames(node, into) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': into.add(node.name); break;
    case 'ObjectPattern':
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, into);
        else collectPatternNames(prop.value, into);
      }
      break;
    case 'ArrayPattern':
      for (const element of node.elements) collectPatternNames(element, into);
      break;
    case 'RestElement': collectPatternNames(node.argument, into); break;
    case 'AssignmentPattern': collectPatternNames(node.left, into); break;
    default: break;
  }
}

function analyze(file) {
  const source = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (error) {
    return { parseError: error.message.split('\n')[0] };
  }

  const bound = new Set();
  const calls = [];

  // 简单的深度遍历（不引 acorn-walk，减少依赖）
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration':
        for (const spec of node.specifiers) bound.add(spec.local.name);
        break;
      case 'VariableDeclarator':
        collectPatternNames(node.id, bound);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) bound.add(node.id.name);
        for (const param of node.params) collectPatternNames(param, bound);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) bound.add(node.id.name);
        break;
      case 'CatchClause':
        collectPatternNames(node.param, bound);
        break;
      case 'CallExpression':
        if (node.callee?.type === 'Identifier') {
          calls.push({ name: node.callee.name, line: node.loc?.start.line || 0 });
        }
        break;
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, node);
      } else if (value && typeof value.type === 'string') {
        visit(value, node);
      }
    }
  };
  visit(ast, null);

  const missing = calls.filter(call =>
    !bound.has(call.name)
    && !GLOBAL_WHITELIST.has(call.name)
    && !EXTRA_OK.has(call.name)
  );
  return { missing };
}

const files = walk(ROOT);
const problems = [];
const parseErrors = [];

for (const file of files) {
  const result = analyze(file);
  if (result.parseError) { parseErrors.push({ file: path.relative(ROOT, file), error: result.parseError }); continue; }
  for (const miss of result.missing) {
    problems.push({ file: path.relative(ROOT, file), line: miss.line, name: miss.name });
  }
}

if (parseErrors.length) {
  console.error(`✗ ${parseErrors.length} 个文件无法解析：`);
  for (const item of parseErrors) console.error(`  · ${item.file}: ${item.error}`);
}

if (!problems.length && !parseErrors.length) {
  console.log(`✓ 未定义符号检查通过（扫描 ${files.length} 个文件）`);
  process.exit(0);
}

if (problems.length) {
  console.error(`\n✗ 发现 ${problems.length} 处「调用了未定义的函数」：`);
  const seen = new Set();
  for (const item of problems) {
    const key = `${item.file}:${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  · ${item.file}:${item.line}  ${item.name}()`);
  }
  console.error('\n修法：补 import，或改成实际存在的函数名。这类错误 node --check 查不出来。');
}
process.exit(1);
