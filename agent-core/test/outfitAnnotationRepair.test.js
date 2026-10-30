/**
 * 着装标注校验 + 专注修复（PR #24 第三步）。
 *
 * 覆盖口径：
 *   ① 没配场景服装 / 少于两套 ⇒ 直接放行（reason: no-outfits）
 *   ② 换装点 ≥4 且全部合法 ⇒ 放行（reason: ok）
 *   ③ 换装点 <4 ⇒ 触发修复（调一次 LLM；用注入的假 chat 验"确实调了 + 结果被采纳"）
 *   ④ 有非法服装名 ⇒ 触发修复
 *   ⑤ 修复结果长度不对 / 名字不合法 ⇒ 保留原标注，绝不拿脏数据覆盖
 *   ⑥ 修复调用抛错 / 返回非 JSON ⇒ 保留原标注，不向上抛
 *
 * ⚠️ 注桩口径：`ensureOutfitAnnotations(schedule, id, chat)` 第三参可注入 LLM 调用
 *    （与 publishToyReaction 的 deps 同思路）。**不要**去桩 globalThis.fetch ——
 *    openai SDK 走 node-fetch，桩 fetch 会让 SDK 内部重试/退避挂着不释放（本仓老坑）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

// 一律禁网：本文件所有 LLM 调用都走注入的假 chat，真网关绝不该被碰到
globalThis.fetch = async url => { throw new Error(`outfit annotation fixture forbids network: ${url}`) }

const { getDb } = await import('../src/db/index.js')
const { upsertSceneOutfits, setCharacterBody, ensureOutfitAnnotations } = await import('../src/services/outfitScene.js')

const CHAR_ID = 1

function reset() {
  const db = getDb()
  db.prepare('DELETE FROM character_outfits WHERE character_id = ?').run(CHAR_ID)
  db.prepare('DELETE FROM daily_schedules WHERE character_id = ?').run(CHAR_ID)
}

/** 配 4 套场景服装（足够触发标注层） */
function seedOutfits() {
  reset()
  upsertSceneOutfits(CHAR_ID, [
    { scene: 'work', name: '日常装', description: 'black tactical suit' },
    { scene: 'casual', name: '便装', description: 'white summer dress' },
    { scene: 'home', name: '居家服', description: 'oversized grey sweatshirt' },
    { scene: 'sleep', name: '睡衣', description: 'pale blue nightdress, barefoot' },
  ])
  setCharacterBody(CHAR_ID, 'long silver hair, purple eyes')
}

/**
 * 造一个假 chat，并记录调用次数与最后一次 prompt。
 * @param {string|Function|null} reply 返回内容；null = 不该被调用（被调用就抛）
 * @returns {{chat: Function, calls: {count: number, prompt: string}}}
 */
function fakeChat(reply) {
  const rec = { count: 0, prompt: '' }
  const chat = async (msgs) => {
    rec.count += 1
    rec.prompt = JSON.stringify(msgs.map(m => m.content))
    if (reply === null) throw new Error('假 chat 不该被调用')
    return typeof reply === 'function' ? reply() : reply
  }
  return { chat, calls: rec }
}

/** 用注入的假 chat 跑一次 */
async function run(schedule, reply) {
  const { chat, calls } = fakeChat(reply)
  const r = await ensureOutfitAnnotations(schedule, CHAR_ID, chat)
  r._calls = calls
  return r
}

test('① 没配场景服装 ⇒ 直接放行，不调 LLM', async () => {
  reset()
  const r = await run([{ startTime: '08:00', endTime: '12:00', activity: '上班' }], null)
  assert.equal(r.reason, 'no-outfits')
  assert.equal(r.repaired, false)
  assert.equal(r._calls.count, 0, '不该调 LLM')
})

test('② 换装点 ≥4 且全合法 ⇒ 放行（reason: ok），不调 LLM', async () => {
  seedOutfits()
  const schedule = [
    { startTime: '07:00', endTime: '07:30', activity: '起床梳洗', replyDelay: 0, outfit: '居家服' },
    { startTime: '08:00', endTime: '12:00', activity: '上班', replyDelay: 0, outfit: '日常装' },
    { startTime: '12:00', endTime: '13:00', activity: '午休回家', replyDelay: 0, outfit: '居家服' },
    { startTime: '13:00', endTime: '18:00', activity: '继续上班', replyDelay: 0, outfit: '日常装' },
    { startTime: '22:00', endTime: '07:00', activity: '就寝', replyDelay: -1, outfit: '睡衣' },
  ]
  const r = await run(schedule, null)
  assert.equal(r.reason, 'ok')
  assert.equal(r.repaired, false)
  assert.equal(r._calls.count, 0, '合格就不该修')
  assert.equal(r.schedule, schedule, '不放行时应原样返回同一数组')
})

