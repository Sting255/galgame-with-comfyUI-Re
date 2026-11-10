import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/index.js'
import { getSavedTheme, getSavedThemeMode, applyTheme, applyThemeMode, resolveThemeByTime } from '../theme.js'

export const useSettingsStore = defineStore('settings', () => {
  const comfyWidth = ref(1600)
  const comfyHeight = ref(1200)
  const eventWidth = ref(1600)
  const eventHeight = ref(1200)
  const imageProvider = ref('comfyui')
  const imageGenMode = ref('smart') // 'off' | 'smart' | 'force'
  const realtimeAffinityDisplay = ref(false)
  const bgmMuted = ref(false) // 小镇 BGM 静音（system_settings 持久化，loadComfyConfig 后修正）
  const hasApiKey = ref(true) // 默认 true，避免闪红；onMounted 后修正
  const weatherCity = ref('')
  const theme = ref(getSavedTheme()) // main.js 已在挂载前应用过，这里只是同步状态
  const themeMode = ref(getSavedThemeMode()) // 'warm' | 'dark' | 'auto'
  const savingKeys = ref(new Set())
  const loadError = ref('')
  let loaded = false
  let loadPromise = null
  let stateRevision = 0

  // ── localStorage 迁移：旧版存在 localStorage，新版存 DB ──
  const legacyForceImageGen = localStorage.getItem('forceImageGen')
  if (legacyForceImageGen !== null) {
    imageGenMode.value = legacyForceImageGen === 'true' ? 'force' : 'smart'
    localStorage.removeItem('forceImageGen')
    // 异步持久化到后端（fire-and-forget）
    api.updateFeatureFlag('imageGenMode', imageGenMode.value).catch(() => {})
  }

  const confirmed = new Map([
    ['imageGenMode', imageGenMode.value],
    ['realtimeAffinityDisplay', realtimeAffinityDisplay.value],
    ['bgmMuted', bgmMuted.value],
    ['weatherCity', weatherCity.value],
  ])

  function isSaving(key) {
    return savingKeys.value.has(key)
  }

  function _setSaving(key, on) {
    const next = new Set(savingKeys.value)
    if (on) next.add(key)
    else next.delete(key)
    savingKeys.value = next
  }

  function _setConfirmed(key, value) {
    confirmed.set(key, value)
  }

  function _commitLoaded(data) {
    comfyWidth.value = data.comfy?.width || 1600
    comfyHeight.value = data.comfy?.height || 1200
    eventWidth.value = data.comfy?.eventWidth || 1600
    eventHeight.value = data.comfy?.eventHeight || 1200
    imageProvider.value = data.comfy?.imageProvider === 'novelai' ? 'novelai' : 'comfyui'
    if (data.features?.imageGenMode !== undefined) {
      imageGenMode.value = data.features.imageGenMode
    } else if (data.features?.forceImageGen !== undefined) {
      imageGenMode.value = data.features.forceImageGen ? 'force' : 'smart'
    }
    if (data.features?.realtimeAffinityDisplay !== undefined) {
      realtimeAffinityDisplay.value = data.features.realtimeAffinityDisplay
    }
    if (data.features?.bgmMuted !== undefined) {
      bgmMuted.value = !!data.features.bgmMuted
    }
    hasApiKey.value = data.llm?.hasApiKey ?? false
    weatherCity.value = data.weather?.city || ''
    _setConfirmed('imageGenMode', imageGenMode.value)
    _setConfirmed('realtimeAffinityDisplay', realtimeAffinityDisplay.value)
    _setConfirmed('bgmMuted', bgmMuted.value)
    _setConfirmed('weatherCity', weatherCity.value)
    loadError.value = ''
    loaded = true
  }

  function loadComfyConfig({ force = false } = {}) {
    if (force) loaded = false
    if (loaded && !force) return Promise.resolve(true)
    // 首屏 App / Chat / 设置页会并发调用；共享同一个在途 Promise，
    // 失败后清空，允许下一次显式重拉。
    if (loadPromise) return loadPromise
    const revision = stateRevision
    loadPromise = (async () => {
      try {
        const data = await api.getConfig()
        if (revision !== stateRevision) return false
        // 保存或保存失败回滚期间不提交读快照；读到的可能是乐观值之前 / 之后但未确认的混合状态。
        // savingKeys 清空后仍由 stateRevision 在 finally 中拒绝这份旧快照，下一次显式拉取再对齐。
        if (savingKeys.value.size > 0) return false
        _commitLoaded(data)
        return true
      } catch (err) {
        loadError.value = err?.message || '配置加载失败'
        return false
      } finally {
        loadPromise = null
      }
    })()
    return loadPromise
  }

  async function _persist(key, stateRef, value, write) {
    if (isSaving(key)) throw new Error('保存中，请稍候')
    const previous = confirmed.has(key) ? confirmed.get(key) : stateRef.value
    if (stateRef.value === value) return true
    stateRevision++
    _setSaving(key, true)
    stateRef.value = value
    try {
      await write(value)
      _setConfirmed(key, value)
      stateRevision++
      return true
    } catch (err) {
      // 只回滚本次乐观写入；若外部已把字段改成其它值，不覆盖那个更新的草稿。
      if (stateRef.value === value) stateRef.value = previous
      throw err
    } finally {
      _setSaving(key, false)
      // 失败回滚、成功确认与“保存中解除”都必须形成新的状态代际。
      // 否则保存期间启动的 load 可能在失败回滚后把旧服务器值重新盖回来。
      stateRevision++
    }
  }

  /**
   * 由外部调用更新（SettingsView 保存后同步）
   */
  function setComfySize(width, height) {
    comfyWidth.value = width
    comfyHeight.value = height
  }

  function setEventSize(width, height) {
    eventWidth.value = width
    eventHeight.value = height
  }

  function setImageProvider(provider) {
    imageProvider.value = provider === 'novelai' ? 'novelai' : 'comfyui'
  }

  /**
   * 切换配图模式：'off'（关闭）/ 'smart'（灵性判断）/ 'force'（强制生图）
   */
  async function setImageGenMode(mode) {
    if (!['off', 'smart', 'force'].includes(mode)) return false
    return _persist('imageGenMode', imageGenMode, mode,
      value => api.updateFeatureFlag('imageGenMode', value))
  }


  async function setRealtimeAffinityDisplay(v) {
    const value = !!v
    return _persist('realtimeAffinityDisplay', realtimeAffinityDisplay, value,
      next => api.updateFeatureFlag('realtimeAffinityDisplay', next))
  }

  /** 切换小镇 BGM 静音（只负责状态与持久化，播放/暂停由 TownView 侧响应） */
  async function setBgmMuted(v) {
    const value = !!v
    return _persist('bgmMuted', bgmMuted, value,
      next => api.updateFeatureFlag('bgmMuted', next))
  }

  function setHasApiKey(v) { hasApiKey.value = v }

  async function setWeatherCity(city) {
    const value = String(city || '').trim()
    return _persist('weatherCity', weatherCity, value,
      next => api.updateWeatherCity(next))
  }

  // 切换主题模式：暖色 / 暗夜 / 按时间，立即应用到 <html data-theme>，持久化在 localStorage
  function setThemeMode(mode) {
    if (!['warm', 'dark', 'auto'].includes(mode)) return
    themeMode.value = mode
    theme.value = mode === 'auto' ? resolveThemeByTime() : mode
    applyThemeMode(mode)
  }

  // 按时间模式下的定时/聚焦刷新
  function refreshTheme() {
    if (themeMode.value !== 'auto') return
    theme.value = resolveThemeByTime()
    applyTheme(theme.value)
  }

  return { comfyWidth, comfyHeight, eventWidth, eventHeight, imageProvider, imageGenMode, realtimeAffinityDisplay, bgmMuted, hasApiKey, weatherCity, theme, themeMode, savingKeys, loadError, isSaving, loadComfyConfig, setComfySize, setEventSize, setImageProvider, setImageGenMode, setRealtimeAffinityDisplay, setBgmMuted, setHasApiKey, setWeatherCity, setThemeMode, refreshTheme }
})
