<template>
  <!-- 睡眠条（2026-11-06 用户要求搬到顶部）：她睡着时在聊天页标题下方常驻一条细进度，
       被推进/触摸时往下掉、停手慢慢沉回去。点一下直接开亲密面板，条本身只负责"看得见"。 -->
  <div
    v-if="state.sleeping"
    class="chat-sleep-bar"
    :class="'is-' + tierKey"
    role="button"
    tabindex="0"
    :title="hint"
    :aria-label="`睡眠 ${state.sleepBar}/100 · ${tierLabel}，点按打开亲密面板`"
    @click="$emit('open')"
    @keydown.enter.prevent="$emit('open')"
    @keydown.space.prevent="$emit('open')"
  >
    <span class="csb-text">睡眠 {{ state.sleepBar }}/100 · {{ tierLabel }}</span>
    <span class="csb-track"><span class="csb-fill" :style="{ width: percent + '%' }"></span></span>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onEvent, offEvent } from '../../stores/unifiedStream.js'
import { fetchIntimateActionState } from '../../api/index.js'
import { normalizeIntimateState } from '../intimateActionLogic.js'

const props = defineProps({
  characterId: { type: [Number, String], default: 0 },
})
defineEmits(['open'])

const snapshot = ref(null)
const state = computed(() => normalizeIntimateState(snapshot.value?.state || {}))
const percent = computed(() => Math.max(0, Math.min(100, Number(state.value.sleepBar ?? 100))))

// 档位与后端 SLEEP_WAKE_THRESHOLD=30 对齐（与亲密面板内原来的文案一致）
const tierKey = computed(() => {
  if (state.value.forcedSleep) return 'locked'
  const bar = Number(state.value.sleepBar ?? 100)
  if (bar <= 0) return 'awake'
  if (bar <= 30) return 'waking'
  return 'deep'
})
const tierLabel = computed(() => ({ locked: '催眠锁死', awake: '已经醒了', waking: '将醒', deep: '深睡' })[tierKey.value] || '')
const hint = computed(() => tierKey.value === 'locked'
  ? '睡眠条被催眠锁在 1 点，怎么弄都醒不过来'
  : '推进与触摸会把这条拽下去，停手会慢慢沉回去；点一下打开亲密面板')

let lastFetch = 0
let pending = null
async function refresh() {
  const id = Number(props.characterId)
  if (!id) { snapshot.value = null; return }
  const now = Date.now()
  if (now - lastFetch < 500) {
    if (pending) return
    pending = setTimeout(() => { pending = null; refresh() }, 500)
    return
  }
  lastFetch = now
  try {
    const data = await fetchIntimateActionState(id, { scene: 'chat' })
    snapshot.value = data || null
  } catch {
    // 亲密功能关闭 / 端点不可用时静默隐藏，不打扰聊天
    snapshot.value = null
  }
}

function onStimulus(payload) {
  const cid = Number(payload?.character_id ?? payload?.characterId)
  if (!cid || cid !== Number(props.characterId)) return
  refresh()
}

onMounted(() => { refresh(); onEvent('intimate_stimulus', onStimulus) })
onBeforeUnmount(() => {
  offEvent('intimate_stimulus', onStimulus)
  if (pending) { clearTimeout(pending); pending = null }
})
watch(() => props.characterId, () => { snapshot.value = null; refresh() })
</script>

<style scoped>
.chat-sleep-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 2px;
  padding: 2px 0;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 16px;
  -webkit-tap-highlight-color: transparent;
}
.csb-text { flex: 0 0 auto; white-space: nowrap; }
.csb-track {
  flex: 1 1 auto;
  min-width: 40px;
  max-width: 140px;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--bg-sunken);
  overflow: hidden;
}
.csb-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent-2);
  transition: width var(--dur-slow, 0.3s) ease;
}
.chat-sleep-bar.is-waking .csb-fill { background: var(--accent); }
.chat-sleep-bar.is-awake .csb-fill { background: var(--accent-3); }
.chat-sleep-bar.is-locked .csb-fill { background: var(--accent-hover); }
.chat-sleep-bar:hover .csb-text { color: var(--text-bright); }
.chat-sleep-bar:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--radius-sm); }
@media (prefers-reduced-motion: reduce) {
  .csb-fill { transition: none; }
}
</style>
