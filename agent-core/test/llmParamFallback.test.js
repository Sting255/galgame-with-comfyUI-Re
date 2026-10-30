/**
 * 网关兼容降级回归（2026-10-20）。
 *
 * 实测 tokenrhythm：聊天接口对 `thinking` / `reasoning_effort` 这类非标准字段回 400，
 * 但连接测试（不带这两个字段）是通的 ⇒ 用户看到「测试已连接、聊天全 400」。
 * 这里钉住：400 时去掉可选参数重试一次，最终能拿到正文。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
process.env.LLM_REASONING_EFFORT = 'low'

const calls = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body || '{}')
  calls.push(body)
  const hasOptional = Object.hasOwn(body, 'thinking') || Object.hasOwn(body, 'reasoning_effort')
  if (hasOptional) {
    return new Response(JSON.stringify({ code: 'INVALID_ARGUMENT', message: 'unsupported parameter', traceId: 'trace_x' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  return new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
await import('openai/shims/web')

const { config } = await import('../src/config.js')
const { chatSync } = await import('../src/llm/llm-client.js')

test('400 时去掉 thinking / reasoning_effort 重试一次并成功', async () => {
  config.llm.freeEgg = false
  config.llm._baseURL = 'https://fallback.invalid/v1'
  config.llm._apiKey = 'test-key'
  config.llm._model = 'test-model'
  config.llm._thinkingMode = 'disabled'
  calls.length = 0

  const content = await chatSync([{ role: 'user', content: '你好' }], { label: 'fallback-test' })

  assert.equal(content, 'ok')
  assert.equal(calls.length, 2, '首次 400 + 去掉可选参数后重试一次')
  assert.ok(calls[0].thinking || calls[0].reasoning_effort, '首次请求确实带了可选参数')
  assert.equal(Object.hasOwn(calls[1], 'thinking'), false, '重试请求不再带 thinking')
  assert.equal(Object.hasOwn(calls[1], 'reasoning_effort'), false, '重试请求不再带 reasoning_effort')
})
