<template>
  <article class="book-row" :class="{ 'is-open': expanded, 'is-disabled': entry.disable }">
    <div class="book-row-head">
      <linshe-button variant="icon" size="sm" :aria-label="`${expanded ? '收起' : '展开'}：${entry.comment || '未命名条目'}`" :aria-expanded="expanded" :aria-controls="`book-entry-${entry.uid}`" @click="$emit('toggle')">
        <svg class="entry-chevron" :class="{ 'is-expanded': expanded }" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </linshe-button>
      <linshe-switch size="sm" :model-value="!entry.disable" :aria-label="`启用：${entry.comment || '未命名条目'}`" @update:model-value="entry.disable = !$event" />
      <linshe-input v-model="entry.comment" class="entry-title" size="sm" aria-label="标题（备注）" placeholder="未命名条目" />
      <label class="head-field trigger-field"><span>触发策略</span><linshe-select :model-value="strategy" size="sm" aria-label="触发策略" :options="strategies" @update:model-value="setStrategy" /></label>
      <label class="head-field position-field"><span>插入位置</span><linshe-select :model-value="placement" size="sm" aria-label="插入位置" :options="positions" @update:model-value="setPlacement" /></label>
      <label class="head-field depth-field"><span>深度</span><linshe-input :model-value="entry.position === 4 ? entry.depth : ''" size="sm" type="number" min="0" max="1000" :disabled="entry.position !== 4" aria-label="深度" placeholder="—" @update:model-value="entry.depth = Number($event)" /></label>
      <label class="head-field order-field"><span>顺序</span><linshe-input v-model.number="entry.order" size="sm" type="number" aria-label="顺序" /></label>
      <label class="head-field probability-field"><span>概率 %</span><linshe-input v-model.number="entry.probability" size="sm" type="number" min="0" max="100" :disabled="entry.useProbability === false" aria-label="触发概率" /></label>
      <div class="row-actions">
        <linshe-button variant="icon" size="sm" :aria-label="`复制：${entry.comment}`" title="复制条目" @click="$emit('duplicate')">⧉</linshe-button>
        <linshe-button variant="icon" size="sm" :aria-label="`删除：${entry.comment}`" title="删除条目" @click="$emit('remove')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg></linshe-button>
      </div>
    </div>
    <Transition name="entry-collapse">
      <div v-if="expanded" :id="`book-entry-${entry.uid}`" class="entry-collapse" :inert="!expanded">
        <div class="entry-collapse-clip">
          <div class="book-row-body">
        <div class="keyword-grid">
          <label>主要关键词<linshe-input :model-value="keywordText.key" size="sm" placeholder="逗号分隔，支持 /正则/flags" @update:model-value="updateKeywords('key', $event)" /></label>
          <label>逻辑<linshe-select v-model="entry.selectiveLogic" size="sm" :options="logicOptions" :disabled="entry.selective === false" /></label>
          <div class="entry-field"><span class="field-heading">可选过滤词<linshe-switch :model-value="entry.selective !== false" size="sm" aria-label="使用可选过滤词" @update:model-value="entry.selective = $event" /></span><linshe-input :model-value="keywordText.keysecondary" size="sm" :disabled="entry.selective === false" placeholder="逗号分隔，留空则忽略" aria-label="可选过滤词" @update:model-value="updateKeywords('keysecondary', $event)" /></div>
        </div>
        <div class="match-grid">
          <label>扫描深度<linshe-input :model-value="entry.scanDepth ?? ''" size="sm" type="number" min="0" max="1000" placeholder="使用全局设置" @update:model-value="entry.scanDepth = nullableNumber($event)" /></label>
          <label v-for="field in nullableFlags" :key="field.key">{{ field.label }}<linshe-select :model-value="entry[field.key] ?? null" size="sm" :options="inheritOptions" @update:model-value="entry[field.key] = $event" /></label>
          <label>自动化 ID<linshe-input v-model="entry.automationId" size="sm" placeholder="无" title="保留 ST 扩展字段，不执行插件脚本" /></label>
        </div>
        <div class="content-heading">
          <span>内容 <small>UID: {{ entry.uid }}</small></span>
          <div class="rule-switches">
            <linshe-switch v-model="entry.excludeRecursion" size="sm" on-text="不可递归" off-text="不可递归" title="不会被其他条目激活" />
            <linshe-switch v-model="entry.preventRecursion" size="sm" on-text="防止进一步递归" off-text="防止进一步递归" title="本条内容不会激活其他条目" />
            <linshe-switch v-model="entry.ignoreBudget" size="sm" on-text="忽略预算" off-text="忽略预算" />
            <linshe-switch :model-value="entry.useProbability !== false" size="sm" on-text="使用概率" off-text="使用概率" @update:model-value="entry.useProbability = $event" />
          </div>
        </div>
        <linshe-input v-model="entry.content" size="sm" type="textarea" :rows="9" aria-label="条目内容" placeholder="写下人物、地点或世界规则…" />
        <div class="timing-grid">
          <div class="entry-field"><span class="field-heading">包含组<linshe-switch v-model="entry.groupOverride" size="sm" on-text="优先" off-text="优先" title="同组优先选择本条" /></span><linshe-input v-model="entry.group" size="sm" aria-label="包含组" placeholder="留空不分组，多个用逗号分隔" /></div>
          <label>组权重<linshe-input :model-value="entry.groupWeight ?? ''" size="sm" type="number" min="0" placeholder="100" @update:model-value="entry.groupWeight = nullableNumber($event)" /></label>
          <label v-for="field in timingFields" :key="field.key" :title="field.hint">{{ field.label }}<linshe-input v-model.number="entry[field.key]" size="sm" type="number" min="0" placeholder="0" /></label>
        </div>
        <div class="filter-grid">
          <label>绑定角色<linshe-input :model-value="(entry.characterFilter?.names || []).join(', ')" size="sm" placeholder="逗号分隔，留空不限" @update:model-value="setFilter('names', csv($event))" /></label>
          <div class="entry-field"><span class="field-heading">角色标签<linshe-switch :model-value="!!entry.characterFilter?.isExclude" size="sm" on-text="排除" off-text="排除" @update:model-value="setFilter('isExclude', $event)" /></span><linshe-input :model-value="(entry.characterFilter?.tags || []).join(', ')" size="sm" placeholder="逗号分隔，留空不限" aria-label="角色标签" @update:model-value="setFilter('tags', csv($event))" /></div>
          <label>生成类型<linshe-input :model-value="(entry.triggers || []).join(', ')" size="sm" placeholder="全部类型（默认）" @update:model-value="entry.triggers = csv($event)" /></label>
          <label>延迟到第几次递归<linshe-input v-model.number="entry.delayUntilRecursion" size="sm" type="number" min="0" placeholder="0" /></label>
        </div>
        <label v-if="entry.position === 7">Outlet 名称<linshe-input v-model="entry.outletName" size="sm" /></label>
        <details><summary>额外匹配来源</summary><div class="source-grid"><linshe-switch v-for="field in sourceFlags" :key="field.key" size="sm" :model-value="!!entry[field.key]" :on-text="field.label" :off-text="field.label" @update:model-value="entry[field.key] = $event" /></div></details>
          </div>
        </div>
      </div>
    </Transition>
  </article>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSelect from './ui/LinsheSelect.vue'
