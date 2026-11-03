/**
 * 信箱回信：JSON 被上游截断时的正文兜底
 *
 * 真机取证（2026-11-03，deepseek-v4.1-flash 走 wb2api 网关）：
 * 回信模型只输出了 565 token 就停了，JSON 在 illustrationPrompt 中间断掉、缺闭合括号：
 *   { "text": "Sting，来信收到。\n剑练得如何？……",
 *     "paperPrompt": "...",
 *     "illustrationPrompt": "yunli ... stares past
 * 整块 JSON.parse 必然失败，于是走了「整段当正文」的兜底 —— 用户在信箱里看到的是
 * 带花括号、字段名和一串英文 prompt 的原文。
 *
 * 本文件钉住：截断时只抽出 text 字段，回信正文保持干净；完整 JSON 与拒答两条老路径不受影响。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { parseReplyJSON } = await import('../src/services/mailboxScheduler.js')

const FULL = JSON.stringify({
  text: '来信收到。\n剑势未钝，只差心上一线。',
  paperPrompt: 'pale letter paper, golden cloud border',
  portraitPrompt: 'yunli writing a letter by candlelight',
  illustrationPrompt: 'empty training ground at night',
})

test('完整 JSON：四个字段正常解析', () => {
  const out = parseReplyJSON(FULL, '')
  assert.equal(out.text, '来信收到。\n剑势未钝，只差心上一线。')
  assert.equal(out.paperPrompt, 'pale letter paper, golden cloud border')
  assert.ok(out.illustrationPrompt.includes('training ground'))
})

test('★ JSON 被截断：只抽出 text，正文不带花括号与字段名', () => {
  const truncated = FULL.slice(0, FULL.indexOf('illustrationPrompt') + 30)   // 断在字段中间
  const out = parseReplyJSON(truncated, '')
  assert.ok(out, '截断也要能出结果，不能整封退回原文')
  assert.equal(out.text, '来信收到。\n剑势未钝，只差心上一线。')
  assert.doesNotMatch(out.text, /[{}\\]|"text"|paperPrompt/, '正文里不能残留 JSON 结构')
  // 缺失的配图字段补默认值，后续生图不会拿到 undefined
  assert.ok(out.paperPrompt.includes('letter paper'))
  assert.ok(out.portraitPrompt)
  assert.ok(out.illustrationPrompt)
})

test('截断且 text 内含转义引号：反转义后仍是原文', () => {
  const raw = '{ "text": "他说「拔剑便是」，然后就沉默了。\\n——云璃", "paperPrompt": "x'
  const out = parseReplyJSON(raw, '')
  assert.match(out.text, /拔剑便是/)
  assert.match(out.text, /云璃/)
})

test('整段完全不是 JSON：仍然回落原文（老行为不变）', () => {
  const out = parseReplyJSON('这里只有一段普通文字，没有任何结构。', '')
  assert.equal(out.text, '这里只有一段普通文字，没有任何结构。')
})

test('拒答文本：返回 null，不当成回信正文', () => {
  const out = parseReplyJSON('抱歉，我无法提供这类内容。', '')
  assert.equal(out, null)
})

test('空输入：返回 null', () => {
  assert.equal(parseReplyJSON('', ''), null)
  assert.equal(parseReplyJSON(null, ''), null)
})
