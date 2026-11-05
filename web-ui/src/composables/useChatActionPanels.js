import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

// Both chat modes own one interaction panel at a time. Changing the conversation
// closes it before a control can accidentally act on the next character/group.
export function useChatActionPanels(conversation) {
  const active = ref('')
  const visible = name => computed({
    get: () => active.value === name,
    set: value => { if (value) active.value = name; else if (active.value === name) active.value = '' },
  })
  const closePanels = () => { active.value = '' }
  const togglePanel = name => { active.value = active.value === name ? '' : name }
  watch(conversation, closePanels, { flush: 'sync' })
  const onKey = event => { if (event.key === 'Escape' && !event.defaultPrevented) closePanels() }
  onMounted(() => window.addEventListener('keydown', onKey))
  onUnmounted(() => window.removeEventListener('keydown', onKey))
  return { showTouchPanel: visible('touch'), showToyPanel: visible('toy'), showIntimatePanel: visible('intimate'), closePanels, togglePanel }
}
