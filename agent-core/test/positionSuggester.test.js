/**
 * 「让她自己决定」体位：模型输出解析 + 非法 key 回退
 *
 * 为什么钉：这条链路只输出一个 key，选到候选外的 key 就会变成「点得动但服务端 400」的死按钮，
 * 而且模型偶尔会把 JSON 包在代码块里、或多写字段 —— 都必须能吃。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { parseSuggestion, suggestPosition, __setSuggestLlm } = await import('../src/services/positionSuggester.js')

const KEY_SET = new Set(['missionary', 'doggystyle', 'cowgirl position'])

test('直出 JSON：正常解析', () => {
  const r = parseSuggestion('{"key":"doggystyle","reason":"她想趴在枕头上"}', KEY_SET)
  assert.deepEqual(r, { key: 'doggystyle', reason: '她想趴在枕头上' })
})

test('代码块包裹 + 多余字段：也能解析', () => {
  const raw = '```json\n{"key":"cowgirl position","reason":"她想看着他","confidence":0.9}\n```'
  assert.equal(parseSuggestion(raw, KEY_SET).key, 'cowgirl position')
})

test('★ 候选外的 key 一律拒绝（防死按钮）', () => {
  assert.equal(parseSuggestion('{"key":"pr24.002.pose","reason":"x"}', KEY_SET), null)
  assert.equal(parseSuggestion('{"key":"","reason":"x"}', KEY_SET), null)
})

test('非 JSON / 空输出：返回 null', () => {
  assert.equal(parseSuggestion('我觉得应该用传教士', KEY_SET), null)
  assert.equal(parseSuggestion('', KEY_SET), null)
  assert.equal(parseSuggestion(null, KEY_SET), null)
})

test('LLM 抛错时回退到合法候选，不把异常抛给前端', async () => {
  __setSuggestLlm(async () => { throw new Error('boom') })
  const r = await suggestPosition({
    character: { id: 1, display_name: '云璃', base_prompt: '你是云璃，剑士。' },
    state: { position: { label: '传教士' }, pace: { label: '中' }, accumulation: 30 },
    candidates: [
      { key: 'missionary', label: '传教士体位' },
      { key: 'doggystyle', label: '狗爬式' },
    ],
  })
  assert.ok(['missionary', 'doggystyle'].includes(r.key))
  assert.equal(r.fallback, true)
  assert.ok(r.label)
})

test('模型给了非法 key 时，同样回退到合法候选', async () => {
  __setSuggestLlm(async () => '{"key":"不存在的体位","reason":"x"}')
  const r = await suggestPosition({
    character: { id: 1, display_name: '云璃', base_prompt: '你是云璃。' },
    state: {},
    candidates: [{ key: 'missionary', label: '传教士体位' }],
  })
  assert.equal(r.key, 'missionary')
  assert.equal(r.fallback, true)
})

test('正常路径：返回模型选中的 key 与理由', async () => {
  __setSuggestLlm(async () => '{"key":"doggystyle","reason":"她不想被他看见脸"}')
  const r = await suggestPosition({
    character: { id: 1, display_name: '云璃', base_prompt: '你是云璃。' },
    state: { position: { label: '传教士' } },
    candidates: [
      { key: 'missionary', label: '传教士体位' },
      { key: 'doggystyle', label: '狗爬式' },
    ],
  })
  assert.equal(r.key, 'doggystyle')
  assert.equal(r.label, '狗爬式')
  assert.equal(r.reason, '她不想被他看见脸')
  assert.equal(r.fallback, undefined)
})
