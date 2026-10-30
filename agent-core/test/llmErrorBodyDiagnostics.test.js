/**
 * 非 OpenAI 错误包体的诊断回归（2026-10-20）。
 *
 * 背景：tokenrhythm 之类的中转出错时返回 `{code,message,traceId}`，
 * OpenAI SDK 只认 `{error:{message}}` ⇒ 报 "400 status code (no body)"，真实原因丢失。
 * `createDiagnosticFetch` 会把原始响应体写进日志；这里用一个会回 400 的本地 server 钉住它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { testLlmConnection } from '../src/llm/llm-client.js'

test('中转返回 {code,message} 错误体时，原始 message 要出现在日志里', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      code: 'INVALID_ARGUMENT',
      message: 'max_tokens is too large: 32768',
      traceId: 'trace_test_1',
    }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port

  const logs = []
  const original = console.error
  console.error = (...args) => { logs.push(args.join(' ')) }
  t.after(() => { console.error = original })

  await assert.rejects(
    testLlmConnection({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'test-model', maxTokens: 32768 }),
  )

  const text = logs.join('\n')
  assert.match(text, /\[llm:test\] HTTP 400/, '要打印状态码与来源')
  assert.match(text, /max_tokens is too large: 32768/, '要带出中转的原始 message')
  assert.match(text, /INVALID_ARGUMENT/, '要带出 code')
})
