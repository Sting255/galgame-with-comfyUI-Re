<template>
  <div class="chat-action-toolbar" role="group" aria-label="聊天互动">
    <div class="chat-action-items">
      <linshe-button touch-target variant="icon" tone="accent" size="lg" :active="touchOpen" :aria-expanded="touchOpen" :title="pendingHint || '动作'" aria-label="动作" @click="$emit('toggle', 'touch')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></svg>
        <span v-if="pendingCount" class="action-count">{{ pendingCount }}</span>
      </linshe-button>
      <linshe-button touch-target v-if="toysEnabled" variant="icon" tone="accent" size="lg" :active="toyOpen" :aria-expanded="toyOpen" :title="toyCount ? `玩具（已佩戴 ${toyCount} 件）` : '玩具'" aria-label="玩具" @click="$emit('toggle', 'toy')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="6" r="3" /><path d="M5 21a7 7 0 0 1 14 0M8 14h8" /></svg>
        <span v-if="toyCount" class="action-count">{{ toyCount }}</span>
      </linshe-button>
      <linshe-button touch-target variant="icon" tone="accent" size="lg" :active="intimateOpen" :aria-expanded="intimateOpen" :title="intimateOpen ? '收起亲密面板' : '亲密'" aria-label="亲密" @click="$emit('toggle', 'intimate')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z" /></svg>
      </linshe-button>
    </div>
    <linshe-button touch-target v-if="group" variant="ghost" size="sm" aria-label="选择互动对象" :title="targetName || '选择互动对象'" @click="$emit('pick-target')">
      <span class="action-target">{{ targetName || '选择对象' }}</span><span aria-hidden="true">⌄</span>
    </linshe-button>
  </div>
</template>

<script setup>
import LinsheButton from '../ui/LinsheButton.vue'
defineProps({ touchOpen: Boolean, toyOpen: Boolean, intimateOpen: Boolean,
  toysEnabled: { type: Boolean, default: true }, pendingCount: { type: Number, default: 0 },
  toyCount: { type: Number, default: 0 }, pendingHint: { type: String, default: '' },
  group: Boolean, targetName: { type: String, default: '' } })
defineEmits(['toggle', 'pick-target'])
</script>

<style scoped>
.chat-action-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; padding: 0; flex: 0 0 auto; min-width: 0; }
.chat-action-items { display: flex; align-items: center; gap: 6px; min-width: 0; }
.action-count { position: absolute; top: -3px; right: -3px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: var(--radius-full); background: var(--btn-primary-bg); color: var(--btn-primary-fg); font-size: 10px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.action-target { display: block; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 767px) {
  .chat-action-toolbar { gap: 4px; flex-wrap: nowrap; }
  .chat-action-items { gap: 4px; }
  .action-target { max-width: 44px; }
}

</style>
