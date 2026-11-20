<template>
  <linshe-modal :model-value="modelValue" title="SillyTavern 预设" full body-class="preset-modal-body" :transition-ms="300" @update:model-value="requestClose">
    <template #header-extra>
      <span class="preset-status" role="status" :title="activeName ? `已启用预设：${activeName}` : '未启用预设'">
        <span v-if="activeName" class="preset-active-badge"><span aria-hidden="true">✓</span> 已启用</span>
        <span class="preset-status-name">{{ activeName || '未启用预设' }}</span>
      </span>
    </template>
    <Transition name="preset-view" mode="out-in">
    <div :key="items.length ? 'workspace' : 'welcome'" class="preset-manager" :class="{'is-empty': !items.length, 'is-preview': selected && view === 'preview'}" :aria-busy="busy">
            <aside v-if="items.length" class="preset-list">
              <div class="preset-library-tools">
                <linshe-select :model-value="selectedKey" class="preset-picker" size="sm" :options="presetOptions" searchable :disabled="busy" placeholder="选择预设" aria-label="选择预设" @update:model-value="selectPreset" />
                <linshe-button size="sm" :disabled="busy" @click="importFile">导入 JSON</linshe-button>
                <linshe-button size="sm" variant="danger" :disabled="busy || !selected" @click="removePreset">删除</linshe-button>
              </div>
              <template v-if="selected">
              <linshe-select v-if="orderOptions.length > 1" v-model="selected.orderId" class="preset-order" size="sm" :options="orderOptions" :disabled="busy" aria-label="排序配置" />
              <div class="preset-list-tools">
                <linshe-input v-model="search" size="sm" placeholder="搜索名称或正文" aria-label="搜索提示词" />
                <linshe-button size="sm" :disabled="busy" @click="addEntry()">＋ 条目</linshe-button>
              </div>
              <div class="preset-stats"><span>条目 <strong>{{ rows.length }}</strong></span><span>启用 <strong>{{ enabledCount }}</strong></span></div>
              <div class="preset-rows">
                <div v-for="row in filteredRows" :key="row.entry.identifier" class="preset-row" :class="{'is-selected': entryId === row.entry.identifier, 'is-off': !row.entry.enabled}" draggable="true" @dragstart="dragId = row.entry.identifier" @dragover.prevent @drop.prevent="dropEntry(row)" @dragend="dragId = ''">
                  <div class="preset-row-label" role="button" tabindex="0" :aria-pressed="entryId === row.entry.identifier" @click="selectEntry(row.entry.identifier)" @keydown.enter.prevent="selectEntry(row.entry.identifier)" @keydown.space.prevent="selectEntry(row.entry.identifier)">
                    <span class="preset-row-name">{{ isPresetMarker(row.prompt) ? '◇ ' : '' }}{{ row.prompt?.name || row.entry.identifier }}</span>
                    <span class="preset-row-meta">{{ !row.prompt ? '条目缺失' : isPresetMarker(row.prompt) ? '邻舍原有内容' : row.index < 0 ? '未加入当前排序' : `${(row.prompt.content || '').length} 字` }}</span>
                  </div>
                  <linshe-switch size="sm" :model-value="row.entry.enabled" :disabled="busy || !row.prompt" :aria-label="`启用 ${row.prompt?.name || row.entry.identifier}`" @update:model-value="setEnabled(row.entry.identifier, $event)" />
                </div>
                <p v-if="!filteredRows.length" class="preset-note">没有匹配的条目。</p>
              </div>
              </template>
            </aside>

      <div class="preset-detail-panel">
        <linshe-tabs v-if="selected" v-model="view" class="preset-view-tabs" :options="[{label:'编辑提示词',value:'edit'},{label:'注入预览',value:'preview'}]" size="md" />
        <p v-if="error && (!selected || view === 'preview')" class="preset-error" role="alert">{{ error }}</p>
        <Transition name="preset-view" mode="out-in" @after-enter="scrollPreviewEntry">
          <section v-if="selected && view === 'preview'" key="preview" class="preset-preview" :aria-busy="previewing" aria-label="system1 注入预览">
            <div class="preset-preview-heading">
              <strong>预设注入方式为在邻舍原有提示词的system0和system2之间插入一个system1专门放置所有预设字段，因为输出格式和要求的不同必然会有不兼容的地方，必定需要大幅度删减</strong>
              <span v-if="result" class="preset-cache-info" :title="previewHint" tabindex="0">
                <span class="preset-cache-label">高缓存设计 · 相同前缀可复用缓存</span>
                <span class="preset-token-count">约 <b>{{ result.estimatedTokens }}</b> tokens</span>
              </span>
            </div>
            <p v-if="previewError" class="preset-error" role="alert">{{ result ? `更新失败，保留上次预览：${previewError}` : previewError }}</p>
            <div v-if="previewEntryNote" class="preset-entry-status" :class="{'is-enabled': previewEntryEnabled}" role="status">
              <span class="preset-entry-status-label">
                <svg class="preset-entry-status-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path v-if="previewEntryEnabled" d="m4 10 4 4 8-8" /><path v-else d="M5 10h10" /></svg>
                {{ previewEntryEnabled ? '已启用' : '未启用' }}
              </span>
              <p>{{ previewEntryNote }}</p>
            </div>
            <pre v-if="result?.content" ref="previewOutput" class="preset-preview-output" tabindex="0" aria-label="system1 预设正文" @wheel.passive="previewScroller.cancel" @touchstart.passive="previewScroller.cancel" @pointerdown="previewScroller.cancel" @keydown="previewScroller.cancel"><span v-for="(segment, index) in previewSegments" :key="index" :data-preset-entry="segment.identifier" :class="{'preset-preview-selected': segment.selected}">{{ segment.text }}</span></pre>
            <p v-else-if="!result && previewing" class="preset-note" role="status">正在展开预设…</p>
            <p v-else-if="!previewError" class="preset-note">{{ emptyPreviewNote }}</p>
            <div v-if="!result?.content && result?.outputSuggestions?.length" class="preset-output-suggestions">
              <span class="preset-note">这些未启用的条目会读取当前变量，可定位后检查并打开左侧开关：</span>
              <div class="preset-toolbar">
                <linshe-button v-for="suggestion in result.outputSuggestions" :key="suggestion.identifier" variant="ghost" size="sm" @click="locateOutput(suggestion)">定位「{{ suggestion.name }}」</linshe-button>
              </div>
            </div>
          </section>
          <div v-else-if="selected" key="edit" class="preset-edit-pane">
        <p v-if="error" class="preset-error" role="alert">{{ error }}</p>
        <p v-if="notice" class="preset-note" role="status">{{ notice }}</p>
            <Transition name="preset-view" mode="out-in">
              <section v-if="entry" :key="entry.identifier" class="preset-editor">
                <div class="preset-editor-heading">
