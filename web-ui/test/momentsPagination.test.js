/**
 * 朋友圈 `loadPosts` 的 keyset 续拉（前端侧）
 *
 * 背景（2026-10-15 修的真缺陷）：
 * 后端 `GET /api/moments` 是 **keyset 分页** —— 默认最新 1000 条，`?before_id=` 续拉更旧一批，
 * 返回 `{ posts, hasMore }`（后端侧已有 `agent-core/test/momentListPagination.test.js` 覆盖）。
 * 但前端 store 原来只调一次、把第一页当成全量 ⇒ **动态超过 1000 条时静默丢掉更旧的历史**
 * （页面看不出异常，只是"翻不到头"）。本文件钉住修复后的续拉行为。
 *
 * 为什么不用「滚动到底再拉下一页」那种增量分页：`charactersWithPosts`（作者筛选列表）与
 * `filteredPosts`（按作者/我发的/赞过筛选）都建立在「posts 是全量」这个前提上，
 * 改增量分页会让作者列表只剩已加载部分 —— 那是更大的行为倒退。
 *
 * 本仓没有组件挂载能力，所以用「读源码 + 提取纯逻辑 + 注入 fake api」的路子
 * （与 `settingsArtist.test.js` / `jailbreakSettings.test.js` 同风格）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const storeSrc = readFileSync(new URL('../src/stores/moments.js', import.meta.url), 'utf8')

/** 精确摘出 loadPosts（含可能的 async 前缀；花括号逐字符配深度） */
function extractFn(script, name) {
  let start = script.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 function ${name}()`)
  if (script.slice(Math.max(0, start - 6), start) === 'async ') start -= 6
  let i = script.indexOf(')', start)
  while (i < script.length && script[i] !== '{') i++
  let depth = 0
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++
    else if (script[i] === '}') { depth--; if (depth === 0) break }
  }
  return script.slice(start, i + 1)
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

/**
 * 用假 api 跑 loadPosts。
 * @param {Array<{posts:Array,hasMore:boolean}>} pages 依次返回的页
 * @param {{ failAt?: number }} opts failAt=第几页抛错（0 基）
 */
async function runLoad(pages, opts = {}) {
  const calls = []
  const api = {
    listMoments: async params => {
      const idx = calls.length
      calls.push(params)
      if (opts.failAt === idx) throw new Error('boom')
      return pages[idx] || { posts: [], hasMore: false }
    },
  }
  const posts = { value: [] }
  const page = { value: 1 }
  const loading = { value: false }
  // loadError 是 2026-10-22 给列表加的 error 通道（失败时不再假装"这里本来就空"），
  // loadPosts 会写它，所以必须注入，否则 new Function 作用域里找不到。
  const loadError = { value: null }
  const marked = { n: 0 }
  const markSeen = async () => { marked.n++ }
  const errors = []

  const factory = new AsyncFunction('api', 'posts', 'page', 'loading', 'markSeen', 'console', 'loadError',
    `${extractFn(storeSrc, 'loadPosts')}
     return loadPosts`)
  const loadPosts = await factory(api, posts, page, loading, markSeen, { error: (...a) => errors.push(a.join(' ')) }, loadError)

  await loadPosts()
  return { posts: posts.value, page: page.value, calls, marked: marked.n, errors, loading: loading.value, loadError: loadError.value }
}

const mkPost = id => ({ id, content: `c${id}` })

// ── ① 单页 ────────────────────────────────────────────────────────────────

test('只有一页（hasMore=false）时只调一次，不续拉', async () => {
  const r = await runLoad([{ posts: [mkPost(3), mkPost(2)], hasMore: false }])
  assert.equal(r.calls.length, 1, '没有更多就不该再请求')
  assert.deepEqual(r.posts.map(p => p.id), [3, 2])
  assert.equal(r.page, 1, 'page 归 1（内存分页从头开始）')
  assert.equal(r.marked, 1, '加载完要 markSeen')
  assert.equal(r.loading, false, 'loading 必须复位')
})

test('第一页就不带 before_id（拿最新一批）', async () => {
  const r = await runLoad([{ posts: [mkPost(9)], hasMore: false }])
  assert.equal(r.calls[0], undefined, '第一次调用不传参（或传 undefined）')
})

// ── ② 多页续拉（本文件核心）──────────────────────────────────────────────

test('hasMore=true 时按 before_id 续拉，直到 hasMore=false', async () => {
  const r = await runLoad([
    { posts: [mkPost(100), mkPost(99)], hasMore: true },
    { posts: [mkPost(98), mkPost(97)], hasMore: true },
    { posts: [mkPost(96)], hasMore: false },
  ])
  assert.equal(r.calls.length, 3, '三页就该调三次')
  assert.equal(r.calls[0], undefined, '第一页不传 before_id')
  assert.deepEqual(r.calls[1], { before_id: 99 }, '第二页用上一批**最后一条**的 id 作游标')
  assert.deepEqual(r.calls[2], { before_id: 97 }, '第三页同理')
  // 顺序：新 → 旧，拼在一起不能乱
  assert.deepEqual(r.posts.map(p => p.id), [100, 99, 98, 97, 96])
  assert.equal(r.marked, 1, '续拉完只 markSeen 一次（不是每页一次）')
})

test('空页立刻停（防后端 hasMore 恒真时死循环）', async () => {
  const r = await runLoad([
    { posts: [mkPost(5)], hasMore: true },
    { posts: [], hasMore: true },   // 说还有，但给空 —— 必须停
  ])
  assert.equal(r.calls.length, 2, '拿到空页就停，不再请求')
  assert.deepEqual(r.posts.map(p => p.id), [5])
})

test('有安全上限（最多 50 页），不会无限拉', async () => {
  // 造 60 页，每页都说 hasMore=true —— 没有上限的话会一直拉下去
  const pages = Array.from({ length: 60 }, (_, i) => ({ posts: [mkPost(1000 - i)], hasMore: true }))
  const r = await runLoad(pages)
  assert.ok(r.calls.length <= 50, `必须有页数上限，实际调了 ${r.calls.length} 次`)
  assert.equal(r.calls.length, 50, '正好停在上限')
})

test('批次里没有 id 时兜底停止（拿不到游标就没法续）', async () => {
  const r = await runLoad([
    { posts: [{ content: '没有 id 的脏数据' }], hasMore: true },
  ])
  assert.equal(r.calls.length, 1, '拿不到游标必须停，否则 before_id=undefined 会重复拉第一页')
})

// ── ③ 运行时状态保留 ─────────────────────────────────────────────────────

test('重复加载时保留 _comments 与 liked（页面切回来不丢已加载评论）', async () => {
  const api = {
    listMoments: async () => ({ posts: [mkPost(7), mkPost(6)], hasMore: false }),
  }
  const posts = { value: [] }
  const factory = new AsyncFunction('api', 'posts', 'page', 'loading', 'markSeen', 'console', 'loadError',
    `${extractFn(storeSrc, 'loadPosts')}
     return loadPosts`)
  const loadPosts = await factory(api, posts, { value: 1 }, { value: false }, async () => {}, console, { value: null })

  await loadPosts()
  // 模拟用户展开了 7 号帖的评论、点了赞
  posts.value[0]._comments = [{ content: '已加载的评论' }]
  posts.value[0].liked = true

  await loadPosts()   // 再加载一次（服务端返回的对象是新的）
  assert.deepEqual(posts.value[0]._comments, [{ content: '已加载的评论' }], '_comments 不能被对象替换弄丢')
  assert.equal(posts.value[0].liked, true, 'liked 同理')
})

// ── ④ 失败路径 ───────────────────────────────────────────────────────────

test('中途某页失败：不崩、loading 复位、已拿到的帖子仍留在内存', async () => {
  const r = await runLoad([
    { posts: [mkPost(10)], hasMore: true },
    { posts: [], hasMore: true },
  ], { failAt: 1 })
  assert.equal(r.loading, false, '失败也要复位 loading（否则页面永远转圈）')
  assert.ok(r.errors.length >= 1, '要打错误日志，不能静默')
  // 注意：这里是整体 try/catch，失败时 posts.value 保持原值（不写半截数据）
  assert.deepEqual(r.posts, [], '失败时不该写入半截结果')
})

// ── ⑤ 源码守卫：别再退回"只拉一次" ───────────────────────────────────────

test('源码守卫：loadPosts 里确实有续拉循环与 hasMore 判断', () => {
  const src = extractFn(storeSrc, 'loadPosts')
  assert.match(src, /hasMore/, '必须认 hasMore')
  assert.match(src, /before_id/, '必须用 before_id 做 keyset 游标')
  assert.match(src, /for\s*\(/, '必须有循环')
  assert.match(src, /MAX_PAGES/, '必须有页数上限')
  assert.equal(/const data = await api\.listMoments\(\)\n\s*const batch/.test(src), false, '不能退回「只调一次」的写法')
})

test('api.listMoments 支持 before_id / limit 参数', () => {
  const apiSrc = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
  const start = apiSrc.indexOf('export async function listMoments(')
  assert.ok(start >= 0, 'api 层要有 listMoments')
  const body = apiSrc.slice(start, apiSrc.indexOf('\n}', start))
  assert.match(body, /before_id/, 'api 层要透传 before_id')
  assert.match(body, /URLSearchParams/, '要拼查询串')
})
