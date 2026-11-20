import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { updateComfyConfig, updateFeatureFlag, imageProviderHealth, updateHiresSettings, getArtistFavorites, addArtistFavorite, deleteArtistFavorite, getPoseControl, updatePoseControl, getNovelaiProfiles, addNovelaiProfile, deleteNovelaiProfile, activateNovelaiProfile } from '../../api/index.js'

// 每个设置页实例独享草稿；只通过 shared 共享跨域的功能开关与全局设置。
export function useImageSettings(shared) {
  const { settingsStore, toastFn, confirmFn, DEFAULT_HIRES_QUALITY, features } = shared

  const form = ref({ artist: '', width: 1600, height: 1200, momentsArtist: '', momentsWidth: 1600, momentsHeight: 1200, eventArtist: '', eventWidth: 1600, eventHeight: 1200 })

  const globalLoras = ref([])

  const globalLoraModalVisible = ref(false)

  const hiresFixModalVisible = ref(false)

  const globalLoraCount = computed(() => (globalLoras.value || []).filter(l => l.path && l.enabled !== false).length)

  const hiresSamplingMode = ref('source')

  const hiresGlobalLoraScale = ref(1)

  const hiresSourceBlend = ref(0)

  const hiresWorkflowMode = ref('basic')

  const hiresUpscaleModel = ref('RealESRGAN_x4plus_anime_6B.pth')

  const hiresLoras = ref([])

  const hiresSteps = ref(35)

  const hiresCfg = ref(5)

  const hiresDenoise = ref(0.2)

  const hiresMaxSize = ref(2000)

  const hiresArtistMode = ref('empty')

  const hiresArtist = ref('')

  const hiresLoraCount = computed(() => (hiresLoras.value || []).filter(l => l.path && l.enabled !== false).length)

  // ── 细化是否按 turbo 参数走（与后端 config.comfyui.hiresTurbo 一致，默认 true）──
  // 打开＝细化阶段强制 CFG 1.0 / 12 步（忽略 hiresSteps/hiresCfg）；关闭＝沿用那两个值。切换即时生效。
  const hiresTurbo = ref(true)

  // ── 体位骨架（Anima Control Pose）──
  // 2026-11-15 用户定：上传固定参考图那条路已整块移除（既不绑定又碍眼），
  // 现在只剩「按当前体位现算骨架」这一种姿势控制，因此这里不再有 poseEnabled / poseImage。
  // 体位骨架（2026-11-03）：默认开 —— "生图跟着体位走"的主开关；后端字段缺失时按开显示（与 config.js 默认 true 一致）
  const poseFromPosition = ref(true)

  // 体位骨架竖构图（2026-11-04）：默认开 —— 横图会把满画布骨架画成近景特写
  const poseFromPositionPortrait = ref(true)

  const poseSaving = ref(false)

  async function loadPoseControl() {
    try {
      const d = await getPoseControl()
      poseFromPosition.value = d.poseFromPosition !== false
      poseFromPositionPortrait.value = d.poseFromPositionPortrait !== false
    } catch { /* 读不到就保持默认，不打断设置页其它配置 */ }
  }

  /** 体位骨架开关：只保留「按体位现算骨架」这一种姿势控制 */
  async function onPoseFromPositionToggle(v) {
    poseSaving.value = true
    try {
      const d = await updatePoseControl({ poseFromPosition: !!v })
      poseFromPosition.value = d.poseFromPosition !== false
      toastFn?.(poseFromPosition.value ? '体位骨架已开启：出图跟着体位走' : '体位骨架已关闭', 'success')
    } catch (e) {
      poseFromPosition.value = !v
      toastFn?.(e.message || '保存失败', 'error')
    } finally { poseSaving.value = false }
  }

  async function onPosePortraitToggle(v) {
    poseSaving.value = true
    try {
      const d = await updatePoseControl({ poseFromPositionPortrait: !!v })
      poseFromPositionPortrait.value = d.poseFromPositionPortrait !== false
      toastFn?.(poseFromPositionPortrait.value ? '体位场景改用竖构图出图' : '体位场景跟随你的尺寸设置', 'success')
    } catch (e) {
      poseFromPositionPortrait.value = !v
      toastFn?.(e.message || '保存失败', 'error')
    } finally { poseSaving.value = false }
  }

  // ── 细化精度三档（D1 用户裁决：精度可选高中低，默认 8 步）──
  // 键 features.hiresQuality（high|medium|low，默认 low）；映射：高 12 步 / 中 10 步 / 低 8 步（都走 turbo CFG 1.0）。
  const HIRES_QUALITY_MODES = [
    { value: 'high', label: '高' },
    { value: 'medium', label: '中' },
    { value: 'low', label: '低' },
  ]

  /** 任意输入 → 合法档位；不认识的一律回落默认 low（8 步） */
  function normalizeHiresQuality(value) {
    return HIRES_QUALITY_MODES.some(mode => mode.value === value) ? value : DEFAULT_HIRES_QUALITY
  }

  function hiresQualityLabel(value) {
    const mode = HIRES_QUALITY_MODES.find(item => item.value === normalizeHiresQuality(value))
    return mode ? mode.label : ''
  }

  // 三档保存：走通用 features PUT；失败把本地档位拨回去，避免「界面改了、后端没存上」
  async function saveHiresQuality(value) {
    const next = normalizeHiresQuality(value)
    const previous = normalizeHiresQuality(features.hiresQuality)
    if (next === previous) return
    features.hiresQuality = next
    try {
      await updateFeatureFlag('hiresQuality', next)
      toastFn?.('细化精度已改为「' + hiresQualityLabel(next) + '」', 'success')
    } catch (err) {
      features.hiresQuality = previous
      toastFn?.('细化精度保存失败：' + (err.message || '未知错误'), 'error')
    }
  }

  // turbo 模式下的细化参数，与后端 config.comfyui.hiresTurboSteps / hiresTurboCfg 的默认值保持一致
  const HIRES_TURBO_STEPS = 12

  const HIRES_TURBO_CFG = 1.0

  // 细化摘要显示**实际生效**的参数：turbo 打开时后端会忽略 hiresSteps/hiresCfg；
  // 进阶版还要带上工作流版本，并在「采样跟随原图」时标明采样来源（该模式步数/CFG 取自源工作流）
  const hiresSummary = computed(() => {
    const lora = hiresLoraCount.value > 0 ? ` · LoRA ${hiresLoraCount.value}` : ''
    const advancedPrefix = hiresWorkflowMode.value === 'advanced' ? '进阶版 · ' : ''
    // 2026-10-01：进阶版 + 跟随原图时，步数/CFG **由源工作流决定**（turbo 开着时则由 turbo 参数决定），
    // 这时再把「35 步 · CFG 5」和「采样跟随原图」并排写出来是两个互斥的说法 —— 二选一，别并列。
    const followsSource = hiresWorkflowMode.value === 'advanced' && hiresSamplingMode.value === 'source'
    if (hiresTurbo.value) {
      // turbo 接管步数/CFG 时仍跟随原图的只剩采样器与调度器，措辞要写准（别写成「采样跟随原图」）
      return `${advancedPrefix}最长边 ${hiresMaxSize.value} · ${HIRES_TURBO_STEPS} 步 · 重绘 ${hiresDenoise.value} · CFG ${HIRES_TURBO_CFG.toFixed(1)}${lora} · turbo${followsSource ? ' · 采样器跟随原图' : ''}`
    }
    if (followsSource) {
      return `${advancedPrefix}最长边 ${hiresMaxSize.value} · 采样跟随原图 · 重绘 ${hiresDenoise.value}${lora}`
    }
    return `${advancedPrefix}最长边 ${hiresMaxSize.value} · ${hiresSteps.value} 步 · 重绘 ${hiresDenoise.value} · CFG ${hiresCfg.value}${lora}`
  })

  // ── 质量提示词（非空覆盖工作流默认，留空不改） ──
  const qualityPrompt = ref('')

  const qualityDialog = reactive({ show: false, text: '' })

  const qualitySaving = ref(false)

  // ── 负面提示词（非空覆盖工作流默认，留空不改） ──
  const negativePrompt = ref('')

  const negativeDialog = reactive({ show: false, text: '' })

  const negativeSaving = ref(false)

  const comfyTab = ref('chat')

  const comfyTabs = [
    { value: 'chat', label: '对话配图' },
    { value: 'moments', label: '朋友圈&信件配图' },
    { value: 'event', label: '奇遇&日程配图' },
  ]

  const activeFields = computed(() => {
    if (comfyTab.value === 'moments') return { artist: 'momentsArtist', width: 'momentsWidth', height: 'momentsHeight' }
    if (comfyTab.value === 'event') return { artist: 'eventArtist', width: 'eventWidth', height: 'eventHeight' }
    return { artist: 'artist', width: 'width', height: 'height' }
  })

  const tabSlideDir = ref('forward')

  const comfyTabOrder = { chat: 0, moments: 1, event: 2 }

  function switchComfyTab(mode) {
    const prev = comfyTabOrder[comfyTab.value] ?? 0
    const next = comfyTabOrder[mode] ?? 0
    tabSlideDir.value = next > prev ? 'forward' : 'back'
    comfyTab.value = mode
  }

  const comfyUrl = ref('')

  const comfySkipTls = ref(false)

  const imageProvider = ref('comfyui')

  const imageProviderOptions = [
    { value: 'comfyui', label: 'ComfyUI' },
    { value: 'novelai', label: 'NovelAI' },
  ]

  const novelaiUrl = ref('')

  // 三协议（上游 v3.10.0）：official=官方直连 / native=原生协议 / relay=OpenAI 兼容中转
  const novelaiApiFormat = ref('relay')

  const novelaiApiFormatOptions = [
    { value: 'official', label: 'NovelAI 官方 API' },
    { value: 'native', label: '原生协议（自建 / 兼容服务）' },
    { value: 'relay', label: 'OpenAI 兼容中转站' },
  ]

  const novelaiProxyUrl = ref('')

  // 官方/原生有内置模型清单；中转站的模型要问接口要
  const novelaiBuiltinModels = ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full']

  function changeNovelaiFormat() {
    novelaiModels.value = novelaiApiFormat.value === 'relay'
      ? []
      : novelaiBuiltinModels.map(id => ({ value: id, label: id }))
  }

  /** 兼容旧代码/旧模板的布尔口径：官方 = official，其余 = relay 语义 */
  const novelaiApiFormatOfficial = computed({
    get: () => novelaiApiFormat.value === 'official',
    set: (v) => { novelaiApiFormat.value = v ? 'official' : 'relay' },
  })

  const novelaiModel = ref('nai-diffusion-4-5-full')

  const novelaiArtist = ref('@ebora')

  const novelaiModels = ref([])

  const novelaiWidth = ref(1216)

  const novelaiHeight = ref(832)

  const novelaiResolutionPresets = [
    { label: '512×512', width: 512, height: 512 },
    { label: '832×1216', width: 832, height: 1216 },
    { label: '1216×832', width: 1216, height: 832 },
    { label: '1024×1024', width: 1024, height: 1024 },
    { label: '1024×1536', width: 1024, height: 1536 },
    { label: '1536×1024', width: 1536, height: 1024 },
  ]

  const novelaiSteps = ref(28)

  const novelaiSampler = ref('k_euler_ancestral')

  const novelaiSamplerOptions = [
    { value: 'k_euler', label: 'Euler' },
    { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
    { value: 'k_dpm_2', label: 'DPM 2' },
    { value: 'k_dpm_2_ancestral', label: 'DPM 2 Ancestral' },
    { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
    { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
    { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
    { value: 'ddim', label: 'DDIM' },
    { value: 'ddim_v3', label: 'DDIM V3' },
  ]

  const novelaiNoiseSchedule = ref('karras')

  const novelaiNoiseScheduleOptions = [
    { value: 'native', label: 'Native' },
    { value: 'karras', label: 'Karras' },
    { value: 'exponential', label: 'Exponential' },
    { value: 'polyexponential', label: 'Polyexponential' },
  ]

  const novelaiGuidance = ref(5)

  const novelaiQualityPrompt = ref('masterpiece, best quality, score_9, score_8, highres, absurdres, year 2025')

  const novelaiDefaultNegativePrompt = 'lowres, bad_anatomy, bad_hands, text, error, missing_fingers, extra_digit, fewer_digits, cropped, worst_quality, low_quality, normal_quality, jpeg_artifacts, signature, watermark, username, blurry, bad_feet, fused_fingers, too_many_fingers, long_neck, cross-eyed, mutated_hands, polar_lowres, bad_body, bad_proportions, gross_proportions, text, error, missing_fingers, missing_arms, missing_legs, extra_digit, extra_arms, extra_leg, extra_foot'

  const novelaiNegativePrompt = ref(novelaiDefaultNegativePrompt)

  const novelaiModelsLoading = ref(false)

  const novelaiApiKey = ref('')

  const novelaiApiKeySaved = ref(false)

  const novelaiApiKeyCleared = ref(false)

  // NovelAI 多套配置：与 LLM 配置胶囊同一套交互（切换 / 新增快照 / 删除）
  const novelaiProfiles = ref([])

  const activeNovelaiProfileId = ref('')

  const showAddNovelaiProfile = ref(false)

  const newNovelaiProfileName = ref('')

  const novelaiProfileBusy = ref(false)

  const newNovelaiProfileInput = ref(null)

  watch(() => showAddNovelaiProfile.value, async (visible) => {
    if (visible) {
      newNovelaiProfileName.value = ''
      await nextTick()
      newNovelaiProfileInput.value?.focus?.()
    }
  })

  const connDirty = ref(false)

  const connSaved = ref(false)

  const dirty = ref(false)

  const saved = ref(false)

  // 保存中：防止连点，也避免用户在请求未回时以为没生效又点一次
  const comfySaving = ref(false)

  const health = ref(null)

  const presets = [
    { label: '768×512', width: 768, height: 512 },
    { label: '768×768', width: 768, height: 768 },
    { label: '1024×1024', width: 1024, height: 1024 },
    { label: '1280×720', width: 1280, height: 720 },
    { label: '1200×900', width: 1200, height: 900 },
    { label: '1600×1200', width: 1600, height: 1200 },
  ]

  // ── 画师串收藏夹 ──
  const artistFavorites = ref([])

  const favDialog = reactive({
    show: false,
    mode: 'chat',
    label: '',
  })

  async function loadArtistFavorites() {
    try {
      const data = await getArtistFavorites()
      artistFavorites.value = data.favorites || []
    } catch {}
  }

  function addToFavorites(mode) {
    const artist = (mode === 'moments' ? form.value.momentsArtist : mode === 'event' ? form.value.eventArtist : form.value.artist).trim()
    if (!artist) return
    if (artistFavorites.value.some(f => f.artist === artist)) {
      toastFn('已收藏过该画师串', 'warning')
      return
    }
    favDialog.mode = mode
    favDialog.label = artist.length > 20 ? artist.slice(0, 20) + '…' : artist
    favDialog.show = true
  }

  async function confirmAddFavorite() {
    const artist = (favDialog.mode === 'moments' ? form.value.momentsArtist : favDialog.mode === 'event' ? form.value.eventArtist : form.value.artist).trim()
    const label = favDialog.label.trim() || artist
    try {
      const result = await addArtistFavorite({ label, artist })
      if (result.ok) {
        artistFavorites.value.push(result.favorite)
      }
    } catch (err) {
      console.error('[favorites] add failed:', err)
    }
    favDialog.show = false
  }

  function cancelAddFavorite() {
    favDialog.show = false
  }

  const favDialogInput = ref(null)

  watch(() => favDialog.show, async (v) => {
    if (v) {
      await nextTick()
      favDialogInput.value?.focus()
      favDialogInput.value?.select()
    }
  })

  function applyFavorite(fav, mode) {
    if (mode === 'moments') {
      form.value.momentsArtist = fav.artist
    } else if (mode === 'event') {
      form.value.eventArtist = fav.artist
    } else {
      form.value.artist = fav.artist
    }
    markDirty()
  }

  async function removeFavorite(id) {
    try {
      await deleteArtistFavorite(id)
      artistFavorites.value = artistFavorites.value.filter(f => f.id !== id)
    } catch {}
  }

  const showNovelaiRelayModal = ref(false)

  const novelaiRelayConfigBusy = ref(false)

  async function applyNovelaiRelayConfig() {
    if (novelaiRelayConfigBusy.value) return
    novelaiRelayConfigBusy.value = true
    try {
      const url = 'https://nai.rinko.ai'
      const result = await updateComfyConfig({ novelaiUrl: url })
      novelaiUrl.value = result.novelaiUrl || url
      health.value = null
      connSaved.value = true
      setTimeout(() => { connSaved.value = false }, 2000)
      showNovelaiRelayModal.value = false
      toastFn?.('已配置 NAI.Rinko 接口地址；请填写 API Key 后测试连接', 'success')
    } catch (err) {
      toastFn?.('快速配置失败: ' + (err.message || '未知错误'), 'error')
    } finally {
      novelaiRelayConfigBusy.value = false
    }
  }

  function markDirty() { dirty.value = true; saved.value = false }

  function markConnDirty() { connDirty.value = true; connSaved.value = false; health.value = null }

  /**
   * 生图配置有未保存改动时，离开设置页先问一句。
   *
   * 2026-11-09（W01/C02）：原来 dirty 只用来禁用「保存」按钮，用户改完宽度/画风
   * 直接点别的页签，改动无声消失 —— 而界面上一句话都没说，看着像已经生效了。
   *
   * 只拦真的会丢东西的情况：dirty 为假时直接放行，不做无意义的确认。
   * 浏览器刷新/关标签用 beforeunload，仅在确实有改动时挂上，避免每次切页都弹窗。
   */
  async function confirmLeave() {
    if (!dirty.value || comfySaving.value) return true
    const ok = await confirmFn?.({
      title: '放弃未保存的修改？',
      message: '生图配置改了但还没保存，离开后这些改动会丢失。',
      okText: '放弃修改',
      cancelText: '留下继续编辑',
      danger: true,
    })
    return ok === true
  }

  onBeforeRouteLeave(async () => {
    const ok = await confirmLeave()
    if (!ok) return false
    dirty.value = false
    return true
  })

  function onBeforeUnload(event) {
    if (!dirty.value) return
    event.preventDefault()
    // 现代浏览器忽略自定义文案，但必须设 returnValue 才会弹原生确认
    event.returnValue = ''
  }

  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

  async function onImageProviderChange(provider) {
    health.value = null
    try {
      const result = await updateComfyConfig({ imageProvider: provider })
      settingsStore.setImageProvider(result.imageProvider)
      connSaved.value = true
      setTimeout(() => { connSaved.value = false }, 2000)
    } catch (err) {
      imageProvider.value = settingsStore.imageProvider
      toastFn?.(err.message || '切换生图服务失败', 'error')
    }
  }

  function applyNovelaiResolutionPreset(preset) {
    novelaiWidth.value = preset.width
    novelaiHeight.value = preset.height
    markConnDirty()
  }

  function onNovelaiDimensionInput(axis, event) {
    const value = Number(event?.target?.value)
    if (axis === 'width') novelaiWidth.value = value
    else novelaiHeight.value = value
    markConnDirty()
  }

  function onNovelaiKeyInput() {
    novelaiApiKeyCleared.value = false
    markConnDirty()
  }

  function clearNovelaiKey() {
    novelaiApiKeyCleared.value = true
    markConnDirty()
  }

  /** 把后端返回的 NovelAI 生效配置铺回表单（切换配置 / 删除激活配置后复用） */
  function applyNovelaiConfig(data) {
    if (!data) return
    novelaiApiFormat.value = data.novelaiApiFormat || 'relay'
    novelaiProxyUrl.value = data.novelaiProxyUrl || ''
    novelaiModels.value = novelaiApiFormat.value === 'relay' ? [] : novelaiBuiltinModels
    novelaiUrl.value = data.novelaiUrl ?? ''
    novelaiModel.value = data.novelaiModel || 'nai-diffusion-4-5-full'
    novelaiArtist.value = data.novelaiArtist ?? '@ebora'
    novelaiWidth.value = data.novelaiWidth || 1216
    novelaiHeight.value = data.novelaiHeight || 832
    novelaiSteps.value = data.novelaiSteps || 28
    novelaiSampler.value = data.novelaiSampler || 'k_euler_ancestral'
    novelaiNoiseSchedule.value = data.novelaiNoiseSchedule || 'karras'
    novelaiGuidance.value = data.novelaiGuidance ?? 5
    novelaiQualityPrompt.value = data.novelaiQualityPrompt ?? 'masterpiece, best quality, score_9, score_8, highres, absurdres, year 2025'
    novelaiNegativePrompt.value = data.novelaiNegativePrompt ?? novelaiDefaultNegativePrompt
    novelaiApiKeySaved.value = data.novelaiApiKeySet === true
    novelaiApiKey.value = ''
    novelaiApiKeyCleared.value = false
    connDirty.value = false
    connSaved.value = false
    health.value = null
  }

  async function loadNovelaiProfiles(data) {
    if (data) {
      novelaiProfiles.value = data.novelaiProfiles || []
      activeNovelaiProfileId.value = data.activeNovelaiProfileId || ''
    } else {
      const res = await getNovelaiProfiles()
      novelaiProfiles.value = res.profiles || []
      activeNovelaiProfileId.value = res.activeProfileId || ''
    }
  }

  async function switchNovelaiProfile(id) {
    if (id === activeNovelaiProfileId.value) return
    try {
      const result = await activateNovelaiProfile(id)
      if (!result.ok) return
      novelaiProfiles.value = result.profiles || []
      activeNovelaiProfileId.value = result.activeProfileId || ''
      applyNovelaiConfig(result)
      const name = novelaiProfiles.value.find(p => p.id === activeNovelaiProfileId.value)?.name || ''
      toastFn?.(name ? `已切换到配置「${name}」` : '已切换 NovelAI 配置', 'success')
    } catch (err) {
      console.error('[novelai] switch profile failed:', err)
      toastFn?.(err.message || '切换 NovelAI 配置失败', 'error')
    }
  }

  async function addNovelaiProfileDraft() {
    const name = newNovelaiProfileName.value.trim()
    if (!name || novelaiProfileBusy.value) return
    novelaiProfileBusy.value = true
    try {
      const result = await addNovelaiProfile(name)
      novelaiProfiles.value = result.profiles || []
      activeNovelaiProfileId.value = result.activeProfileId || novelaiProfiles.value[0]?.id || ''
      showAddNovelaiProfile.value = false
      newNovelaiProfileName.value = ''
      toastFn?.(`已复制当前配置为「${name}」，改完保存后可用上方胶囊切换`, 'success')
    } catch (err) {
      console.error('[novelai] add profile failed:', err)
      toastFn?.(err.message || '新增配置失败', 'error')
    } finally {
      novelaiProfileBusy.value = false
    }
  }

  async function removeNovelaiProfile(id) {
    if (novelaiProfiles.value.length <= 1) return
    const name = novelaiProfiles.value.find(p => p.id === id)?.name || '该配置'
    const title = `删除「${name}」`
    const body = '将删除该配置快照，当前正在使用的配置不受影响，此操作不可撤销'
    if (!confirmFn) {
      if (!window.confirm(`${title}\n\n${body}`)) return
    } else {
      const ok = await confirmFn({ title, message: body, danger: true, okText: '删除' })
      if (!ok) return
    }
    try {
      const result = await deleteNovelaiProfile(id)
      if (!result.ok) return
      novelaiProfiles.value = result.profiles || []
      activeNovelaiProfileId.value = result.activeProfileId || ''
      applyNovelaiConfig(result)
      toastFn?.(`已删除配置「${name}」`, 'success')
    } catch (err) {
      console.error('[novelai] delete profile failed:', err)
      toastFn?.(err.message || '删除配置失败', 'error')
    }
  }

  async function saveComfy() {
    if (comfySaving.value) return
    comfySaving.value = true
    try {
      await updateComfyConfig({
        artist: form.value.artist, width: form.value.width, height: form.value.height,
        momentsArtist: form.value.momentsArtist, momentsWidth: form.value.momentsWidth, momentsHeight: form.value.momentsHeight,
        eventArtist: form.value.eventArtist, eventWidth: form.value.eventWidth, eventHeight: form.value.eventHeight,
      })
      settingsStore.setComfySize(form.value.width, form.value.height)
      settingsStore.setEventSize(form.value.eventWidth, form.value.eventHeight)
      dirty.value = false; saved.value = true
      setTimeout(() => saved.value = false, 2000)
    } catch (err) {
      // 以前这里没有 try/catch：保存失败就是 unhandled rejection，界面毫无反应、
      // dirty 仍是 true，用户会以为已经存上了（生图配置恰恰是最需要确认写库成功的地方）。
      toastFn?.(`生图配置保存失败：${err?.message || '未知错误'}`, 'error')
    } finally {
      comfySaving.value = false
    }
  }

  function onGlobalLoraSaved(globalList) {
    if (Array.isArray(globalList)) globalLoras.value = globalList
  }

  function onHiresFixSaved({ loras, steps, cfg, denoise, maxSize, artistMode, artist, samplingMode, globalLoraScale, sourceBlend, upscaleModel, workflowMode, turbo }) {
    if (samplingMode !== undefined) hiresSamplingMode.value = samplingMode
    if (globalLoraScale !== undefined) hiresGlobalLoraScale.value = globalLoraScale
    if (sourceBlend !== undefined) hiresSourceBlend.value = sourceBlend
    if (workflowMode !== undefined) hiresWorkflowMode.value = workflowMode
    if (upscaleModel !== undefined) hiresUpscaleModel.value = upscaleModel
    if (Array.isArray(loras)) hiresLoras.value = loras
    if (steps !== undefined) hiresSteps.value = steps
    if (cfg !== undefined) hiresCfg.value = cfg
    if (denoise !== undefined) hiresDenoise.value = denoise
    if (maxSize !== undefined) hiresMaxSize.value = maxSize
    if (artistMode !== undefined) hiresArtistMode.value = artistMode
    if (artist !== undefined) hiresArtist.value = artist
    if (turbo !== undefined) hiresTurbo.value = turbo
  }

  // 「细化用 turbo 参数」开关：即改即存（改完立刻生效，无需重启）；
  // 保存失败回滚本地开关，避免界面显示与后端实际状态不一致（沿用本页 saveIntimateFeature 的写法）
  async function onHiresTurboToggle(val) {
    try {
      await updateHiresSettings({ turboMode: val })
      hiresTurbo.value = val
      toastFn?.(val
        ? `细化已改用 turbo 参数（CFG ${HIRES_TURBO_CFG.toFixed(1)} / ${HIRES_TURBO_STEPS} 步）`
        : '细化已恢复「设置」里的步数与 CFG', 'success')
    } catch (err) {
      hiresTurbo.value = !val
      toastFn?.(`turbo 参数保存失败：${err.message || '未知错误'}`, 'error')
    }
  }

  function openGlobalLora() {
    globalLoraModalVisible.value = true
  }

  function openHiresFixSettings() {
    hiresFixModalVisible.value = true
  }

  function openQualityDialog() {
    qualityDialog.text = qualityPrompt.value
    qualityDialog.show = true
  }

  async function saveQualityPrompt() {
    qualitySaving.value = true
    try {
      const text = qualityDialog.text.trim()
      await updateComfyConfig({ qualityPrompt: text })
      qualityPrompt.value = text
      qualityDialog.show = false
      toastFn(text ? '质量提示词已更新，下张图生效' : '已恢复系统默认质量提示词', 'success')
    } catch (e) {
      console.error('saveQualityPrompt failed:', e)
      toastFn(e.message || '保存失败', 'error')
    } finally {
      qualitySaving.value = false
    }
  }

  function openNegativeDialog() {
    negativeDialog.text = negativePrompt.value
    negativeDialog.show = true
  }

  async function saveNegativePrompt() {
    negativeSaving.value = true
    try {
      const text = negativeDialog.text.trim()
      await updateComfyConfig({ negativePrompt: text })
      negativePrompt.value = text
      negativeDialog.show = false
      toastFn(text ? '负面提示词已更新，下张图生效' : '已恢复工作流默认负面提示词', 'success')
    } catch (e) {
      console.error('saveNegativePrompt failed:', e)
      toastFn(e.message || '保存失败', 'error')
    } finally {
      negativeSaving.value = false
    }
  }

  async function saveComfyUrl() {
    try {
      if (imageProvider.value === 'novelai' && (!Number.isInteger(Number(novelaiWidth.value)) || !Number.isInteger(Number(novelaiHeight.value))
        || Number(novelaiWidth.value) < 64 || Number(novelaiHeight.value) < 64
        || Number(novelaiWidth.value) > 4096 || Number(novelaiHeight.value) > 4096)) {
        toastFn?.('NovelAI 分辨率需为 64–4096 之间的整数像素', 'error')
        return
      }
      const hasNovelaiKey = Boolean(novelaiApiKey.value.trim() || (novelaiApiKeySaved.value && !novelaiApiKeyCleared.value))
      if (imageProvider.value === 'novelai' && !hasNovelaiKey) {
        toastFn?.('切换到 NovelAI 前，请先填写 API Key', 'error')
        return
      }
      const payload = {
        imageProvider: imageProvider.value,
        novelaiApiFormat: novelaiApiFormat.value,
        novelaiProxyUrl: novelaiProxyUrl.value.trim(),
        novelaiUrl: novelaiUrl.value.trim().replace(/\/+$/, ''),
        novelaiModel: novelaiModel.value,
        novelaiArtist: novelaiArtist.value,
        novelaiWidth: Number(novelaiWidth.value),
        novelaiHeight: Number(novelaiHeight.value),
        novelaiSteps: Math.min(50, Math.max(1, Number(novelaiSteps.value) || 28)),
        novelaiSampler: novelaiSampler.value,
        novelaiNoiseSchedule: novelaiNoiseSchedule.value,
        novelaiGuidance: Number(novelaiGuidance.value),
        novelaiQualityPrompt: novelaiQualityPrompt.value,
        novelaiNegativePrompt: novelaiNegativePrompt.value,
      }
      if (imageProvider.value === 'comfyui') {
        payload.url = comfyUrl.value.trim().replace(/\/+$/, '')
        payload.tlsVerify = !comfySkipTls.value
      }
      if (novelaiApiKey.value.trim()) payload.novelaiApiKey = novelaiApiKey.value.trim()
      if (novelaiApiKeyCleared.value) payload.clearNovelaiApiKey = true
      const result = await updateComfyConfig(payload)
      settingsStore.setImageProvider(result.imageProvider)
      novelaiApiKeySaved.value = result.novelaiApiKeySet === true
      novelaiApiKey.value = ''
      novelaiApiKeyCleared.value = false
      connDirty.value = false; connSaved.value = true
      setTimeout(() => connSaved.value = false, 2000)
      // 保存会同步进当前激活的配置快照，刷新胶囊上的密钥/模型状态
      if (imageProvider.value === 'novelai') await loadNovelaiProfiles()
      await checkHealth()
    } catch (err) {
      toastFn?.(err.message || '生图连接设置保存失败', 'error')
    }
  }

  async function checkHealth() {
    const result = await imageProviderHealth({
      provider: imageProvider.value,
      apiFormat: novelaiApiFormat.value,
      proxyUrl: novelaiProxyUrl.value.trim(),
      url: imageProvider.value === 'novelai' ? novelaiUrl.value : comfyUrl.value,
      model: novelaiModel.value,
      ...(novelaiApiKey.value.trim() ? { apiKey: novelaiApiKey.value.trim() } : {}),
    })
    health.value = result
    if (result.provider === 'novelai') {
      novelaiModels.value = Array.isArray(result.models)
        ? result.models.map(model => ({ value: model, label: model }))
        : []
    }
  }

  async function fetchNovelaiModels() {
    novelaiModelsLoading.value = true
    try {
      const result = await imageProviderHealth({
        provider: 'novelai',
        apiFormat: novelaiApiFormat.value,
        proxyUrl: novelaiProxyUrl.value.trim(),
        url: novelaiUrl.value,
        model: novelaiModel.value,
        ...(novelaiApiKey.value.trim() ? { apiKey: novelaiApiKey.value.trim() } : {}),
      })
      health.value = result
      novelaiModels.value = Array.isArray(result.models)
        ? result.models.map(model => ({ value: model, label: model }))
        : []
      if (result.connected) toastFn?.(`已获取 ${result.modelCount} 个模型`, 'success')
      else toastFn?.(result.error || '获取模型列表失败', 'error')
    } finally {
      novelaiModelsLoading.value = false
    }
  }

  function isPresetActive(p) {
    const f = activeFields.value
    return form.value[f.width] === p.width && form.value[f.height] === p.height
  }

  function applyPreset(p, mode = 'chat') {
    if (mode === 'moments') {
      form.value.momentsWidth = p.width; form.value.momentsHeight = p.height;
    } else if (mode === 'event') {
      form.value.eventWidth = p.width; form.value.eventHeight = p.height;
    } else {
      form.value.width = p.width; form.value.height = p.height;
    }
    dirty.value = true; saved.value = false;
  }

  function applyImageConfig(data) {
    // 画师串口径（与后端 routes/images.js 一致）：空串 '' ＝ 用户明确要「不要画师串」，
    // 必须原样保留；只有 undefined / 字段缺失（旧配置）才回落到上一个页签的值。
    // 所以这里一律用 ??，不能用 || —— || 会把显式空串当成"没值"，把 @chat 又塞回去。
    // 三个页签各自的字段分别判断，互不影响。
    form.value = {
      artist: data.comfy.artist, width: data.comfy.width, height: data.comfy.height,
      momentsArtist: data.comfy.momentsArtist ?? data.comfy.artist,
      momentsWidth: data.comfy.momentsWidth ?? 1600,
      momentsHeight: data.comfy.momentsHeight ?? 1200,
      eventArtist: data.comfy.eventArtist ?? data.comfy.momentsArtist ?? data.comfy.artist,
      eventWidth: data.comfy.eventWidth ?? 1600,
      eventHeight: data.comfy.eventHeight ?? 1200,
    }
    globalLoras.value = data.comfy.globalLora || []
    hiresSamplingMode.value = data.comfy.hiresSamplingMode ?? 'source'
    hiresGlobalLoraScale.value = data.comfy.hiresGlobalLoraScale ?? 1
    hiresSourceBlend.value = data.comfy.hiresSourceBlend ?? 0
    hiresWorkflowMode.value = data.comfy.hiresWorkflowMode === 'advanced' ? 'advanced' : 'basic'
    hiresUpscaleModel.value = data.comfy.hiresUpscaleModel ?? 'RealESRGAN_x4plus_anime_6B.pth'
    hiresLoras.value = data.comfy.hiresLora || []
    hiresTurbo.value = data.comfy.hiresTurbo ?? true
    hiresSteps.value = data.comfy.hiresSteps ?? 35
    hiresCfg.value = data.comfy.hiresCfg ?? 5
    hiresDenoise.value = data.comfy.hiresDenoise ?? 0.2
    hiresMaxSize.value = data.comfy.hiresMaxSize ?? 2000
    hiresArtistMode.value = data.comfy.hiresArtistMode ?? 'empty'
    hiresArtist.value = data.comfy.hiresArtist ?? ''
    qualityPrompt.value = data.comfy.qualityPrompt ?? ''
    negativePrompt.value = data.comfy.negativePrompt ?? ''
    comfyUrl.value = data.comfy.url || 'http://localhost:8188'
    comfySkipTls.value = data.comfy.tlsVerify === false
    imageProvider.value = data.comfy.imageProvider === 'novelai' ? 'novelai' : 'comfyui'
    applyNovelaiConfig(data.comfy)
    settingsStore.setComfySize(data.comfy.width, data.comfy.height)
    loadNovelaiProfiles(data)
  }

  return { form, globalLoras, hiresSamplingMode, hiresGlobalLoraScale, hiresSourceBlend, hiresWorkflowMode, hiresUpscaleModel, hiresLoras, hiresSteps, hiresCfg, hiresDenoise, hiresMaxSize, hiresArtistMode, hiresArtist, hiresTurbo, loadPoseControl, qualityPrompt, negativePrompt, comfyUrl, comfySkipTls, imageProvider, loadArtistFavorites, applyNovelaiConfig, loadNovelaiProfiles, checkHealth, comfyTab, comfyTabs, switchComfyTab, tabSlideDir, activeFields, markDirty, addToFavorites, artistFavorites, applyFavorite, removeFavorite, presets, isPresetActive, applyPreset, poseFromPosition, poseSaving, onPoseFromPositionToggle, poseFromPositionPortrait, onPosePortraitToggle, hiresSummary, openHiresFixSettings, HIRES_TURBO_CFG, HIRES_TURBO_STEPS, onHiresTurboToggle, normalizeHiresQuality, HIRES_QUALITY_MODES, saveHiresQuality, openQualityDialog, openNegativeDialog, dirty, comfySaving, saveComfy, saved, openGlobalLora, globalLoraCount, globalLoraModalVisible, onGlobalLoraSaved, hiresFixModalVisible, onHiresFixSaved, favDialog, cancelAddFavorite, confirmAddFavorite, qualityDialog, qualitySaving, saveQualityPrompt, negativeDialog, negativeSaving, saveNegativePrompt, favDialogInput, showNovelaiRelayModal, novelaiRelayConfigBusy, applyNovelaiRelayConfig, onImageProviderChange, imageProviderOptions, markConnDirty, novelaiProfiles, activeNovelaiProfileId, switchNovelaiProfile, removeNovelaiProfile, showAddNovelaiProfile, novelaiApiFormat, changeNovelaiFormat, novelaiApiFormatOptions, novelaiUrl, novelaiProxyUrl, novelaiModel, novelaiModels, novelaiModelsLoading, fetchNovelaiModels, novelaiQualityPrompt, novelaiArtist, novelaiNegativePrompt, novelaiWidth, onNovelaiDimensionInput, novelaiHeight, novelaiResolutionPresets, applyNovelaiResolutionPreset, novelaiSampler, novelaiSamplerOptions, novelaiNoiseSchedule, novelaiNoiseScheduleOptions, novelaiSteps, novelaiGuidance, novelaiApiKey, novelaiApiKeySaved, onNovelaiKeyInput, novelaiApiKeyCleared, clearNovelaiKey, health, connDirty, saveComfyUrl, connSaved, newNovelaiProfileName, novelaiProfileBusy, addNovelaiProfileDraft, newNovelaiProfileInput, applyImageConfig }
}