<strong>编辑提示词</strong><div class="preset-toolbar">
                  <linshe-button size="sm" :disabled="busy || entryIndex <= 0" aria-label="上移条目" @click="move(-1)">↑</linshe-button>
                  <linshe-button size="sm" :disabled="busy || entryIndex < 0 || entryIndex >= order.length - 1" aria-label="下移条目" @click="move(1)">↓</linshe-button>
                  <linshe-button size="sm" :disabled="busy || isPresetMarker(entry)" @click="duplicateEntry">复制条目</linshe-button>
                  <linshe-button size="sm" variant="ghost" :disabled="busy || isPresetMarker(entry)" @click="removeEntry">删除条目</linshe-button>
                </div>
</div>
                <label>名称<linshe-input v-model="entry.name" size="sm" :disabled="busy" /></label>
                <p v-if="isPresetMarker(entry)" class="preset-note">这是酒馆的内容占位标记。邻舍继续在原位置提供角色、世界书与历史；此标记不重复注入，也不控制原内容的开关。</p>
                <label v-else class="preset-content">提示词<linshe-input v-model="entry.content" type="textarea" :rows="16" :disabled="busy" spellcheck="false" /></label>
              </section>
              <div v-else key="empty-entry" class="empty">选择左侧提示词开始编辑，或新增条目。</div>
            </Transition>
          </div>
          <div v-else-if="loading" key="loading" class="empty">正在读取预设…</div>
          <section v-else-if="items.length" key="no-preset" class="preset-welcome" aria-labelledby="preset-disabled-title">
            <h4 id="preset-disabled-title">不加载预设</h4>
            <p class="preset-welcome-description">后续生成不注入预设。已导入的预设仍保留，可从左侧选择后保存并启用。</p>
          </section>
        <section v-else key="welcome" class="preset-welcome preset-import-welcome" aria-labelledby="preset-welcome-title">
          <div class="preset-import-copy">
            <h4 id="preset-welcome-title">导入 SillyTavern 预设</h4>
            <p class="preset-welcome-description">选择 JSON 预设，删减并启用合适的条目。展开后的正文会按顺序汇总，装入独立的 system1。</p>
            <linshe-button variant="primary" :loading="saving" :disabled="busy" @click="importFile">选择 JSON 文件</linshe-button>
            <div class="preset-import-caution">
              <strong>导入后，需要大幅删减</strong>
              <p>预设中很多结构化部分不适合直接注入邻舍，例如固定 JSON 输出模板、状态栏、MVU / ERA 变量更新指令和强制标签格式。请删除或关闭与邻舍输出要求冲突的条目，预览确认后再保存并启用。</p>
            </div>
          </div>
          <figure class="preset-injection-figure">
            <svg class="preset-injection-diagram" viewBox="0 0 460 350" role="img" aria-labelledby="preset-injection-title preset-injection-desc">
              <title id="preset-injection-title">预设如何装入 system1</title>
              <desc id="preset-injection-desc">从 SillyTavern JSON 中手动删减并启用条目，按顺序展开变量并汇总正文，放入 system0 与 system2 之间的独立 system1。system0 保留邻舍基础规则与世界观，system2 及后续层保留原有任务要求、人设和上下文。</desc>
              <g class="injection-source">
                <rect class="injection-paper-back" x="10" y="81" width="154" height="178" rx="14" transform="rotate(-4 87 170)" />
                <rect class="injection-paper" x="6" y="76" width="154" height="178" rx="14" />
                <text class="injection-title" x="22" y="103">SillyTavern</text>
                <text class="injection-muted" x="22" y="125">JSON 预设</text>
                <path class="injection-divider" d="M22 140h122" />
                <path class="injection-check" d="m22 159 4 4 7-8m-11 33 4 4 7-8" />
                <text class="injection-small" x="39" y="163">文风与叙事偏好</text>
                <text class="injection-small" x="39" y="192">变量展开的正文</text>
                <text class="injection-muted injection-small" x="22" y="234">手动删减 · 启用条目</text>
              </g>
              <g class="injection-transfer">
                <text class="injection-muted injection-small" x="192" y="141" text-anchor="middle">按序汇总</text>
                <path class="injection-arrow" d="M169 166h47m-7-6 7 6-7 6" />
              </g>
              <g>
                <rect class="injection-layer" x="228" y="12" width="226" height="70" rx="13" />
                <text class="injection-title" x="246" y="39">system0</text>
                <text class="injection-muted" x="246" y="62">邻舍基础规则 + 世界观（如有）</text>
                <path class="injection-connector" d="M341 83v19m-4-4 4 4 4-4" />
              </g>
              <g class="injection-loaded">
                <rect class="injection-slot" x="228" y="110" width="226" height="112" rx="13" />
                <text class="injection-title injection-accent" x="246" y="138">system1</text>
                <text class="injection-accent injection-small" x="435" y="138" text-anchor="end">预设专用</text>
                <text class="injection-body" x="246" y="164">启用条目展开后的正文</text>
                <path class="injection-content-line" d="M246 182h185m-185 13h132" />
              </g>
              <g>
                <path class="injection-connector" d="M341 223v19m-4-4 4 4 4-4" />
                <rect class="injection-layer" x="228" y="250" width="226" height="70" rx="13" />
                <text class="injection-title" x="246" y="277">system2 及后续层</text>
                <text class="injection-muted" x="246" y="300">邻舍原有任务要求、人设与上下文</text>
              </g>
              <text class="injection-muted injection-small" x="341" y="344" text-anchor="middle">↓ 继续原有请求结构</text>
            </svg>
            <figcaption>仅用于已接入预设的创作请求；变量需被引用后才会输出。</figcaption>
          </figure>
        </section>
        </Transition>
      </div>
    </div>
    </Transition>
    <template v-if="selected || dirtyCount" #footer>
      <div class="preset-footer">
        <span class="preset-footer-state">{{ dirtyCount ? `${dirtyCount} 份草稿未保存` : '所有修改已保存' }}</span>
        <linshe-button v-if="selected" size="sm" variant="primary" :loading="saving" :disabled="busy || (!selectedDirty && selected.active)" @click="saveAndActivate">保存并启用</linshe-button>
      </div>
    </template>
  </linshe-modal>