import LinsheSwitch from './ui/LinsheSwitch.vue'
const props = defineProps({ entry: { type: Object, required: true }, expanded: Boolean })
defineEmits(['toggle', 'duplicate', 'remove'])
// Edit the shared draft in place; collapsing and filtering must not normalize imported fields.
const entry = computed(() => props.entry)
const strategy = computed(() => entry.value.constant ? 'constant' : entry.value.vectorized ? 'vector' : 'keyword')
const strategies = [{ label: '● 常驻', value: 'constant' }, { label: '◉ 关键词', value: 'keyword' }, { label: '◇ 向量', value: 'vector' }]
const positions = [
  { label: '角色定义之前', value: 0 }, { label: '角色定义之后', value: 1 },
  { label: '作者注前 · 世界观前', value: 2 }, { label: '作者注后 · 世界观后', value: 3 },
  { label: '@D 聊天深度', value: 'depth:0' },
  { label: '示例之前 · 前组', value: 5 }, { label: '示例之后 · 后组', value: 6 }, { label: 'Outlet · 命名引用', value: 7 },
]
const placement = computed(() => entry.value.position === 4 ? 'depth:0' : entry.value.position)
function setPlacement(value) {
  if (String(value).startsWith('depth:')) { entry.value.position = 4 }
  else entry.value.position = value
}
function setStrategy(value) { entry.value.constant = value === 'constant'; entry.value.vectorized = value === 'vector' }
function setFilter(key, value) { entry.value.characterFilter = { ...entry.value.characterFilter, [key]: value } }
// Keep raw typing (including a trailing comma) while updating the shared draft.
const keywordText = ref({ key: '', keysecondary: '' })
watch(() => props.entry, value => {
  keywordText.value = { key: (value.key || []).join(', '), keysecondary: (value.keysecondary || []).join(', ') }
}, { immediate: true })
function updateKeywords(field, value) {
  keywordText.value[field] = value
  entry.value[field] = splitKeywords(value)
}
function splitKeywords(value) {
  const result = []
  let token = '', inRegex = false, escaped = false, inClass = false
  for (const char of String(value)) {
    if (inRegex) {
      token += char
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '[') inClass = true
      if (char === ']') inClass = false
      if (char === '/' && !inClass) inRegex = false
    } else if (char === ',' || char === '，') {
      if (token.trim()) result.push(token.trim())
      token = ''
    } else {
      if (char === '/' && !token.trim()) inRegex = true
      token += char
    }
  }
  if (token.trim()) result.push(token.trim())
  return result
}
const csv = value => String(value).split(',').map(x => x.trim()).filter(Boolean)
const nullableNumber = value => value === '' ? null : Number(value)
const logicOptions = ['与任意', '非全部', '非任意', '与全部'].map((label, value) => ({ label, value }))
const inheritOptions = [{ label: '使用全局', value: null }, { label: '开启', value: true }, { label: '关闭', value: false }]
const fields = pairs => pairs.map(([key, label]) => ({ key, label }))
const nullableFlags = fields([['caseSensitive', '区分大小写'], ['matchWholeWords', '完整单词'], ['useGroupScoring', '组评分']])
const sourceFlags = fields([['matchPersonaDescription', '用户设定'], ['matchCharacterDescription', '角色描述'], ['matchCharacterPersonality', '角色性格'], ['matchCharacterDepthPrompt', '角色备注'], ['matchScenario', '场景'], ['matchCreatorNotes', '作者备注']])
const timingFields = [{ key: 'sticky', label: '粘性', hint: '触发后持续生效的消息数，0 为关闭' }, { key: 'cooldown', label: '冷却', hint: '结束后等待的消息数，0 为关闭' }, { key: 'delay', label: '延迟', hint: '开聊后等待的消息数，0 为关闭' }]
</script>

