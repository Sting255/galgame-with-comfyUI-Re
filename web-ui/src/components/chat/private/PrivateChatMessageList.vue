<template>
<div
ref="msgList" class="message-list" @scroll="onScroll(); clearSpeechBubble()"
        @wheel.passive="interruptImageScroll" @touchstart.passive="interruptImageScroll"
        @pointerdown="interruptImageScroll" @keydown="onScrollKeydown"
>
        <!-- 加载指示器置于列表顶部 → 用户上滚到顶部时自动展开更早消息 -->
        <div v-if="chat.hasMoreOlder" class="load-older load-older-hint">↑ 向上滚动加载更多</div>

        <div ref="msgListInner" class="msg-list-inner">
          <template v-for="item in flatItems" :key="item.id">
            <!-- 时间分隔符 -->
            <PrivateChatMessage :item="item" />
          </template>
        </div>
      </div>
</template>

<script setup>

import { usePrivateChatContext } from '../../../composables/chat/privateChatContext.js'
import PrivateChatMessage from './PrivateChatMessage.vue'
const { onScroll, clearSpeechBubble, interruptImageScroll, onScrollKeydown, chat, flatItems, msgList, msgListInner } = usePrivateChatContext()
</script>

<style scoped>
.chat-header, .message-list, .guesses-row, .input-area { position: relative; }

.message-list {
  flex:1; overflow-y:auto; padding:16px 24px;
  background: transparent;
}

.msg-list-inner {
  display:flex; flex-direction:column; gap:4px;
}

.load-older { text-align:center; padding:8px 0; font-size:12px; color:var(--text-secondary); user-select:none; }
.load-older-hint { opacity:0.6; }
@media (max-width: 767px) {
  .message-list { padding: 5px 10px; }
}
</style>
