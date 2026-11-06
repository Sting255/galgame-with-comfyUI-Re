<!--
  运行状态面板（2026-11-06）

  动机：真机日志里，报纸 / 日程 / 朋友圈 / 事件 / 群聊在 9 分钟内连续失败几十次，
  界面上毫无提示；同时还有「输出额度填成 340000」「ComfyUI 路径没推导出来」「低优生图等满上限」
  三件事，全都只活在日志里。用户不把两万行日志发给别人看就不会知道。

  这里只回答一个问题：**现在哪儿坏了**。
  - LLM / ComfyUI：启动后 60 秒自检的结论
  - 生图队列：进行中几张、低优排队几张、队首等了多久
  - 失败汇总：最近 60 分钟按模块计数，展开能看最后一条原文
-->
<template>
  <div class="card runtime-health">
    <div class="rh-head">
      <h3>运行状态</h3>
      <linshe-button variant="ghost" size="sm" :loading="loading" @click="refresh">刷新</linshe-button>
    </div>
    <p class="fd">最近 {{ windowMinutes }} 分钟的失败与生图队列。这里没有红字，说明后台真在正常跑。</p>

    <div class="rh-chips">
      <div class="rh-chip" :class="stateClass(llmState)">
        <span class="rh-dot" aria-hidden="true"></span>
        LLM · {{ llmText }}
      </div>
      <div class="rh-chip" :class="stateClass(comfyState)">
        <span class="rh-dot" aria-hidden="true"></span>
        ComfyUI · {{ comfyText }}
      </div>
      <div class="rh-chip" :class="queueWarn ? 'is-warn' : 'is-ok'">
        <span class="rh-dot" aria-hidden="true"></span>
        生图队列 · {{ queueText }}
      </div>
    </div>

    <div v-if="errors.length || warnings.length" class="rh-list">
      <div v-for="item in errors" :key="`e-${item.module}`" class="rh-row is-error">
        <span class="rh-module">{{ item.module }}</span>
        <span class="rh-count">{{ item.count }} 次</span>
        <span class="rh-msg" :title="item.lastMessage">{{ item.lastMessage }}</span>
      </div>
      <div v-for="item in warnings" :key="`w-${item.module}`" class="rh-row is-warn">
        <span class="rh-module">{{ item.module }}</span>
        <span class="rh-count">{{ item.count }} 次</span>
        <span class="rh-msg" :title="item.lastMessage">{{ item.lastMessage }}</span>
      </div>
    </div>
    <p v-else-if="loaded" class="rh-ok">最近 {{ windowMinutes }} 分钟没有失败</p>
    <p v-else class="rh-ok">读取中…</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import LinsheButton from '../ui/LinsheButton.vue'
import { getRuntimeHealth } from '../../api/index.js'

const REFRESH_MS = 30_000

const loading = ref(false)
const loaded = ref(false)
const windowMinutes = ref(60)
const errors = ref([])
const warnings = ref([])
const selfCheck = ref({})
const imageQueue = ref(null)
let timer = null

const llmState = computed(() => {
  const c = selfCheck.value?.llm
  if (!c) return 'unknown'
  return c.ok ? 'ok' : 'error'
})
const comfyState = computed(() => {
  const c = selfCheck.value?.comfy
  if (!c) return 'unknown'
  return c.ok ? 'ok' : 'error'
})

const llmText = computed(() => {
  const c = selfCheck.value?.llm
  if (!c) return '未检测'
  if (c.ok) return `正常${c.ms != null ? ` · ${c.ms}ms` : ''}`
  return truncate(c.error) || '失败'
})
const comfyText = computed(() => {
  const c = selfCheck.value?.comfy
  if (!c) return '未检测'
  if (c.ok) return '已连接'
  return truncate(c.error) || '连不上'
})

const queueText = computed(() => {
  const q = imageQueue.value
  if (!q) return '未知'
  const parts = [`进行中 ${q.active || 0}`]
  if (q.low) {
    const waited = Math.round((q.headWaitedMs || 0) / 1000)
    parts.push(`低优排队 ${q.low} 张${waited > 0 ? `（队首等 ${waited}s）` : ''}`)
  }
  return parts.join(' · ')
})
/** 低优有排队就算需要留意：用户在玩时它最多等 LOW_QUEUE_MAX_WAIT 才会被放行 */
const queueWarn = computed(() => Number(imageQueue.value?.low || 0) > 0)

function truncate(text, max = 80) {
  const s = String(text || '').trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function stateClass(state) {
  if (state === 'ok') return 'is-ok'
  if (state === 'error') return 'is-error'
  return 'is-unknown'
}

async function refresh() {
  if (loading.value) return
  loading.value = true
  try {
    const data = await getRuntimeHealth()
    windowMinutes.value = Number(data?.windowMinutes) || 60
    errors.value = Array.isArray(data?.errors) ? data.errors : []
    warnings.value = Array.isArray(data?.warnings) ? data.warnings : []
    selfCheck.value = data?.selfCheck || {}
    imageQueue.value = data?.imageQueue || null
    loaded.value = true
  } catch {
    // 读失败不打扰用户：面板本来就是旁路信息
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  refresh()
  timer = setInterval(refresh, REFRESH_MS)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  timer = null
})
</script>

<style scoped>
.rh-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.rh-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.rh-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 999px;
  border: 1px solid var(--glass-border); background: var(--bg-primary);
  font-size: 12px; color: var(--text-secondary); max-width: 100%;
}
.rh-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-secondary); flex-shrink: 0; }
.rh-chip.is-ok .rh-dot { background: #52c41a; }
.rh-chip.is-warn .rh-dot { background: var(--warning, #faad14); }
.rh-chip.is-error .rh-dot { background: var(--danger, #ff4d4f); }
.rh-chip.is-ok { color: var(--text-primary); }
.rh-chip.is-error { color: var(--danger, #ff4d4f); border-color: var(--danger, #ff4d4f); }
.rh-list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.rh-row {
  display: grid; grid-template-columns: minmax(84px, auto) 56px 1fr;
  gap: 8px; align-items: baseline;
  padding: 6px 10px; border-radius: 10px; background: var(--bg-primary);
  font-size: 12px;
}
.rh-row.is-error .rh-module { color: var(--danger, #ff4d4f); }
.rh-row.is-warn .rh-module { color: var(--warning, #faad14); }
.rh-module { font-weight: 600; }
.rh-count { color: var(--text-secondary); }
.rh-msg { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rh-ok { margin: 12px 0 0; font-size: 12px; color: var(--text-secondary); }
</style>
