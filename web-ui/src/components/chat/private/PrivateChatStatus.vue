<template>
<Transition name="guesses-fade">
        <div v-if="chat.memoryRecalling" class="recall-status" role="status">
          <svg class="recall-status-spinner cel-spin" viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="8" stroke="var(--accent)" stroke-opacity="0.25" stroke-width="2.5" />
            <path d="M18 10a8 8 0 0 0-8-8" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" />
          </svg>
          <span>回想着过去的记忆…</span>
        </div>
      </Transition>

<Transition name="guesses-fade">
        <div v-if="chat.rerolling" class="recall-status reroll-status" role="status">
          <svg class="recall-status-spinner cel-spin" viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="8" stroke="var(--accent)" stroke-opacity="0.25" stroke-width="2.5" />
            <path d="M18 10a8 8 0 0 0-8-8" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" />
          </svg>
          <span>重新组织语言中…</span>
        </div>
      </Transition>

<Transition name="guesses-fade">
        <div v-if="chat.guesses" class="guesses-row">
          <span class="guess-prefix">🔮</span>
          <div
            v-for="(text, key) in (chat.guesses || {})"
            :key="key"
            role="button"
            tabindex="0"
            class="guess-pill"
            @keydown.enter.prevent="pickGuess(text)"
            @keydown.space.prevent="pickGuess(text)"
            @click="pickGuess(text)"
          >
{{ text }}
</div>
        </div>
      </Transition>
</template>

<script setup>

import { usePrivateChatContext } from '../../../composables/chat/privateChatContext.js'
const { chat, pickGuess } = usePrivateChatContext()
</script>

<style scoped>
.chat-header, .message-list, .guesses-row, .input-area { position: relative; }
.recall-status {
  display: flex; align-items: center; gap: 7px;
  margin: 0 24px 6px;
  padding: 6px 12px;
  width: fit-content;
  font-size: 12.5px;
  color: var(--text-secondary);
  background: var(--glass-bg);
  border: 1.5px solid var(--glass-border);
  border-radius: var(--radius-full);
  backdrop-filter: blur(8px);
}
.recall-status-spinner { flex-shrink: 0; }
.guesses-row {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 24px 8px;
  flex-wrap: wrap;
}
.guess-prefix {
  font-size: 13px;
  flex-shrink: 0;
}
.guess-pill {
  padding: 6px 14px;
  font-size: 13px; line-height: 1.4;
  border-radius: 18px;
  border: 1.5px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--text-primary);
  cursor: pointer;
  white-space: normal; word-break: break-word;
  transition: all 0.15s ease;
  flex-shrink: 0;
  user-select: none;
}
.guess-pill:hover {
  border-color: var(--accent-light);
  background: rgba(var(--accent-rgb), 0.08);
  transform: translateY(-1px);
  box-shadow: 0 2px 10px rgba(var(--accent-rgb), 0.12);
}
.guess-pill:active {
  transform: scale(0.96);
}
@media (max-width: 767px) {
  .guesses-row { padding: 2px 10px 6px; gap: 4px; flex-wrap: nowrap; }
  .guess-prefix { display: none; }
  .guess-pill { padding: 4px 10px; font-size: 12px; max-width: 50%; min-width: 60px; flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
}
</style>
