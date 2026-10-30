<template>
  <media-game-button
    size="sm"
    variant="ghost"
    :loading="loading"
    :disabled="disabled"
    :aria-pressed="!!post?.is_favorite"
    :title="post?.is_favorite ? '取消收藏' : wholeIssue ? '收藏整期报刊' : '收藏帖子'"
    @click.stop="emit('toggle', post)"
  >
    <svg width="14" height="16" viewBox="0 0 16 20" :fill="post?.is_favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M3 1h10a1 1 0 0 1 1 1v16l-6-4-6 4V2a1 1 0 0 1 1-1Z" />
    </svg>
    {{ post?.is_favorite ? '已收藏' : wholeIssue ? '收藏本期' : '收藏' }}
  </media-game-button>
</template>

<script setup>
import MediaGameButton from './MediaGameButton.vue'
defineProps({ post: Object, loading: Boolean, disabled: Boolean, wholeIssue: Boolean })
const emit = defineEmits(['toggle'])
</script>
