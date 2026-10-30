import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '../api/index.js'
import { onEvent } from './unifiedStream.js'

export const useMailboxStore = defineStore('mailbox', () => {
  const letters = ref([])
  const unreadCount = ref(0)
  const processingCount = ref(0)
  const loading = ref(false)
  // 加载失败要能和「真的没有信件」区分开（2026-10-22）：以前 catch 只打日志，
  // 接口一失败，界面显示的是「还没有任何通信 / 写下第一封信吧」，用户以为信箱空了。
  const loadError = ref(null)

  let pollTimer = null
  let _unsubProcessing = null
  let _unsubReady = null
  let _unsubFailed = null
  let _pollingRefs = 0

  const pendingLetters = computed(() =>
    letters.value.filter(l => l.status === 'pending' || l.status === 'processing')
  )
  const completedLetters = computed(() =>
    letters.value.filter(l => l.status === 'completed')
  )
  // 失败终态（2026-10-17 §P2-1）：连续失败到上限后后端落 `failed`、不再自动重试，
  // 前端要能把它显示出来（三处视图早有 `status === 'failed'` 分支），并给「重新投递」入口。
  const failedLetters = computed(() =>
    letters.value.filter(l => l.status === 'failed')
  )

  async function fetchLetters() {
    loading.value = true
    try {
      const data = await api.listLetters()
      letters.value = data.letters || []
      loadError.value = null
    } catch (err) {
      console.error('[mailbox] fetchLetters error:', err)
      loadError.value = err?.message || '加载失败'
    } finally {
      loading.value = false
    }
  }

  async function fetchUnread() {
    try {
      const data = await api.getUnreadCount()
      unreadCount.value = data.unread || 0
      processingCount.value = data.processing || 0
    } catch (err) {
      console.error('[mailbox] fetchUnread error:', err)
    }
  }

  async function sendLetter(characterId, title, content) {
    const result = await api.sendLetter(characterId, title, content)
    if (result.letter) {
      letters.value.unshift(result.letter)
    }
    return result
  }

  async function markRead(letterId) {
    await api.markLetterRead(letterId)
    const letter = letters.value.find(l => l.id === letterId)
    if (letter) {
      letter.is_read = 1
      fetchUnread()
    }
  }

  async function deleteLetter(letterId) {
    await api.deleteLetter(letterId)
    letters.value = letters.value.filter(l => l.id !== letterId)
    fetchUnread()
  }

  /** 手动重新投递一封失败的信（2026-10-17 §P2-1）：后端 failed → pending + 清零重试。 */
  async function retryLetter(letterId) {
    const result = await api.retryLetter(letterId)
    if (result.letter) {
      const idx = letters.value.findIndex(l => l.id === letterId)
      if (idx >= 0) letters.value[idx] = result.letter
      else letters.value.unshift(result.letter)
    }
    fetchUnread()
    return result
  }

  function _onReplyProcessing(data) {
    const letterId = data.letter_id
    const letter = letters.value.find(l => l.id === letterId)
    if (letter) {
      letter.status = 'processing'
    }
    fetchUnread()
  }

  function _onReplyReady(data) {
    const letterId = data.letter_id
    const letter = letters.value.find(l => l.id === letterId)
    if (letter) {
      letter.status = 'completed'
      letter.direction = 'char_to_user'
      letter.reply_content = data.reply_content
      letter.paper_path = data.paper_path
      letter.portrait_path = data.portrait_path
      letter.illustration_path = data.illustration_path
      letter.handwriting_font = data.handwriting_font || ''
      letter.is_read = 0
    } else {
      fetchLetters()
    }
    fetchUnread()
  }

  function _onReplyFailed(data) {
    const letterId = data.letter_id
    const letter = letters.value.find(l => l.id === letterId)
    if (letter) {
      letter.status = 'failed'
      letter.retry_count = data.retry_count
    } else {
      fetchLetters()
    }
    fetchUnread()
  }

  function startPolling() {
    _pollingRefs++
    if (_pollingRefs > 1) {
      fetchLetters()
      return
    }

    fetchLetters()
    fetchUnread()

    _unsubProcessing = onEvent('reply_processing', _onReplyProcessing)
    _unsubReady = onEvent('reply_ready', _onReplyReady)
    _unsubFailed = onEvent('reply_failed', _onReplyFailed)

    pollTimer = setInterval(() => {
      fetchUnread()
      if (letters.value.some(l => l.status === 'pending' || l.status === 'processing')) {
        fetchLetters()
      }
    }, 60000)
  }

  function stopPolling() {
    _pollingRefs = Math.max(0, _pollingRefs - 1)
    if (_pollingRefs > 0) return

    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (_unsubProcessing) { _unsubProcessing(); _unsubProcessing = null }
    if (_unsubReady) { _unsubReady(); _unsubReady = null }
    if (_unsubFailed) { _unsubFailed(); _unsubFailed = null }
  }

  return {
    letters, unreadCount, processingCount, loading, loadError,
    pendingLetters, completedLetters, failedLetters,
    fetchLetters, fetchUnread, sendLetter, markRead, deleteLetter, retryLetter,
    startPolling, stopPolling,
  }
})
