import { test } from 'node:test'
import assert from 'node:assert/strict'
import { testStyle } from '../src/api/index.js'

const frame = (event, data) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

test('流式 API 在最终结果到达前回调提示词，支持跨字节分块', async t => {
  let controller, requestBody
  const stream = new ReadableStream({ start(value) { controller = value } })
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    requestBody = JSON.parse(options.body)
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  })
  let delivered
  const promptReceived = new Promise(resolve => { delivered = resolve })
  let completed = false
  const pending = testStyle({ sceneDesc: '咖啡馆' }, { onPrompt: delivered }).then(value => {
    completed = true
    return value
  })
  const bytes = frame('prompt', { generatedPrompt: '咖啡馆 prompt', stage: 'generating' })
  for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
  const prompt = await promptReceived
  assert.equal(prompt.generatedPrompt, '咖啡馆 prompt')
  assert.equal(completed, false)
  assert.equal(requestBody.stream, true)
  controller.enqueue(frame('result', { success: true, images: [{ base64: 'image' }] }))
  controller.close()
  assert.equal((await pending).images[0].base64, 'image')
})

test('流中断时抛出错误，已经回调的提示词不丢失', async t => {
  let prompt
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(frame('prompt', { generatedPrompt: 'retained prompt' }))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } }))
  await assert.rejects(testStyle({}, { onPrompt: data => { prompt = data.generatedPrompt } }), /连接已中断/)
  assert.equal(prompt, 'retained prompt')
})

test('兼容非流式调用和旧后端 JSON 返回', async t => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    bodies.push(JSON.parse(options.body))
    return Response.json({ success: true, generatedPrompt: 'legacy prompt' })
  })
  assert.equal((await testStyle({ prompt: 'manual' })).success, true)
  assert.equal(bodies[0].stream, undefined)
  assert.equal((await testStyle({}, { onPrompt() {} })).generatedPrompt, 'legacy prompt')
  assert.equal(bodies[1].stream, true)
})