<style scoped>
.book-row{border:1px solid var(--border);border-radius:var(--radius-md);min-width:0;background:var(--bg-primary)}
.book-row-head{display:grid;grid-template-columns:var(--book-row-columns);align-items:center;gap:6px;padding:7px}
.book-row-head>*{min-width:0}
.book-row.is-disabled .entry-title{opacity:.5}
.head-field>span{display:none}
.row-actions,.field-heading,.content-heading,.rule-switches{display:flex;align-items:center;gap:8px}
.row-actions{gap:4px}
.book-row-body{display:grid;gap:12px;padding:8px 12px 12px;border-top:1px solid var(--border)}
label:not(.ls-switch),.entry-field{display:grid;gap:5px;min-width:0;font-size:var(--fs-xs);color:var(--text-secondary)}
.keyword-grid{display:grid;grid-template-columns:minmax(0,1fr) 110px minmax(0,1fr);gap:10px;align-items:end}
.match-grid,.timing-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:end}
.timing-grid{grid-template-columns:minmax(0,2fr) repeat(4,minmax(0,1fr))}
.filter-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:end}
.field-heading{justify-content:space-between;min-height:24px}
.content-heading{justify-content:space-between;font-size:var(--fs-sm);color:var(--text-secondary);flex-wrap:wrap}
.content-heading small{font-size:var(--fs-xs);margin-left:12px}
.rule-switches{flex-wrap:wrap;gap:8px 16px}
summary{cursor:pointer;font-size:var(--fs-sm);color:var(--text-primary);font-weight:600;padding:8px 0}
details{border-top:1px solid var(--border)}
.source-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:8px 0}
.entry-chevron{display:block;flex:none;transform-origin:center;transition:transform .3s var(--ease-standard)}
.entry-chevron.is-expanded{transform:rotate(180deg)}
/* Animate the occupied space too, so the following rows move with the editor. */
.entry-collapse{display:grid;grid-template-rows:1fr;opacity:1}
.entry-collapse-clip{min-height:0;overflow:hidden}
.entry-collapse-enter-active,.entry-collapse-leave-active{transition:grid-template-rows .3s var(--ease-standard),opacity .3s var(--ease-standard)}
.entry-collapse-enter-from,.entry-collapse-leave-to{grid-template-rows:0fr;opacity:0}
@media(max-width:1050px){
  .book-row-head{grid-template-columns:28px 34px repeat(5,minmax(0,1fr)) 60px;gap:8px}
  .entry-title{grid-column:3 / 8}.row-actions{grid-column:8;grid-row:1}
  .head-field{grid-row:2}.head-field>span{display:block}
  .trigger-field{grid-column:1 / 4}.position-field{grid-column:4 / 6}.depth-field{grid-column:6}.order-field{grid-column:7}.probability-field{grid-column:8}
  .match-grid,.filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:600px){
  .book-row-head{grid-template-columns:28px 34px repeat(2,minmax(0,1fr)) 28px 28px;gap:8px}
  .entry-title{grid-column:3 / 5}.row-actions{grid-column:5 / 7}
  .trigger-field{grid-column:1 / 4}.position-field{grid-column:4 / 7}
  .depth-field{grid-row:3;grid-column:1 / 3}.order-field{grid-row:3;grid-column:3 / 5}.probability-field{grid-row:3;grid-column:5 / 7}
  .keyword-grid{grid-template-columns:minmax(0,1fr) 100px}.keyword-grid>.entry-field:last-child{grid-column:1 / -1}
  .timing-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.timing-grid>.entry-field:first-child{grid-column:span 2}
  .source-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .book-row-body{padding:10px;gap:12px}
}
</style>
