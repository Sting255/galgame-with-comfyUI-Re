<template>
<ChatRetryNotice />

<div class="input-area">
        <div class="force-img-wrap">
          <div
            role="button"
            tabindex="0"
            class="force-img-toggle"
            :class="{
              active: imageGenMode === 'force',
              off: imageGenMode === 'off',
              'is-disabled': settings.isSaving('imageGenMode'),
            }"
            :aria-disabled="settings.isSaving('imageGenMode')"
            :title="imageGenModeLabel"
            @keydown.enter.prevent="cycleImageGenMode"
            @keydown.space.prevent="cycleImageGenMode"
            @click="cycleImageGenMode"
          >
            <span class="force-img-icon">{{ imageGenModeIcon }}</span>
          </div>
          <span v-if="forceTipVisible" class="force-img-tip" :class="{ 'is-mobile': isMobile }">{{ imageGenModeLabel }}</span>
        </div>
        <textarea
ref="inputEl" v-model="inputText" class="chat-input"
          placeholder="输入消息..." rows="1"
          @keydown.enter.exact.prevent="send"
          @keydown.enter.shift.exact="inputText += '\n'"
          @focus="inputFocused = true"
          @blur="inputFocused = false"
        ></textarea>
        <div v-if="isCharSleeping" role="button" tabindex="0" class="gift-btn wake-btn" :class="{ 'wake-shaking': wakeShaking }" @keydown.enter.prevent="onWakeChar" @keydown.space.prevent="onWakeChar" @click="onWakeChar" title="叫醒角色">
          <svg class="gift-btn-icon" viewBox="0 0 24 24" width="20" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
        </div>
        <div v-else v-show="!(isMobile && inputFocused)" role="button" tabindex="0" class="gift-btn" @keydown.enter.prevent="showGiftPanel = true" @keydown.space.prevent="showGiftPanel = true" @click="showGiftPanel = true" title="送礼物">
          <svg class="gift-btn-icon" viewBox="0 0 1138 1024" width="20" height="18" fill="#fff"><path d="M57.242236 626.030169l397.969831 0 0 397.969831-397.969831 0 0-397.969831zM683.272405 626.030169l397.969831 0 0 397.969831-397.969831 0 0-397.969831zM0 284.393966l455.212067 0 0 284.393966-455.212067 0 0-284.393966zM1137.575865 284.393966l0 284.393966-454.303461 0 0-284.393966 454.303461 0zM512.454303 284.393966l113.575865 0 0 739.606034-113.575865 0 0-739.606034zM683.272405 228.060337l-228.060337 0 0-170.818101 228.060337 0 0 170.818101zM1024 228.060337l-284.393966 0 111.758651-228.060337 172.635315 0 0 228.060337zM398.878438 228.060337l-284.393966 0 0-228.060337 169.909494 0z" /></svg>
        </div>
      <ChatActionToolbar
        :touch-open="showTouchPanel" :toy-open="showToyPanel" :intimate-open="showIntimatePanel"
        :toys-enabled="toysEnabled" :pending-count="touchPendingCount" :pending-hint="touchPendingHint"
        :toy-count="wornToys.length" @toggle="togglePanel"
      />
        <!-- 撤回气泡：长按发送按钮浮现 -->
        <Transition name="undo-bubble">
          <div v-if="showUndoBubble" role="button" tabindex="0" class="undo-bubble-btn" @keydown.enter.prevent="undoLastRound" @keydown.space.prevent="undoLastRound" @click.stop="undoLastRound">
            ↩ 撤回上一轮对话
          </div>
        </Transition>
        <div
