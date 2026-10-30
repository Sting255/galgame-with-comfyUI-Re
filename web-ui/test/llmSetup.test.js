import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canUseDeepseekSetup, initialLlmSetupMode, connectAndSaveDeepseek,
  describeDeepseekSetupError, readLlmSetupPreference, writeLlmSetupPreference,
} from '../src/utils/llmSetup.js'

function defaults() {
  const llm = { connectionType: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash',
    hasApiKey: false, thinkingMode: 'disabled', maxTokens: 393216, headers: {}, extraBody: {} }
  return { llm, llmProfiles: [{ ...llm, id: 'default', name: '默认配置' }], features: {} }
}

test('new users see the guide; skipping persists without touching their API config', () => {
  const data = defaults()
  const before = structuredClone(data)
  const values = new Map()
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
  assert.equal(initialLlmSetupMode(data, readLlmSetupPreference(storage)), 'guided')
  writeLlmSetupPreference(storage, 'full')
  assert.equal(initialLlmSetupMode(data, readLlmSetupPreference(storage)), 'full')
  assert.deepEqual(data, before)
  writeLlmSetupPreference(storage, 'guided')
  assert.equal(initialLlmSetupMode(data, readLlmSetupPreference(storage)), 'guided')
})

test('existing credentials stay in full settings unless the user previously chose the guide', () => {
  const data = defaults()
  data.llm.hasApiKey = true
  assert.equal(initialLlmSetupMode(data, ''), 'full')
  assert.equal(initialLlmSetupMode(data, 'guided'), 'guided')
})

test('custom, Vertex, multi-profile and customized official setups are never hidden by the guide', () => {
  for (const change of [
    data => { data.llm.connectionType = 'vertexai' },
    data => { data.llm.baseURL = 'https://relay.example/v1' },
    data => { data.llm.model = 'another-model' },
    data => { data.llm.hasVertexServiceAccount = true },
    data => { data.llm.thinkingMode = 'enabled' },
    data => { data.llm.maxTokens = 4096 },
    data => { data.llm.headers = { 'X-Title': 'custom' } },
    data => { data.llm.extraBody = { temperature: 0.5 } },
    data => { data.features.mergeMessages = true },
    data => { data.features.serializeBackgroundLLM = true },
    data => { data.llmProfiles.push({ name: 'another' }) },
    data => { data.llmProfiles[0].name = '我自己的配置' },
    data => { data.llm.freeEgg = true },
  ]) {
    const data = defaults()
    change(data)
    assert.equal(canUseDeepseekSetup(data), false)
    assert.equal(initialLlmSetupMode(data, 'guided'), 'full')
  }
  assert.equal(initialLlmSetupMode({}, ''), 'full')
})

test('guide uses the official endpoint and tests before saving the trimmed key', async () => {
  const calls = []
  const stages = []
  const result = await connectAndSaveDeepseek('  fake-test-key  ', {
    testConnection: async payload => { calls.push(['test', payload]); return { ok: true } },
    saveConfig: async payload => { calls.push(['save', payload]); return { ok: true, hasApiKey: true } },
    onStage: stage => stages.push(stage),
  })
  assert.deepEqual(stages, ['testing', 'saving'])
  assert.deepEqual(calls.map(([action]) => action), ['test', 'save'])
  assert.deepEqual(calls[0][1], { connectionType: 'openai', baseURL: 'https://api.deepseek.com',
    model: 'deepseek-flash', apiKey: 'fake-test-key', thinkingMode: 'disabled', maxTokens: 393216, headers: {}, extraBody: {} })
  assert.deepEqual(calls[0][1], calls[1][1])
  assert.equal(result.hasApiKey, true)
})

test('blank keys and failed tests never save; failed persistence never reports success', async () => {
  let saves = 0
  const saveConfig = async () => { saves++; return { ok: true, hasApiKey: true } }
  await assert.rejects(connectAndSaveDeepseek(' ', { testConnection: () => assert.fail(), saveConfig }), /粘贴/)
  await assert.rejects(connectAndSaveDeepseek('fake', { testConnection: async () => { throw new Error('401') }, saveConfig }), /401/)
  await assert.rejects(connectAndSaveDeepseek('fake', { testConnection: async () => ({ ok: false, error: 'invalid key' }), saveConfig }), /invalid key/)
  assert.equal(saves, 0)
  for (const save of [async () => { throw new Error('network') }, async () => ({ ok: false }), async () => ({ ok: true, hasApiKey: false })]) {
    await assert.rejects(connectAndSaveDeepseek('fake', { testConnection: async () => ({ ok: true }), saveConfig: save }), error => error.stage === 'saving' && /保存失败/.test(error.message))
  }
})

test('actionable errors do not echo upstream credentials or raw payloads', () => {
  assert.match(describeDeepseekSetupError(new Error('401 incorrect API key sk-private')), /Key 无效/)
  assert.match(describeDeepseekSetupError(new Error('Insufficient Balance')), /余额不足/)
  assert.match(describeDeepseekSetupError(new Error('fetch failed')), /检查网络/)
  assert.match(describeDeepseekSetupError(new Error('429 rate limit')), /稍等/)
  assert.doesNotMatch(describeDeepseekSetupError(new Error('sk-private custom server error')), /sk-private/)
  const storage = { getItem() { throw new Error() }, setItem() { throw new Error() } }
  assert.equal(readLlmSetupPreference(storage), '')
  assert.doesNotThrow(() => writeLlmSetupPreference(storage, 'full'))
})
