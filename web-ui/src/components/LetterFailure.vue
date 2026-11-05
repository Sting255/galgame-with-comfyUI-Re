<template>
  <div class="letter-failure" role="status">
    <p>回信失败，已停止自动重试</p>
    <p class="letter-failure-hint">连续 {{ letter.retry_count || 5 }} 次尝试未完成。检查模型或生图服务后，可以重新投递，原信会保留。</p>
    <linshe-button variant="primary" size="sm" :loading="busy" :disabled="disabled" @click="$emit('retry', letter.id)">重新投递</linshe-button>
  </div>
</template>

<script setup>
import LinsheButton from './ui/LinsheButton.vue'
defineProps({ letter: { type: Object, required: true }, busy: Boolean, disabled: Boolean })
defineEmits(['retry'])
</script>

<style scoped>
.letter-failure { padding: 24px; color: #3a2a1a; }
.letter-failure-hint { color: #7a6a5a; line-height: 1.7; margin: 12px 0 16px; }
</style>