</template>

<script setup>
import { computed, inject, nextTick, onScopeDispose, ref, watch } from 'vue'
import LinsheModal from './ui/LinsheModal.vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSelect from './ui/LinsheSelect.vue'
import LinsheSwitch from './ui/LinsheSwitch.vue'
import LinsheTabs from './ui/LinsheTabs.vue'
import * as api from '../api/index.js'
import { isPresetMarker, presetSnapshot, presetOrder, presetRows, setPresetEntryEnabled, movePresetEntry, removePresetEntry, presetPreviewSegments, createPresetScroller } from '../utils/promptPresets.js'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue', 'changed'])
const confirm = inject('confirm')
const noPresetKey = '__none__'
const items = ref([]), selectedKey = ref(''), entryId = ref(''), search = ref(''), view = ref('edit'), dragId = ref('')
const loading = ref(false), saving = ref(false), previewing = ref(false), error = ref(''), notice = ref(''), result = ref(null)
const busy = computed(() => loading.value || saving.value)
const selected = computed(() => items.value.find(p => p.key === selectedKey.value))
const rows = computed(() => presetRows(selected.value))
const filteredRows = computed(() => rows.value.filter(r => `${r.prompt?.name || r.entry.identifier} ${r.prompt?.content || ''}`.toLowerCase().includes(search.value.toLowerCase())))
const order = computed(() => selected.value ? presetOrder(selected.value) : [])
const entry = computed(() => selected.value?.document.prompts.find(p => p.identifier === entryId.value))
const entryIndex = computed(() => order.value.findIndex(p => p.identifier === entryId.value))
const enabledCount = computed(() => rows.value.filter(r => r.entry.enabled && r.prompt && !isPresetMarker(r.prompt)).length)
const isDirty = item => !item.id || presetSnapshot(item) !== item.baseline
const selectedDirty = computed(() => selected.value && isDirty(selected.value))
const dirtyCount = computed(() => items.value.filter(isDirty).length)
const activeName = computed(() => items.value.find(p => p.active)?.name || '')
const presetOptions = computed(() => [{label:'不加载预设',value:noPresetKey},...items.value.map(p => ({label:`${p.active ? '✓ 已启用 · ' : ''}${p.name}${isDirty(p) ? ' *' : ''}`,value:p.key}))])
const orderOptions = computed(() => (selected.value?.document.prompt_order || []).map(p => ({label:String(p.character_id) === '100001' ? '全局排序（100001）' : `排序 ${p.character_id}`,value:String(p.character_id)})))
const previewError = ref('')
const previewOutput = ref(null)
const previewSegments = computed(() => presetPreviewSegments(result.value,entryId.value))
const previewEntryEnabled = computed(() => Boolean(order.value.find(item => item.identifier === entryId.value)?.enabled))
const emptyPreviewNote = computed(() => result.value?.entries?.some(row=>row.emptyKind==='assignment')
  ? '当前启用的条目只设置变量，没有输出正文。请在左侧启用读取这些变量的汇总输出条目；保存和启用不会自动打开被关闭的条目。'
  : '当前没有可注入的正文。')
