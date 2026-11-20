import { ref, watch, onBeforeUnmount } from 'vue'

export function getSavedClothingTags(appearance) {
  const line = String(appearance || '').match(/^Outfit tags:\s*([^\n]+)$/m)?.[1]
  return line ? [...new Set(line.replace(/\.\s*$/, '').split(',').map(tag => tag.trim()).filter(Boolean))].slice(0, 32) : []
}

// 每次选择或补充变动都使旧草稿失效；关闭窗口/切换角色后迟到的请求不能回填。
export function useClothingDraft(generate, getContext) {
  const tags = ref([])
  const brief = ref('')
  const result = ref('')
  const error = ref('')
  const busy = ref(false)
  let revision = 0
  let controller
  function cancel() {
    revision++
    controller?.abort()
    controller = undefined
    busy.value = false
  }
  function invalidate() { cancel(); result.value = ''; error.value = '' }
  function reset() { invalidate(); tags.value = []; brief.value = '' }
  watch([tags, brief], invalidate, { deep: true, flush: 'sync' })
  async function createDraft() {
    if (busy.value || !tags.value.length) return
    invalidate()
    const current = revision
    const context = { ...getContext() }
    controller = new AbortController()
    busy.value = true
    try {
      const response = await generate({ ...context, tags: [...tags.value], brief: brief.value.trim(), signal: controller.signal })
      if (current !== revision) return
      if (!response?.appearance?.trim()) throw new Error('生成结果为空，请重试')
      result.value = response.appearance
    } catch (err) {
      if (current === revision && err.name !== 'AbortError') error.value = err.message || '生成失败，请重试'
    } finally {
      if (current === revision) { busy.value = false; controller = undefined }
    }
  }
  onBeforeUnmount(cancel)
  return { tags, brief, result, error, busy, createDraft, reset, cancel }
}