role="button" tabindex="0" class="send-btn" :class="{ 'is-disabled': sendDisabled }" :aria-disabled="sendDisabled"
          @keydown.enter.prevent="onSendClick"
          @keydown.space.prevent="onSendClick"
          @click="onSendClick"
          :title="chat.streaming ? '发送中...' : (showUndoBubble ? '' : '发送（长按可撤回）')"
          @mousedown="onSendPressStart"
          @mouseup="onSendPressEnd"
          @mouseleave="onSendPressEnd"
          @touchstart="onSendPressStart"
          @touchend="onSendPressEnd"
          @touchcancel="onSendPressEnd"
        >
          <svg v-if="!chat.streaming" class="send-icon" viewBox="0 0 1024 1024" fill="#fff">
            <path d="M659.655431 521.588015q23.970037-6.71161 46.022472-13.423221 19.17603-5.752809 39.310861-11.505618t33.558052-10.546816l-13.423221 50.816479q-5.752809 21.093633-10.546816 31.640449-9.588015 25.88764-22.531835 47.940075t-24.449438 38.35206q-13.423221 19.17603-27.805243 35.475655l-117.932584 35.475655 96.838951 17.258427q-19.17603 16.299625-41.228464 33.558052-19.17603 14.382022-43.625468 30.202247t-51.29588 29.243446-59.925094 13.902622-62.801498-4.314607q-34.516854-4.794007-69.033708-16.299625 10.546816-16.299625 23.011236-36.434457 10.546816-17.258427 25.40824-40.749064t31.161049-52.254682q46.022472-77.662921 89.168539-152.449438t77.662921-135.191011q39.310861-69.992509 75.745318-132.314607-45.06367 51.775281-94.921348 116.014981-43.146067 54.651685-95.88015 129.917603t-107.385768 164.434457q-11.505618 18.217228-25.88764 42.187266t-30.202247 50.816479-32.599251 55.131086-33.078652 55.131086q-38.35206 62.322097-78.621723 130.397004 0.958801-20.134831 7.670412-51.775281 5.752809-26.846442 19.17603-67.116105t38.35206-94.921348q16.299625-34.516854 24.928839-53.692884t13.423221-29.722846q4.794007-11.505618 7.670412-15.340824-4.794007-5.752809-1.917603-23.011236 1.917603-15.340824 11.026217-44.58427t31.161049-81.977528q22.052434-53.692884 58.007491-115.535581t81.018727-122.726592 97.797753-117.932584 107.865169-101.153558 110.262172-72.389513 106.906367-32.11985q0.958801 33.558052-6.71161 88.689139t-19.17603 117.932584-25.88764 127.520599-27.805243 117.453184z" />
          </svg>
          <svg v-else class="send-icon sending" viewBox="0 0 20 20" fill="none">
            <circle cx="6" cy="10" r="1.5" fill="#fff" opacity="0.4" /><circle cx="10" cy="10" r="1.5" fill="#fff" opacity="0.65" /><circle cx="14" cy="10" r="1.5" fill="#fff" opacity="0.9" />
          </svg>
        </div>
      </div>

<GiftPanel
        v-if="showGiftPanel"
        :character-id="chat.activeCharId"
        :character-name="chat.activeChar?.display_name || ''"
        :is-oath="chat.activeChar?.is_oath || 0"
        :affinity="chat.activeChar?.affinity ?? 50"
        @close="showGiftPanel = false"
        @sent="onGiftSent"
      />
</template>

<script setup>
import GiftPanel from '../../GiftPanel.vue'
import ChatActionToolbar from '../ChatActionToolbar.vue'
import ChatRetryNotice from '../ChatRetryNotice.vue'
import { usePrivateChatContext } from '../../../composables/chat/privateChatContext.js'
const { imageGenMode, settings, imageGenModeLabel, cycleImageGenMode, imageGenModeIcon, forceTipVisible, isMobile, inputText, send, inputFocused, isCharSleeping, wakeShaking, onWakeChar, showGiftPanel, showTouchPanel, showToyPanel, showIntimatePanel, toysEnabled, touchPendingCount, touchPendingHint, wornToys, togglePanel, showUndoBubble, undoLastRound, sendDisabled, onSendClick, chat, onSendPressStart, onSendPressEnd, onGiftSent, inputEl } = usePrivateChatContext()
</script>

