import { ref, computed } from 'vue'
import { restoreWorkflow, getWorkflows, updateWorkflowMode, updateWorkflowScene } from '../../api/index.js'

// 每个设置页实例独享草稿；只通过 shared 共享跨域的功能开关与全局设置。
export function useWorkflowSettings(shared) {
  const { toastFn, confirmFn } = shared

  // ── 工作流 ──
  const BASE_WORKFLOW_MODE_OPTIONS = [
    { value: 'turbo', label: 'turbo', desc: '只用 Anima_turbo 模型，<span class="wf-mo-highlight">速度提升300%+</span>，但代价是构图能力下降，画师串影响略微下降' },
    { value: 'base', label: 'base', desc: '只用 Anima_base 模型，泛用性最强的基底模型，构图能力强，画师串遵循强，速度较慢' },
    { value: 'hybrid', label: 'base+turbo', desc: 'turbo + base，切换时需要加载模型导致首图较慢' },
  ]

  // 自定义工作流卡片：仅当 workflow 目录里存在可选工作流时才出现（上游 v3.10.0）
  const CUSTOM_WORKFLOW_MODE_OPTION = {
    value: 'custom',
    label: '自定义',
    desc: '使用上游自带的生图工作流，或你自己放进 workflow 目录的工作流，所有生图场景统一生效（角色专属工作流仍优先）',
  }

  // 放大细化工作流由 HiresFix 单独管理，不作为生图工作流选项
  const NON_GENERATION_WORKFLOWS = ['放大细化工作流.json', '放大细化工作流-进阶.json']

  const sceneOptions = [
    { key: 'chat', label: '私聊' },
    { key: 'group', label: '群聊' },
    { key: 'moments', label: '朋友圈' },
    { key: 'events', label: '奇遇' },
    { key: 'schedule', label: '日程' },
    { key: 'mailbox', label: '信箱' },
  ]

  const workflowMode = ref('turbo')

  const workflowScene = ref({ chat: 'turbo', group: 'base', moments: 'base', events: 'base', schedule: 'base', mailbox: 'base' })

  const workflowCustomTemplate = ref('')

  const customWorkflowList = ref([])

  const customWorkflowLoading = ref(false)

  const wfResetting = ref(false)

  const wfSaving = ref(false)

  const showWfModeDialog = ref(false)

  const workflowInjectRows = [
    { node: '画面描述', type: 'PrimitiveString', desc: '替换为本次生成的画面描述（优先替换标题节点里含「请输入画面描述」占位符的输入）' },
    { node: '画师串', type: 'PrimitiveString', desc: '当前画师串（角色 / 场景 / 全局设置）' },
    { node: '图片的宽', type: 'PrimitiveInt', desc: '目标图片宽度' },
    { node: '图片的长', type: 'PrimitiveInt', desc: '目标图片高度' },
    { node: '质量提示词', type: 'PrimitiveString', desc: '质量提示词；留空时保留工作流里自带的默认值' },
    { node: '负面提示词', type: 'CLIPTextEncode', desc: '负面提示词；留空时保留默认值，缺少该标题时自动写入 KSampler 负面输入来源的文本节点' },
    { node: 'lora触发词', type: 'PrimitiveString', desc: '所有已启用 LoRA 的触发词拼接' },
  ]

  const workflowModeOptions = computed(() => customWorkflowList.value.length > 0
    ? [...BASE_WORKFLOW_MODE_OPTIONS, CUSTOM_WORKFLOW_MODE_OPTION]
    : BASE_WORKFLOW_MODE_OPTIONS)

  // 内置生图工作流也在这份列表里（后端 builtin: true）—— 「自定义」开箱即可选，不用先自备文件
  const customWorkflowOptions = computed(() => customWorkflowList.value.map(w => ({
    value: w.filename,
    label: w.builtin ? `${w.label}（内置）` : w.label,
  })))

  // 弹窗草稿状态
  const wfModeDraft = ref('turbo')

  const wfSceneDraft = ref({ chat: 'turbo', group: 'base', moments: 'base', events: 'base', schedule: 'base', mailbox: 'base' })

  const wfCustomDraft = ref('')

  async function fetchCustomWorkflows() {
    customWorkflowLoading.value = true
    try {
      const data = await getWorkflows()
      customWorkflowList.value = (data.workflows || [])
        .filter(w => !NON_GENERATION_WORKFLOWS.includes(w.filename) && !w.filename.startsWith('放大细化工作流'))
    } catch {
      customWorkflowList.value = []
    } finally {
      customWorkflowLoading.value = false
    }
  }

  function openWfModeDialog() {
    wfModeDraft.value = workflowMode.value
    wfSceneDraft.value = { ...workflowScene.value }
    wfCustomDraft.value = workflowCustomTemplate.value
    showWfModeDialog.value = true
    // 每次打开都重新拉取：workflow 目录新增文件后不用刷新页面
    fetchCustomWorkflows()
  }

  async function saveWfModeDialog() {
    if (wfModeDraft.value === 'custom' && !wfCustomDraft.value) {
      toastFn?.('请先选择一个自定义工作流', 'warning')
      return
    }
    wfSaving.value = true
    try {
      const modeChanged = wfModeDraft.value !== workflowMode.value
      const sceneChanged = JSON.stringify(wfSceneDraft.value) !== JSON.stringify(workflowScene.value)
      const customChanged = wfCustomDraft.value !== workflowCustomTemplate.value

      if (modeChanged || customChanged) await updateWorkflowMode(wfModeDraft.value, wfCustomDraft.value)
      if (sceneChanged || modeChanged) await updateWorkflowScene({ ...wfSceneDraft.value })

      workflowMode.value = wfModeDraft.value
      workflowScene.value = { ...wfSceneDraft.value }
      workflowCustomTemplate.value = wfCustomDraft.value
      showWfModeDialog.value = false
    } catch {} finally { wfSaving.value = false }
  }

  async function doWorkflowReset2() {
    const ok = await confirmFn({
      title: '重置工作流',
      message: '将用内置模板覆盖现有的\n制图工作流.json 和 制图工作流-pro.json',
      okText: '重置',
    })
    if (!ok) return
    wfResetting.value = true
    try {
      await restoreWorkflow()
    } catch {} finally { wfResetting.value = false }
  }

  function applyWorkflowConfig(data) {
    if (data.workflow) {
      workflowMode.value = data.workflow.mode || 'turbo'
      workflowCustomTemplate.value = data.workflow.customTemplate || ''
      workflowScene.value = { chat: 'turbo', group: 'base', moments: 'base', events: 'base', schedule: 'base', mailbox: 'base', ...data.workflow.scene }
    }
  }

  return { workflowMode, workflowScene, workflowCustomTemplate, wfResetting, doWorkflowReset2, openWfModeDialog, showWfModeDialog, wfSaving, saveWfModeDialog, workflowModeOptions, wfModeDraft, wfCustomDraft, customWorkflowOptions, customWorkflowLoading, workflowInjectRows, sceneOptions, wfSceneDraft, applyWorkflowConfig }
}
