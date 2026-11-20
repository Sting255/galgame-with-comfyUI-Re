import { ref, reactive, computed, watch } from 'vue'
import { getConfig, updateFeatureFlag, updateAntiRepetitionPenalty, updateProactiveFreq, updateEventFreq, updateMomentFreq, updateDisturbMode, updateDisturbSettings, listCharacters, updateGroupSummaryInterval } from '../../api/index.js'
import { TOUCH_IMAGE_MODE_KEY, normalizeTouchImageMode, touchImageModeLabel, TOUCH_REACTION_MODE_KEY, normalizeTouchReactionMode, touchReactionModeLabel } from '../../components/touchActionLogic.js'
import { getIntimateInjectAll, setIntimateInjectAll } from '../../api/intimate.js'
import { getDefaultAssistantSetting, setDefaultAssistantSetting } from '../../api/index.js'
import { useChatStore } from '../../stores/chat.js'

// 每个设置页实例独享草稿；只通过 shared 共享跨域的功能开关与全局设置。
export function useFeatureSettings(shared) {
  const { settingsStore, toastFn, features, backgroundConcurrency } = shared

  // 默认助手（生图助手）开关：关掉后它不进角色列表、不被「对所有人」的批量指令带上（2026-11-08）
  const chat = useChatStore()

  const defaultAssistantEnabled = ref(true)

  async function loadDefaultAssistant() {
    try {
      const res = await getDefaultAssistantSetting()
      if (res && typeof res.enabled === 'boolean') defaultAssistantEnabled.value = res.enabled
    } catch { /* 读失败就按启用显示，不弹错 */ }
  }

  async function saveDefaultAssistant(val) {
    const next = val === undefined ? defaultAssistantEnabled.value : val
    try {
      await setDefaultAssistantSetting(next)
      toastFn?.(next ? '已启用默认助手' : '已停用默认助手：它不再出现在角色列表，也不会被批量指令带上', 'success')
      // 列表变化要重新拉一次，否则侧栏还挂着已停用的那个
      try { await chat.loadCharacters() } catch { /* 忽略 */ }
    } catch (err) {
      defaultAssistantEnabled.value = !next
      toastFn?.(err?.message || '保存失败', 'error')
    }
  }

  const featureSaving = reactive(new Set())

  /**
   * 亲密度看板两个总开关的读取口径：**fail-closed**。
   * 它们是"会写档案 / 写流水"的功能，只有后端明确给出布尔 `true` 才算开启：
   *   · 键缺失（旧后端没有这两个键）→ 关闭。不能沿用 reactive 的初始默认值，否则界面显示"已开启"、
   *     而后端根本没有这个概念（静默不一致）。
   *   · 脏值（字符串 `"false"` 之类）→ 关闭，且不把非布尔塞进 LinsheSwitch（否则 Vue prop 类型告警，
   *     且非空字符串为真会渲染成"开"）。
   * 依据：task-22 浏览器实机核对的反例 F1（缺键）/ F2（脏值），两条原本都渲染成了"开"。
   */
  function normalizeIntimateFlags(source) {
    if (!source || typeof source !== 'object') return
    features.intimate = source.intimate === true
    features.intimateBackfill = source.intimateBackfill === true
  }

  /**
   * 「全部角色知晓身体档案」总开关（2026-11-06）：状态口径来自后端统计，不用本地记忆。
   * 开关打开 = 所有角色都已开启；部分开启时显示为关，副标题写明已开启数量，
   * 因为开关本身表达不了"3/12"这种中间态。
   */
  const injectAll = reactive({ total: 0, enabled: 0, saving: false })

  const injectAllOn = ref(false)

  const injectAllHint = computed(() => {
    if (injectAll.total === 0) return '还没有角色'
    if (injectAll.enabled >= injectAll.total) return `全部 ${injectAll.total} 个角色已开启`
    return `${injectAll.enabled} / ${injectAll.total} 个角色已开启`
  })

  async function loadInjectAllStatus() {
    try {
      const d = await getIntimateInjectAll()
      injectAll.total = Number(d?.total) || 0
      injectAll.enabled = Number(d?.enabled) || 0
      injectAllOn.value = injectAll.total > 0 && injectAll.enabled >= injectAll.total
    } catch {
      // 读失败保持"关"，不阻塞设置页其它配置
    }
  }

  async function saveInjectAll(val) {
    injectAll.saving = true
    try {
      const d = await setIntimateInjectAll(val === true)
      injectAll.total = Number(d?.total) || 0
      injectAll.enabled = Number(d?.enabled) || 0
      injectAllOn.value = injectAll.total > 0 && injectAll.enabled >= injectAll.total
      toastFn?.(val ? `已为 ${injectAll.enabled} 个角色开启「知晓身体档案」` : '已关闭所有角色的「知晓身体档案」', 'success')
    } catch (err) {
      injectAllOn.value = !val
      toastFn?.(`全部角色知晓保存失败：${err.message || '未知错误'}`, 'error')
    } finally {
      injectAll.saving = false
    }
  }

  const freqSlider = ref(0.5)

  const eventFreqSlider = ref(1)

  // 仅换算显示，保留原有 0~1 参数；公式对应两个 scheduler 的现有间隔。
  function frequencyTimeLabel(minutes) {
    return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`
  }

  const chatFreqLabel = computed(() => freqSlider.value <= 0
    ? '关闭' : frequencyTimeLabel(Math.round(8 + (1 - freqSlider.value) / 0.9 * 112)))

  const eventFreqLabel = computed(() => eventFreqSlider.value <= 0
    ? '关闭' : frequencyTimeLabel(Math.round(30 / eventFreqSlider.value)))

  // 具体时间档控制角色的统一间隔；镇民保留默认排期，关闭档同时关闭两者。
  // 时间档从慢到快排列，最右侧额外提供沿用原有频率的「默认」档。
  const MOMENT_FREQ_STEPS = [
    { value: 0,    label: '关闭',    hint: '关闭自动发帖（仍可手动发）。' },
    // 上游 v3.10.0 新增的「36 小时」档（2026-10-19 合并）：比 24 小时更慢，给低活跃角色留白
    { value: 1 / 18, label: '36 小时', hint: '每个角色以 36 小时为中心，随机间隔 28.8~43.2 小时。' },
    { value: 1 / 12, label: '24 小时', hint: '每个角色以 24 小时为中心，随机间隔 19.2~28.8 小时。' },
    { value: 1 / 8, label: '16 小时', hint: '每个角色以 16 小时为中心，随机间隔 12.8~19.2 小时。' },
    { value: 1 / 6, label: '12 小时', hint: '每个角色以 12 小时为中心，随机间隔 9.6~14.4 小时。' },
    { value: 0.25, label: '8 小时',  hint: '每个角色以 8 小时为中心，随机间隔 6.4~9.6 小时。' },
    { value: 0.5,  label: '4 小时',  hint: '每个角色以 4 小时为中心，随机间隔 3.2~4.8 小时。' },
    { value: 1,    label: '2 小时',  hint: '每个角色以 2 小时为中心，随机间隔 1.6~2.4 小时。' },
    { value: 2,    label: '1 小时',  hint: '每个角色以 1 小时为中心，随机间隔 48~72 分钟。' },
    { value: 4,    label: '30 分钟', hint: '每个角色以 30 分钟为中心，随机间隔 24~36 分钟。' },
    { value: 8,    label: '15 分钟', hint: '每个角色以 15 分钟为中心，随机间隔 12~18 分钟。' },
    { value: 24,   label: '5 分钟',  hint: '每个角色以 5 分钟为中心，随机间隔 4~6 分钟，LLM 与生图消耗很高。' },
    { value: 1, mode: 'default', label: '默认', hint: '沿用原有频率：每个角色约 2~8 小时一条，首次等待 1~4 小时。' },
  ]

  const DEFAULT_MOMENT_STEP = MOMENT_FREQ_STEPS.length - 1

  const momentFreqStepIdx = ref(DEFAULT_MOMENT_STEP)

  const momentFreqHint = computed(() => {
    const step = MOMENT_FREQ_STEPS[momentFreqStepIdx.value]
    if (!step) return ''
    return step.hint
  })

  const momentFreqLabel = computed(() => MOMENT_FREQ_STEPS[momentFreqStepIdx.value]?.label || '')

  /** 库里存的 momentFreq → 最接近的档位下标（老值可能是任意数） */
  function momentStepFromValue(v, mode) {
    if (v == null) return DEFAULT_MOMENT_STEP
    if (Number(v) === 1 && mode !== 'interval') return DEFAULT_MOMENT_STEP
    let best = 0
    let bestDiff = Infinity
    MOMENT_FREQ_STEPS.forEach((s, i) => {
      const d = Math.abs(s.value - v)
      if (d < bestDiff) { bestDiff = d; best = i }
    })
    return best
  }

  // ── 防打扰模式 ──
  const disturbMode = ref(false)

  const disturbStartTime = ref('22:00')

  const disturbEndTime = ref('08:00')

  const disturbCharacterIds = ref([])

  const disturbHideWorld = ref(false)

  const disturbSkipWeekends = ref(false)

  const allCharacters = ref([])

  // 全部角色列表（含头像）

  // ── 天气 ──
  const weatherCity = ref('')

  const weatherCityDialog = reactive({ show: false, city: '' })

  // 弹窗状态（编辑期间使用独立副本，确认后才同步）
  const disturbDialog = reactive({
    show: false,
    startTime: '22:00',
    endTime: '08:00',
    characterIds: [],
    hideWorld: false,
    skipWeekends: false,
  })

  const featureLabels = {
    emotion: '好感度系统',
    replyGuesses: '聊天候选词',
    realtimeAffinityDisplay: '实时好感度',
    weather: '实时天气',
    memory: '聊天记忆',
  }

  async function saveFeature(key, val) {
    if (featureSaving.has(key)) return
    featureSaving.add(key)
    try {
      if (key === 'realtimeAffinityDisplay') {
        await settingsStore.setRealtimeAffinityDisplay(val)
      } else {
        await updateFeatureFlag(key, val)
      }
      const label = featureLabels[key] || '设置'
      toastFn?.(val ? `已开启${label}` : `已关闭${label}`, 'success')
    } catch (err) {
      features[key] = !val
      toastFn?.(`${featureLabels[key] || '设置'}保存失败：${err?.message || '未知错误'}`, 'error')
    } finally {
      featureSaving.delete(key)
    }
  }

  // ── 反重复 / 反钻牛角尖（专题·车轱辘话与钻牛角尖 · 阶段一）──
  // 两个开关都是纯 prompt 增强，保存失败时回滚本地开关（沿用页面既有 toastFn 口径）
  const antiRepFeatureLabels = { antiRepetition: '反车轱辘话', antiRepetitionLock: '反钻牛角尖', antiRepetitionEscalation: '重复时自动加强约束', antiRepetitionReroll: '重写这一轮' }

  /**
   * 功能开关的保存闭环（失败回滚本地开关 + toast）——反重复卡片与动作卡片共用一份，
   * 免得两处各写一套回滚逻辑。保存失败时把开关拨回去，避免"界面显示开了、后端没存上"的静默不一致。
   */
  async function saveFeatureWithToast(key, val, label) {
    try {
      await updateFeatureFlag(key, val)
      toastFn?.(val ? `已开启${label}` : `已关闭${label}`, 'success')
    } catch (err) {
      features[key] = !val
      toastFn?.(`${label}保存失败：${err.message || '未知错误'}`, 'error')
    }
  }

  async function saveAntiRepFeature(key, val) {
    return saveFeatureWithToast(key, val, antiRepFeatureLabels[key] || '设置')
  }

  // ── SLG 动作系统（触摸互动 · 专题-SLG动作系统 · 阶段一）──
  const touchFeatureLabels = { touch: '动作系统', touchInstant: '即时反应', touchGroupAdult: '群聊里的敏感动作' }

  async function saveTouchFeature(key, val) {
    return saveFeatureWithToast(key, val, touchFeatureLabels[key] || '设置')
  }

  // 动作出图档位（阶段三）：三档选择，键与后端 features.touchImageMode 同口径
  // （always | smart | never，默认 smart）。失败回滚到上一档，避免"界面显示改了、后端没存上"。
  async function saveTouchImageMode(value) {
    const next = normalizeTouchImageMode(value)
    const previous = normalizeTouchImageMode(features.touchImageMode)
    if (next === previous) return
    features.touchImageMode = next
    try {
      await updateFeatureFlag(TOUCH_IMAGE_MODE_KEY, next)
      toastFn?.('动作出图已改为「' + touchImageModeLabel(next) + '」', 'success')
    } catch (err) {
      features.touchImageMode = previous
      toastFn?.('动作出图保存失败：' + (err.message || '未知错误'), 'error')
    }
  }

  // 动作反应风格（task-30）：键 features.touchReactionMode，取值 conversation | quick，默认 conversation。
  // 与出图档位同口径：失败回滚到上一档，避免"界面显示改了、后端没存上"。
  async function saveTouchReactionMode(value) {
    const next = normalizeTouchReactionMode(value)
    const previous = normalizeTouchReactionMode(features.touchReactionMode)
    if (next === previous) return
    features.touchReactionMode = next
    try {
      await updateFeatureFlag(TOUCH_REACTION_MODE_KEY, next)
      toastFn?.('动作反应已改为「' + touchReactionModeLabel(next) + '」', 'success')
    } catch (err) {
      features.touchReactionMode = previous
      toastFn?.('动作反应保存失败：' + (err.message || '未知错误'), 'error')
    }
  }

  // ── 群聊围观插话概率（task-22）──
  // 契约：features.touchBystanderChance 是 **数字 0~1 = 开启**，'' / null / false = 关闭（退回 task-17 口径）。
  // 写：通用 PUT /api/config/features { key:'touchBystanderChance', value } —— 数字由后端 0~1 夹取，
  //     'off' / null = 关闭，非数字回落 0.3（见 agent-core/src/config.js:549-556）。
  // 失败一律回滚本地值；features 变了会带动下面的 watch 把开关与滑块一起同步回去。
  const BYSTANDER_DEFAULT_PERCENT = 30

  /** 0~1（或 '' / null / false）→ 整数百分比；非法 / 关闭都给默认 30 */
  function chanceToPercent(value) {
    if (value === '' || value === null || value === undefined || value === false) return BYSTANDER_DEFAULT_PERCENT
    const n = Number(value)
    if (!Number.isFinite(n)) return BYSTANDER_DEFAULT_PERCENT
    return Math.round(Math.min(1, Math.max(0, n)) * 100)
  }

  /** 任意输入 → 0~100 整数百分比（滑块的值已经是百分比，别拿 chanceToPercent 再乘一遍）；非数字回落默认 30 */
  function clampPercent(value) {
    if (value === '' || value === null || value === undefined || value === false) return BYSTANDER_DEFAULT_PERCENT
    const n = Number(value)
    if (!Number.isFinite(n)) return BYSTANDER_DEFAULT_PERCENT
    return Math.round(Math.min(100, Math.max(0, n)))
  }

  const bystanderEnabled = ref(true)

  const bystanderPercent = ref(BYSTANDER_DEFAULT_PERCENT)

  // ── 群聊记忆轮次（2026-10-31 用户要求可开到 30 轮）──
  // 后端 PUT /api/config/group-summary-interval 接受 2~30；值落在 system_settings 里，所有群共享。
  const groupMemRounds = ref(4)

  getConfig()
    .then(c => {
      const n = Number(c?.groupChat?.summaryInterval ?? c?.values?.['groupChat.summaryInterval'])
      if (Number.isFinite(n) && n >= 2) groupMemRounds.value = Math.min(30, Math.round(n))
    })
    .catch(() => {})

  async function saveGroupMemRounds(value) {
    const n = Math.min(30, Math.max(2, Math.round(Number(value) || 4)))
    groupMemRounds.value = n
    try {
      await updateGroupSummaryInterval(n)
      toastFn?.(`群聊记忆已设为 ${n} 轮`, 'success')
    } catch (err) {
      toastFn?.('群聊记忆轮次保存失败：' + (err.message || '未知错误'), 'error')
    }
  }

  // 载入 / 回滚后同步本地开关与滑块；**关闭时保留上次的百分比**，方便再打开
  watch(() => features.touchBystanderChance, (value) => {
    const closed = value === '' || value === null || value === undefined || value === false
    bystanderEnabled.value = !closed
    if (!closed) bystanderPercent.value = chanceToPercent(value)
  }, { immediate: true })

  async function saveBystanderEnabled(enabled) {
    const previous = features.touchBystanderChance
    const pct = clampPercent(bystanderPercent.value)
    const next = enabled ? (pct / 100) : 'off'
    features.touchBystanderChance = next
    try {
      await updateFeatureFlag('touchBystanderChance', next)
      toastFn?.(enabled
        ? '已开启群聊围观插话（' + pct + '%）'
        : '已关闭群聊围观插话：这轮其他成员都不发言', 'success')
    } catch (err) {
      features.touchBystanderChance = previous
      toastFn?.('围观插话保存失败：' + (err.message || '未知错误'), 'error')
    }
  }

  async function saveBystanderChance(percent) {
    // 关闭状态下不发送概率（关闭语义由 'off' 表达）
    if (!bystanderEnabled.value) return
    const pct = clampPercent(percent)
    const previous = features.touchBystanderChance
    if (chanceToPercent(previous) === pct) return
    features.touchBystanderChance = pct / 100
    try {
      await updateFeatureFlag('touchBystanderChance', pct / 100)
      toastFn?.('围观插话概率已改为 ' + pct + '%', 'success')
    } catch (err) {
      features.touchBystanderChance = previous
      toastFn?.('围观插话保存失败：' + (err.message || '未知错误'), 'error')
    }
  }

  // 重复惩罚参数（L3）：留空 = 不发送该字段。字符串与 number 都接受，范围 -2 ~ 2。
  const antiRepPenaltyPresence = ref('')

  const antiRepPenaltyFrequency = ref('')

  const antiRepPenaltySaving = ref(false)

  const antiRepPenaltySaved = ref(false)

  const antiRepPenaltyError = ref('')

  function parsePenaltyInput(raw) {
    const text = String(raw ?? '').trim()
    if (!text) return { valid: true, value: null }
    const n = Number(text)
    if (!Number.isFinite(n) || n < -2 || n > 2) return { valid: false, value: null }
    return { valid: true, value: n }
  }

  const antiRepPenaltyPresenceValid = computed(() => parsePenaltyInput(antiRepPenaltyPresence.value).valid)

  const antiRepPenaltyFrequencyValid = computed(() => parsePenaltyInput(antiRepPenaltyFrequency.value).valid)

  const antiRepPenaltyValid = computed(() => antiRepPenaltyPresenceValid.value && antiRepPenaltyFrequencyValid.value)

  async function onAntiRepPenaltySave() {
    antiRepPenaltyError.value = ''
    const presence = parsePenaltyInput(antiRepPenaltyPresence.value)
    const frequency = parsePenaltyInput(antiRepPenaltyFrequency.value)
    if (!presence.valid || !frequency.valid) {
      antiRepPenaltyError.value = '两个参数都必须是 -2 ~ 2 之间的数字，留空表示不发送'
      return
    }
    antiRepPenaltySaving.value = true
    try {
      const result = await updateAntiRepetitionPenalty({ presence: presence.value, frequency: frequency.value })
      const savedPresence = result?.antiRepetitionPenalty
      const savedFrequency = result?.antiRepetitionFrequency
      antiRepPenaltyPresence.value = savedPresence === null || savedPresence === undefined ? '' : String(savedPresence)
      antiRepPenaltyFrequency.value = savedFrequency === null || savedFrequency === undefined ? '' : String(savedFrequency)
      antiRepPenaltySaved.value = true
      setTimeout(() => { antiRepPenaltySaved.value = false }, 2000)
    } catch (err) {
      antiRepPenaltyError.value = `保存失败：${err.message || '未知错误'}`
    } finally {
      antiRepPenaltySaving.value = false
    }
  }

  // 亲密度看板 / 历史对话回填两个开关的中文名（保存结果提示复用）
  const intimateFeatureLabels = { intimate: '亲密度看板', intimateBackfill: '历史对话回填' }

  // 看板开关关闭是有实际副作用的操作（停止自动记账），所以单独处理：
  // 保存失败时回滚本地开关，避免界面显示与后端实际状态不一致（沿用页面既有 toastFn）
  async function saveIntimateFeature(key, val) {
    const label = intimateFeatureLabels[key] || '设置'
    try {
      await updateFeatureFlag(key, val)
      toastFn?.(val ? `已开启${label}` : `已关闭${label}`, 'success')
    } catch (err) {
      features[key] = !val
      toastFn?.(`${label}保存失败：${err.message || '未知错误'}`, 'error')
    }
  }

  // ── 深度思考（测试版）：开关在 settings store 持久化，聊天页实时读取 ──
  const deepThinkMode = computed(() => settingsStore.deepThinkMode)

  function onDeepThinkChange(v) {
    settingsStore.setDeepThinkMode(v)
  }

  // 滑块松手时触发，持久化到后端并更新 features
  async function onFreqChange() {
    const v = freqSlider.value
    features.proactiveChatFreq = v
    try { await updateProactiveFreq(v) } catch { /* 非关键 */ }
  }

  async function onEventFreqChange() {
    const v = eventFreqSlider.value
    features.eventFreq = v
    try { await updateEventFreq(v) } catch { /* 非关键 */ }
  }

  async function onMomentFreqChange() {
    const step = MOMENT_FREQ_STEPS[momentFreqStepIdx.value]
    if (!step) return
    const v = step.value
    features.momentFreq = v
    features.momentFreqMode = step.mode || 'interval'
    try {
      await updateMomentFreq(v, features.momentFreqMode)
      toastFn?.(v <= 0 ? '已关闭自动发帖' : `朋友圈频率已设为「${step.label}」`, 'success')
    } catch (err) {
      toastFn?.('保存失败: ' + (err?.message || '未知错误'), 'error')
    }
  }

  // ── 防打扰模式 ──

  async function onDisturbModeToggle() {
    try {
      await updateDisturbMode(disturbMode.value)
      features.disturbMode = disturbMode.value
    } catch { /* 非关键 */ }
  }

  function openDisturbDialog() {
    // 复制当前已保存的设置到弹窗副本
    disturbDialog.startTime = disturbStartTime.value
    disturbDialog.endTime = disturbEndTime.value
    disturbDialog.characterIds = [...disturbCharacterIds.value]
    disturbDialog.hideWorld = disturbHideWorld.value
    disturbDialog.skipWeekends = disturbSkipWeekends.value
    disturbDialog.show = true
    // 按需加载角色列表
    if (allCharacters.value.length === 0) {
      loadAllCharacters()
    }
  }

  function cancelDisturbDialog() {
    disturbDialog.show = false
  }

  async function confirmDisturbDialog() {
    try {
      await updateDisturbSettings({
        startTime: disturbDialog.startTime,
        endTime: disturbDialog.endTime,
        characterIds: [...disturbDialog.characterIds],
        hideWorld: disturbDialog.hideWorld,
        skipWeekends: disturbDialog.skipWeekends,
      })
      // 同步到外层状态
      disturbStartTime.value = disturbDialog.startTime
      disturbEndTime.value = disturbDialog.endTime
      disturbCharacterIds.value = [...disturbDialog.characterIds]
      disturbHideWorld.value = disturbDialog.hideWorld
      disturbSkipWeekends.value = disturbDialog.skipWeekends
      disturbDialog.show = false
    } catch (err) {
      console.error('[disturb] save failed:', err)
    }
  }

  function toggleDisturbDialogChar(id) {
    const idx = disturbDialog.characterIds.indexOf(id)
    if (idx >= 0) {
      disturbDialog.characterIds.splice(idx, 1)
    } else {
      disturbDialog.characterIds.push(id)
    }
  }

  // ── 天气城市设置 ──

  function openWeatherCityDialog() {
    weatherCityDialog.city = weatherCity.value
    weatherCityDialog.show = true
  }

  async function confirmWeatherCity() {
    if (settingsStore.isSaving('weatherCity')) return
    const city = String(weatherCityDialog.city || '').trim()
    try {
      await settingsStore.setWeatherCity(city)
      weatherCity.value = settingsStore.weatherCity
      weatherCityDialog.show = false
      toastFn?.('天气城市已保存', 'success')
    } catch (err) {
      console.error('[weather] save city failed:', err)
      toastFn?.(`天气城市保存失败：${err?.message || '未知错误'}`, 'error')
    }
  }

  async function loadAllCharacters() {
    try {
      const data = await listCharacters({ scope: 'user' })
      allCharacters.value = data.characters || []
    } catch { /* 非关键 */ }
  }

  function applyFeatureConfig(data) {
    Object.assign(features, data.features)
    normalizeIntimateFlags(data.features)
    loadInjectAllStatus()
    freqSlider.value = features.proactiveChatFreq ?? 0.5
    eventFreqSlider.value = features.eventFreq ?? 1
    momentFreqStepIdx.value = momentStepFromValue(features.momentFreq, features.momentFreqMode)
    backgroundConcurrency.value = features.backgroundLLMMaxConcurrency ?? 3
    // 防打扰模式
    if (data.disturb) {
      disturbMode.value = features.disturbMode ?? false
      disturbStartTime.value = data.disturb.startTime || '22:00'
      disturbEndTime.value = data.disturb.endTime || '08:00'
      disturbCharacterIds.value = data.disturb.characterIds || []
      disturbHideWorld.value = data.disturb.hideWorld ?? false
      disturbSkipWeekends.value = data.disturb.skipWeekends ?? false
    }
    weatherCity.value = data.weather?.city || ''
    // 反重复采样参数：null = 不发送该字段（默认）→ 输入框留空
    antiRepPenaltyPresence.value = data.llm.antiRepetitionPenalty === null || data.llm.antiRepetitionPenalty === undefined
      ? '' : String(data.llm.antiRepetitionPenalty)
    antiRepPenaltyFrequency.value = data.llm.antiRepetitionFrequency === null || data.llm.antiRepetitionFrequency === undefined
      ? '' : String(data.llm.antiRepetitionFrequency)
  }

  return { loadDefaultAssistant, normalizeIntimateFlags, loadInjectAllStatus, freqSlider, eventFreqSlider, momentFreqStepIdx, momentStepFromValue, disturbMode, disturbStartTime, disturbEndTime, disturbCharacterIds, disturbHideWorld, disturbSkipWeekends, weatherCity, antiRepPenaltyPresence, antiRepPenaltyFrequency, featureSaving, saveFeature, saveFeatureWithToast, defaultAssistantEnabled, saveDefaultAssistant, onFreqChange, onEventFreqChange, openDisturbDialog, onDisturbModeToggle, openWeatherCityDialog, saveIntimateFeature, injectAllHint, injectAllOn, injectAll, saveInjectAll, disturbDialog, cancelDisturbDialog, confirmDisturbDialog, allCharacters, toggleDisturbDialogChar, weatherCityDialog, confirmWeatherCity, saveAntiRepFeature, antiRepPenaltyPresenceValid, onAntiRepPenaltySave, antiRepPenaltyFrequencyValid, antiRepPenaltySaving, antiRepPenaltyValid, antiRepPenaltySaved, antiRepPenaltyError, saveTouchFeature, saveTouchImageMode, saveTouchReactionMode, bystanderEnabled, saveBystanderEnabled, bystanderPercent, saveBystanderChance, groupMemRounds, saveGroupMemRounds, applyFeatureConfig }
}
