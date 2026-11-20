import { ref, computed } from 'vue'
import { defaultMaxTokens, isValidMaxTokens } from '../../../../agent-core/src/llm/modelCapabilities.js'
import { validateVertexServiceAccount } from '../../api/index.js'
import { useLlmProfiles } from '../useLlmProfiles.js'
import { canUseDeepseekSetup, writeLlmSetupPreference, initialLlmSetupMode, readLlmSetupPreference } from '../../utils/llmSetup.js'
import { getConfig, updateLlmConfig, testLlmConnection, setLlmFreeEgg, fetchLlmModels, fetchLlmApiKey, updateFeatureFlag, updateBackgroundConcurrency, addLlmProfile, deleteLlmProfile, activateLlmProfile, syncActiveLlmProfile, getModelRoutes, saveModelRoutes } from '../../api/index.js'

// 每个设置页实例独享草稿；只通过 shared 共享跨域的功能开关与全局设置。
export function useLlmSettings(shared) {
  const { settingsStore, toastFn, confirmFn, features, backgroundConcurrency } = shared

  // 模型配置保存中：按钮 loading，防止连点（保存失败必须有可见反馈，见 saveLlmConfig）
  const llmSaving = ref(false)

  // ── LLM API ──
  const llmPreview = ref({ provider: 'deepseek', hasApiKey: false, preview: '', model: 'deepseek-chat' })

  const freeEgg = ref(false)

  const llmApiKey = ref('')

  /**
   * 只有**用户手动输入过**才把 apiKey 提交（上游 v3.10.0 口径）：
   * 浏览器自动填充的旧值如果被当成"用户输入"，会被写回库/覆盖 Profile。
   */
  const llmApiKeyTouched = ref(false)

  function onLlmKeyInput() {
    llmApiKeyTouched.value = true
    clearLlmModels()
    markLlmDirty()
  }

  const llmBaseURL = ref('https://api.deepseek.com')

  // 接入方式：OpenAI 兼容接口 / Google Vertex AI（服务账号）
  const llmConnectionType = ref('openai')

  const llmConnectionOptions = [
    { value: 'openai', label: 'OpenAI 兼容接口（DeepSeek / 自定义）' },
    { value: 'vertexai', label: 'Google Vertex AI（服务账号）' },
  ]

  const vertexServiceAccount = ref('')

  const hasVertexServiceAccount = ref(false)

  const vertexRegion = ref('global')

  const vertexRegionOptions = ['global', 'us-central1', 'europe-west1', 'asia-northeast1'].map(value => ({ value, label: value }))

  const vertexValidating = ref(false)

  const vertexValidation = ref('')

  let vertexValidationVersion = 0

  function onVertexAccountInput() {
    vertexValidationVersion++
    vertexValidation.value = ''
    vertexValidating.value = false
    clearLlmModels()
    markLlmDirty()
  }

  /** 回显已保存的 Vertex 配置：账号明文永远不回显，只回 hasVertexServiceAccount */
  function restoreVertexSettings(saved) {
    llmConnectionType.value = saved.connectionType === 'vertexai' ? 'vertexai' : 'openai'
    vertexRegion.value = saved.vertexRegion || 'global'
    hasVertexServiceAccount.value = Boolean(saved.hasVertexServiceAccount)
    vertexServiceAccount.value = ''
    vertexValidation.value = ''
    vertexValidationVersion++
    vertexValidating.value = false
  }

  function onLlmConnectionChange() {
    if (llmConnectionType.value === 'vertexai') {
      llmBaseURL.value = 'https://aiplatform.googleapis.com'
      llmModel.value = 'gemini-2.5-pro'
      llmThinkingMode.value = 'omit'
      isCustomBaseURL.value = true
    } else {
      llmBaseURL.value = 'https://api.deepseek.com'
      llmModel.value = 'deepseek-flash'
      // DeepSeek 官方地址原生态支持 thinking:disabled，用它速度更快更省 token；
      // 只有自定义中转（默认 'omit'）才完全不发思考字段。
      llmThinkingMode.value = 'disabled'
      isCustomBaseURL.value = false
    }
    llmHeadersEnabled.value = false
    llmExtraBodyEnabled.value = false
    clearLlmModels()
    fillLlmMaxTokens()
    markLlmDirty()
  }

  async function validateVertexAccount() {
    if (vertexValidating.value) return
    const version = ++vertexValidationVersion
    vertexValidating.value = true
    vertexValidation.value = ''
    try {
      const result = await validateVertexServiceAccount({ vertexServiceAccount: vertexServiceAccount.value.trim() || undefined })
      if (version !== vertexValidationVersion) return
      vertexValidation.value = `认证通过 · ${result.projectId}${vertexServiceAccount.value.trim() ? ' · 请保存配置' : ''}`
    } catch (error) {
      if (version !== vertexValidationVersion) return
      vertexValidation.value = error.message || '服务账号验证失败'
    } finally {
      if (version === vertexValidationVersion) vertexValidating.value = false
    }
  }

  const llmModel = ref('deepseek-chat')

  const llmModels = ref([])

  const llmModelsLoading = ref(false)

  const llmModelsError = ref('')

  const llmModelSelect = ref(null)

  // Vertex 没有"取模型列表"那一步，给两个常用模型兜底
  const llmModelOptions = computed(() => (llmModels.value.length
    ? llmModels.value
    : llmConnectionType.value === 'vertexai' ? ['gemini-2.5-pro', 'gemini-2.5-flash'] : []
  ).map(model => ({ value: model, label: model })))

  const llmModelSelectVal = computed({
    get: () => llmModel.value,
    set: (val) => {
      if (llmModel.value === val) return
      llmModel.value = val
      fillLlmMaxTokens()
      markLlmDirty()
    },
  })

  // ── 输出额度（MAX_tokens）：默认按「地址 + 模型」算，模型能力拿到后优先用接口上限 ──
  const llmMaxTokens = ref(defaultMaxTokens(llmBaseURL.value, llmModel.value))

  const llmMaxTokensValid = computed(() => isValidMaxTokens(llmMaxTokens.value))

  const llmTokenSource = ref('default')

  const llmModelCapabilities = ref({})

  let llmModelsVersion = 0

  // ── 按用途分配模型（2026-11-07）──
  // 神说需要「愿意写、不设防」的模型，日程 / 事件结局需要「稳定输出完整 JSON」的模型，
  // 这两类需求常指向不同供应商——一个模型通吃的结果是两头都不够好。
  // 后端存 system_settings.llm_model_routes，生效点在 llm-client 的三个收口。
  const modelRoutes = ref([])

  const modelRoutesDefault = ref('')

  const modelRoutesFreeEgg = ref(false)

  const modelRoutesError = ref('')

  const modelRoutesSaving = ref(false)

  const modelRoutesSaved = ref(false)

  const modelRoutesDirty = ref(false)

  let modelRoutesSnapshot = ''

  const modelRoutesSignature = () => JSON.stringify(modelRoutes.value.map(r => [r.key, r.model || '']))

  function applyModelRouteData(data) {
    modelRoutes.value = (data?.routes || []).map(r => ({ key: r.key, label: r.label, model: r.model || '' }))
    modelRoutesDefault.value = data?.defaultModel || ''
    modelRoutesFreeEgg.value = !!data?.freeEgg
    modelRoutesSnapshot = modelRoutesSignature()
    modelRoutesDirty.value = false
  }

  async function loadModelRoutes() {
    modelRoutesError.value = ''
    try {
      applyModelRouteData(await getModelRoutes())
    } catch (err) {
      // 读失败只影响这一块，不阻塞设置页其它配置
      modelRoutesError.value = err?.message || '读取按用途分配失败'
    }
  }

  function markModelRoutesDirty() {
    modelRoutesDirty.value = modelRoutesSignature() !== modelRoutesSnapshot
    modelRoutesSaved.value = false
  }

  async function saveModelRouteChanges() {
    if (modelRoutesSaving.value) return
    modelRoutesSaving.value = true
    modelRoutesError.value = ''
    try {
      const patch = {}
      for (const r of modelRoutes.value) patch[r.key] = r.model || ''
      applyModelRouteData(await saveModelRoutes(patch))
      modelRoutesSaved.value = true
      setTimeout(() => { modelRoutesSaved.value = false }, 2000)
    } catch (err) {
      modelRoutesError.value = err?.message || '保存失败'
    } finally {
      modelRoutesSaving.value = false
    }
  }

  let llmTokenEditVersion = 0

  const llmMaxTokensHint = computed(() => {
    if (!llmMaxTokensValid.value) return '请输入大于 0 的整数。'
    const amount = Number(llmMaxTokens.value).toLocaleString()
    // 输出额度没有硬上限（服务商各自不同），但填出远超真实上限的大数会被服务商拒绝或截断。
    // 2026-11-07：**只在「上游明确声明过上限」时才比较**——点过「获取模型」才有这个值。
    // 硬编码表只是兜底估计（deepseek v4 族猜 32768，中转站实际 393216），
    // 拿它比较会把完全合规的 393216 报成「远超上限 32,768」，和后端 applyOutputTokenLimit 同口径。
    const cap = llmModelCapabilities.value[llmModel.value]?.maxTokens
    if (isValidMaxTokens(cap) && Number(llmMaxTokens.value) > cap * 1.5) {
      return `当前额度 ${amount} tokens，远超这个模型的常用上限 ${Number(cap).toLocaleString()}`
        + ' —— 部分服务商会直接拒绝或截断回复，建议改回常用值。'
    }
    if (llmTokenSource.value === 'model') return '已从模型能力自动填入 ' + amount + ' tokens，可手动调整。'
    if (llmTokenSource.value === 'manual' || llmTokenSource.value === 'saved') return '当前额度 ' + amount + ' tokens，仍受服务商上限约束。'
    return '默认额度 ' + amount + ' tokens；自动获取模型后优先使用接口上限，也可手动调整。'
  })

  /** 额度是否远超模型上限（只做提示，不拦保存：用户可能确实知道自己在干什么） */
  const llmMaxTokensOversized = computed(() => {
    if (!llmMaxTokensValid.value) return false
    // 同上：没有上游声明值就不判断，避免用兜底估计误报
    const cap = llmModelCapabilities.value[llmModel.value]?.maxTokens
    return isValidMaxTokens(cap) && Number(llmMaxTokens.value) > cap * 1.5
  })

  function clearLlmModels() {
    llmModelsVersion++
    llmModelsLoading.value = false
    llmModels.value = []
    llmModelCapabilities.value = {}
    llmModelsError.value = ''
  }

  function fillLlmMaxTokens() {
    const capability = llmModelCapabilities.value[llmModel.value]
    llmMaxTokens.value = isValidMaxTokens(capability?.maxTokens) ? capability.maxTokens : defaultMaxTokens(llmBaseURL.value, llmModel.value)
    llmTokenSource.value = isValidMaxTokens(capability?.maxTokens) ? 'model' : 'default'
  }

  /** 保存/切换配置后回填（含 Vertex 的公开字段；账号明文不接受回显） */
  function restoreLlmMaxTokens(saved) {
    restoreVertexSettings(saved)
    clearLlmModels()
    llmTokenEditVersion++
    llmMaxTokens.value = isValidMaxTokens(saved.maxTokens) ? saved.maxTokens : defaultMaxTokens(llmBaseURL.value, llmModel.value)
    llmTokenSource.value = isValidMaxTokens(saved.maxTokens) ? 'saved' : 'default'
  }

  function onLlmMaxTokensInput() {
    llmTokenEditVersion++
    llmTokenSource.value = 'manual'
    markLlmDirty()
  }

  function onLlmEndpointInput() {
    clearLlmModels()
    fillLlmMaxTokens()
    markLlmDirty()
  }

  const llmThinkingMode = ref('disabled')

  // ── 上下文窗口声明（token）：留空交给服务端从上游模型列表探测 / 用默认值 ──
  // 用字符串持有输入，避免数字输入框在清空过程中把用户输到一半的内容吃掉。
  const llmContextWindowText = ref('')

  const llmContextWindowValid = computed(() => {
    const raw = String(llmContextWindowText.value ?? '').trim()
    if (!raw) return true   // 留空 = 自动探测，合法
    return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0
  })

  /** 保存口径：留空传 null（服务端清掉声明），否则传整数 token */
  const llmContextWindowValue = computed(() => {
    const raw = String(llmContextWindowText.value ?? '').trim()
    if (!raw || !llmContextWindowValid.value) return null
    return Number(raw)
  })

  function applyLlmContextWindow(value) {
    llmContextWindowText.value = value === null || value === undefined || value === '' ? '' : String(value)
  }

  // 只留「关 / 开」两项（2026-10-30 用户要求）：
  // 后端的 omit（一个思考字段都不发）仍保留给免费通道与个别中转自动使用，
  // 界面上统一按「关」呈现 —— 它就是"不启用思考"，用户没必要为此多一个选项。
  const thinkingModeOptions = [
    { value: 'disabled', label: '关' },
    { value: 'enabled', label: '开' },
  ]

  /** 只两档：点「关」写 disabled（明确禁用），点「开」写 enabled；历史值 omit 在界面上即「关」 */
  function onThinkingModePick(value) {
    llmThinkingMode.value = value === 'enabled' ? 'enabled' : 'disabled'
    markLlmDirty()
  }

  const isCustomBaseURL = ref(false)

  // 目前只内置 DeepSeek 一个官方地址，其余服务统一走「自定义…」手填
  const presetURLs = ['https://api.deepseek.com']

  const llmBaseURLOptions = [
    { value: 'https://api.deepseek.com', label: 'DeepSeek' },
    { value: '', label: '自定义…' },
  ]

  const llmBaseURLSelectVal = computed({
    get: () => isCustomBaseURL.value ? '' : llmBaseURL.value,
    set: (val) => {
      if (val === '') {
        isCustomBaseURL.value = true
        llmBaseURL.value = ''
      } else {
        isCustomBaseURL.value = false
        llmBaseURL.value = val
        // 换回官方地址：思考口径与自定义请求头一律复位（上游 v3.10.0）
        llmThinkingMode.value = 'disabled'
        llmHeadersEnabled.value = false
        llmExtraBodyEnabled.value = false
        llmHeadersText.value = '{}'
        llmExtraBodyText.value = '{}'
        features.serializeBackgroundLLM = false
        backgroundConcurrency.value = 3
        features.mergeMessages = false
      }
      clearLlmModels()
      fillLlmMaxTokens()
      markLlmDirty()
    }
  })

  const llmHeadersEnabled = ref(false)

  const llmHeadersText = ref('{}')

  const llmHeadersValid = computed(() => {
    if (!llmHeadersEnabled.value) return true
    try { const value = JSON.parse(llmHeadersText.value); return !!value && typeof value === 'object' && !Array.isArray(value) } catch { return false }
  })

  const llmExtraBodyEnabled = ref(false)

  const llmExtraBodyText = ref('{}')

  // Vertex 的额外请求体是 Google 的 generationConfig，OpenAI 兼容接口则是自定义字段
  const llmExtraBodyPlaceholder = computed(() => JSON.stringify(llmConnectionType.value === 'vertexai'
    ? { generationConfig: { topK: 40 } }
    : { agent: 'my-agent', agentName: 'Nova' }))

  const llmExtraBodyValid = computed(() => {
    if (!llmExtraBodyEnabled.value) return true
    try { const value = JSON.parse(llmExtraBodyText.value); return !!value && typeof value === 'object' && !Array.isArray(value) } catch { return false }
  })

  const showApiKey = ref(false)

  const llmDirty = ref(false)

  const llmSaved = ref(false)

  const llmTesting = ref(false)

  let llmDraftRevision = 0

  function markLlmDirty() { llmDraftRevision++; llmDirty.value = true; llmSaved.value = false }

  // 高级设置抽屉
  const llmAdvancedOpen = ref(false)

  function toggleLlmAdvanced() { llmAdvancedOpen.value = !llmAdvancedOpen.value }

  // 推荐第三方 LLM 中转站
  const showRelayModal = ref(false)

  const relayStations = [
    { name: '词元跳动', keysUrl: 'https://tokendance.space/keys', url: 'https://tokendance.space/gateway/v1', desc: '仍然提供v4flash预览版，所以没有涨价' },
    { name: '基元律动', keysUrl: 'https://tokenrhythm.studio/i/rf_tr_sFVpaGViDHbVQrjGtHKXT2in', url: 'https://tokenrhythm.studio/v1', desc: '注册即送68元，邀请还送68元，同样还有flash预览版，但是不够稳定' },
  ]

  const relayConfigBusy = ref(false)

  function uniqueProfileName(baseName) {
    const names = new Set(llmProfiles.value.map(p => p.name))
    if (!names.has(baseName)) return baseName
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    let candidate = `${baseName}-${date}`
    let index = 2
    while (names.has(candidate)) {
      candidate = `${baseName}-${date}-${index}`
      index += 1
    }
    return candidate
  }

  async function applyRelayConfig(station) {
    if (llmBusy.value || relayConfigBusy.value) return
    relayConfigBusy.value = true
    try {
      const name = uniqueProfileName(station.name)
      const success = await addProfile(name, {
        connectionType: 'openai', apiKey: '', baseURL: station.url, model: 'deepseek-flash',
        thinkingMode: 'disabled', headers: {}, extraBody: {},
        serializeBackgroundLLM: false, mergeMessages: false, backgroundConcurrency: 3,
      }, { activateNew: true })
      if (success) {
        showRelayModal.value = false
        toastFn?.('已新增并启用「' + name + '」', 'success')
      }
    } finally { relayConfigBusy.value = false }
  }

  // 每日免费鸡蛋：点击按钮开/关；开 = 走 opencode zen 免费端点（免 Key、强制关思考），关 = 恢复自有配置
  const freeEggBusy = ref(false)

  const freeEggBtn = ref(null)

  const eggSplash = ref(null)

  let eggSplashSeq = 0

  function burstEggSplash() {
    const btn = freeEggBtn.value
    if (btn) {
      btn.animate(
        [
          { transform: 'scale(1.02, 0.8) rotate(-2deg)', boxShadow: 'inset 0 0 0 5px rgba(255, 214, 70, 0.95)', filter: 'brightness(1.5)' },
          { transform: 'scale(1.12, 1.24) rotate(2deg)', boxShadow: 'inset 0 0 0 2px rgba(255, 214, 70, 0.45)', filter: 'brightness(1.2)', offset: 0.35 },
          { transform: 'scale(0.96, 1.04) rotate(0deg)', boxShadow: 'inset 0 0 0 0 rgba(255, 214, 70, 0)', filter: 'brightness(1.02)', offset: 0.68 },
          { transform: 'scale(1, 1) rotate(0deg)', boxShadow: 'inset 0 0 0 0 rgba(255, 214, 70, 0)', filter: 'brightness(1)' }
        ],
        { duration: 460, easing: 'cubic-bezier(0.22, 0.9, 0.3, 1.35)' }
      )
    }

    const drops = []
    const dropColors = ['#ffd83d', '#ffc61a', '#fff3c4', '#ffb02e', '#ffe38a']
    for (let i = 0; i < 16; i++) {
      const angle = (Math.PI * 2 * i) / 16 + (Math.random() - 0.5) * 0.55
      const dist = 52 + Math.random() * 88
      const x = Math.cos(angle) * dist
      const y = Math.sin(angle) * dist
      const size = 4 + Math.random() * 7
      drops.push({
        id: i,
        style: {
          '--x': `${x.toFixed(1)}px`,
          '--y': `${y.toFixed(1)}px`,
          '--mx': `${(x * 0.6).toFixed(1)}px`,
          '--my': `${(y * 0.6).toFixed(1)}px`,
          '--fall': `${(16 + Math.random() * 44).toFixed(1)}px`,
          '--size': `${size.toFixed(1)}px`,
          '--rot': `${(angle * 180 / Math.PI + 90).toFixed(1)}deg`,
          '--dur': `${(540 + Math.random() * 340).toFixed(0)}ms`,
          '--delay': `${(Math.random() * 40).toFixed(0)}ms`,
          '--color': dropColors[i % dropColors.length]
        }
      })
    }

    const shards = []
    for (let i = 0; i < 7; i++) {
      const angle = (Math.PI * 2 * i) / 7 + (Math.random() - 0.5) * 0.7
      const dist = 66 + Math.random() * 60
      const x = Math.cos(angle) * dist
      const y = Math.sin(angle) * dist
      const size = 7 + Math.random() * 6
      shards.push({
        id: i,
        style: {
          '--x': `${x.toFixed(1)}px`,
          '--y': `${y.toFixed(1)}px`,
          '--mx': `${(x * 0.55).toFixed(1)}px`,
          '--my': `${(y * 0.55).toFixed(1)}px`,
          '--size': `${size.toFixed(1)}px`,
          '--rot': `${(angle * 180 / Math.PI).toFixed(1)}deg`,
          '--dur': `${(620 + Math.random() * 260).toFixed(0)}ms`,
          '--delay': `${(Math.random() * 35).toFixed(0)}ms`
        }
      })
    }

    eggSplash.value = { id: ++eggSplashSeq, drops, shards }
  }

  function onFreeEggClick() {
    if (llmBusy.value) return
    burstEggSplash()
    toggleFreeEgg()
  }

  async function toggleFreeEgg() {
    if (llmBusy.value) return
    freeEggBusy.value = true
    try {
      if (llmDirty.value) {
        const options = { title: '切换免费模式', message: '当前修改尚未保存，切换会放弃这些修改。', okText: '放弃修改并切换' }
        const accepted = confirmFn ? await confirmFn(options) : window.confirm(options.message)
        if (!accepted) return
      }
      const next = !freeEgg.value
      const result = await setLlmFreeEgg(next)
      if (!result.ok) throw new Error(result.error || '服务端未完成切换')
      freeEgg.value = next
      applyLlmConfig(result)
      toastFn?.(next ? '已开启每日免费鸡蛋 🥚' : '已恢复自有 LLM 配置', 'success')
    } catch (err) {
      toastFn?.('切换免费鸡蛋失败: ' + (err.message || '未知错误'), 'error')
    } finally { freeEggBusy.value = false }
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text)
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    return Promise.resolve()
  }

  async function copyLlmApiKey() {
    let key = llmApiKey.value.trim()
    if (!key) {
      try {
        const data = await fetchLlmApiKey()
        key = data.apiKey || ''
      } catch (err) {
        const msg = err.message || '未知错误'
        toastFn?.(msg === '未设置 API Key' ? '暂无 API Key 可复制' : '获取 API Key 失败: ' + msg, msg === '未设置 API Key' ? 'warning' : 'error')
        return
      }
    }
    if (!key) {
      toastFn?.('暂无 API Key 可复制', 'warning')
      return
    }
    try {
      await copyTextToClipboard(key)
      toastFn?.('API Key 已复制', 'success')
    } catch (err) {
      toastFn?.('复制失败: ' + (err.message || '未知错误'), 'error')
    }
  }

  async function loadAvailableModels() {
    if (llmModelsLoading.value || (llmConnectionType.value === 'openai' && !llmBaseURL.value.trim())) return
    if (llmHeadersEnabled.value && !llmHeadersValid.value) {
      llmModelsError.value = '请先修正自定义请求头 JSON'
      return
    }

    // 版本号：慢请求回来时如果地址/模型/手动额度已经变过，就不许覆盖用户的新选择
    const requestVersion = ++llmModelsVersion
    const editVersion = llmTokenEditVersion
    llmModelsLoading.value = true
    llmModelsError.value = ''
    llmModels.value = []
    try {
      const headers = llmHeadersEnabled.value ? JSON.parse(llmHeadersText.value) : {}
      const result = await fetchLlmModels({
        connectionType: llmConnectionType.value,
        vertexRegion: vertexRegion.value,
        vertexServiceAccount: llmConnectionType.value === 'vertexai' ? vertexServiceAccount.value.trim() || undefined : undefined,
        baseURL: llmBaseURL.value.trim(),
        // 未手动输入时不传 key，由后端回落到库里存的那个（避免用浏览器自动填充的旧值去请求）
        apiKey: llmApiKeyTouched.value ? (llmApiKey.value.trim() || undefined) : undefined,
        headers,
      })
      if (requestVersion !== llmModelsVersion) return
      llmModels.value = result.models || []
      llmModelCapabilities.value = result.capabilities || {}
      if (editVersion === llmTokenEditVersion) {
        fillLlmMaxTokens()
        markLlmDirty()
      }
      if (llmModels.value.length) llmModelSelect.value?.open()
    } catch (error) {
      if (requestVersion !== llmModelsVersion) return
      llmModelsError.value = error.message || '获取模型失败'
      toastFn?.(llmModelsError.value, 'error')
    } finally {
      if (requestVersion === llmModelsVersion) llmModelsLoading.value = false
    }
  }

  // ── LLM Profile 切换 ──
  const showLlmHelp = ref(false)

  // 设置页两种形态（上游 v3.10.0）：guided=DeepSeek 简易向导 / full=完整配置
  // loading / error 是首屏读配置的过渡态 —— 别把「还没读到」当成「没配置」
  const llmSetupMode = ref('loading')

  const llmCardFirst = ref(false)

  const canReturnToGuidedSetup = computed(() => !llmDirty.value && !freeEgg.value && canUseDeepseekSetup({
    llm: llmPreview.value, llmProfiles: llmProfiles.value, features,
  }))

  function openFullLlmSetup() {
    writeLlmSetupPreference(localStorage, 'full')
    llmSetupMode.value = 'full'
  }

  function returnToGuidedSetup() {
    // 只在「没改过 + 仍是官方预设」时允许回去，否则会把用户的自定义配置藏起来
    if (!canReturnToGuidedSetup.value) return
    writeLlmSetupPreference(localStorage, 'guided')
    llmSetupMode.value = 'guided'
  }

  function onGuidedLlmConnected(result) {
    settingsStore.setHasApiKey(result.hasApiKey)
    llmPreview.value = { ...result }
    llmBaseURL.value = result.baseURL
    llmModel.value = result.model
    llmThinkingMode.value = result.thinkingMode
    restoreLlmMaxTokens(result)
    llmApiKey.value = ''
    llmApiKeyTouched.value = false
    llmDirty.value = false
    llmSaved.value = true
    llmProfiles.value = llmProfiles.value.map(profile => profile.id === activeLlmProfileId.value
      ? { ...profile, hasApiKey: result.hasApiKey, preview: result.preview, model: result.model, baseURL: result.baseURL }
      : profile)
    writeLlmSetupPreference(localStorage, 'guided')
  }

  const profileManager = useLlmProfiles({
    api: { addLlmProfile, deleteLlmProfile, activateLlmProfile },
    notify: (message, type) => toastFn?.(message, type),
    confirm: options => confirmFn ? confirmFn(options) : window.confirm(options.title + '\n\n' + options.message),
    isDirty: () => llmDirty.value,
    isBlocked: () => llmSaving.value || freeEggBusy.value,
    applyConfig: applyLlmConfig,
    refreshFeatures: async () => {
      const cfg = await getConfig()
      // Profile changes own only these options. Unrelated settings may have local drafts.
      features.serializeBackgroundLLM = cfg.features.serializeBackgroundLLM ?? false
      features.mergeMessages = cfg.features.mergeMessages ?? false
      backgroundConcurrency.value = cfg.features.backgroundLLMMaxConcurrency ?? 3
      restoreLlmCustomMode()
    },
  })

  const { profiles: llmProfiles, activeId: activeLlmProfileId, busy: profileBusy,
    load: loadLlmProfiles, switchProfile, addProfile, removeProfile } = profileManager

  const llmBusy = computed(() => profileBusy.value || llmSaving.value || freeEggBusy.value)

  function restoreLlmCustomMode() {
    isCustomBaseURL.value = !presetURLs.includes(llmBaseURL.value) || llmHeadersEnabled.value || llmExtraBodyEnabled.value
      || Boolean(features.mergeMessages || features.serializeBackgroundLLM)
  }

  function applyLlmConfig(saved) {
    llmPreview.value = { ...saved }
    llmBaseURL.value = saved.baseURL || 'https://api.deepseek.com'
    llmModel.value = saved.model || 'deepseek-chat'
    llmThinkingMode.value = saved.thinkingMode || 'disabled'
    restoreLlmMaxTokens(saved)
    applyLlmContextWindow(saved.contextWindow)
    llmHeadersEnabled.value = Boolean(saved.headers && Object.keys(saved.headers).length)
    llmExtraBodyEnabled.value = Boolean(saved.extraBody && Object.keys(saved.extraBody).length)
    restoreLlmCustomMode()
    llmHeadersText.value = JSON.stringify(saved.headers || {}, null, 2)
    llmExtraBodyText.value = JSON.stringify(saved.extraBody || {}, null, 2)
    settingsStore.setHasApiKey(saved.hasApiKey)
    llmApiKey.value = ''
    llmApiKeyTouched.value = false
    llmDirty.value = false
    llmSaved.value = false
  }

  function buildLlmPayload() {
    if (!llmContextWindowValid.value) throw new Error('上下文窗口必须为正整数，或留空自动探测')
    if (!llmHeadersValid.value || !llmExtraBodyValid.value) throw new Error('自定义请求头与请求体必须为 JSON 对象')
    // 接入方式（上游 v3.10.0）：Vertex 走服务账号，不下发 apiKey
    const payload = { connectionType: llmConnectionType.value }
    if (llmConnectionType.value === 'vertexai') {
      payload.vertexRegion = vertexRegion.value.trim() || 'global'
      if (vertexServiceAccount.value.trim()) payload.vertexServiceAccount = vertexServiceAccount.value.trim()
    }
    // 只有用户手动输入过才提交 apiKey —— 否则浏览器自动填充的旧值会被当成"用户的输入"写回库
    if (llmConnectionType.value === 'openai' && llmApiKeyTouched.value && llmApiKey.value.trim()) {
      payload.apiKey = llmApiKey.value.trim()
    }
    if (llmBaseURL.value) payload.baseURL = llmBaseURL.value
    if (llmModel.value) payload.model = llmModel.value
    // 输出额度：非法值直接拦在这里，不要发一个半截配置给后端
    if (!llmMaxTokensValid.value) throw new Error('MAX_tokens 必须为正整数')
    payload.maxTokens = llmMaxTokens.value
    payload.thinkingMode = llmThinkingMode.value
    // 上下文窗口：留空传 null，让服务端从上游探测 / 用默认值
    payload.contextWindow = llmContextWindowValue.value
    payload.headers = isCustomBaseURL.value && llmHeadersEnabled.value
      ? JSON.parse(llmHeadersText.value)
      : {}
    payload.extraBody = isCustomBaseURL.value && llmExtraBodyEnabled.value
      ? JSON.parse(llmExtraBodyText.value)
      : {}
    return payload
  }

  async function runLlmConnectionTest() {
    if (llmTesting.value) return
    if (!llmHeadersValid.value || !llmExtraBodyValid.value) {
      toastFn?.('请先修正 LLM 自定义请求头或请求体 JSON', 'warning')
      return
    }
    if (!llmBaseURL.value.trim()) {
      toastFn?.('请先填写 API 地址', 'warning')
      return
    }

    llmTesting.value = true
    try {
      const result = await testLlmConnection(buildLlmPayload())
      const parts = ['LLM 连接成功']
      if (result.model) parts.push(result.model)
      if (result.latencyMs != null) parts.push(`${result.latencyMs}ms`)
      toastFn?.(parts.join(' · '), 'success')
    } catch (err) {
      toastFn?.('LLM 连接失败: ' + (err.message || '未知错误'), 'error')
    } finally {
      llmTesting.value = false
    }
  }

  async function saveLlmConfig() {
    if (llmBusy.value) return
    llmSaving.value = true
    const revision = llmDraftRevision
    try {
      const payload = buildLlmPayload()
      const custom = isCustomBaseURL.value
      const queue = custom && features.serializeBackgroundLLM
      const concurrency = custom ? backgroundConcurrency.value : 3
      const merge = custom && features.mergeMessages
      const requireSaved = result => {
        if (!result?.ok) throw new Error(result?.error || result?.message || '服务端未确认保存')
        return result
      }
      const result = requireSaved(await updateLlmConfig(payload))
      if (!result?.ok) throw new Error('服务端未确认保存')
      // Keep the draft until all steps finish, so a failed secondary setting can be retried.
      requireSaved(await updateFeatureFlag('serializeBackgroundLLM', queue))
      if (queue) requireSaved(await updateBackgroundConcurrency(concurrency))
      requireSaved(await updateFeatureFlag('mergeMessages', merge))
      requireSaved(await syncActiveLlmProfile())
      settingsStore.setHasApiKey(result.hasApiKey)
      if (revision === llmDraftRevision) {
        applyLlmConfig(result)
        isCustomBaseURL.value = custom
        features.serializeBackgroundLLM = queue
        features.mergeMessages = merge
        backgroundConcurrency.value = concurrency
        llmSaved.value = true
        setTimeout(() => { llmSaved.value = false }, 2000)
      } else {
        toastFn?.('提交的配置已保存，之后的修改仍待保存。', 'info')
      }
    } catch (err) {
      toastFn?.('模型配置未全部保存：' + (err?.message || '网络或服务异常') + '，草稿已保留，可重试。', 'error')
    } finally { llmSaving.value = false }
  }

  function applyLlmInitialConfig(data) {
    llmPreview.value = { ...data.llm }
    freeEgg.value = data.llm?.freeEgg === true
    llmBaseURL.value = data.llm.baseURL || 'https://api.deepseek.com'
    llmModel.value = data.llm.model || 'deepseek-chat'
    llmThinkingMode.value = data.llm.thinkingMode || 'disabled'
    // 输出额度 / 接入方式 / Vertex 公开字段（上游 v3.10.0）
    restoreLlmMaxTokens(data.llm)
    applyLlmContextWindow(data.llm.contextWindow)
    const hasCustom = (data.llm.headers && Object.keys(data.llm.headers).length > 0)
      || (data.llm.extraBody && Object.keys(data.llm.extraBody).length > 0)
      || data.features?.mergeMessages
    isCustomBaseURL.value = !presetURLs.includes(llmBaseURL.value) || hasCustom
    llmHeadersEnabled.value = Boolean(data.llm.headers && Object.keys(data.llm.headers).length)
    llmExtraBodyEnabled.value = Boolean(data.llm.extraBody && Object.keys(data.llm.extraBody).length)
    llmHeadersText.value = data.llm.headers && Object.keys(data.llm.headers).length
      ? JSON.stringify(data.llm.headers, null, 2) : '{}'
    llmExtraBodyText.value = data.llm.extraBody && Object.keys(data.llm.extraBody).length
      ? JSON.stringify(data.llm.extraBody, null, 2) : '{}'
    loadLlmProfiles(data)
    llmSetupMode.value = initialLlmSetupMode(data, readLlmSetupPreference(localStorage))
    llmCardFirst.value = llmSetupMode.value === 'guided' || !data.llm.hasApiKey
  }

  return { llmPreview, freeEgg, llmBaseURL, llmModel, loadModelRoutes, restoreLlmMaxTokens, llmThinkingMode, applyLlmContextWindow, isCustomBaseURL, presetURLs, llmHeadersEnabled, llmHeadersText, llmExtraBodyEnabled, llmExtraBodyText, llmSetupMode, llmCardFirst, loadLlmProfiles, llmBusy, onFreeEggClick, eggSplash, onGuidedLlmConnected, openFullLlmSetup, showLlmHelp, canReturnToGuidedSetup, returnToGuidedSetup, llmConnectionType, onLlmConnectionChange, llmConnectionOptions, vertexServiceAccount, onVertexAccountInput, vertexValidating, hasVertexServiceAccount, validateVertexAccount, vertexValidation, vertexRegion, onLlmEndpointInput, vertexRegionOptions, llmProfiles, activeLlmProfileId, switchProfile, removeProfile, addProfile, llmApiKey, showApiKey, onLlmKeyInput, copyLlmApiKey, llmBaseURLSelectVal, llmBaseURLOptions, llmModelSelectVal, llmModelOptions, llmModelsLoading, loadAvailableModels, llmModelsError, llmMaxTokens, llmMaxTokensValid, onLlmMaxTokensInput, llmMaxTokensOversized, llmMaxTokensHint, modelRoutesSaved, modelRoutesFreeEgg, modelRoutes, markModelRoutesDirty, modelRoutesDefault, modelRoutesError, modelRoutesSaving, modelRoutesDirty, saveModelRouteChanges, thinkingModeOptions, onThinkingModePick, llmAdvancedOpen, toggleLlmAdvanced, markLlmDirty, llmHeadersValid, llmExtraBodyValid, llmDirty, llmContextWindowValid, llmSaving, saveLlmConfig, llmSaved, llmTesting, runLlmConnectionTest, showRelayModal, relayStations, relayConfigBusy, applyRelayConfig, freeEggBtn, llmModelSelect, applyLlmInitialConfig }
}
