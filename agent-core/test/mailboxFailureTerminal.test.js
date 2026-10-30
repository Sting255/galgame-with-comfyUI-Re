/**
 * 信箱失败终态（2026-10-17 全项目复查 §P2-1 的回归钉子）
 *
 * ## 修的是什么
 * `mailboxScheduler` 原来**没有失败终态**：`retry_count` 无上限、backoff 封顶 10 分钟 ⇒
 * 一封「毒信件」（LLM 配置坏 / 生图长期失败）会**每 10 分钟烧 1 次 LLM + 3 张图、永远 pending**，
 * 而用户在前端只看到"信一直没回"，完全看不出发生了什么。
 *
 * ## 现在的口径（这些用例钉的就是它）
 * ① 连续失败到 `MAX_RETRY_COUNT` ⇒ `status='failed'`，**不再自动重试**；
 * ② 未到上限仍按原 backoff 回 `pending`（别把重试也一起砍了）；
 * ③ 落终态时发 `reply_failed` 广播（前端靠它立刻改状态，不用等轮询）；
 * ④ 启动回收语义**不变**：崩溃残留的 `processing` 仍重置为 `pending, retry_count=0`
 *    —— 那是崩溃恢复，不是"失败重试"，两者不许混；
 * ⑤ 手动重投入口：`POST /api/mailbox/:id/retry` 只接受 `failed`/`pending`，
 *    `processing`/`completed` 要 409（否则会双跑 / 静默覆盖已回好的信）。
 *
 * ⚠️ 本文件是**源码守卫**（读源码断言）而不是集成测试：`processReply` 不导出、
 *    真跑一轮要真 LLM + 真生图（`:memory:` 里造不出）。既有先例：
 *    `chatSoftState.test.js`、`characterLorasConvergence.test.js` 都是这个打法。
 *    所以这里**钉结构不钉行为**的部分要写到"改坏了会红"的粒度（见每条注释）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dirname, '../src')
const scheduler = fs.readFileSync(path.join(SRC, 'services/mailboxScheduler.js'), 'utf8')
const routes = fs.readFileSync(path.join(SRC, 'routes/mailbox.js'), 'utf8')

/** 剥注释后只留会被执行的代码（血泪清单 §13：源码扫描型守卫必须先剥注释）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
const schedulerCode = stripComments(scheduler)
const routesCode = stripComments(routes)

test('① 有重试上限常量，且取正整数', () => {
  const m = /export const MAX_RETRY_COUNT = (\d+)/.exec(schedulerCode)
  assert.ok(m, 'MAX_RETRY_COUNT 必须是显式导出的常量（否则"上限"是隐性魔法数、改不了也测不了）')
  assert.ok(Number(m[1]) > 0, `MAX_RETRY_COUNT 必须是正整数，实际 ${m[1]}`)
})

test('② 到上限落 failed 终态、不再排下一次重试', () => {
  // 必须同时满足三件事，缺一件就是没修：
  //   · 有 `retryCount >= MAX_RETRY_COUNT` 的判断
  //   · 该分支把 status 写成 'failed'
  //   · 该分支**提前 return**（不 return 会继续往下走、把 status 又改回 pending —— 这正是最容易写错的地方）
  assert.match(schedulerCode, /retryCount\s*>=\s*MAX_RETRY_COUNT/, '缺"到上限"的判断')

  const failBlockStart = schedulerCode.indexOf('retryCount >= MAX_RETRY_COUNT')
  assert.ok(failBlockStart > 0, '定位不到终态分支')
  const block = schedulerCode.slice(failBlockStart, failBlockStart + 900)
  assert.match(block, /\.run\('failed'/, '终态分支必须把 status 落成 failed')
  assert.match(block, /return\b/, '终态分支必须提前 return，否则会继续把 status 改回 pending')

  // 反证：终态分支之后那一句仍是回 pending 的重试路径（说明顺序没被写反）
  assert.match(schedulerCode, /\.run\('pending', retryCount, nextRetry, letterId\)/, '未到上限的重试路径必须保留')
})

test('③ 未到上限仍按原 backoff 回 pending（重试没被一起砍掉）', () => {
  assert.match(schedulerCode, /retryCount <= 1 \? 120000/, '第一档退避 120s 丢了')
  assert.match(schedulerCode, /retryCount <= 2 \? 300000/, '第二档退避 300s 丢了')
  assert.match(schedulerCode, /600000/, '封顶档 600s 丢了')
})

test('④ 落终态时广播 reply_failed（前端靠它立刻改状态）', () => {
  assert.match(schedulerCode, /broadcast\('reply_failed'/, '终态必须广播，否则前端要等下一次 60s 轮询才知道')
})

test('⑤ 启动回收语义不变：崩溃残留的 processing 仍重置为 pending + retry_count 清零', () => {
  // ⚠️ 这条是**反向守卫**：修失败终态时很容易顺手把这里也改成 failed，
  //    而那是崩溃恢复、不是失败重试 —— 改了会让"上次进程被强杀，信直接报废"。
  assert.match(
    schedulerCode,
    /UPDATE mailbox_letters SET status = 'pending', retry_count = 0 WHERE status = 'processing'/,
    '启动回收必须保持 pending/retry_count=0（崩溃恢复语义，别改成 failed）'
  )
})

test('⑥ 手动重投路由：只接受 failed/pending，processing/completed 一律 409', () => {
  assert.match(routesCode, /router\.post\('\/:id\/retry'/, '缺 POST /:id/retry 路由')
  const start = routesCode.indexOf("router.post('/:id/retry'")
  const block = routesCode.slice(start, start + 1600)
  assert.match(block, /status === 'processing'/, '必须显式挡住 processing（否则和正在跑的那轮双跑）')
  assert.match(block, /status === 'completed'/, '必须显式挡住 completed（否则静默覆盖已回好的信）')
  assert.ok((block.match(/409/g) || []).length >= 2, '两个拒绝分支都要用 409（语义化拒绝，前端按 status 翻人话）')
  assert.match(block, /status = 'pending'/, '重投要把状态打回 pending')
  assert.match(block, /retry_count = 0/, '重投必须清零 retry_count，否则一次成功重投也只剩很少机会')
})

test('⑦ 没有同方法的通配路由会把它吃掉（Express 按「方法 + 路径」双匹配）', () => {
  // ⚠️ 我第一版这里写的是"POST /:id/retry 必须排在 GET /:id 之前"，**那是错的**：
  //    Express 同时匹配方法与路径，`GET /:id` 永远吃不到 `POST` 请求。
  //    真正会吃掉它的是**同方法**且更宽的模式，即一个 `POST /:id`。
  // 本项目确实踩过同类坑（`PUT /:id/outfits/scene` 被 `PUT /:id/outfits/:outfitId` 吃掉，
  // 见 接手必读 §6.1-0）—— 所以这条守卫保留，但判据改成"**同方法**的更宽模式"。
  const postPatterns = [...routesCode.matchAll(/router\.post\('([^']+)'/g)].map((m) => m[1])
  assert.ok(postPatterns.includes('/:id/retry'), '缺 POST /:id/retry')
  const retryAt = postPatterns.indexOf('/:id/retry')

  // 任何注册在它之前的、能匹配 `/任意id/retry` 的 POST 模式都会遮蔽它。
  // 现在文件里只有 `/send`（字面量，不匹配）与 `/:id/retry` 自己 ⇒ 无遮蔽。
  const shadowing = postPatterns.slice(0, retryAt).filter((p) => {
    const re = new RegExp('^' + p.replace(/:[^/]+/g, '[^/]+').replace(/\//g, '\\/') + '$')
    return re.test('/9/retry')
  })
  assert.deepEqual(shadowing, [], `这些先注册的 POST 路由会遮蔽 /:id/retry：${shadowing.join(', ')}`)
})
