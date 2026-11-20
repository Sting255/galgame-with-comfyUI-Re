import { inject, ref, reactive } from 'vue'
import { useSettingsStore } from '../../stores/settings.js'
import { DEFAULT_TOUCH_IMAGE_MODE, DEFAULT_TOUCH_REACTION_MODE } from '../../components/touchActionLogic.js'

export const SETTINGS_PAGE_CONTEXT = Symbol('settings-page')

// 跨域引用清单：features（生图质量/LLM/功能面板）、后台并发数、Pinia 与反馈入口。
export function createSettingsSharedState() {
  const settingsStore = useSettingsStore()

  const toastFn = inject('toast')

  const confirmFn = inject('confirm')

  const DEFAULT_HIRES_QUALITY = 'low'

  const features = reactive({ emotion: false, memory: false, replyGuesses: false, realtimeAffinityDisplay: false, serializeBackgroundLLM: false, backgroundLLMMaxConcurrency: 3, mergeMessages: false, weather: true, intimate: true, intimateBackfill: true, antiRepetition: true, antiRepetitionLock: true, antiRepetitionEscalation: true, antiRepetitionReroll: false, hiresQuality: DEFAULT_HIRES_QUALITY, toys: false, touch: true, touchInstant: true, touchGroupAdult: false, touchImageMode: DEFAULT_TOUCH_IMAGE_MODE, touchReactionMode: DEFAULT_TOUCH_REACTION_MODE, touchBystanderChance: 0.3, jailbreak: true })

  const backgroundConcurrency = ref(3)
  return { settingsStore, toastFn, confirmFn, DEFAULT_HIRES_QUALITY, features, backgroundConcurrency }
}

export function useSettingsPageContext() {
  const context = inject(SETTINGS_PAGE_CONTEXT)
  if (!context) throw new Error('设置面板必须在 SettingsView 内使用')
  return context
}