const previewEntryNote = computed(() => {
  if (!result.value || previewing.value) return ''
  const row = result.value.entries?.find(item => item.identifier === entryId.value)
  if (row?.ranges?.length && row.reason !== 'included') return '此条目通过变量引用注入，已标出实际输出位置。'
  if (row?.reason === 'variables') return ({assignment:'此条目设置了变量，但本次展开中没有保留其输出（可能未被引用或已被覆盖）。',comment:'此条目为注释，不参与注入。',blank:'此条目正文为空。',expansion:'此条目的宏在当前预览上下文中展开为空。'})[row.emptyKind] || '此条目没有直接输出，内容可能通过变量由其他条目引用。'
  return ({disabled:'此条目未启用，没有注入正文。',marker:'此条目为内容占位标记，没有独立的预设正文。',missing:'此条目缺失，没有注入正文。'})[row?.reason] || (!row && entryId.value ? '此条目未加入当前排序，没有注入正文。' : '')
})
const previewScroller = createPresetScroller({requestFrame:callback=>window.requestAnimationFrame(callback),cancelFrame:id=>window.cancelAnimationFrame(id),reducedMotion:()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches})
onScopeDispose(previewScroller.cancel)
watch([view,selectedKey,result,()=>props.modelValue],previewScroller.cancel)
let pendingPreviewScroll = false
function scrollPreviewEntry() {
  if (view.value !== 'preview' || !pendingPreviewScroll || !previewOutput.value) return
  const output = previewOutput.value
  const target = output.querySelector('.preset-preview-selected')
  if (!target) { if (!previewing.value) pendingPreviewScroll = false; return }
  // 仅滚动预览正文，保持左侧列表和弹窗的位置不变。
  previewScroller.scroll(output,output.scrollTop + target.getBoundingClientRect().top - output.getBoundingClientRect().top - 12)
  pendingPreviewScroll = false
}
watch(result, async () => { await nextTick(); scrollPreviewEntry() })
watch(view, value => { if (value === 'preview') pendingPreviewScroll = true })
const previewHint = computed(() => ['预设统一放在 system0 后，采用前缀复用的高缓存设计。首次请求建立缓存；后续相同前缀可复用，实际命中取决于提供商支持、缓存有效期及前缀是否保持一致。', '此处为当前草稿的模拟预览与 token 估算，不是实际缓存命中统计。角色、历史、时间或随机宏变化可能影响后续前缀的缓存复用。', ...(result.value?.warnings || [])].join('\n'))
const localKey = () => `draft-${crypto.randomUUID()}`
function loaded(item) { return {...item,key:String(item.id),baseline:presetSnapshot(item)} }
watch(() => props.modelValue, open => { if (open) load() }, {immediate:true})
watch(selectedKey, () => { entryId.value = rows.value[0]?.entry.identifier || ''; search.value = ''; result.value = null })
watch([view, selectedKey, () => selected.value && JSON.stringify([selected.value.document, selected.value.orderId]), () => props.modelValue, loading], (values, previous, onCleanup) => {
  previewError.value = ''; previewing.value = false
  if (!props.modelValue || loading.value || view.value !== 'preview' || !selected.value) return
  previewing.value = true
  let cancelled = false
  const payload = {document:JSON.parse(JSON.stringify(selected.value.document)),orderId:selected.value.orderId}
  const timer = setTimeout(async () => {
    try { const response = await api.previewPromptPreset(payload); if (!cancelled) result.value = response }
    catch (e) { if (!cancelled) previewError.value = e.message }
    finally { if (!cancelled) previewing.value = false }
  }, previous?.[0] === 'preview' ? 150 : 0)
  onCleanup(() => { cancelled = true; clearTimeout(timer) })
})
async function load() {
  loading.value = true; error.value = ''; notice.value = ''
  try { const data = await api.getPromptPresets(); items.value = data.items.map(loaded); selectedKey.value = items.value.find(p => p.key === selectedKey.value)?.key || items.value.find(p => p.active)?.key || noPresetKey; entryId.value = rows.value[0]?.entry.identifier || '' }
  catch (e) { error.value = e.message }
  finally { loading.value = false }
}
async function mayDiscard() { return !dirtyCount.value || await confirm({title:'尚未保存',message:`放弃 ${dirtyCount.value} 份预设草稿的修改？`,okText:'放弃修改',danger:true}) }
async function requestClose(open) { if (busy.value || (!open && !(await mayDiscard()))) return; emit('update:modelValue', open) }
async function selectPreset(key) {
  if (busy.value) return
  if (key !== noPresetKey) { selectedKey.value = key; return }
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const active = items.value.find(item => item.active)
    if (active) {
      const {item} = await api.activatePromptPreset(active.id,false,active.revision)
      // 停用预设时不得覆盖未保存的提示词修改，也不得将其标记为已保存。
      active.active = item.active
      active.revision = item.revision
    }
    selectedKey.value = noPresetKey
    emit('changed')
  } catch (e) { error.value = e.message } finally { saving.value = false }
}
function createDraft(document, name, orderId) {
  const item = {key:localKey(),name,document,orderId:String(orderId ?? document.prompt_order.find(p => String(p.character_id) === '100001')?.character_id ?? document.prompt_order[0]?.character_id ?? 100001),active:false,baseline:''}
  if (!document.prompt_order.length) document.prompt_order.push({character_id:100001,order:[]})
  items.value.push(item); selectedKey.value = item.key; view.value = 'edit'
}
async function selectEntry(id) {
  previewScroller.cancel()
  entryId.value = id
  if (view.value !== 'preview') return
  pendingPreviewScroll = true
  await nextTick()
  scrollPreviewEntry()
}
function locateOutput(suggestion) { search.value = suggestion.name; selectEntry(suggestion.identifier) }
function addEntry(source) {
  view.value = 'edit'
  const prompt = {identifier:crypto.randomUUID(),name:'新提示词',role:'system',content:'',system_prompt:false,marker:false,...source}
  selected.value.document.prompts.push(prompt); order.value.push({identifier:prompt.identifier,enabled:true}); entryId.value = prompt.identifier; search.value = ''
}
function duplicateEntry() { addEntry({...JSON.parse(JSON.stringify(entry.value)),identifier:crypto.randomUUID(),name:`${entry.value.name} 副本`}) }
function setEnabled(id, enabled) { setPresetEntryEnabled(selected.value,id,enabled) }
function move(delta) { movePresetEntry(selected.value,entryId.value,delta) }
function dropEntry(row) {
  if (busy.value || row.index < 0) return
  const from = order.value.findIndex(p => p.identifier === dragId.value)
  if (from >= 0) movePresetEntry(selected.value,dragId.value,row.index - from)
  dragId.value = ''
}
async function removeEntry() { if (await confirm({title:'删除提示词',message:`从所有排序中删除「${entry.value.name}」？保存后生效。`,okText:'删除',danger:true})) { removePresetEntry(selected.value,entryId.value); entryId.value = rows.value[0]?.entry.identifier || '' } }
async function importFile() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return
    saving.value = true; error.value = ''; notice.value = ''
    try { if (file.size > 4 * 1024 * 1024) throw new Error('预设文件不能超过 4 MiB'); const parsed = JSON.parse((await file.text()).replace(/^\uFEFF/,'')); const checked = await api.previewPromptPreset({document:parsed}); createDraft(checked.document,file.name.replace(/\.json$/i,''),checked.orderId); notice.value = '已导入草稿，可预览后保存并启用。' }
    catch (e) { error.value = e.message }
    finally { saving.value = false }
  }
  input.click()
}
async function saveAndActivate() {
  if (!selected.value || busy.value) return
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const item = selected.value
    const body = {name:item.name,document:item.document,orderId:item.orderId,expectedRevision:item.revision,activate:true}
    const response = item.id ? await api.updatePromptPreset(item.id,body) : await api.createPromptPreset(body)
    // 保存草稿只更新数据库 ID，不切换当前编辑区。
    // 保留本地标识、选中条目、搜索内容和当前预览。
    Object.assign(item,loaded(response.item),{key:item.key})
    for (const fresh of response.items || []) {
      const existing = items.value.find(p => p.id === fresh.id)
      if (!existing) continue
      existing.active = fresh.active
      // 仅接受启用状态变化带来的版本更新；若远端正文已修改，
      // 不得保留旧本地草稿却更新版本号，以免后续保存覆盖未读取的远端修改。
      if (presetSnapshot(fresh) === existing.baseline) existing.revision = fresh.revision
    }
    notice.value = '预设已保存并启用，用于后续生成请求。'; emit('changed')
  } catch (e) { error.value = e.message } finally { saving.value = false }
}
async function removePreset() {
  const item = selected.value
  if (!await confirm({title:'删除预设',message:`删除「${item.name}」？${item.active ? '这也会停用当前预设。' : ''}可先导出备份。`,okText:'删除',danger:true})) return
  saving.value = true; error.value = ''
  try { if (item.id) await api.deletePromptPreset(item.id,item.revision); items.value = items.value.filter(p => p.key !== item.key); selectedKey.value = items.value[0]?.key || ''; emit('changed') }
  catch (e) { error.value = e.message } finally { saving.value = false }
}
</script>

