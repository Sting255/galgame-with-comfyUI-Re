import { onMounted, onUnmounted, watch } from 'vue'
import { useScheduleStore } from '../stores/schedule.js'

/** 聊天页拥有兜底刷新；离页释放，后台页等待重新可见后再刷新。 */
export function useChatSchedule(conversation, busy, revision) {
  const schedule = useScheduleStore()
  let timer = null
  let pending = null
  let mounted = false
  function refresh() {
    if (!mounted || document.hidden || !conversation()) return
    clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      if (mounted && !document.hidden && conversation()) schedule.fetchOverview(true)
    }, 150)
  }
  watch([conversation, busy, revision], ([id, working], previous) => {
    if (id !== previous[0] || !working) refresh()
  })
  onMounted(() => {
    mounted = true
    refresh()
    timer = setInterval(refresh, 30000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
  })
  onUnmounted(() => {
    mounted = false
    clearInterval(timer)
    clearTimeout(pending)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  })
  return schedule
}
