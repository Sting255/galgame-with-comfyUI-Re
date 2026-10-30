import { ref, watch, onBeforeUnmount } from 'vue'
import { getCharacterStandingState } from '../api/index.js'
import { onEvent } from '../stores/unifiedStream.js'

export function useDialogueStanding(characterId, active) {
  const shown = ref(null), error = ref(''), loading = ref(true)
  let generation = 0, latest = null, disposed = false
  async function apply(data) {
    if (disposed || !active() || Number(data.characterId) !== Number(characterId())) return
    if (latest?.epoch === data.epoch && latest.revision > data.revision) return
    latest = data
    const ticket = ++generation
    loading.value = true
    try {
      if (data.imageUrl && data.imageUrl !== shown.value?.imageUrl) {
        await new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = reject; img.src = data.imageUrl })
      }
      if (ticket === generation && !disposed) { shown.value = data; error.value = '' }
    } catch {
      if (ticket === generation) { shown.value = { ...data, imageUrl: null }; error.value = '立绘加载失败，请重试或打开立绘管理' }
    } finally { if (ticket === generation) loading.value = false }
  }
  async function refresh() {
    const id = characterId(), ticket = generation
    if (!id || !active() || disposed) return
    if (!shown.value) loading.value = true
    try {
      const data = await getCharacterStandingState(id)
      if (id === characterId() && ticket === generation) await apply(data)
    } catch (cause) { if (id === characterId() && ticket === generation && !disposed) { error.value = cause.message; loading.value = false } }
  }
  watch(characterId, () => { generation++; latest = null; shown.value = null; error.value = '' }, { flush: 'sync' })
  watch([characterId, active], refresh, { immediate: true })
  const offs = [onEvent('character_standing_state', apply), onEvent('connected', refresh), onEvent('expression_standings_updated', refresh)]
  onBeforeUnmount(() => { disposed = true; generation++; offs.forEach(off => off()) })
  return { shown, error, loading, refresh }
}
