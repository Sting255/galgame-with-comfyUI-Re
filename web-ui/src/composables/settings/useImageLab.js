import { ref, computed, watch, nextTick } from 'vue'
import { testStyle, testHires } from '../../api/index.js'

// 每个设置页实例独享草稿；只通过 shared 共享跨域的功能开关与全局设置。
export function useImageLab(shared, image) {
  const { form, imageProvider } = image

  // ── 测试画风 ──
  const testMode = ref('chat')

  const testModes = [
    { value: 'chat', label: '对话参数' },
    { value: 'moments', label: '朋友圈参数' },
    { value: 'event', label: '奇遇参数' },
  ]

  const styleTesting = ref(false)

  const styleError = ref('')

  const styleImages = ref([])

  // 两阶段提示词（上游 v3.9.0 契约）：先 preparing（LLM 完善中），再 generating（生图中）。
  // 后端通过 testStyle 的 onPrompt 回调在最终结果到达前就把提示词推给前端，所以失败/中断时
  // 已经产出的提示词也不该丢——这条链路是「提示词可见」而不是「出图计时」。
  const styleStage = ref('prompt')

  // 当前展示的 prompting 是否已经过完善（决定重生成时要不要再走一遍 LLM 合并）
  const generatedPromptPrepared = ref(true)

  const styleElapsed = ref(null)

  // ms
  const styleTiming = ref(null)

  // { comfyui_ms, download_ms, overhead_ms }
  const freeSceneDesc = ref('')

  // 自由画面描述（LLM 完善提示词）
  const generatedPrompt = ref('')

  // RAG 召回合并后的最终 prompt 展示
  const promptEditing = ref(false)

  // prompt 展示框的点击编辑态
  const promptEditRef = ref(null)

  // 切换参数组后重新使用对应的默认提示词，避免沿用上一组的编辑结果。
  watch(testMode, () => {
    generatedPrompt.value = ''
    generatedPromptPrepared.value = true
    promptEditing.value = false
  })

  function submitOnEnter(event, action) {
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    action()
  }

  // 点击 prompt 框进入编辑：光标定位到末尾
  async function startPromptEdit() {
    promptEditing.value = true
    await nextTick()
    promptEditRef.value?.focusToEnd()
  }

  // 画面描述框：收起态单行省略展示 ↔ 聚焦展开编辑
  const sceneDescFocused = ref(false)

  const sceneDescRef = ref(null)

  // 点击收起态的省略展示 → 展开编辑，光标到末尾
  function focusSceneDesc() {
    sceneDescRef.value?.focusToEnd()
  }

  function onSceneDescFocus() {
    sceneDescFocused.value = true
  }

  // 失焦后组件自动回到单行
  function onSceneDescBlur() {
    sceneDescFocused.value = false
  }

  const hireTesting = ref(false)

  const hiresError = ref('')

  const hiresCompare = ref(null)

  // Lightbox
  const lightboxVisible = ref(false)

  const lightboxIndex = ref(0)

  const lightboxImgs = computed(() => styleImages.value.map(i => i.base64))

  function openLightbox(index) {
    lightboxIndex.value = index
    lightboxVisible.value = true
  }

  function formatElapsed(ms) {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    const min = Math.floor(ms / 60000)
    const sec = ((ms % 60000) / 1000).toFixed(0)
    return `${min}min ${sec}s`
  }

  async function executeStyleTest({ prompt = '', sceneDesc = '', reuseSceneLoras = false, alreadyPrepared = false } = {}) {
    styleTesting.value = true
    styleStage.value = sceneDesc ? 'prompt' : alreadyPrepared ? 'generating' : 'preparing'
    styleError.value = ''
    styleImages.value = []
    styleElapsed.value = null
    styleTiming.value = null
    promptEditing.value = false

    try {
      const isMoments = testMode.value === 'moments'
      const isEvent = testMode.value === 'event'
      const result = await testStyle({
        artist: isMoments ? form.value.momentsArtist : isEvent ? form.value.eventArtist : form.value.artist,
        width: isMoments ? form.value.momentsWidth : isEvent ? form.value.eventWidth : form.value.width,
        height: isMoments ? form.value.momentsHeight : isEvent ? form.value.eventHeight : form.value.height,
        mode: testMode.value,
        prompt,
        sceneDesc,
        reuseSceneLoras,
        alreadyPrepared,
      }, {
        // 流式回调：最终结果还没回来就先展示提示词（跨字节分块由 api 层负责拼）
        onPrompt: ({ generatedPrompt: text, stage }) => {
          generatedPrompt.value = text
          generatedPromptPrepared.value = stage === 'generating'
          styleStage.value = stage
        },
      })
      if (result.generatedPrompt) {
        generatedPrompt.value = result.generatedPrompt
        if (result.success) generatedPromptPrepared.value = true
      }
      if (result.elapsed != null) styleElapsed.value = result.elapsed
      if (result.timing) styleTiming.value = result.timing
      if (result.success && result.images?.length > 0) {
        styleImages.value = result.images
      } else {
        styleError.value = result.error || `生成失败，请检查${imageProvider.value === 'novelai' ? ' NovelAI' : ' ComfyUI'} 连接`
      }
    } catch (err) {
      styleError.value = '请求失败: ' + (err.message || '网络错误')
    } finally {
      styleTesting.value = false
      // 收尾把阶段落回生成态：提示词已经确定，后面只等图片
      if (styleStage.value !== 'prompt') styleStage.value = 'generating'
    }
  }

  function runStyleTest() {
    if (styleTesting.value) return
    // 中间的最终提示词优先；与编辑框回车共用入口，不依赖上方自由描述是否为空。
    if (generatedPrompt.value.trim()) {
      return runGeneratedPromptTest()
    }
    generatedPrompt.value = ''
    return executeStyleTest({ prompt: testPrompts.value[testMode.value] || '' })
  }

  // 自由画面描述 → 后端分层 LLM 链路完善提示词后生图
  function runFreeSceneTest() {
    const desc = freeSceneDesc.value.trim()
    if (!desc || styleTesting.value) return
    generatedPrompt.value = ''
    return executeStyleTest({ sceneDesc: desc })
  }

  // 最终 prompt 已包含 RAG 合并结果；按钮或回车重生成时跳过重复合并
  function runGeneratedPromptTest() {
    const prompt = generatedPrompt.value.trim()
    if (!prompt || styleTesting.value) return
    return executeStyleTest({
      prompt,
      reuseSceneLoras: Boolean(freeSceneDesc.value.trim()),
      alreadyPrepared: generatedPromptPrepared.value,
    })
  }

  async function runHiresTest() {
    hireTesting.value = true
    hiresError.value = ''
    hiresCompare.value = null
    try {
      const result = await testHires()
      if (result.success && result.original && result.refined) {
        hiresCompare.value = { original: result.original, refined: result.refined, elapsed: result.elapsed }
      } else {
        hiresError.value = result.error || '测试细化失败，请检查 ComfyUI 连接'
      }
    } catch (err) {
      hiresError.value = '请求失败: ' + (err.message || '网络错误')
    } finally {
      hireTesting.value = false
    }
  }

  // ── 测试提示词编辑器 ──
  const TEST_PROMPTS_KEY = 'test-style-prompts'

  const DEFAULT_TEST_PROMPTS = {
    chat: `Hatsune Miku (VOCALOID), 1girl, close-up shot, teal twin-tailed hair, blue eyes, black school uniform with tie, holding a fork, looking happily at a matcha mille crepe cake on a white plate, matcha latte with musical note latte art beside it, soft natural lighting, shallow depth of field, cafe background with wooden tables, warm and cozy atmosphere, 1girl, teal-haired Hatsune Miku smiling while eating matcha cake`,
    moments: `2girls, Kiana Kaslana(honkai impact 3rd), white hair in twin braids, blue eyes, wearing a casual outfit, sitting at a cozy café table with a giant strawberry cake in front of her, laughing joyfully. Raiden Mei(honkai impact 3rd) is sitting across from her, smiling softly, two pudding cups on the table. Warm afternoon sunlight streaming through the window, soft bokeh, cute and heartwarming atmosphere, anime style, high quality illustration.`,
    event: `Yae Miko (Genshin Impact), long pink hair in a high ponytail, M-shaped bangs, purple fox-like eyes with a sly expression, wearing a red and white shrine maiden outfit with exposed side breast, lying on a futon in the Grand Narukami Shrine's private sleeping quarters. She is half-asleep, one hand loosely holding a closed light novel on her chest, the other tucked under her cheek. Her posture is relaxed, legs slightly bent, bare feet peeking out from under the thin silk blanket. Around her, soft lantern light casts warm shadows on tatami mats, a half-eaten plate of fried tofu sits on a low wooden tray nearby, and a faint smile plays on her lips as she drifts into peaceful slumber. Camera angle: slightly elevated, looking down from a 45-degree angle, capturing her serene yet mischievous aura in the dim, cozy chamber.`,
  }

  function loadTestPrompts() {
    try {
      const raw = localStorage.getItem(TEST_PROMPTS_KEY)
      if (raw) return JSON.parse(raw)
    } catch {}
    return { ...DEFAULT_TEST_PROMPTS }
  }

  const testPrompts = ref(loadTestPrompts())

  const showPromptEditor = ref(false)

  function openPromptEditor() {
    showPromptEditor.value = true
  }

  function saveTestPrompts() {
    localStorage.setItem(TEST_PROMPTS_KEY, JSON.stringify(testPrompts.value))
    showPromptEditor.value = false
  }

  function resetTestPrompts() {
    testPrompts.value = { ...DEFAULT_TEST_PROMPTS }
  }

  return { freeSceneDesc, onSceneDescFocus, onSceneDescBlur, submitOnEnter, runFreeSceneTest, styleTesting, generatedPrompt, promptEditing, startPromptEdit, runGeneratedPromptTest, styleError, styleImages, styleElapsed, formatElapsed, styleTiming, openLightbox, runStyleTest, testMode, testModes, hireTesting, runHiresTest, openPromptEditor, hiresError, hiresCompare, lightboxVisible, lightboxImgs, lightboxIndex, showPromptEditor, resetTestPrompts, saveTestPrompts, testPrompts, sceneDescRef, promptEditRef }
}
