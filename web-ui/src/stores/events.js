import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '../api/index.js'
import { onEvent } from './unifiedStream.js'

export const useEventsStore = defineStore('events', () => {
  const HISTORY_PAGE_SIZE = 20

  const activeEvents = ref([])        // 活跃事件列表
  const history = ref([])             // 事件历史（全量）
  const loading = ref(false)
  // 加载失败通道：区分「请求失败」与「真的没有奇遇」
  const loadError = ref(null)
  const historyPage = ref(1)          // 往期奇遇当前渲染页数
  const filterCharacterId = ref(null) // null = 全部
  const filterEngaged = ref(false)      // 只看参与过的

  // ── 红点通知状态 ──
  const newEventCount = ref(0)
  const isViewingEvents = ref(false)

  // ── 筛选 ──
  function setFilter(charId) {
    filterCharacterId.value = charId
    filterEngaged.value = false
    historyPage.value = 1
  }
  function toggleFilterEngaged() {
    filterEngaged.value = !filterEngaged.value
    filterCharacterId.value = null
    historyPage.value = 1
  }

  // ── 滚动到顶部信号 ──
  const scrollToTopSignal = ref(0)
  function requestScrollToTop() {
    scrollToTopSignal.value++
  }

  // 按角色 + 参与状态筛选
  const filteredActive = computed(() => {
    let result = activeEvents.value
    if (filterCharacterId.value !== null) result = result.filter(e => e.character_id === filterCharacterId.value)
    if (filterEngaged.value) result = result.filter(e => e.engaged)
    return result
  })

  const filteredHistory = computed(() => {
    let result = history.value
    if (filterCharacterId.value !== null) result = result.filter(e => e.character_id === filterCharacterId.value)
    if (filterEngaged.value) result = result.filter(e => e.engaged)
    return result
  })

  // 前端切片：只渲染前 historyPage 页（对标朋友圈 moments store）
  const visibleHistory = computed(() =>
    filteredHistory.value.slice(0, historyPage.value * HISTORY_PAGE_SIZE)
  )
  const historyHasMore = computed(() =>
    filteredHistory.value.length > historyPage.value * HISTORY_PAGE_SIZE
  )

  // 有事件的角色列表
  const charactersWithEvents = computed(() => {
    const map = new Map()
    for (const e of activeEvents.value) {
      const id = e.character_id
      if (!id) continue
      const existing = map.get(id)
      const evtTime = new Date(e.created_at || 0).getTime()
      if (!existing || evtTime > existing._latestAt) {
        map.set(id, {
          character_id: id,
          display_name: e.display_name || '未知',
          avatar_path: e.avatar_path || '',
          _latestAt: evtTime,
        })
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b._latestAt - a._latestAt)
      .map(({ _latestAt, ...rest }) => rest)
  })

  // 加载全部事件（对标朋友圈 loadPosts：一次性全量，前端切片渲染）
  let loadPromise = null
  let reloadRequested = false
  function loadEvents() {
    if (loadPromise) {
      reloadRequested = true
      return loadPromise
    }
    loadPromise = (async () => {
      do {
        reloadRequested = false
        await fetchEvents()
      } while (reloadRequested)
    })().finally(() => { loadPromise = null })
    return loadPromise
  }

  async function fetchEvents() {
    loading.value = true
    try {
      const data = await api.listEvents()
      const now = Date.now()
      const expired = []

      // 保留本地 processing / queued 状态 —— 后端 DB 里没有排队状态，
      // 直接用后端数据覆盖会导致切换页面后 loading 消失
      const localMeta = new Map()
      for (const e of activeEvents.value) {
        if (_pendingIds.has(e.id) || _chooseQueue.some(q => q.eventId === e.id)) {
          localMeta.set(e.id, { processing: true, _queued: _chooseQueue.some(q => q.eventId === e.id) })
        }
      }

      activeEvents.value = (data.active || []).filter(e => {
        if (!e.expires_at) return true
        if (new Date(e.expires_at).getTime() > now) return true
        // 过期但正在本地处理/排队中 → 保留（后端调度器可能还没结算）
        if (e.processing || localMeta.has(e.id)) return true
        expired.push(e)
        return false
      }).map(e => {
        const local = localMeta.get(e.id)
        return local ? { ...e, processing: local.processing, _queued: local._queued } : e
      })
      for (const q of [..._chooseQueue]) {
        if (!activeEvents.value.some(e => e.id === q.eventId)) cancelQueuedChoice(q.eventId)
      }
      // 过期事件在调度器处理前先并入前端 history，避免消失
      history.value = [
        ...expired.map(e => ({
          ...e,
          outcome: 'expired',
          ended_at: e.expires_at,
          summary: e.summary || '',
          image: undefined,
          final_image: e.image,
        })),
        ...(data.history || []),
      ]
      historyPage.value = 1
      loadError.value = null
      if (isViewingEvents.value) await markSeen()
    } catch (err) {
      console.error('[events] loadEvents error:', err)
      loadError.value = err?.message || '加载失败'
    } finally {
      loading.value = false
    }
  }

  // 加载更多历史（对标朋友圈 loadMore：纯前端切片，无网络请求）
  function loadMoreHistory() {
    if (!historyHasMore.value) return
    historyPage.value++
  }

  // ── 选择队列：最多 2 个 HTTP 请求并发，超出排队 ──
  // 用户点第 3 个分支时不会报错，而是暂存并在有空闲时自动处理。
  // UI 立刻显示"推进中"（processing=true），无需等待 HTTP 响应。
  const MAX_CONCURRENT_CHOOSES = 2
  const BRANCH_TIME_EXTENSION_MS = 5 * 60 * 1000
  // 只有"还剩 15 分钟以内"才预览这次延长（与后端同口径）
  const BRANCH_TIME_EXTENSION_WINDOW_MS = 15 * 60 * 1000
  let _choosingCount = 0
  const _chooseQueue = []
  // 请求归属独立于 SSE 数据，服务端推送不能提前解锁仍未完成的本地操作。
  const _pendingIds = new Set()

  function patchEvent(eventId, patch) {
    const idx = activeEvents.value.findIndex(e => e.id === eventId)
    if (idx !== -1) activeEvents.value[idx] = { ...activeEvents.value[idx], ...patch }
  }

  async function _executeChoice(eventId, choice, customText) {
    _choosingCount++
    _pendingIds.add(eventId)
    const originalExpiry = activeEvents.value.find(e => e.id === eventId)?.expires_at
    let previewExpiry = null
    const remaining = new Date(originalExpiry).getTime() - Date.now()
    if (remaining > 0 && remaining <= BRANCH_TIME_EXTENSION_WINDOW_MS) {
      previewExpiry = new Date(new Date(originalExpiry).getTime() + BRANCH_TIME_EXTENSION_MS).toISOString()
      patchEvent(eventId, { expires_at: previewExpiry })
    }
    try {
      const result = await api.chooseEventOption(eventId, choice, customText)
      if (result.concluded) {
        activeEvents.value = activeEvents.value.filter(e => e.id !== eventId)
        await loadEvents()
      } else if (result.event) {
        patchEvent(eventId, result.event)
      }
      return result
    } catch (err) {
      // 只回滚尚未被服务端新数据覆盖的本地预估。
      if (previewExpiry && activeEvents.value.find(e => e.id === eventId)?.expires_at === previewExpiry) {
        patchEvent(eventId, { expires_at: originalExpiry })
      }
      throw err
    } finally {
      _pendingIds.delete(eventId)
      patchEvent(eventId, { processing: false, _queued: false })
      _choosingCount--
      _drainQueue()
    }
  }

  function _drainQueue() {
    while (_chooseQueue.length && _choosingCount < MAX_CONCURRENT_CHOOSES) {
      const next = _chooseQueue.shift()
      if (!activeEvents.value.some(e => e.id === next.eventId)) {
        next.resolve({ cancelled: true })
        continue
      }
      patchEvent(next.eventId, { _queued: false })
      _executeChoice(next.eventId, next.choice, next.customText).then(next.resolve, next.reject)
    }
  }

  function cancelQueuedChoice(eventId) {
    const idx = _chooseQueue.findIndex(q => q.eventId === eventId)
    if (idx === -1) return false
    const [queued] = _chooseQueue.splice(idx, 1)
    patchEvent(eventId, { processing: false, _queued: false })
    queued.resolve({ cancelled: true })
    return true
  }

  async function undoChoice(eventId) {
    const event = activeEvents.value.find(e => e.id === eventId)
    if (!event || event.processing || _pendingIds.has(eventId)) return null
    _pendingIds.add(eventId)
    patchEvent(eventId, { processing: true })
    try {
      const result = await api.undoEventOption(eventId)
      if (result.event) patchEvent(eventId, result.event)
      return result
    } finally {
      _pendingIds.delete(eventId)
      patchEvent(eventId, { processing: false })
    }
  }

  async function makeChoice(eventId, choice, customText) {
    const event = activeEvents.value.find(e => e.id === eventId)
    if (!event || event.processing || _pendingIds.has(eventId) || _chooseQueue.some(q => q.eventId === eventId)) return null
    patchEvent(eventId, { processing: true, _queued: _choosingCount >= MAX_CONCURRENT_CHOOSES })
    if (_choosingCount < MAX_CONCURRENT_CHOOSES) return _executeChoice(eventId, choice, customText)
    return new Promise((resolve, reject) => {
      _chooseQueue.push({ eventId, choice, customText, resolve, reject })
    })
  }

  async function dismissEvent(eventId) {
    await api.dismissEvent(eventId)
    cancelQueuedChoice(eventId)
    activeEvents.value = activeEvents.value.filter(e => e.id !== eventId)
    await loadEvents()
  }

  async function deleteEvent(eventId) {
    await api.deleteEvent(eventId)
    cancelQueuedChoice(eventId)
    activeEvents.value = activeEvents.value.filter(e => e.id !== eventId)
    history.value = history.value.filter(e => e.id !== eventId)
  }

  // ── 未读计数 ──
  async function refreshUnreadCount() {
    try {
      const data = await api.getEventsUnread()
      if (data && typeof data.count === 'number') {
        newEventCount.value = data.count
      }
    } catch { /* silent */ }
  }

  async function markSeen() {
    newEventCount.value = 0
    try { await api.markEventsRead() } catch { /* silent */ }
  }

  // ── 统一 SSE 订阅（替代独立 SSE 长连接）──
  let _sseStarted = false
  let _unsubs = []  // onEvent 返回的取消订阅函数

  /** SSE 事件触发时，本地更新未读计数而不发起额外 API 请求。 */
  function _bumpUnreadLocal() {
    newEventCount.value = activeEvents.value.length
  }

  function connectSSE() {
    if (_sseStarted) return
    _sseStarted = true

    // 订阅统一 SSE 流的事件类型（单个 HTTP 连接承载所有事件）
    _unsubs = [
      onEvent('new_event', (data) => {
        const exists = activeEvents.value.find(e => e.id === data.id)
        if (!exists) activeEvents.value.unshift(data)
        _bumpUnreadLocal()
      }),
      onEvent('event_update', (data) => {
        const idx = activeEvents.value.findIndex(e => e.id === data.id)
        if (idx !== -1) {
          const queued = _chooseQueue.some(q => q.eventId === data.id)
          activeEvents.value[idx] = {
            ...activeEvents.value[idx], ...data,
            ...(_pendingIds.has(data.id) || queued ? { processing: true, _queued: queued } : {}),
          }
        } else {
          // 事件不在本地列表中（如用户刷新后未重新加载），直接插入
          activeEvents.value.unshift(data)
        }
        _bumpUnreadLocal()
      }),
      onEvent('event_concluded', (data) => {
        // 优先按 id 匹配；兼容旧服务端未携带 event_id 的广播。
        activeEvents.value = activeEvents.value.filter(e =>
          data.event_id ? String(e.id) !== String(data.event_id)
            : !(e.character_id === data.character_id && e.title === data.event_title)
        )
        for (const q of [..._chooseQueue]) {
          if (!activeEvents.value.some(e => e.id === q.eventId)) cancelQueuedChoice(q.eventId)
        }
        _bumpUnreadLocal()
        if (isViewingEvents.value) loadEvents()
      }),
      onEvent('event_expired', (data) => {
        activeEvents.value = activeEvents.value.filter(e =>
          data.event_id ? String(e.id) !== String(data.event_id)
            : !(e.character_id === data.character_id && e.title === data.event_title)
        )
        for (const q of [..._chooseQueue]) {
          if (!activeEvents.value.some(e => e.id === q.eventId)) cancelQueuedChoice(q.eventId)
        }
        _bumpUnreadLocal()
        if (isViewingEvents.value) loadEvents()
      }),
      onEvent('event_urgency', (data) => {
        // 半程强制联络：更新事件紧急标记 + 红点
        const idx = activeEvents.value.findIndex(e => e.id === data.event_id)
        if (idx !== -1) {
          activeEvents.value[idx] = { ...activeEvents.value[idx], _urgent: true }
        }
        _bumpUnreadLocal()
      }),
    ]

  }

  function disconnectSSE() {
    _sseStarted = false
    _unsubs.forEach(fn => fn())
    _unsubs = []

  }

  // 后台图片编辑任务确认覆盖后，刷新事件图片 URL
  function bumpImageUrls(base, newUrl) {
    const patchEvent = (e) => {
      if (!e) return
      if (e.image && e.image.replace(/\?.*$/, '') === base) e.image = newUrl
      if (Array.isArray(e.choice_history)) {
        for (const step of e.choice_history) {
          if (step.image && step.image.replace(/\?.*$/, '') === base) step.image = newUrl
        }
      }
    }
    for (const e of activeEvents.value) patchEvent(e)
    for (const e of history.value) patchEvent(e)
  }

  return {
    activeEvents, history, loading, historyPage, historyHasMore, visibleHistory,
    filterCharacterId, filterEngaged, newEventCount, isViewingEvents,
    scrollToTopSignal,
    filteredActive, filteredHistory, charactersWithEvents,
    loadError,
    loadEvents, loadMoreHistory, makeChoice, cancelQueuedChoice, undoChoice, dismissEvent, deleteEvent,
    setFilter, toggleFilterEngaged,
    refreshUnreadCount, markSeen,
    connectSSE, disconnectSSE, requestScrollToTop, bumpImageUrls,
  }
})
