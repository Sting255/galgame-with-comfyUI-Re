import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/index.js'
import { onEvent } from './unifiedStream.js'
import { useChatStore } from './chat.js'
import { useEventsStore } from './events.js'
import { refreshImageUrls, recordOverwriteBust } from '../utils/imageUrlRefresh.js'

const MAX_REMOVED_TASK_IDS = 200

function normalizeTask(data, existing = null) {
  return {
    id: data.id,
    action: data.action || 'regenerate',
    url: data.url || '',
    status: data.status || 'running',
    previewUrl: data.previewUrl || null,
    token: data.token || '',
    progress: data.progress ?? null,
    error: data.error || '',
    createdAt: data.createdAt || Date.now(),
    characterId: data.characterId ?? data.meta?.characterId ?? existing?.characterId ?? null,
    // 被动型后台任务（如 diary）：meta 带角色/日期等上下文，result 带完成后的产物标识
    meta: data.meta ?? existing?.meta ?? null,
    result: data.result ?? existing?.result ?? null,
  }
}

export const useImageEditTasksStore = defineStore('imageEditTasks', () => {
  const tasks = ref([])
  let _unsubs = []
  let _connected = false
  let _revision = 0
  let _refreshRequest = 0
  let _refreshQueued = false
  // Map 按插入顺序保留最近一次移除；容量有界，不能让前端生命周期无限增长。
  const _removedIds = new Map()

  function _rememberRemoved(id) {
    if (!id) return
    _removedIds.delete(id)
    _removedIds.set(id, true)
    while (_removedIds.size > MAX_REMOVED_TASK_IDS) {
      _removedIds.delete(_removedIds.keys().next().value)
    }
  }

  function _upsert(data) {
    if (!data?.id) return
    // 本端已经确认 apply/discard 的任务不接受任何晚到 SSE，避免重新出现。
    if (_removedIds.has(data.id)) return
    const idx = tasks.value.findIndex(t => t.id === data.id)
    const item = normalizeTask(data, idx >= 0 ? tasks.value[idx] : null)
    if (idx >= 0) {
      const prev = tasks.value[idx]
      // 进度不倒退（B06）：SSE 与快照刷新可能乱序到达，一个较早的 progress 事件
      // 不该把已经 80% 的进度打回 20%。终态（done/error）也不该被 running 覆盖。
      if (item.progress && prev.progress && typeof item.progress.progress === 'number'
          && typeof prev.progress.progress === 'number'
          && item.progress.progress < prev.progress.progress
          && item.status === prev.status) {
        item.progress = prev.progress
      }
      const terminal = new Set(['ready', 'pending_confirm', 'applied', 'discarded', 'failed'])
      if (terminal.has(prev.status) && item.status === 'running') {
        // 后端 serializeTask 会给 progress 带上当时的完整旧快照。若只保留 status/progress，
        // 终态的 token / previewUrl / result 会被旧 running 快照覆盖成空值，用户便无法应用。
        // 这类降级事件整条忽略，保留原终态对象。
        return
      }
      _revision++
      tasks.value.splice(idx, 1, item)
    } else {
      _revision++
      tasks.value.push(item)
    }
  }

  function _remove(id) {
    _revision++
    _rememberRemoved(id)
    const idx = tasks.value.findIndex(t => t.id === id)
    if (idx >= 0) tasks.value.splice(idx, 1)
  }

  function _queueRefresh() {
    if (_refreshQueued) return
    _refreshQueued = true
    // 合并同一次请求期间收到的多次进度/终态事件，只补查一次完整快照。
    queueMicrotask(() => {
      _refreshQueued = false
      refresh()
    })
  }

  function connect() {
    if (_connected) return
    _connected = true
    _unsubs = [
      onEvent('image_edit_task_start', _upsert),
      onEvent('image_edit_task_progress', _upsert),
      onEvent('image_edit_task_done', _upsert),
      onEvent('image_edit_task_error', _upsert),
      // 断线期间完成的任务不会补发已经错过的 SSE；重连成功后用活动任务快照补齐。
      onEvent('connected', refresh),
    ]
    refresh()
  }

  function disconnect() {
    for (const un of _unsubs) un()
    _unsubs = []
    _connected = false
  }

  async function refresh() {
    const request = ++_refreshRequest
    const revision = _revision
    try {
      const { tasks: list } = await api.listImageEditTasks()
      // 只允许最新一次快照提交。请求期间发生过 SSE 或本地 apply/discard 时，
      // 丢弃这份旧快照，并合并排一次补查，保证被其它任务事件打断的遗漏任务最终收敛。
      if (request !== _refreshRequest) return
      if (revision !== _revision) {
        _queueRefresh()
        return
      }
      const prev = new Map(tasks.value.map(t => [t.id, t]))
      const rows = list || []
      const fresh = rows.filter(d => !_removedIds.has(d.id))
      tasks.value = fresh.map(d => normalizeTask(d, prev.get(d.id)))
    } catch (err) {
      console.warn('[imageEditTasks] refresh failed:', err.message)
    }
  }

  async function start(action, url, opts = {}) {
    let res
    if (action === 'standing') {
      const body = opts.prompt ? { prompt: opts.prompt } : { requirement: opts.requirement || '' }
      res = await api.generateStandingTask(opts.characterId, body)
      if (res?.task_id) {
        _upsert({
          id: res.task_id, action, url, status: 'running',
          createdAt: Date.now(), characterId: opts.characterId,
        })
      }
    } else {
      const submit = action === 'upscale' ? api.upscaleImage : api.regenerateImage
      res = await submit(url)
      if (res?.task_id) {
        _upsert({ id: res.task_id, action, url, status: 'running', createdAt: Date.now() })
      }
    }
    refresh()
    return res
  }

  async function apply(task) {
    const res = await api.applyImageEditTask(task.id, task.token)
    _remove(task.id)
    refresh()
    if (task.action === 'standing') {
      window.dispatchEvent(new CustomEvent('standing-overwritten', {
        detail: { characterId: task.characterId, url: res.url, scene: task.meta?.scene, promptText: task.meta?.promptText },
      }))
      return res
    }
    const base = (task.url || '').replace(/\?.*$/, '')
    const url = res.url || (base + '?t=' + Date.now())
    // 先登记 cache-bust：详情卡/灯箱可能已关闭（实例销毁），登记表留到下次重开时取用
    recordOverwriteBust(base, Date.now())
    window.dispatchEvent(new CustomEvent('image-overwritten', {
      detail: { url, base, action: task.action },
    }))
    useChatStore().bumpImageUrls(base, url)
    useEventsStore().bumpImageUrls(base, url)
    refreshImageUrls(base)
    return res
  }

  async function rerun(task) {
    const res = await api.rerunImageEditTask(task.id, task.token)
    _remove(task.id)
    if (res?.task_id) {
      _upsert({
        id: res.task_id, action: task.action, url: task.url, status: 'running',
        createdAt: Date.now(), characterId: task.characterId,
      })
    }
    refresh()
    return res
  }

  async function discard(task) {
    await api.discardImageEditTask(task.id, task.token)
    _remove(task.id)
    refresh()
  }

  return { tasks, connect, disconnect, refresh, start, apply, rerun, discard }
})
