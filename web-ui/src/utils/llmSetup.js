import { DEEPSEEK_MAX_TOKENS } from '../../../agent-core/src/llm/modelCapabilities.js'

export const LLM_SETUP_PREFERENCE_KEY = 'linshe.llm.setup-view'

// Only the untouched official preset is eligible. Never hide an existing custom setup.
export function canUseDeepseekSetup(data) {
  const llm = data?.llm
  if (!llm || llm.freeEgg || (llm.connectionType && llm.connectionType !== 'openai')) return false
  if (!['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(String(llm.baseURL || '').replace(/\/+$/, ''))) return false
  if (llm.model !== 'deepseek-flash' || llm.hasVertexServiceAccount) return false
  if (llm.thinkingMode && llm.thinkingMode !== 'disabled') return false
  if (llm.maxTokens != null && llm.maxTokens !== DEEPSEEK_MAX_TOKENS) return false
  if (Object.keys(llm.headers || {}).length || Object.keys(llm.extraBody || {}).length) return false
  if (data.features?.mergeMessages || data.features?.serializeBackgroundLLM) return false
  const profiles = data.llmProfiles || []
  return profiles.length === 0 || (profiles.length === 1
    && profiles[0].name === '默认配置'
    && (!profiles[0].connectionType || profiles[0].connectionType === 'openai')
    && !profiles[0].hasVertexServiceAccount
    && profiles[0].model === llm.model
    && String(profiles[0].baseURL || '').replace(/\/+$/, '') === String(llm.baseURL).replace(/\/+$/, ''))
}

export function initialLlmSetupMode(data, preference) {
  if (preference === 'full' || !canUseDeepseekSetup(data)) return 'full'
  return !data.llm.hasApiKey || preference === 'guided' ? 'guided' : 'full'
}

export function readLlmSetupPreference(storage) {
  try { return storage.getItem(LLM_SETUP_PREFERENCE_KEY) || '' } catch { return '' }
}

export function writeLlmSetupPreference(storage, mode) {
  try { storage.setItem(LLM_SETUP_PREFERENCE_KEY, mode) } catch { /* UI still works when storage is unavailable. */ }
}

export function deepseekSetupPayload(apiKey) {
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('请先粘贴 DeepSeek API Key。')
  return {
    connectionType: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash',
    apiKey: key, maxTokens: DEEPSEEK_MAX_TOKENS, thinkingMode: 'disabled', headers: {}, extraBody: {},
  }
}

export function describeDeepseekSetupError(error) {
  const message = String(error?.message || '')
  if (/余额|insufficient.*(balance|quota)|payment|402/i.test(message)) return 'DeepSeek 余额不足，请到 DeepSeek 平台充值后重试。'
  if (/401|unauthorized|authentication|invalid.*(key|token)|api.?key.*invalid|密钥.*无效/i.test(message)) return 'Key 无效或已失效，请重新复制完整的 DeepSeek API Key。'
  if (/403|permission|forbidden/i.test(message)) return '这个 Key 暂时没有访问权限，请检查 DeepSeek 账号状态。'
  if (/429|rate.?limit|too many/i.test(message)) return 'DeepSeek 请求较多，请稍等片刻再试。'
  if (/network|fetch|timeout|timed out|econn|enotfound|网络|超时/i.test(message)) return '暂时连不上 DeepSeek，请检查网络后重试。'
  return '暂时无法完成连接，请稍后重试；也可以选择其他接口。'
}

export async function connectAndSaveDeepseek(apiKey, { testConnection, saveConfig, onStage = () => {} }) {
  const payload = deepseekSetupPayload(apiKey)
  onStage('testing')
  const test = await testConnection(payload)
  if (!test?.ok) throw new Error(test?.error || '连接测试失败')
  onStage('saving')
  try {
    const result = await saveConfig(payload)
    if (!result?.ok || !result.hasApiKey) throw new Error('配置未保存')
    return result
  } catch {
    // Do not present a successful test as a successful setup if persistence fails.
    const error = new Error('已连接到 DeepSeek，但保存失败，请重试。')
    error.stage = 'saving'
    throw error
  }
}