test('③ 换装点 <4 ⇒ 触发一次专注修复并采纳结果', async () => {
  seedOutfits()
  const schedule = [
    { startTime: '08:00', endTime: '12:00', activity: '上班', replyDelay: 0, outfit: '日常装' },
    { startTime: '12:00', endTime: '18:00', activity: '摸鱼', replyDelay: 0, outfit: null },
    { startTime: '22:00', endTime: '07:00', activity: '就寝', replyDelay: -1, outfit: '睡衣' },
  ]
  const r = await run(schedule, JSON.stringify({ outfits: ['居家服', null, '睡衣'] }))
  assert.equal(r.repaired, true, '应采纳修复结果')
  assert.match(r.reason, /换装点偏少/)
  assert.deepEqual(r.schedule.map(a => a.outfit), ['居家服', null, '睡衣'])
  // 修复 prompt 必须是"只做标注"的专注提示（含日程逐条清单 + 只输出 outfits 数组）
  assert.equal(r._calls.count, 1, '只修一次')
  assert.ok(r._calls.prompt.includes('着装校对员'))
  assert.ok(r._calls.prompt.includes('08:00-12:00'), 'prompt 应含逐时段清单')
})

test('④ 有非法服装名 ⇒ 触发修复', async () => {
  seedOutfits()
  const schedule = [
    { startTime: '08:00', endTime: '12:00', activity: '上班', replyDelay: 0, outfit: 'LLM编的名字' },
    { startTime: '12:00', endTime: '18:00', activity: '摸鱼', replyDelay: 0, outfit: '日常装' },
    { startTime: '22:00', endTime: '07:00', activity: '就寝', replyDelay: -1, outfit: '睡衣' },
  ]
  const r = await run(schedule, JSON.stringify({ outfits: ['日常装', null, '睡衣'] }))
  assert.equal(r.repaired, true)
  assert.match(r.reason, /非法服装名/)
})

test('⑤ 修复结果长度不对 ⇒ 保留原标注，绝不覆盖', async () => {
  seedOutfits()
  const schedule = [
    { startTime: '08:00', endTime: '12:00', activity: '上班', replyDelay: 0, outfit: '日常装' },
    { startTime: '22:00', endTime: '07:00', activity: '就寝', replyDelay: -1, outfit: '睡衣' },
  ]
  const r = await run(schedule, JSON.stringify({ outfits: ['日常装'] }))   // 长度 1 ≠ 2
  assert.equal(r.repaired, false)
  assert.equal(r.reason, 'repair-failed')
  assert.deepEqual(r.schedule.map(a => a.outfit), ['日常装', '睡衣'], '原标注必须原样保留')
})

test('⑤b 修复结果含非法名字 ⇒ 保留原标注', async () => {
  seedOutfits()
  const schedule = [
    { startTime: '08:00', endTime: '12:00', activity: '上班', replyDelay: 0, outfit: '日常装' },
    { startTime: '22:00', endTime: '07:00', activity: '就寝', replyDelay: -1, outfit: '睡衣' },
  ]
  const r = await run(schedule, JSON.stringify({ outfits: ['日常装', '不存在的衣服'] }))
  assert.equal(r.repaired, false)
  assert.deepEqual(r.schedule.map(a => a.outfit), ['日常装', '睡衣'])
})

test('⑥ 修复调用抛错 ⇒ 保留原标注且不向上抛', async () => {
  seedOutfits()
  const schedule = [
    { startTime: '08:00', endTime: '12:00', activity: '上班', replyDelay: 0, outfit: '日常装' },
    { startTime: '22:00', endTime: '07:00', activity: '就寝', replyDelay: -1, outfit: '睡衣' },
  ]
  const r = await run(schedule, () => { throw new Error('网关炸了') })
  assert.equal(r.repaired, false)
  assert.equal(r.reason, 'repair-failed')
  assert.deepEqual(r.schedule.map(a => a.outfit), ['日常装', '睡衣'])
})

test('⑥b 修复返回非 JSON ⇒ 保留原标注', async () => {
  seedOutfits()
  const schedule = [
    { startTime: '08:00', endTime: '12:00', activity: '上班', replyDelay: 0, outfit: '日常装' },
    { startTime: '22:00', endTime: '07:00', activity: '就寝', replyDelay: -1, outfit: '睡衣' },
  ]
  const r = await run(schedule, '我不是 JSON，是一段废话')
  assert.equal(r.repaired, false)
  assert.deepEqual(r.schedule.map(a => a.outfit), ['日常装', '睡衣'])
})

test('⑦ 空日程 / 非数组 ⇒ 直接放行', async () => {
  seedOutfits()
  const r1 = await run([], null)
  assert.equal(r1.reason, 'no-outfits')
  const r2 = await run(null, null)
  assert.equal(r2.reason, 'no-outfits')
  assert.equal(r2._calls.count, 0)
})
