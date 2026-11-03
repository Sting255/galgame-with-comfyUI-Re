/**
 * 原生工具流：模型用 DSML 文本块表达工具调用时的解析兜底
 *
 * 真机取证（2026-11-03，deepseek-v4.1-flash 走 wb2api 网关）：
 * 有一轮 assistant 消息直接吐出了
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="read_group_messages">
 *   <｜｜DSML｜｜ parameter name="group_id" string="false">5</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 * 而 delta.tool_calls 是空的 ⇒ 那一轮工具调用直接丢失，界面上还显示这坨标签。
 *
 * 本文件钉住：
 *   ① 标签不会作为正文吐给前端（text_delta 里不含 DSML 标记）
 *   ② 能解析成标准 tool_calls，string="false" 的参数还原成数字
 *   ③ 标记被分片切开（跨 chunk）也能拼回来
 *   ④ 普通文本流行为不变（逐片原样输出）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readAgentResponse } from '../src/llm/agentStream.js'

const BAR = String.fromCodePoint(0xff5c, 0xff5c)   // 全角竖线 ×2
const DSML = `<${BAR}DSML${BAR}`                  // 用码点构造，避免手写字形相近的字符

function chunk(content, finish = null) {
  return { choices: [{ delta: content === null ? {} : { content }, finish_reason: finish }] }
}

async function* streamOf(chunks) {
  for (const c of chunks) yield c
}

async function collect(chunks) {
  const events = []
  for await (const ev of readAgentResponse(streamOf(chunks))) events.push(ev)
  return events
}

const block = [
  `${DSML} calls>`,
  `${DSML} invoke name="read_group_messages">`,
  `${DSML} parameter name="group_id" string="false">5</${BAR}DSML${BAR} parameter>`,
  `${DSML} parameter name="limit" string="false">10</${BAR}DSML${BAR} parameter>`,
  `</${BAR}DSML${BAR} invoke>`,
  `</${BAR}DSML${BAR} calls>`,
].join('\n')

test('DSML 工具块：不进正文，解析成标准 tool_calls', async () => {
  const events = await collect([chunk(block), chunk(null, 'stop')])
  const text = events.filter(e => e.type === 'text_delta').map(e => e.text).join('')
  assert.ok(!text.includes('DSML'), '标签不能出现在正文里')
  const end = events.find(e => e.type === 'assistant_end')
  assert.equal(end.message.tool_calls.length, 1)
  assert.equal(end.message.tool_calls[0].function.name, 'read_group_messages')
  assert.deepEqual(JSON.parse(end.message.tool_calls[0].function.arguments), { group_id: 5, limit: 10 })
})

test('DSML 被分片切开也能拼回来', async () => {
  const pieces = []
  for (let i = 0; i < block.length; i += 7) pieces.push(block.slice(i, i + 7))
  const events = await collect([...pieces.map(p => chunk(p)), chunk(null, 'stop')])
  const text = events.filter(e => e.type === 'text_delta').map(e => e.text).join('')
  assert.ok(!text.includes('DSML'), '标签不能漏进正文')
  const end = events.find(e => e.type === 'assistant_end')
  assert.equal(end.message.tool_calls?.[0]?.function.name, 'read_group_messages')
})

test('正文 + DSML 混排：正文照常输出，调用照常解析', async () => {
  const events = await collect([
    chunk('我先查一下群里的消息。\n'),
    chunk(block),
    chunk('\n查完了。'),
    chunk(null, 'stop'),
  ])
  const text = events.filter(e => e.type === 'text_delta').map(e => e.text).join('')
  assert.ok(text.includes('我先查一下群里的消息'), '前置正文要保留')
  assert.ok(text.includes('查完了'), '后置正文要保留')
  assert.ok(!text.includes('DSML'))
  const end = events.find(e => e.type === 'assistant_end')
  assert.equal(end.message.tool_calls[0].function.name, 'read_group_messages')
  assert.ok(end.message.content.includes('我先查一下群里的消息'))
})

test('普通文本流行为不变（逐片原样输出）', async () => {
  const events = await collect([chunk('吾神，'), chunk('云庭一切安好。'), chunk(null, 'stop')])
  const texts = events.filter(e => e.type === 'text_delta').map(e => e.text)
  assert.deepEqual(texts, ['吾神，', '云庭一切安好。'])
  const end = events.find(e => e.type === 'assistant_end')
  assert.equal(end.message.content, '吾神，云庭一切安好。')
  assert.equal(end.message.tool_calls, undefined)
})
