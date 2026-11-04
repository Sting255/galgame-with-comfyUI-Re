// SSE 结束后接回仍在后台运行的图片任务。每个任务只保留一个查询循环。
export function createImageTaskRecovery({ fetchTask, isCurrent, onDone, onError,
  intervalMs = 2000, maxWaitMs = 600000, requestTimeoutMs = 10000 }) {
  const pending = new Map()

  function stop(id) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    clearTimeout(entry.deadline)
    clearTimeout(entry.requestTimer)
    entry.controller?.abort()
  }

  function start(id, context) {
    if (pending.has(id) || !isCurrent(id, context)) return
    const entry = { context, errors: 0, controller: null }
    pending.set(id, entry)
    const current = () => pending.get(id) === entry && isCurrent(id, context)
    const fail = message => {
      const active = current()
      stop(id)
      if (active) onError(id, message, context)
    }
    entry.deadline = setTimeout(() => fail('图片仍未完成，请稍后重新打开聊天查看'), maxWaitMs)

    async function poll() {
      if (!current()) { stop(id); return }
      const controller = new AbortController()
      entry.controller = controller
      // fetch 遵循 AbortSignal；超时也算一次暂时失败，允许重试。
      entry.requestTimer = setTimeout(() => controller.abort(), requestTimeoutMs)
      try {
        const task = await fetchTask(id, { signal: controller.signal })
        if (!current()) return
        entry.errors = 0
        if (task.status === 'done') {
          const images = (Array.isArray(task.output_paths) ? task.output_paths : [])
            .filter(url => typeof url === 'string' && url.length > 0).map(url => ({ url }))
          if (!images.length) { fail('图片任务已结束，但没有可用图片'); return }
          stop(id)
          onDone(id, images, context)
        } else if (['failed', 'cancelled'].includes(task.status)) {
          fail(task.error || '图片生成失败，请重试')
        }
      } catch (error) {
        if (current() && ++entry.errors >= 3) fail(error.message || '暂时无法查询图片结果，请重新打开聊天查看')
      } finally {
        clearTimeout(entry.requestTimer)
        if (current()) entry.timer = setTimeout(poll, intervalMs)
        else if (pending.get(id) === entry) stop(id)
      }
    }
    void poll()
  }

  return { start, stop, stopAll() { for (const id of pending.keys()) stop(id) } }
}
