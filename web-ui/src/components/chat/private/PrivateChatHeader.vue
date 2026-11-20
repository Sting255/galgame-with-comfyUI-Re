<template>
<div class="chat-header">
        <linshe-button v-if="isMobile" variant="icon" class="btn-mobile-back" @click="toggleMobileSidebar" title="角色列表">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </linshe-button>
        <div class="chat-header-center">
          <div class="chat-header-title-row">
            <span class="chat-title">{{ chat.activeChar?.display_name }}</span>
            <span v-if="realtimeAffinityEnabled && chat.realtimeAffinity" class="header-affinity">
              <svg class="affinity-heart-icon" viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor"><path d="M512.042667 193.237333a255.914667 255.914667 0 0 1 351.658666 9.728 256 256 0 0 1 10.069334 351.402667l-361.813334 362.325333-361.728-362.325333a256 256 0 0 1 361.813334-361.130667z" /></svg>{{ Math.round(chat.realtimeAffinity.affinity) }}
              <span class="affinity-delta-wrap">
                <Transition name="roll">
                  <span :key="chat.affinityKey" class="header-affinity-delta" :class="chat.realtimeAffinity.affinityDelta >= 0 ? 'delta-up' : 'delta-down'">
                    {{ chat.realtimeAffinity.affinityDelta >= 0 ? '+' : '' }}{{ Number(chat.realtimeAffinity.affinityDelta).toFixed(1) }}
                  </span>
                </Transition>
              </span>
            </span>
          </div>
          <div class="chat-header-schedule" v-if="currentScheduleText">{{ currentScheduleText }}</div>
          <ChatSleepStatus :states="[charSleepState]" :loaded="scheduleStore.overviewLoaded" :error="scheduleStore.overviewError" @retry="scheduleStore.fetchOverview(true)" />
          <!-- 睡眠条（2026-11-06 用户要求放到最顶上）：只有她睡着时才出现，点一下开亲密面板 -->
          <ChatSleepBar :character-id="chat.activeCharId" @open="showIntimatePanel = true" />
        </div>
        <div class="chat-header-right">
          <linshe-button class="standing-entry-desktop" variant="ghost" size="sm" @click="openStandingDisplayPage">同步形象展示 ↗</linshe-button>
          <span class="affinity-reason-wrap">
            <Transition name="roll">
              <span v-if="realtimeAffinityEnabled && chat.realtimeAffinity?.lastReason" :key="chat.affinityKey" class="header-reason">
                💬"{{ chat.realtimeAffinity.lastReason }}"
              </span>
            </Transition>
          </span>
          <div class="btn-header-settings" title="角色设置" @click="openSettings">
            <gear-icon :size="16" />
          </div>
        </div>
        <ChatModeSwitch :active="!immersive" :busy="preparingGalgame" @switch="enterGalgame" />
      </div>
</template>

<script setup>
import GearIcon from '../../GearIcon.vue'
import LinsheButton from '../../ui/LinsheButton.vue'
import ChatModeSwitch from '../ChatModeSwitch.vue'
import ChatSleepStatus from '../ChatSleepStatus.vue'
import ChatSleepBar from '../ChatSleepBar.vue'
import { usePrivateChatContext } from '../../../composables/chat/privateChatContext.js'
const { isMobile, toggleMobileSidebar, chat, realtimeAffinityEnabled, currentScheduleText, charSleepState, scheduleStore, showIntimatePanel, openStandingDisplayPage, openSettings, immersive, preparingGalgame, enterGalgame } = usePrivateChatContext()
</script>

<style scoped>
@media (max-width:767px) {
  .standing-entry-desktop { display:none; }
}
.chat-header, .message-list, .guesses-row, .input-area { position: relative; }
.chat-header {
  padding:14px 24px;
  border-bottom: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  display:flex; align-items:center; justify-content:space-between;
  position: relative;
  z-index: 7;
}
.chat-title { font-size:16px; font-weight:600; color:var(--text-bright); }
.btn-mobile-back {
  width: 44px; height: 44px; flex-shrink: 0;
  margin-right: 8px;
  background: transparent;
}

.btn-header-settings {
  width:32px; height:32px; border-radius:10px;
  border:1px solid var(--glass-border);
  color:var(--text-secondary); font-size:16px; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  transition: all 0.2s ease;
}
.btn-header-settings:hover { color:var(--text-bright); border-color:var(--accent); }
.force-img-toggle.active {
  opacity: 1;
  background: linear-gradient(135deg, rgba(var(--accent-rgb), 0.15) 0%, rgba(208, 110, 94, 0.15) 100%);
  border-color: var(--accent-light);
  box-shadow: var(--focus-ring), 0 0 16px rgba(var(--accent-rgb), 0.08);
}
.force-img-toggle.active .force-img-icon { transform: scale(1.1); }
.color-dot.active { border-color:var(--accent); transform:scale(1.15); }
@media (max-width: 767px) {
  .chat-header { padding: 12px 16px; }
}
.affinity-change-delta.delta-up { color: #e05a7a; }
.affinity-change-delta.delta-down { color: #6366f1; }
.chat-header-center { display: flex; flex-direction: column; gap: 0; flex: 1; min-width: 0; }
.chat-header-title-row { display: flex; align-items: center; gap: 8px; }
.chat-header-schedule {
  font-size: 11px; color: var(--accent-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  opacity: 0.75; margin-top: 2px;
}
.header-affinity { font-size: 14px; font-weight: 600; color: #c2184a; white-space: nowrap;display: flex;align-items: center; }
.affinity-heart-icon { vertical-align: middle; margin-right: 1px; flex-shrink: 0; }
.header-affinity-delta { font-size: 11px; font-weight: 500; margin-left: 4px; }
.header-affinity-delta.delta-up { color: #c2184a; }
.header-affinity-delta.delta-down { color: #4a90d9; }
.chat-header-right { display: flex; align-items: center; gap: 10px; }
.header-reason {
  font-size: 11px; color: var(--text-secondary); font-style: italic;
  white-space: nowrap;
}
.affinity-delta-wrap,
.affinity-reason-wrap { position: relative; display: inline-block; vertical-align: bottom; }
@media (max-width: 768px) {
  .chat-header-schedule { font-size: 10px; max-width: 50vw; }
  .header-affinity { font-size: 12px; }
  .header-affinity-delta { font-size: 10px; }
  .chat-header-right { max-width: 40vw; }
  .affinity-reason-wrap { min-width: 0; overflow: hidden; }
  .header-reason {
    display: block;
    max-width: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn-header-settings { flex-shrink: 0; }
}
</style>