<style scoped>
.chat-header, .message-list, .guesses-row, .input-area { position: relative; }
.force-img-wrap {
  position: relative;
}
.force-img-toggle {
  display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; flex-shrink: 0;
  border-radius: 12px; cursor: pointer;
  background: var(--glass-bg-strong);
  border: 1.5px solid var(--glass-border);
  font: inherit; color: inherit; padding: 0;
  -webkit-tap-highlight-color: transparent; user-select: none;
  transition: all 0.25s ease;
  opacity: 0.5;
}
.force-img-icon { font-size: 18px; line-height: 1; transition: transform 0.25s ease; }
.force-img-toggle:hover { opacity: 0.8; border-color: rgba(var(--accent-rgb), 0.3); }
.force-img-toggle.active {
  opacity: 1;
  background: linear-gradient(135deg, rgba(var(--accent-rgb), 0.15) 0%, rgba(208, 110, 94, 0.15) 100%);
  border-color: var(--accent-light);
  box-shadow: var(--focus-ring), 0 0 16px rgba(var(--accent-rgb), 0.08);
}
.force-img-toggle.active .force-img-icon { transform: scale(1.1); }
.force-img-toggle.off {
  opacity: 0.55;
  background: var(--glass-bg);
  border-color: var(--border);
  box-shadow: none;
}
.force-img-toggle.off:hover { opacity: 0.75; border-color: var(--border-strong); }
.force-img-toggle.off .force-img-icon { transform: scale(0.92); }
.force-img-toggle.is-disabled { opacity: 0.35; cursor: wait; }

.force-img-tip {
  position: absolute;
  bottom: calc(100% + 18px);
  left: calc(50% + 10px);
  transform: translateX(-50%);
  white-space: nowrap;
  padding: 6px 14px;
  font-size: 12px; font-weight: 500;
  color: var(--text-bright);
  background: var(--popover-bg);
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  pointer-events: none;
}
.force-img-tip.is-mobile {
  left: calc(50% + 20px);
}
.input-area {
  padding:8px 24px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--glass-border);
  display:flex; gap:10px; align-items:flex-end;
  background: var(--glass-bg);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
