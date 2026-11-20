import { ref, watch, onBeforeUnmount } from 'vue'
import { getCharacterReactionAssets } from '../api/index.js'

/** Read only the current character's enabled, completed stickers; never generate assets. */
export function useDialogueEmojis(characterId, active) {
  const available = ref(false), checked = ref(false), loading = ref(false), error = ref('')
  let generation = 0, disposed = false

  async function refresh() {
    if (!characterId() || !active() || disposed) return
    const id = characterId(), ticket = ++generation
    loading.value = true
    try {
      const data = await getCharacterReactionAssets(id)
      if (disposed || ticket !== generation || id !== characterId() || !active()) return
      if (Number(data.characterId) !== Number(id)) throw new Error('表情包角色不匹配，请重新检查')
      available.value = Array.isArray(data.emojis) && data.emojis.some(emoji => typeof emoji.url === 'string' && emoji.url.trim())
      error.value = ''
    } catch (cause) {
      if (disposed || ticket !== generation || id !== characterId() || !active()) return
      available.value = false
      error.value = cause.message || '表情包检查失败，请重试'
    } finally {
      if (!disposed && ticket === generation) { checked.value = true; loading.value = false }
    }
  }

  watch([characterId, active], () => {
    generation++
    available.value = false; checked.value = false; error.value = ''; loading.value = false
    refresh()
  }, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => { disposed = true; generation++ })
  return { available, checked, loading, error, refresh }
}
