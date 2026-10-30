import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 模板注释配对守卫（2026-10-30 补）
 *
 * 为什么要有它：合并上游 v4.0.0 时，TavernView 里一处 HTML 注释用了 JS 注释的收尾写法
 * （星号加斜杠，而不是 HTML 的箭号收尾），于是 `<!--` 一直没闭合，
 * 把后面那张「音色管理」卡片和它的闭合 div 整段吃进注释。
 *
 * 后果很隐蔽：
 *   · 单测全绿（没人渲染这个模板）
 *   · `vite build` 成功、产物里也确实少了几个节点（构建不会为一处被注释的节点报错）
 *   · 只有真机点页面才发现少了一张卡，而且 DOM 里还多出一个悬空 `</div>`
 *
 * 所以钉这条：src 下每个 .vue 的 `<!--` 与 `-->` 数量必须相等。
 * 只做计数配对，不解析语义 —— 它的作用是"让这类手滑在跑单测时就红"。
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

function count(haystack, needle) {
  let n = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length }
  return n
}

test('所有 .vue 的 HTML 注释都正确闭合（<!-- 与 --> 数量相等）', () => {
  const files = walk(SRC)
  assert.ok(files.length > 0, '要能找到 .vue 文件')
  const broken = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const open = count(text, '<!--')
    const close = count(text, '-->')
    if (open !== close) broken.push(`${file.replace(SRC, 'src/')}: <!--=${open} -->=${close}`)
  }
  assert.deepEqual(broken, [], '这些模板的注释没闭合（`<!--` 配 `*/` 是最常见的写错方式）：' + JSON.stringify(broken))
})