.chat-input {
  flex:1; min-width:0; min-height:40px; max-height:120px; padding:10px 14px; font-size:14px;
  background: var(--bg-secondary);
  border-radius: 14px; color:var(--text-bright); outline:none; resize:none;
  overflow: hidden; caret-color: var(--accent);
  transition: border-color 0.2s ease, box-shadow 0.3s ease, background 0.2s ease;
}
.chat-input::placeholder { color: var(--text-secondary); opacity: 0.5; }
.chat-input:hover { border-color: rgba(var(--accent-rgb), 0.35); }
.chat-input:focus {
  background: var(--bg-secondary);
  border-color: var(--accent-light);
  box-shadow:
    0 0 0 4px rgba(var(--accent-rgb), 0.10),
    0 0 24px rgba(var(--accent-rgb), 0.08),
    inset 0 0 10px rgba(var(--accent-rgb), 0.04);
}
.gift-btn {
  width: 42px; height: 42px; flex-shrink: 0;
  border-radius: 50%;
  font-size: 0;
  background: linear-gradient(135deg, #f9c270 0%, var(--accent) 100%);
  color: #fff;
  border: none; padding: 0;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(249, 194, 112, 0.25);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex; align-items: center; justify-content: center;
  user-select: none;
}
.gift-btn-icon { font-size: 20px; transition: transform 0.2s ease; }
.gift-btn:hover { transform: scale(1.08); box-shadow: 0 4px 16px rgba(249, 194, 112, 0.35); }
.gift-btn:hover .gift-btn-icon { transform: rotate(12deg) scale(1.1); }
.gift-btn:active { transform: scale(0.94); }
.wake-btn {
  background: linear-gradient(135deg, #6ee7a0 0%, #22b573 100%);
  box-shadow: 0 2px 8px rgba(34, 181, 115, 0.25);
  animation: wake-nudge 3s ease-in-out infinite;
}
.wake-btn:hover {
  box-shadow: 0 4px 16px rgba(34, 181, 115, 0.35);
}
.wake-shaking {
  animation: wake-shake 0.5s ease-in-out infinite;
}
@keyframes wake-shake {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-12deg); }
  50% { transform: rotate(12deg); }
  75% { transform: rotate(-8deg); }
}
@keyframes wake-nudge {
  0%, 19%, 100% { transform: rotate(0deg); }
  3% { transform: rotate(-14deg) scale(1.08); }
  6% { transform: rotate(12deg) scale(1.08); }
  9% { transform: rotate(-9deg) scale(1.08); }
  13% { transform: rotate(7deg) scale(1.05); }
  16% { transform: rotate(-3deg) scale(1.02); }
}
.send-btn {
  width: 42px; height: 42px; flex-shrink: 0;
  border-radius: 50%;
  font-size: 0;
  background: var(--grad-brand);
  color: #fff;
  border: none; padding: 0;
  opacity: 1; cursor: pointer;
  box-shadow:
    0 2px 8px rgba(var(--accent-rgb), 0.22),
    0 0 0 0 rgba(var(--accent-rgb), 0);
  transition:
    opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  position: relative; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  user-select: none;
}
.send-icon { width: 18px; height: 18px; display: block; transition: transform 0.2s ease; }
.send-icon.sending circle { animation: dotPulse 1s ease-in-out infinite; }
.send-icon.sending circle:nth-child(2) { animation-delay: 0.15s; }
.send-icon.sending circle:nth-child(3) { animation-delay: 0.3s; }
@keyframes dotPulse { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
.send-btn::after {
  content: '';
  position: absolute; inset: -4px;
  border-radius: 50%;
  border: 2px solid rgba(var(--accent-rgb), 0.25);
  opacity: 0;
  transition: opacity 0.3s ease, inset 0.3s ease;
}
.send-btn:not(.is-disabled):hover {
  box-shadow:
    0 4px 18px rgba(var(--accent-rgb), 0.35),
    0 0 32px rgba(var(--accent-rgb), 0.10);
  transform: scale(1.06);
}
.send-btn:not(.is-disabled):hover .send-icon { transform: translateX(1.5px); }
.send-btn:not(.is-disabled):hover::after {
  opacity: 1;
  inset: -8px;
}
.send-btn:not(.is-disabled):active {
  transform: scale(0.94);
  box-shadow: 0 1px 4px rgba(var(--accent-rgb), 0.2);
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}
.send-btn.is-disabled {
  opacity: 0.35;
  box-shadow: none;
}
.undo-bubble-btn {
  position: absolute;
  right: 5px;
  bottom: 72px;
  background: var(--popover-bg);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-bright);
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.10), 0 1px 4px rgba(0, 0, 0, 0.04);
  z-index: 10;
  transition: background 0.2s ease, transform 0.15s ease;
  user-select: none;
}
.undo-bubble-btn:hover {
  background: var(--bg-hover);
  transform: translateY(-1px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.13), 0 2px 8px rgba(0, 0, 0, 0.06);
}
.undo-bubble-btn:active {
  transform: scale(0.96);
}
.color-dot.active { border-color:var(--accent); transform:scale(1.15); }
.sp-btn.is-disabled { opacity:0.4; cursor:not-allowed; }
.sp-btn-danger:hover:not(.is-disabled) { background:rgba(255, 77, 79, 0.06); }
@media (max-width: 767px) {
  .input-area { padding: 8px 16px; padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); }
}
.impression-card-confidence .dot.off {
  background: var(--tint-subtle);
}
.impression-btn.is-disabled { opacity: 0.5; cursor: not-allowed; }
.input-area { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.input-area > .chat-input { grid-column: 1 / -1; grid-row: 1; width: 100%; box-sizing: border-box; }
.input-area > .force-img-wrap { grid-column: 1; grid-row: 2; }
.input-area > .gift-btn { grid-column: 2; grid-row: 2; }
.input-area > .chat-action-toolbar { grid-column: 3; grid-row: 2; justify-self: end; }
.input-area > .send-btn { grid-column: 4; grid-row: 2; }
</style>
