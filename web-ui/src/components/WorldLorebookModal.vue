<template>
  <linshe-modal :model-value="modelValue" :title="`${worldName || '世界观'} · 世界书`" full panel-class="lorebook-modal" :transition-ms="300" @update:model-value="requestClose">
    <div v-if="loading" class="empty">正在读取世界书…</div>
    <div v-else class="lorebook">
      <div class="lorebook-toolbar lorebook-heading">
        <linshe-input v-model="name" class="lorebook-name-field" size="sm" aria-label="世界书名称" />
        <linshe-switch v-model="enabled" size="sm" on-text="启用" off-text="停用" />
        <linshe-button size="sm" @click="pickFile">导入</linshe-button>
        <linshe-button size="sm" :disabled="!entries.length" @click="exportBook">导出</linshe-button>
        <linshe-button size="sm" variant="ghost" @click="tab = tab === 'settings' ? 'entries' : 'settings'">{{ tab === 'settings' ? '← 返回条目' : '整本书设置' }}</linshe-button>
        <linshe-button size="sm" variant="ghost" @click="tab = tab === 'preview' ? 'entries' : 'preview'">{{ tab === 'preview' ? '← 返回条目' : '触发测试' }}</linshe-button>
      </div>
      <p v-if="error" class="lorebook-error" role="alert">{{ error }}</p>
      <ul v-if="warnings.length" class="lorebook-warnings"><li v-for="w in warnings" :key="w">{{ w }}</li></ul>
      <Transition name="lorebook-fade" mode="out-in">
        <section v-if="tab === 'entries'" key="entries" class="lorebook-entries">
          <div class="lorebook-toolbar lorebook-list-tools">
            <linshe-button size="sm" @click="addEntry">＋ 新增</linshe-button>
            <linshe-button size="sm" variant="ghost" @click="expandAll">全部展开</linshe-button>
            <linshe-button size="sm" variant="ghost" @click="expanded = []">全部收起</linshe-button>
            <linshe-input v-model="search" class="lorebook-search" size="sm" aria-label="搜索条目" placeholder="搜索…" />
            <linshe-select v-model="sort" class="lorebook-sort" size="sm" :options="sortOptions" aria-label="排序方式" />
            <span class="lorebook-count" aria-live="polite">{{ search ? `${filtered.length} / ${entries.length}` : entries.length }} 条</span>
          </div>
          <div class="lorebook-column-head" aria-hidden="true"><span></span><span></span><span>标题（备注）</span><span>触发策略</span><span>插入位置</span><span>深度</span><span>顺序</span><span>概率 %</span><span></span></div>
          <div class="lorebook-rows">
              <world-lorebook-entry-row v-for="entry in filtered" :key="entry.uid" :entry="entry" :expanded="expanded.includes(String(entry.uid))" @toggle="toggleEntry(entry.uid)" @duplicate="duplicateEntry(entry)" @remove="removeEntry(entry)" />
              <p v-if="!entries.length" class="lorebook-empty">导入世界书，或新增第一条设定。</p>
              <p v-else-if="!filtered.length" class="lorebook-empty">没有找到匹配的条目。</p>
          </div>
        </section>
            <section v-else-if="tab === 'settings'" key="settings" class="lorebook-settings">
              <div class="lorebook-toolbar"><label class="lorebook-name-field">世界书名称<linshe-input v-model="name" /></label><linshe-button size="sm" @click="pickFile">导入</linshe-button><linshe-button size="sm" :disabled="!entries.length" @click="exportBook">导出 JSON</linshe-button></div>
              <div class="lorebook-grid">
                <label>检查最近几条消息<linshe-input v-model.number="settings.scanDepth" type="number" min="0" max="1000" /></label>
                <label>世界书 token 上限<linshe-input v-model.number="settings.budgetCap" type="number" min="0" placeholder="8192" /></label>
              </div>
              <label>注入方式<linshe-select v-model="settings.positionPolicy" :options="[{label:'常驻前置 · 条件后置（推荐）',value:'cache'},{label:'按条目位置与深度',value:'anchors'}]" /></label>
              <p class="lorebook-note">常驻按角色、世界观边界注入；位置越过动态内容时提前到稳定区末尾。条件与动态宏条目后置。作者注对应世界观；示例前后对应 user 前的两组示例，常驻示例提前到历史之前。深度在高缓存模式下映射到稳定区或尾部；Outlet 仅被命名引用时生效。按条目位置模式使用实际边界，可能降低缓存复用。</p>
              <linshe-switch v-model="settings.recursive" size="sm" on-text="允许条目互相触发（递归）" off-text="允许条目互相触发（递归）" />
              <details v-for="group in settingGroups" :key="group.title">
                <summary>{{ group.title }}</summary>
                <div class="lorebook-fields">
                  <div class="lorebook-grid"><label v-for="field in group.numbers" :key="field.key">{{ field.label }}<linshe-input v-model.number="settings[field.key]" type="number" :min="field.min ?? 0" :max="field.max" :step="field.step ?? 1" :placeholder="field.placeholder" /></label></div>
                  <div class="lorebook-grid"><linshe-switch v-for="field in group.flags" :key="field.key" v-model="settings[field.key]" size="sm" :on-text="field.label" :off-text="field.label" /></div>
                </div>
              </details>
              <details>
                <summary>正文替换规则（正则）</summary>
                <label>JSON 数组：pattern / flags / replacement<linshe-input v-model="regexText" type="textarea" :rows="5" /></label>
              </details>
              <p class="lorebook-note">条目未单独设置时跟随这里的配置。预算按完整条目取舍；token 上限为 0 时不单独设限，仍受上下文额度限制。</p>
            </section>
            <section v-else key="preview" class="lorebook-preview">
              <label>输入一句话，看看哪些条目会生效<linshe-input v-model="previewText" type="textarea" :rows="3" placeholder="例如：我想召唤一位从者" /></label>
              <div class="lorebook-toolbar lorebook-preview-bar">
                <linshe-button :loading="previewing" @click="preview">检查触发</linshe-button>
                <span v-if="previewResult" class="lorebook-stats"><strong>{{ previewResult.activation.entries.length }} 条生效</strong><span>估算用量 {{ previewResult.activation.tokens }} / {{ previewResult.activation.budget }} tokens</span></span>
                <span v-else class="lorebook-note">不调用模型，不消耗额度</span>
              </div>
              <template v-if="previewResult">
                <div class="lorebook-table-wrap"><table><thead><tr><th>生效条目</th><th>触发方式</th><th>放置位置</th></tr></thead><tbody><tr v-for="row in activeTrace" :key="row.uid"><td>{{ row.title || row.uid }}</td><td>{{ reasonLabels[row.via] || row.via }}</td><td>{{ placementText(row.uid) }}</td></tr><tr v-if="!activeTrace.length"><td colspan="3">没有条目被触发，可以换一句话试试。</td></tr></tbody></table></div>
                <details>
                  <summary>查看未生效原因与位置说明</summary>
                  <ul v-if="previewResult.warnings.length" class="lorebook-warnings"><li v-for="w in previewResult.warnings" :key="w">{{ w }}</li></ul>
                  <div class="lorebook-table-wrap"><table><thead><tr><th>条目</th><th>原因</th></tr></thead><tbody><tr v-for="(row,i) in inactiveTrace" :key="i"><td>{{ row.title || row.uid }}</td><td>{{ reasonLabels[row.reason] || row.reason }}</td></tr></tbody></table></div>
                </details>
                <details><summary>查看最终提示词</summary><article v-for="(m,i) in previewResult.messages" :key="i"><strong>{{ i }} · {{ m.role }}</strong><pre>{{ m.content }}</pre></article></details>
              </template>
              <details>
                <summary>实测模型缓存</summary>
                <div class="lorebook-fields">
                  <p class="lorebook-note">使用已保存的世界书发送 4 次模型请求，会消耗少量额度，不写入聊天记录。请先保存修改。</p>
                  <linshe-button :loading="probing" :disabled="dirty || !revision || !enabled" @click="probeCache">开始实测（4 次请求）</linshe-button>
                  <div v-if="cacheResult" class="lorebook-table-wrap"><table><thead><tr><th>请求</th><th>输入 tokens</th><th>命中 tokens</th><th>命中率</th></tr></thead><tbody><tr v-for="row in cacheResult.rows" :key="row.name"><td>{{ row.name }}</td><td>{{ row.promptTokens ?? '不可用' }}</td><td>{{ row.cachedTokens ?? '不可用' }}</td><td>{{ row.cacheHitRate == null ? '不可用' : `${(row.cacheHitRate * 100).toFixed(1)}%` }}</td></tr></tbody></table></div>
                </div>
              </details>
            </section>
      </Transition>
    </div>
    <template #footer><span class="lorebook-note">{{ dirty ? '有未保存的修改' : revision ? '已保存' : '尚未创建世界书' }}</span><linshe-button @click="requestClose(false)">关闭</linshe-button><linshe-button variant="primary" :loading="saving" :disabled="loading || !dirty" @click="save">保存</linshe-button></template>
  </linshe-modal>
