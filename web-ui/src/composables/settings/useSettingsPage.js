import { onMounted, ref, computed, inject } from 'vue'
import { getConfig } from '../../api/index.js'
import { useRouter } from 'vue-router'
import { THEME_MODES } from '../../theme.js'
import { CHANGELOG_ENTRIES } from '../../data/changelog.js'
import { createSettingsSharedState } from './settingsContext.js'
import { useImageSettings } from './useImageSettings.js'
import { useFeatureSettings } from './useFeatureSettings.js'
import { useLlmSettings } from './useLlmSettings.js'
import { useImageLab } from './useImageLab.js'
import { useWorkflowSettings } from './useWorkflowSettings.js'

export function useSettingsPage() {
  const shared = createSettingsSharedState()
  const { toastFn } = shared
  const themeModes = THEME_MODES

  const router = useRouter()

  const isMobile = inject('isMobile')

  const toggleMobileSidebar = inject('toggleMobileSidebar')

  const showChangelogFn = inject('showChangelog', null)

  // ── 更新说明入口：显示最新版本号与条目数，点击重新打开弹窗 ──
  const changelogLatest = computed(() => CHANGELOG_ENTRIES[0] || null)

  const changelogTotal = computed(() => CHANGELOG_ENTRIES.length)

  function openChangelog() {
    if (showChangelogFn) showChangelogFn()
    else toastFn?.('更新说明弹窗未就绪，请刷新页面重试', 'info')
  }

  // ── 移动端滚动方向感知：下滑隐藏标题，上滑显示 ──
  const scrollEl = ref(null)

  const headerVisible = ref(true)

  let settingsLastScroll = 0

  function onSettingsScroll() {
    if (!isMobile) return
    const el = scrollEl.value
    if (!el) return
    const delta = el.scrollTop - settingsLastScroll
    if (el.scrollTop > 40 && delta > 8) {
      headerVisible.value = false
    } else if (delta < -4) {
      headerVisible.value = true
    }
    settingsLastScroll = el.scrollTop
  }
  const image = useImageSettings(shared)
  const workflow = useWorkflowSettings(shared)
  const features = useFeatureSettings(shared)
  const llm = useLlmSettings(shared)
  const lab = useImageLab(shared, image)
  onMounted(async () => {
    image.loadPoseControl()
    llm.loadModelRoutes()
    features.loadDefaultAssistant()
    try {
      const data = await getConfig()
      image.applyImageConfig(data)
      features.applyFeatureConfig(data)
      llm.applyLlmInitialConfig(data)
      workflow.applyWorkflowConfig(data)
    } catch {
      llm.llmSetupMode.value = 'error'
    }
    await image.checkHealth()
    await image.loadArtistFavorites()
  })
  return { ...shared, ...image, ...workflow, ...features, ...llm, ...lab, onSettingsScroll, isMobile, headerVisible, toggleMobileSidebar, router, openChangelog, changelogLatest, changelogTotal, scrollEl, themeModes }
}
