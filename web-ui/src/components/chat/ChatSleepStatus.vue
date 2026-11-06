<template>
  <div class="chat-sleep-status" role="status" aria-live="polite" aria-atomic="true" :title="details">
    <Transition name="sleep-status" mode="out-in">
      <span :key="label" class="sleep-status-text">{{ label }}</span>
    </Transition>
    <linshe-button v-if="error" variant="link" size="sm" aria-label="刷新睡眠状态" @click="$emit('retry')">重试</linshe-button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import LinsheButton from '../ui/LinsheButton.vue'
import { describeScheduleSleep, summarizeScheduleSleep } from '../../utils/scheduleSleep.js'

const props = defineProps({
  states: { type: Array, default: () => [] },
  group: Boolean,
  loaded: Boolean,
  error: { type: String, default: null },
})
defineEmits(['retry'])
const label = computed(() => props.error ? '睡眠状态待更新' : !props.loaded ? '睡眠状态加载中' : summarizeScheduleSleep(props.states, props.group))
const details = computed(() => props.error ? '暂时无法获取日程状态，请重试' : props.states.map(s => `${s?.display_name || '角色'}：${describeScheduleSleep(s)}`).join('；'))
</script>

<style scoped>
.chat-sleep-status { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 20px; color: var(--text-secondary); font-size: 11px; }
.sleep-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sleep-status-enter-active, .sleep-status-leave-active { transition: opacity 0.3s ease; }
.sleep-status-enter-from, .sleep-status-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .sleep-status-enter-active, .sleep-status-leave-active { transition: none; }
}
</style>