</template>

<script setup>
import { ref, computed, watch, inject } from 'vue'
import LinsheModal from './ui/LinsheModal.vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSelect from './ui/LinsheSelect.vue'
import LinsheSwitch from './ui/LinsheSwitch.vue'
import WorldLorebookEntryRow from './WorldLorebookEntryRow.vue'
import * as api from '../api/index.js'
const props = defineProps({ modelValue:Boolean, worldId:Number, worldName:String })
const emit = defineEmits(['update:modelValue','saved'])
const confirm = inject('confirm')
const loading=ref(false), saving=ref(false), error=ref(''), warnings=ref([]), name=ref(''), enabled=ref(true), documentData=ref({entries:{}}), settings=ref({}), revision=ref(0), baseline=ref(''), regexText=ref('[]')
const expanded=ref([]), search=ref(''), sort=ref('order'), tab=ref('entries'), previewText=ref(''), previewResult=ref(null), previewing=ref(false)
const probing=ref(false),cacheResult=ref(null)
const previewTrace=computed(()=>[...(previewResult.value?.activation.trace||[])].sort((a,b)=>Number(b.reason==='activated')-Number(a.reason==='activated')))
const activeTrace=computed(()=>previewTrace.value.filter(row=>row.reason==='activated'))
const inactiveTrace=computed(()=>previewTrace.value.filter(row=>row.reason!=='activated'))
const snapshot = () => JSON.stringify([name.value,enabled.value,documentData.value,settings.value,regexText.value])
const dirty=computed(()=>snapshot()!==baseline.value)
const entries=computed(()=>Object.values(documentData.value.entries || {}))
const filtered=computed(()=>entries.value.filter(e=>`${e.comment} ${(e.key||[]).join(' ')} ${e.content}`.toLowerCase().includes(search.value.toLowerCase())).sort((a,b)=>sort.value==='order' ? Number(!!b.constant)-Number(!!a.constant) || b.order-a.order : sort.value==='position' ? a.position-b.position || b.order-a.order : String(a.comment).localeCompare(String(b.comment))))
const sortOptions=[{label:'优先级',value:'order'},{label:'插入位置',value:'position'},{label:'标题',value:'title'}]
const fields = pairs => pairs.map(([key,label])=>({key,label}))
const settingGroups=[
  {title:'匹配方式',numbers:[],flags:fields([['includeNames','同时检查发言者名称'],['caseSensitive','区分大小写'],['matchWholeWords','只匹配完整单词'],['useGroupScoring','同组优先选关键词命中更多的条目']])},
  {title:'扫描范围与递归上限',numbers:fields([['minActivations','尽量触发至少几条'],['minDepthMax','最多追溯几条消息'],['maxRecursionSteps','最多扫描几次']]),flags:[]},
  {title:'上下文与预算',numbers:[{key:'budgetPercent',label:'世界书最多占上下文（%）',max:100},{key:'contextTokens',label:'模型上下文额度（tokens）'}],flags:[]},
  {title:'向量匹配',numbers:[{key:'vectorQueryMessages',label:'向量查询最近几条消息（独立于关键词扫描）',min:1,max:1000,placeholder:'2'},{key:'vectorMaxEntries',label:'最多匹配几条',placeholder:'5'},{key:'vectorThreshold',label:'最低相似度',step:0.05,max:1,min:-1,placeholder:'0.3'}],flags:fields([['vectorAll','所有条目都参与向量匹配']])},
]
const reasonLabels={activated:'已激活',constant:'常驻',keyword:'关键词',vector:'向量',external:'外部激活',sticky:'持续生效',disabled:'已停用','no-key-match':'关键词未命中',secondary:'辅助词不满足',probability:'概率未通过',budget:'预算不足',group:'分组落选',cooldown:'冷却中',delay:'尚未到激活时间',trigger:'生成类型不符','character-filter':'角色筛选不符'}
function toggleEntry(uid){const key=String(uid);expanded.value=expanded.value.includes(key)?expanded.value.filter(id=>id!==key):[...expanded.value,key]}
function expandAll(){expanded.value=[...new Set([...expanded.value,...filtered.value.map(e=>String(e.uid))])]}
function revealEntry(uid){search.value='';expanded.value=[...new Set([...expanded.value,String(uid)])];tab.value='entries'}
let loadSequence=0
watch(()=>[props.modelValue,props.worldId],async([open,id])=>{
  if(!open||!id)return
  const sequence=++loadSequence;loading.value=true;error.value='';warnings.value=[];tab.value='entries';expanded.value=[];search.value=''
  try{const {book}=await api.getWorldLorebook(id);if(sequence!==loadSequence)return
    name.value=book?.name||`${props.worldName}世界书`;enabled.value=book?.enabled??true;documentData.value=book?.document||{entries:{}};revision.value=book?.revision||0
    settings.value=book?.settings||{scanDepth:2,vectorQueryMessages:2,recursive:false,maxRecursionSteps:32,minActivations:0,minDepthMax:100,budgetPercent:25,budgetCap:8192,contextTokens:32768,includeNames:true,vectorMaxEntries:5,vectorThreshold:0.3,positionPolicy:'cache'}
    regexText.value=JSON.stringify(settings.value.regexRules||[],null,2);baseline.value=snapshot();previewResult.value=null;cacheResult.value=null
  }catch(e){error.value=e.message}finally{if(sequence===loadSequence)loading.value=false}
},{immediate:true})
async function requestClose(open){if(!open&&dirty.value&&!(await confirm({title:'尚未保存',message:'放弃世界书的未保存修改？',okText:'放弃修改',danger:true})))return;emit('update:modelValue',open)}
function addEntry(){const uid=Math.max(-1,...entries.value.map(e=>Number(e.uid)||0))+1;documentData.value.entries[uid]={uid,comment:'新条目',key:[],keysecondary:[],content:'',constant:false,vectorized:false,selective:true,selectiveLogic:0,position:1,role:0,depth:4,order:100,probability:100,useProbability:true};revealEntry(uid);return uid}
function duplicateEntry(source){const entry=JSON.parse(JSON.stringify(source));const uid=addEntry();documentData.value.entries[uid]={...entry,uid,comment:`${entry.comment}（副本）`};revealEntry(uid)}
async function removeEntry(entry){const uid=String(entry.uid);if(!await confirm({title:'删除条目',message:`删除「${entry.comment}」？保存后生效。`,okText:'删除',danger:true}))return;delete documentData.value.entries[uid];expanded.value=expanded.value.filter(id=>id!==uid)}
async function pickFile(){
  const picker=window.document.createElement('input');picker.type='file';picker.accept='.json,application/json'
  picker.onchange=async()=>{try{const file=picker.files?.[0];if(!file)return;const parsed=JSON.parse(await file.text());const source=parsed.character_book||parsed;if(!source.entries)throw new Error('文件缺少 entries')
    if(entries.value.length&&!await confirm({title:'替换世界书',message:'导入将替换当前草稿中的条目，保存后生效。',okText:'导入'}))return
    // Normalization and validation use the same backend as save, without committing.
    const preview=await api.previewWorldLorebook(props.worldId,{document:source,text:''})
    documentData.value=preview.document
    name.value=file.name.replace(/\.json$/i,'');expanded.value=[];search.value='';tab.value='entries';warnings.value=['已读入草稿，保存后才会生效。'];error.value=''
  }catch(e){error.value=e.message}};picker.click()
}
function parsedSettings(){const rules=JSON.parse(regexText.value);if(!Array.isArray(rules))throw new Error('正文正则必须是 JSON 数组');return {...settings.value,regexRules:rules}}
async function save(){saving.value=true;error.value='';try{const result=await api.saveWorldLorebook(props.worldId,{name:name.value,enabled:enabled.value,document:documentData.value,settings:parsedSettings(),expectedRevision:revision.value});documentData.value=result.book.document;settings.value=result.book.settings;revision.value=result.book.revision;warnings.value=result.warnings;baseline.value=snapshot();emit('saved')}catch(e){error.value=e.message}finally{saving.value=false}}
function exportBook(){const url=URL.createObjectURL(new Blob([JSON.stringify(documentData.value,null,2)],{type:'application/json'}));const link=window.document.createElement('a');link.href=url;link.download=`${name.value||'世界书'}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
async function preview(){previewing.value=true;error.value='';try{previewResult.value=await api.previewWorldLorebook(props.worldId,{document:documentData.value,settings:parsedSettings(),text:previewText.value})}catch(e){error.value=e.message}finally{previewing.value=false}}
async function probeCache(){probing.value=true;error.value='';try{cacheResult.value=await api.probeWorldLorebookCache(props.worldId)}catch(e){error.value=e.message}finally{probing.value=false}}
function placementText(uid){const p=previewResult.value?.placements.find(p=>String(p.uid)===String(uid));return p?`${p.cacheTier==='stable'?'稳定常驻 · ':p.cacheTier==='dynamic'?'动态条目 · ':''}${p.requested}${p.depth!=null?` ${p.depth}`:''} → ${p.used===false?'未引用':`${p.actualAnchor||''} · ${p.role||''} ${p.index??p.outlet??''}${p.mode==='inline'?' · 原层内':p.mode==='slot'?' · 新增槽位':''}`}${p.mapped?'（适配）':''}`:'—'}
</script>

<style scoped>
.lorebook,.lorebook-fields,.lorebook-settings,.lorebook-preview{display:grid;gap:14px;min-width:0;color:var(--text-primary)}
.lorebook-note,.lorebook-label-hint,.lorebook-count{font-size:var(--fs-sm);color:var(--text-secondary);line-height:1.6;font-weight:400;margin:0}
.lorebook-toolbar,.lorebook-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.lorebook-heading{padding-bottom:12px;border-bottom:1px solid var(--border)}
.lorebook-count{margin-left:8px;font-variant-numeric:tabular-nums}
.lorebook label:not(.ls-switch){display:grid;gap:8px;font-size:var(--fs-sm);line-height:1.5}
.lorebook-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.lorebook details{border-top:1px solid var(--border);padding-top:14px;min-width:0}
.lorebook summary{cursor:pointer;font-size:var(--fs-sm);font-weight:600;line-height:1.6}
.lorebook details[open]>summary{margin-bottom:16px}
.lorebook details>label,.lorebook details>.lorebook-grid{margin-bottom:12px}
.lorebook-settings,.lorebook-preview{max-width:880px;width:100%;margin-inline:auto}
.lorebook-name-field{flex:1;min-width:180px}
.lorebook-stats{display:flex;align-items:baseline;gap:8px 20px;flex-wrap:wrap;font-size:var(--fs-sm);color:var(--text-secondary);line-height:1.6}
.lorebook-stats strong{color:var(--text-primary);font-weight:600}
.lorebook-preview-bar{padding-bottom:14px;border-bottom:1px solid var(--border)}
.lorebook-empty{font-size:var(--fs-sm);color:var(--text-secondary);line-height:1.7;margin:0;padding:24px 12px;text-align:center}
.lorebook-error{color:var(--danger);font-size:var(--fs-sm);line-height:1.6;margin:0}
.lorebook-warnings{font-size:var(--fs-sm);line-height:1.7;color:var(--text-secondary);margin:0;padding-left:20px}
.lorebook-table-wrap{overflow:auto;min-width:0}
.lorebook table{border-collapse:collapse;width:100%;font-size:var(--fs-sm)}
.lorebook td,.lorebook th{padding:10px;text-align:left;border-bottom:1px solid var(--border);line-height:1.6}
.lorebook pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--fs-sm);line-height:1.6}
.lorebook-fade-enter-active,.lorebook-fade-leave-active{transition:opacity .3s}
.lorebook-fade-enter-from,.lorebook-fade-leave-to{opacity:0}
:global(.lorebook-modal){--modal-full-width:1440px}
.lorebook{--book-row-columns:28px 34px minmax(160px,1fr) 108px 174px 60px 64px 64px 60px}
.lorebook-entries,.lorebook-rows{display:grid;gap:6px;min-width:0}
.lorebook-list-tools{gap:8px;margin-bottom:6px}
.lorebook-search{flex:1;min-width:130px}
.lorebook-sort{width:132px}
.lorebook-column-head{display:grid;grid-template-columns:var(--book-row-columns);gap:6px;padding:0 8px 4px;color:var(--text-secondary);font-size:var(--fs-xs);text-align:center}
.lorebook-count{font-variant-numeric:tabular-nums;white-space:nowrap}
@media(max-width:1050px){.lorebook-column-head{display:none}}
@media(max-width:767px){.lorebook-grid{grid-template-columns:1fr}.lorebook-toolbar{gap:8px}.lorebook-heading>.lorebook-name-field{flex-basis:calc(100% - 90px)}.lorebook-stats{gap:4px 12px}.lorebook-search{flex-basis:60%}.lorebook-sort{flex:1}}
</style>
