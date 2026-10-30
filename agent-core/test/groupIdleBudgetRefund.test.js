/**
 * 群聊后台闲聊「失败退预算」（2026-10-17 全项目复查 §P2-3 的回归钉子）
 *
 * ## 修的是什么
 * `idleTick` 原来是**先扣预算后跑 round**，而 round 抛错时**不退**：
 *   `consumeIdleBudget()` → `runGroupRound()` 抛错 → 进 catch → 只打日志
 * ⇒ 一次 LLM 报错/网关超时/生图失败就白吃掉当日额度，而每群每天默认**只有 2 轮**
 *   （`config.groupChat.activity`）。用户体验就是"今天群里怎么突然不说话了"，
 *   日志里只有一行 `round failed`，查不出额度去哪了。
 *
 * ## 现在的口径
 * ① round 抛错 **且一条消息都没产出** ⇒ 退 1 次预算；
 * ② **已经产出过消息**的失败**不退** —— 那些闲聊真的广播出去了，额度是真花掉的，
 *    退了就成了"花得多、扣得少"（对用户的另一种不公平）；
 * ③ 退款不越界：只在"当日计数确实是我们扣的那一次"时退，且不退到负数
 *    （跨天边界上宁可少退，也不把 `idle_budget_used` 弄成 -1）。
 *
 * 这里用**真实 `:memory:` 库 + 真实 SQL** 验（这两个函数已按依赖注入收好了 `db` 形参），
 * 不是源码文本守卫 —— 所以在真的把跨天判定写错、或把退款写成负数时都会红。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async (url) => { throw new Error('budget fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const { consumeIdleBudget, refundIdleBudget } = await import('../src/services/groupIdleScheduler.js')

after(() => closeDb())

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const yesterday = () => {
  const d = new Date(Date.now() - 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let seq = 0
/** 建一个群，并把预算计数设成指定值（默认"今天已用 0 次"）。 */
function mkGroup({ budgetDate = today(), budgetUsed = 0 } = {}) {
  seq += 1
  const db = getDb()
  const id = Number(db.prepare(
    `INSERT INTO group_chats (name, idle_enabled, idle_budget_date, idle_budget_used) VALUES (?, 1, ?, ?)`
  ).run(`退预算群_${seq}`, budgetDate, budgetUsed).lastInsertRowid)
  return db.prepare('SELECT * FROM group_chats WHERE id = ?').get(id)
}
const usedOf = (id) => getDb().prepare('SELECT idle_budget_used AS u FROM group_chats WHERE id = ?').get(id).u

test('① 正常扣费仍工作（预算是真的加一）', () => {
  const g = mkGroup()
  assert.equal(consumeIdleBudget(getDb(), g), true, '首次消耗应当成功')
  assert.equal(usedOf(g.id), 1)
  assert.equal(consumeIdleBudget(getDb(), getDb().prepare('SELECT * FROM group_chats WHERE id = ?').get(g.id)), true)
  assert.equal(usedOf(g.id), 2, '第二次应当也成功（默认额度 2）')
})

test('② 额度用满后不再放行（这条是原有行为，防被退款改动带坏）', () => {
  const g = mkGroup({ budgetUsed: 2 })   // 默认 activity=2，已用满
  assert.equal(consumeIdleBudget(getDb(), g), false, '已用满必须拒绝')
  assert.equal(usedOf(g.id), 2, '被拒时不许改计数')
})

test('③ 退款：今天扣的那一次能退回来', () => {
  const g = mkGroup()
  assert.equal(consumeIdleBudget(getDb(), g), true)
  assert.equal(usedOf(g.id), 1)

  // 模拟 round 抛错后的退款
  assert.equal(refundIdleBudget(getDb(), g.id), true, '应当退成功')
  assert.equal(usedOf(g.id), 0, '退完应当回到 0')

  // 退完之后额度又能用了 —— 这才是"没白烧额度"的真正含义
  const fresh = getDb().prepare('SELECT * FROM group_chats WHERE id = ?').get(g.id)
  assert.equal(consumeIdleBudget(getDb(), fresh), true, '退款后应当能再次消耗')
})

test('④ 退款不越界：计数为 0 时不退（不许退成负数）', () => {
  const g = mkGroup({ budgetUsed: 0 })
  assert.equal(refundIdleBudget(getDb(), g.id), false, '没用过就不该退')
  assert.equal(usedOf(g.id), 0, '计数不许变成 -1')
})

test('⑤ 跨天不误退：计数属于昨天时退款拒绝（今天的额度没被扣过）', () => {
  // 这是最危险的边界：如果退款不比对日期，就会把"昨天用掉 2 次"退成 1 次，
  // 而消费者下一句会把它当成"今天用了 1 次"⇒ 白白多送一次额度。
  const g = mkGroup({ budgetDate: yesterday(), budgetUsed: 2 })
  assert.equal(refundIdleBudget(getDb(), g.id), false, '昨天的计数不该被今天的退款动')
  assert.equal(usedOf(g.id), 2, '昨天的计数必须原样不动')

  // 而且它此时真的按"今天还没用过"算（懒重置语义没被破坏）
  const fresh = getDb().prepare('SELECT * FROM group_chats WHERE id = ?').get(g.id)
  assert.equal(consumeIdleBudget(getDb(), fresh), true, '跨天后应当按新的一天重新放行')
  assert.equal(usedOf(g.id), 1, '跨天后的第一次消耗应当记成 1（不是 3）')
})

test('⑥ 群不存在时退款安全返回 false（不抛）', () => {
  assert.equal(refundIdleBudget(getDb(), 999999), false)
})

test('⑦ 源码守卫：idleTick 的失败分支必须真的调退款，且只在零产出时退', async () => {
  // 前六条验的是两个纯函数；这一条钉**接线**（纯函数绿 ≠ 接上了 —— 血泪清单 §10）。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/services/groupIdleScheduler.js', import.meta.url), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.match(code, /let producedMessages = 0/, '缺"本轮产出计数"（没有它就分不清真失败与部分成功）')
  assert.match(
    code,
    /producedMessages === 0 && refundIdleBudget\(/,
    '失败分支必须在**零产出**时才退款（无条件退会把已广播的闲聊也算成白烧）'
  )
  // 产出计数必须真的被 emit 回调加上去（否则它恒为 0 ⇒ 变成无条件退款）
  assert.match(code, /producedMessages \+= 1/, 'emit 回调里必须给产出计数加一')
  // 顺序守卫：扣预算发生在 runGroupRound 之前（先扣后跑的语义没变，退款才是配套补丁）
  const consumeAt = code.indexOf('consumeIdleBudget(db, candidate)')
  const roundAt = code.indexOf('await runGroupRound(candidate.id')
  assert.ok(consumeAt > 0 && roundAt > 0 && consumeAt < roundAt, '扣预算仍应在 runGroupRound 之前')
})