<style>
.preset-modal-body { display:flex; overflow:hidden; }
@media(max-width:767px) { .preset-modal-body { display:block; overflow-y:auto; } }
</style>

<style scoped>
.preset-manager { display:grid; grid-template-columns:minmax(240px,.8fr) minmax(0,1.7fr); gap:20px; color:var(--text-primary); min-height:0; flex:1; min-width:0; width:100%; }
.preset-manager.is-empty { grid-template-columns:1fr; }
.preset-manager.is-empty .preset-detail-panel { overflow-y:auto; }
.preset-welcome { width:100%; max-width:560px; margin:auto; padding:40px 20px; display:flex; flex-direction:column; align-items:center; text-align:center; }
.preset-welcome h4 { margin:0 0 10px; font-size:var(--fs-xl); line-height:1.5; color:var(--text-primary); }
.preset-welcome-description { margin:0 0 24px; font-size:var(--fs-sm); line-height:1.8; color:var(--text-secondary); }
.preset-import-welcome { max-width:1080px; display:grid; grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr); align-items:center; gap:40px; text-align:left; }
.preset-import-caution { margin-top:28px; padding-top:18px; border-top:1px solid var(--border); }
.preset-import-caution strong { display:block; font-size:var(--fs-sm); font-weight:600; color:var(--text-primary); }
.preset-import-caution p { margin:8px 0 0; font-size:var(--fs-sm); line-height:1.8; color:var(--text-secondary); }
.preset-injection-figure { min-width:0; margin:0; }
.preset-injection-diagram { display:block; width:100%; height:auto; overflow:visible; font-family:inherit; }
.preset-injection-figure figcaption { margin-top:12px; text-align:center; font-size:var(--fs-xs); line-height:1.7; color:var(--text-secondary); }
.injection-paper-back { fill:var(--bg-sunken); stroke:var(--border); }
.injection-paper { fill:var(--bg-secondary); stroke:var(--border-strong); }
.injection-layer { fill:var(--bg-sunken); stroke:var(--border); }
.injection-slot { fill:rgba(var(--accent-rgb),.1); stroke:var(--accent); stroke-width:1.5; }
.injection-title { fill:var(--text-primary); font-size:16px; font-weight:600; }
.injection-body { fill:var(--text-primary); font-size:14px; }
.injection-muted { fill:var(--text-secondary); font-size:12px; }
.injection-small { fill:var(--text-secondary); font-size:12px; }
.injection-accent { fill:var(--accent); }
.injection-divider { stroke:var(--border); }
.injection-check, .injection-arrow, .injection-content-line, .injection-connector { fill:none; stroke:var(--accent); stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.injection-connector { stroke:var(--border-strong); }
.injection-content-line { opacity:.4; }
.injection-source, .injection-transfer, .injection-loaded { animation:preset-injection-appear .3s var(--ease-standard) both; }
.injection-transfer { animation-delay:.1s; }
.injection-loaded { animation-delay:.2s; }
@keyframes preset-injection-appear { from { opacity:0; transform:translateX(-6px); } to { opacity:1; transform:translateX(0); } }
.preset-detail-panel, .preset-edit-pane { display:flex; flex-direction:column; gap:12px; min-height:0; min-width:0; }
.preset-detail-panel > .preset-view-tabs, .preset-edit-pane > :not(.preset-editor) { flex-shrink:0; }
.preset-edit-pane { flex:1; }
.preset-toolbar, .preset-editor-heading, .preset-stats { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.preset-library-tools { display:flex; align-items:center; gap:6px; flex-shrink:0; margin-bottom:10px; }
.preset-library-tools > :not(.preset-picker) { flex-shrink:0; }
.preset-picker { flex:1; min-width:0; }
.preset-manager label { display:flex; flex-direction:column; gap:6px; font-size:var(--fs-sm); color:var(--text-secondary); min-width:0; }
.preset-order { flex-shrink:0; margin-bottom:10px; }
.preset-list { display:flex; flex-direction:column; min-width:0; min-height:0; border-right:1px solid var(--border); padding-right:16px; }
.preset-list-tools { display:flex; gap:8px; align-items:center; }
.preset-list-tools > :first-child { flex:1; min-width:0; }
.preset-stats, .preset-status, .preset-footer-state { font-size:var(--fs-xs); color:var(--text-secondary); }
.preset-status { display:flex; align-items:center; gap:8px; min-width:0; }
.preset-active-badge { display:inline-flex; align-items:center; gap:5px; flex-shrink:0; padding:4px 10px; border:1px solid rgba(var(--accent-rgb),.5); border-radius:var(--radius-full); background:rgba(var(--accent-rgb),.16); color:var(--accent); font-size:var(--fs-sm); font-weight:700; line-height:1.4; }
.preset-status-name { max-width:260px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.preset-stats { margin:8px 0; }
.preset-stats strong { color:var(--text-primary); font-variant-numeric:tabular-nums; }
.preset-rows { flex:1; min-height:0; overflow:auto; padding:2px 4px 8px 0; }
.preset-row { display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--border); padding:7px 6px; border-radius:var(--radius-sm); }
.preset-row.is-selected { background:rgba(var(--accent-rgb), .12); }
.preset-row.is-off .preset-row-label { color:var(--text-secondary); }
.preset-row-label { cursor:pointer; text-align:left; min-width:0; flex:1; display:flex; flex-direction:column; gap:2px; }
.preset-row-name { font-size:var(--fs-sm); overflow-wrap:anywhere; }
.preset-row-meta { font-size:var(--fs-xs); color:var(--text-secondary); }
.preset-editor, .preset-preview { display:flex; flex-direction:column; gap:12px; min-width:0; min-height:0; flex:1; overflow-y:auto; padding-right:4px; }
.preset-editor-heading { justify-content:space-between; font-size:var(--fs-md); }
.preset-content { flex:1; min-height:180px; }
.preset-content > :last-child { flex:1; min-height:160px; resize:vertical; }
.preset-note { margin:0; font-size:var(--fs-sm); line-height:1.75; color:var(--text-secondary); overflow-wrap:anywhere; }
.preset-error { margin:0; font-size:var(--fs-sm); line-height:1.6; color:var(--danger); }
.preset-preview-heading { display:grid; grid-template-columns:minmax(0,1fr) minmax(110px,230px); align-items:start; gap:16px; flex-shrink:0; font-size:var(--fs-xs); color:var(--text-secondary); }
.preset-preview-heading strong { font-weight:600; color:var(--text-primary); line-height:1.7; overflow-wrap:anywhere; }
.preset-cache-info { display:flex; flex-direction:column; align-items:flex-end; gap:4px; min-width:0; padding-left:16px; border-left:1px solid var(--border); text-align:right; line-height:1.7; overflow-wrap:anywhere; }
.preset-cache-label { color:var(--accent); }
.preset-token-count { font-variant-numeric:tabular-nums; }
.preset-token-count b { color:var(--text-primary); font-weight:600; }
.preset-entry-status { --entry-status-color:var(--text-secondary); display:flex; align-items:center; gap:10px; flex-shrink:0; padding:9px 12px; border-radius:var(--radius-sm); background:var(--bg-sunken); color:var(--text-primary); font-size:var(--fs-sm); line-height:1.65; }
.preset-entry-status.is-enabled { --entry-status-color:color-mix(in srgb,var(--success) 65%,var(--text-primary)); background:color-mix(in srgb,var(--success) 7%,var(--bg-secondary)); }
.preset-entry-status-icon { width:14px; height:14px; flex-shrink:0; }
.preset-entry-status-label { display:inline-flex; align-items:center; gap:4px; flex-shrink:0; padding:3px 8px; border-radius:var(--radius-full); background:color-mix(in srgb,var(--entry-status-color) 12%,transparent); color:var(--entry-status-color); font-size:var(--fs-xs); font-weight:600; white-space:nowrap; }
.preset-entry-status p { min-width:0; margin:0; font:inherit; overflow-wrap:anywhere; }
.preset-preview-output { flex:1; min-height:0; margin:0; overflow:auto; overflow-anchor:none; white-space:pre-wrap; overflow-wrap:anywhere; padding:12px; border-radius:var(--radius-sm); background:var(--bg-primary); font-family:inherit; font-size:var(--fs-sm); line-height:1.8; }
.preset-preview-selected { background:rgba(var(--accent-rgb),.12); border-radius:3px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
.preset-output-suggestions { display:flex; flex-direction:column; gap:8px; }
.preset-footer-state { margin-right:auto; }
.preset-footer { display:flex; flex-wrap:wrap; align-items:center; width:100%; gap:8px; }
.preset-view-enter-active, .preset-view-leave-active { transition:opacity .3s var(--ease-standard); }
.preset-view-enter-from, .preset-view-leave-to { opacity:0; }
@media(max-width:767px) {
  .preset-welcome { padding:48px 8px; }
  .preset-import-welcome { grid-template-columns:1fr; gap:24px; padding:24px 4px; }
  .preset-injection-figure { max-width:480px; width:100%; justify-self:center; }
  .preset-manager { display:flex; flex-direction:column; flex:0 0 auto; gap:12px; }
  .preset-list { flex:none; border-right:0; border-bottom:1px solid var(--border); padding:0 0 10px; }
  .preset-detail-panel, .preset-edit-pane { flex:none; min-height:auto; }
  .is-preview .preset-detail-panel { order:-1; }
  .is-preview .preset-preview { height:65dvh; overflow:hidden; flex:none; }
  .preset-rows { max-height:42dvh; flex:none; }
  .preset-editor, .preset-preview { overflow:visible; flex:none; }
  .preset-content { min-height:260px; }
  .preset-status { max-width:160px; gap:6px; }
  .preset-status-name { min-width:0; }
  .preset-footer-state { flex-basis:100%; }
  .preset-preview-heading { grid-template-columns:minmax(0,1fr) minmax(96px,.55fr); gap:10px; }
  .preset-cache-info { padding-left:10px; }
  .preset-entry-status { align-items:flex-start; flex-wrap:wrap; gap:6px 8px; padding:8px 10px; }
}
</style>
