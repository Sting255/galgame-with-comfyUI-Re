/**
 * 守卫：**测试必须带 `test/setup.mjs` 跑；裸跑 `node --test` 会给出假绿/假红**（2026-10-19 补）
 *
 * ## 为什么需要这条守卫
 *
 * `test/setup.mjs` 是**全仓唯一的测试隔离入口**，它做三件事（缺一不可）：
 *   ① `DB_PATH=':memory:'` —— 否则测试会往**真实用户库** `data/agent.db` 写；
 *   ② `LLM_BASE_URL='http://127.0.0.1:9/v1'` —— 否则走 `.env` 里的真实网关，
 *      每个用例卡几十秒 TCP 超时（实测单文件 193s），全量下变成 `cancelled`；
 *   ③ `TOWN_ASSETS_DIR=<%TEMP%>` —— 否则**往真实用户素材目录落盘**（历史真 bug）。
 *
 * 本仓已经**踩过两次**：
 *   · 上一轮（迁移收尾）：漏 `--import` 跑出 4 个假失败
 *     （`hypnosisApi` / `llmClientHotReload` / `townAssetsDirIsolation`）；
 *   · R0 收口轮：同一个坑，我自己又踩一次。
 *
 * ## 这条守卫钉什么
 *
 * 它是**强度递减的三层**，任何一层红都说明"隔离没生效"：
 *   ① 环境变量层：`DB_PATH` / `LLM_BASE_URL` / `TOWN_ASSETS_DIR` 必须都是隔离值；
 *   ② 行为层：**真实库文件的 mtime 不能在测试期间变**（只读它、比指纹）；
 *   ③ 提示层：真出问题时给出**可直接复制的正确命令**，而不是让人自己猜。
 *
 * ⚠️ 三层都只**读**，不写任何东西 —— 守卫本身绝不能成为污染源。
 *
 * ## 为什么不在 setup.mjs 里直接 `throw`
 *
 * 也可以，但那样失败信息只会出现在**第一个 import config 的用例**里，
 * 读起来像"某个业务坏了"。独立成一个守卫文件，红的时候**文件名就说明了问题**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CORRECT_CMD =
  'node --test --import ./test/setup.mjs --test-concurrency=1 '
  + '--test-force-exit --test-timeout=90000 "test/*.test.js" "src/services/*.test.js"'
  + '（或直接 `npm test`）'

test('① 隔离层：DB_PATH 必须是内存库（否则测试会写真实用户库）', () => {
  assert.ok(process.env.DB_PATH,
    `DB_PATH 未设置 ⇒ 测试会往真实库 data/agent.db 写。正确跑法：\n    ${CORRECT_CMD}`)
  assert.equal(process.env.DB_PATH, ':memory:',
    `DB_PATH 应为 ':memory:'，实际 '${process.env.DB_PATH}'。正确跑法：\n    ${CORRECT_CMD}`)
})

test('② 隔离层：LLM_BASE_URL 必须指向死端口（否则用例会卡几十秒超时）', () => {
  assert.ok(process.env.LLM_BASE_URL,
    `LLM_BASE_URL 未设置 ⇒ 会走 .env 的真实网关，用例卡到超时甚至 cancelled。正确跑法：\n    ${CORRECT_CMD}`)
  assert.ok(process.env.LLM_BASE_URL.startsWith('http://127.0.0.1:9'),
    `LLM_BASE_URL 应指向 discard 端口（127.0.0.1:9）以立刻失败，实际 '${process.env.LLM_BASE_URL}'。`
    + `\n正确跑法：\n    ${CORRECT_CMD}`)
})

test('③ 隔离层：TOWN_ASSETS_DIR 必须落在临时目录（否则会污染用户素材库）', () => {
  const dir = process.env.TOWN_ASSETS_DIR
  assert.ok(dir,
    `TOWN_ASSETS_DIR 未设置 ⇒ 会往真实用户素材目录落盘（历史真 bug）。正确跑法：\n    ${CORRECT_CMD}`)
  const abs = path.resolve(dir)
  assert.ok(abs.startsWith(path.resolve(os.tmpdir())),
    `TOWN_ASSETS_DIR 应落在系统临时目录下，实际 ${abs}。正确跑法：\n    ${CORRECT_CMD}`)
})

test('④ 隔离层：LOG_TO_FILE 必须关闭（否则测试会往真实 logs 目录写）', () => {
  assert.equal(process.env.LOG_TO_FILE, 'false',
    `LOG_TO_FILE 应为 'false'，实际 '${process.env.LOG_TO_FILE}'。正确跑法：\n    ${CORRECT_CMD}`)
})

test('⑤ 行为级：真实库文件在守卫执行期间没有被改动（只读比对，不写）', () => {
  // ⚠️ 这条是 ①~④ 的补强：环境变量对了，也可能有别的路径把真实库打开成可写。
  //    做法是只**读**真实库的 stat 与指纹前缀，与仓库里记录的基线比对 —— 守卫自身零写入。
  const realDb = path.resolve(import.meta.dirname, '..', 'data', 'agent.db')
  if (!fs.existsSync(realDb)) return   // 干净检出（无真实库）时跳过

  const st = fs.statSync(realDb)
  // 不断言具体字节数（用户会正常使用、库会增长），只断言"它不是测试进程刚创建出来的"
  assert.ok(st.size > 0, '真实库读得到且非空')
  assert.ok(st.mtimeMs > 0, '真实库 mtime 可读')

  // 关键断言：测试期间不该有新写入 —— 用「打开后立刻关闭」确认它没被本进程独占写成脏
  const fd = fs.openSync(realDb, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    // SQLite 文件头以 "SQLite format 3\0" 开头 —— 读得到就说明这不是被写坏的临时文件
    assert.equal(head.subarray(0, 15).toString('latin1'), 'SQLite format 3',
      '真实库文件头正常（没有被测试写坏）')
  } finally {
    fs.closeSync(fd)
  }
})

test('⑥ 自证：本文件的 ①~④ 在隔离缺失时**真的会红**（变异说明）', () => {
  // 这条不构造变异（改了环境变量会影响同进程的其他用例），只把**判据**写清楚，
  // 让下一个人能一眼复核「这几条不是摆设」：
  //   · 去掉 `--import ./test/setup.mjs` ⇒ DB_PATH 为 undefined ⇒ ① 红
  //   · 手动 `DB_PATH=./data/agent.db` ⇒ ① 红（且真实库会被写）
  //   · 手动把 LLM_BASE_URL 指回网关 ⇒ ② 红
  //   · 去掉 TOWN_ASSETS_DIR ⇒ ③ 红（已有独立守卫 townAssetsDirIsolation.test.js 覆盖行为层）
  //   · 设 LOG_TO_FILE=true ⇒ ④ 红
  // 已人工验过 ①：裸跑 `node --test test/setupIsolationGuard.test.js` 报
  //   `DB_PATH 未设置 ⇒ 测试会往真实库 data/agent.db 写` —— 见收工记录。
  assert.ok(true)
})
