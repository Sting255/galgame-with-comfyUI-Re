<template>
  <div ref="entry" class="chat-mode-switch" :class="{ 'is-revealed': hovered || guiding || touchRevealed || busy }">
    <div class="mode-switch-action" role="button" tabindex="0" aria-label="切换到 Galgame" :aria-busy="busy || undefined" :aria-disabled="busy || undefined" @click="switchMode" @keydown.enter.stop.prevent="switchMode" @keydown.space.stop.prevent="switchMode">
      <svg class="mode-switch-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="5" /><path d="m10 9 5 3-5 3Z" />
      </svg>
      <span>{{ busy ? '准备中' : 'Galgame' }}</span>
      <svg class="mode-switch-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
    </div>
    <Transition name="mode-guide">
      <span v-if="guiding" class="mode-switch-guide" role="status">在这里切换对话模式</span>
    </Transition>
  </div>
</template>

<script>
// 设备级的一次性提示；存储不可用时，至少在当前会话中只出现一次。
let guideSeenInSession = false
const GUIDE_KEY = 'linshe:chat-mode-guide-seen:v1'
</script>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({ active: { type: Boolean, default: true }, busy: Boolean })
const emit = defineEmits(['switch'])
const entry = ref(null)
const hovered = ref(false)
const guiding = ref(false)
const touchRevealed = ref(false)
let host, guideTimer, dismissTimer, touchTimer, stopWatching, touchStart
let revealClickUntil = 0

function clearGuide() {
  clearTimeout(guideTimer)
  clearTimeout(dismissTimer)
  clearTimeout(touchTimer)
  guiding.value = false
  touchRevealed.value = false
  touchStart = null
}
function switchMode(event) {
  if (props.busy || (event?.type === 'click' && performance.now() < revealClickUntil)) return
  clearGuide()
  rememberGuide()
  hovered.value = false
  emit('switch')
}
function trackPointer(event) {
  if (event.pointerType === 'touch') {
    if (touchStart && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10) touchStart = null
    return
  }
  if (!props.active) return
  const rect = host.getBoundingClientRect()
  const entryRect = entry.value.getBoundingClientRect()
  // 监听宿主，不铺透明热区，标题栏设置与舞台操作仍可直接点击。
  hovered.value = event.clientX >= rect.right - 220 && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= entryRect.bottom + 24
}
function leaveHost() { hovered.value = false }
function revealTouchEntry() {
  clearTimeout(touchTimer)
  touchRevealed.value = true
  touchTimer = setTimeout(() => { touchRevealed.value = false }, 4200)
}
function touchHost(event) {
  revealClickUntil = 0
  if (!props.active || event.pointerType !== 'touch') return
  touchStart = null
  const target = event.target
  // The hidden entry sits BELOW the header; its former location belongs to the
  // message list. Accept that area too, but never taps inside floating panels.
  if (!target.closest('.chat-standard') || entry.value.contains(target)) return
  // Header controls keep their own action, including taps on nested SVG paths.
  if (target.closest('button, a, input, textarea, select, [role="button"], [contenteditable], .clickable, .btn-header-settings')) {
    clearGuide()
    hovered.value = false
    return
  }
  const rect = host.getBoundingClientRect()
  const entryRect = entry.value.getBoundingClientRect()
  if (event.clientX >= rect.right - 220 && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= entryRect.bottom + 24) {
    touchStart = { id: event.pointerId, x: event.clientX, y: event.clientY }
  }
}
function finishTouch(event) {
  const start = touchStart
  touchStart = null
  if (props.active && start?.id === event.pointerId
    && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 10) {
    // Some WebViews retarget the following synthetic click to the new button.
    // Ignore that click; the next pointerdown immediately enables a real tap.
    revealClickUntil = performance.now() + 500
    revealTouchEntry()
  }
}
function cancelTouch() { touchStart = null }
function rememberGuide() {
  guideSeenInSession = true
  try { localStorage.setItem(GUIDE_KEY, '1') } catch {}
}
function showFirstGuide() {
  if (guideSeenInSession) return
  try { if (localStorage.getItem(GUIDE_KEY)) return } catch {}
  rememberGuide()
  guiding.value = true
  dismissTimer = setTimeout(() => { guiding.value = false }, 4200)
}
onMounted(() => {
  host = entry.value.closest('.chat-view')
  host?.addEventListener('pointermove', trackPointer, { passive: true })
  host?.addEventListener('pointerleave', leaveHost)
  host?.addEventListener('pointerdown', touchHost, { passive: true })
  host?.addEventListener('pointerup', finishTouch, { passive: true })
  host?.addEventListener('pointercancel', cancelTouch)
  stopWatching = watch(() => props.active, active => {
    clearGuide()
    hovered.value = false
    if (active) guideTimer = setTimeout(() => {
      if (window.matchMedia('(hover: none), (pointer: coarse)').matches) revealTouchEntry()
      showFirstGuide()
    }, 600)
  }, { immediate: true })
})
onBeforeUnmount(() => {
  clearGuide()
  stopWatching?.()
  host?.removeEventListener('pointermove', trackPointer)
  host?.removeEventListener('pointerleave', leaveHost)
  host?.removeEventListener('pointerdown', touchHost)
  host?.removeEventListener('pointerup', finishTouch)
  host?.removeEventListener('pointercancel', cancelTouch)
})
</script>

<style scoped>
.chat-mode-switch { position: absolute; top: calc(100% + 8px); right: max(16px, env(safe-area-inset-right)); z-index: 6; width: 168px; color: var(--dialogue-ink); opacity: 0; transform: translate(12px, -6px); pointer-events: none; transition: opacity .3s var(--ease-standard), transform .3s var(--ease-standard); }
.chat-mode-switch.is-revealed, .chat-mode-switch:has(:focus-visible) { opacity: 1; transform: translate(0, 0); }
.mode-switch-action { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 16px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--bg-secondary); box-shadow: var(--shadow-sm); color: var(--accent-text); font-size: 14px; font-weight: 600; letter-spacing: .02em; text-align: left; cursor: pointer; user-select: none; transition: transform .3s var(--ease-standard); }
.is-revealed .mode-switch-action, .chat-mode-switch:has(:focus-visible) .mode-switch-action { pointer-events: auto; }
.mode-switch-icon, .mode-switch-arrow { width: 19px; height: 19px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.mode-switch-arrow { width: 15px; height: 15px; margin-left: auto; color: var(--dialogue-muted); transition: transform .3s var(--ease-standard); }
.mode-switch-action:hover .mode-switch-arrow { transform: translateX(3px); }
.mode-switch-action:active { transform: scale(.97); }
.mode-switch-action:focus-visible { outline: 2px solid var(--dialogue-ink); outline-offset: 4px; }
.mode-switch-guide { display: block; margin-top: 10px; padding: 6px 8px; border-radius: var(--radius-sm); background: var(--dialogue-paper); color: var(--dialogue-muted); font-size: 11px; line-height: 1.5; text-align: center; pointer-events: none; }
.mode-guide-enter-active, .mode-guide-leave-active { transition: opacity .3s var(--ease-standard), transform .3s var(--ease-standard); }
.mode-guide-enter-from, .mode-guide-leave-to { opacity: 0; transform: translateY(-4px); }
@media (hover: none), (pointer: coarse) {
  .chat-mode-switch { width: 140px; }
}
</style>
