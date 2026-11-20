import { ref } from 'vue'

// Both mailbox entry points share confirmation, in-flight guards and feedback.
export function useMailboxActions(store, confirm, toast) {
  const deletingId = ref(null)
  const retryingId = ref(null)
  async function remove(id) {
    if (deletingId.value !== null || retryingId.value !== null) return false
    if (store.letters.find(l => l.id === id)?.status === 'processing') {
      toast?.('这封信正在回信中，请等处理结束后再删除', 'info')
      return false
    }
    deletingId.value = id
    try {
      if (!await confirm({ title: '删除信件', message: '确定要删除这封信件吗？此操作无法撤销。', okText: '删除', cancelText: '取消', danger: true })) return false
      await store.deleteLetter(id)
      return true
    } catch (err) {
      toast?.(err?.message || '删除失败，请稍后再试', 'error')
      return false
    } finally { deletingId.value = null }
  }
  async function retry(id) {
    if (retryingId.value !== null || deletingId.value !== null) return
    retryingId.value = id
    try {
      await store.retryLetter(id)
      toast?.('已重新投递，稍等片刻她会回信', 'success')
    } catch (err) {
      toast?.(err?.message || '重新投递失败，请稍后再试', 'error')
    } finally { retryingId.value = null }
  }
  return { deletingId, retryingId, remove, retry }
}
