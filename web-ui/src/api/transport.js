export const REQUEST_TIMEOUTS = Object.freeze({
  query: 30_000,
  write: 60_000,
  llm: 10 * 60_000,
  batch: 30 * 60_000,
  backup: 30 * 60_000,
  sseConnect: 15_000,
  errorBody: 5_000,
  chatConnect: 8_000,
})

function abortError(reason) {
  if (reason?.name === 'AbortError') return reason
  const error = new Error('请求已取消', reason ? { cause: reason } : undefined)
  error.name = 'AbortError'
  if (reason !== undefined) error.reason = reason
  return error
}

function requestError(message, { status = null, code, path, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.status = status
  error.code = code
  error.path = path
  return error
}

function timeoutError(path, timeoutMs) {
  return requestError(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒，${path}）`, {
    code: 'REQUEST_TIMEOUT',
    path,
  })
}

function payloadObject(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
}

function httpError(res, path, payload) {
  const result = payloadObject(payload)
  const status = res.status
  const safeDetail = status < 500 ? (result.message || result.error) : result.error
  const missingRoute = status === 404 && !result.error && !result.message
  const message = missingRoute
    ? '接口不存在 (404 not found)：后端服务还是旧代码，请先在启动器里重启服务再试'
    : (safeDetail || `请求失败 (${status})`)
  const error = requestError(message, {
    status,
    code: result.code || result.error || (missingRoute ? 'NOT_FOUND' : `HTTP_${status}`),
    path,
  })
  for (const key of ['requestId', 'characterId']) {
    if (result[key] !== undefined) error[key] = result[key]
  }
  return error
}

async function bodyTextOnce(res, {
  signal = null,
  timeoutMs = null,
  path = '',
  abortBody = null,
} = {}) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    if (signal?.aborted) throw abortError(signal.reason)
    return res.text()
  }
  const decoder = new TextDecoder()
  const chunks = []
  let removeAbort = null
  let timer = null
  let firstCause = null
  let rejectAbort
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject })
  abortPromise.catch(() => {})

  const triggerAbort = cause => {
    if (firstCause !== null) return
    firstCause = cause
    const reason = cause === 'deadline' ? timeoutError(path, timeoutMs) : abortError(signal?.reason)
    if (cause === 'deadline') {
      try { abortBody?.(reason) } catch { /* original timeout remains authoritative */ }
    }
    rejectAbort(reason)
  }
  const onAbort = () => triggerAbort('caller')

  if (signal) {
    if (signal.aborted) {
      try { reader.releaseLock() } catch { /* reader not locked */ }
      throw abortError(signal.reason)
    }
    signal.addEventListener?.('abort', onAbort, { once: true })
    removeAbort = () => signal.removeEventListener?.('abort', onAbort)
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => triggerAbort('deadline'), timeoutMs)
  }

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortPromise])
      if (done) {
        chunks.push(decoder.decode())
        return chunks.join('')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } catch (error) {
    if (firstCause === 'deadline') throw timeoutError(path, timeoutMs)
    if (firstCause === 'caller') throw abortError(signal?.reason || error)
    throw error
  } finally {
    if (timer !== null) clearTimeout(timer)
    removeAbort?.()
    try {
      const cancellation = reader.cancel()
      if (cancellation && typeof cancellation.catch === 'function') {
        void cancellation.catch(() => {})
      }
    } catch { /* preserve original result/error */ }
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

/** 二进制响应体读取；同样遵守首个 abort 原因，并确保锁定状态释放。 */
export async function bodyBlobOnce(res, {
  signal = null,
  timeoutMs = null,
  path = '',
  abortBody = null,
} = {}) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    if (signal?.aborted) throw abortError(signal.reason)
    return res.blob()
  }
  const chunks = []
  let removeAbort = null
  let timer = null
  let firstCause = null
  let rejectAbort
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject })
  abortPromise.catch(() => {})

  const triggerAbort = cause => {
    if (firstCause !== null) return
    firstCause = cause
    const reason = cause === 'deadline' ? timeoutError(path, timeoutMs) : abortError(signal?.reason)
    if (cause === 'deadline') {
      try { abortBody?.(reason) } catch { /* original timeout remains authoritative */ }
    }
    rejectAbort(reason)
  }
  const onAbort = () => triggerAbort('caller')

  if (signal) {
    if (signal.aborted) {
      try { reader.releaseLock() } catch { /* reader not locked */ }
      throw abortError(signal.reason)
    }
    signal.addEventListener?.('abort', onAbort, { once: true })
    removeAbort = () => signal.removeEventListener?.('abort', onAbort)
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => triggerAbort('deadline'), timeoutMs)
  }

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortPromise])
      if (done) return new Blob(chunks)
      chunks.push(value)
    }
  } catch (error) {
    if (firstCause === 'deadline') throw timeoutError(path, timeoutMs)
    if (firstCause === 'caller') throw abortError(signal?.reason || error)
    throw error
  } finally {
    if (timer !== null) clearTimeout(timer)
    removeAbort?.()
    try {
      const cancellation = reader.cancel()
      if (cancellation && typeof cancellation.catch === 'function') {
        void cancellation.catch(() => {})
      }
    } catch { /* preserve original result/error */ }
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

/**
 * 从 fetch 开始，一直覆盖到 task（通常还包含响应体读取）结束。
 * deadline 触发后只取消本次客户端等待；不会重发请求，也不代表服务器已取消。
 */
export async function withDeadline(task, {
  signal = null,
  timeoutMs = REQUEST_TIMEOUTS.query,
  path = '',
} = {}) {
  if (signal?.aborted) throw abortError(signal.reason)

  const controller = new AbortController()
  let timeoutId = null
  let removeAbort = null
  let firstCause = null
  const triggerAbort = cause => {
    if (firstCause !== null) return
    firstCause = cause
    controller.abort(cause === 'deadline'
      ? timeoutError(path, timeoutMs)
      : signal?.reason)
  }
  const onAbort = () => triggerAbort('caller')

  if (signal) {
    signal.addEventListener?.('abort', onAbort, { once: true })
    removeAbort = () => signal.removeEventListener?.('abort', onAbort)
    if (signal.aborted) triggerAbort('caller')
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => triggerAbort('deadline'), timeoutMs)
  }

  const causeError = error => {
    if (firstCause === 'caller') return abortError(signal?.reason || error)
    if (firstCause === 'deadline') return timeoutError(path, timeoutMs)
    return error
  }

  try {
    const result = await task(controller.signal)
    if (firstCause !== null) throw causeError(new Error('request aborted'))
    return result
  } catch (error) {
    throw causeError(error)
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
    removeAbort?.()
  }
}

/**
 * SSE 只给“拿到响应头”设连接 deadline。完成后清计时器，但保留调用方
 * controller 到响应流的 abort 接线，直到 consumeSSE 结束。
 */
export async function openStreamResponse(url, options, {
  signal = options?.signal || null,
  timeoutMs = REQUEST_TIMEOUTS.sseConnect,
  path = url,
} = {}) {
  if (signal?.aborted) throw abortError(signal.reason)

  const controller = new AbortController()
  let firstCause = null
  let timeoutId = null
  let removeAbort = null
  const triggerAbort = cause => {
    if (firstCause !== null) return
    firstCause = cause
    controller.abort(cause === 'deadline'
      ? timeoutError(path, timeoutMs)
      : signal?.reason)
  }
  const onAbort = () => triggerAbort('caller')

  if (signal) {
    signal.addEventListener?.('abort', onAbort, { once: true })
    removeAbort = () => signal.removeEventListener?.('abort', onAbort)
    if (signal.aborted) triggerAbort('caller')
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => triggerAbort('deadline'), timeoutMs)
  }

  const closeTimer = () => {
    if (timeoutId !== null) clearTimeout(timeoutId)
    timeoutId = null
  }
  const causeError = error => {
    if (firstCause === 'caller') return abortError(signal?.reason || error)
    if (firstCause === 'deadline') return timeoutError(path, timeoutMs)
    return error
  }

  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (firstCause !== null) {
      try { await response.body?.cancel?.() } catch { /* response already closed */ }
      throw causeError(new Error('stream aborted'))
    }
    closeTimer()
    return {
      response,
      signal: controller.signal,
      timedOut: () => firstCause === 'deadline',
      finishHeaders() {
        closeTimer()
      },
      dispose() {
        closeTimer()
        removeAbort?.()
      },
      abort(reason) {
        controller.abort(reason)
        removeAbort?.()
      },
    }
  } catch (error) {
    closeTimer()
    removeAbort?.()
    throw causeError(error)
  }
}

/** 只读一次响应体，再按状态和内容决定返回值或结构化错误。 */
export async function readJsonResponse(res, path, {
  method = '',
  signal = null,
  timeoutMs = null,
  abortBody = null,
} = {}) {
  if (signal?.aborted) throw abortError(signal.reason)
  const noBody = res.status === 204 || res.status === 205 || res.status === 304
    || String(method || res.request?.method || '').toUpperCase() === 'HEAD'
  const raw = noBody ? '' : await bodyTextOnce(res, { signal, timeoutMs, path, abortBody })
  const hasText = raw.trim().length > 0
  let parsed
  let valid = false
  if (hasText) {
    try {
      parsed = JSON.parse(raw)
      valid = true
    } catch { /* 非 JSON 错误页在下面按状态分类 */ }
  }

  if (!res.ok) throw httpError(res, path, valid ? parsed : null)
  if (noBody) return undefined
  // 保持旧接口兼容：成功空 JSON 端点按空对象返回；无 body 状态仍返回 undefined。
  if (!hasText) return {}
  if (!valid) {
    throw requestError(`响应解析失败 (${res.status} ${path})：服务端返回的不是合法 JSON`, {
      status: res.status,
      code: 'RESPONSE_PARSE_ERROR',
      path,
    })
  }
  return parsed
}

/** 非 JSON 或二进制响应也要按只读一次的方式读取错误体。 */
export async function httpErrorForResponse(res, path, {
  allowBackupPath = false,
  signal = null,
  abortBody = null,
} = {}) {
  const raw = await bodyTextOnce(res, {
    signal,
    timeoutMs: REQUEST_TIMEOUTS.errorBody,
    path,
    abortBody,
  })
  let payload = null
  if (raw.trim()) {
    try { payload = JSON.parse(raw) } catch { /* HTML / plain error body */ }
  }
  const error = httpError(res, path, payload)
  if (allowBackupPath && path.startsWith('/data/') && typeof payload?.backupPath === 'string') {
    error.backupPath = payload.backupPath
  }
  return error
}

export async function requestJson(url, {
  method = 'GET',
  body,
  headers,
  signal,
  timeoutMs,
  path = url,
} = {}) {
  const normalizedMethod = String(method || 'GET').toUpperCase()
  const effectiveTimeout = timeoutMs ?? (
    normalizedMethod === 'GET' || normalizedMethod === 'HEAD'
      ? REQUEST_TIMEOUTS.query
      : REQUEST_TIMEOUTS.write
  )
  return withDeadline(async combinedSignal => {
    const res = await fetch(url, { method, headers, body, signal: combinedSignal })
    return readJsonResponse(res, path, {
      method,
      signal: combinedSignal,
      timeoutMs: 0,
    })
  }, { signal, timeoutMs: effectiveTimeout, path })
}

/** 调用方需要自行控制取消控制器时，用它打开连接阶段的 deadline。 */
export async function fetchWithConnectDeadline(url, options = {}, {
  timeoutMs = REQUEST_TIMEOUTS.sseConnect,
  path = url,
} = {}) {
  return openStreamResponse(url, options, {
    signal: options.signal,
    timeoutMs,
    path,
  })
}

/** 非 2xx SSE 响应：短预算读取错误体，并确保未消费 body 被取消。 */
export async function rejectStreamResponse(res, path, { signal = null, abortBody = null } = {}) {
  try {
    return await httpErrorForResponse(res, path, { signal, abortBody })
  } finally {
    try {
      const cancellation = res.body?.locked ? null : res.body?.cancel?.()
      if (cancellation && typeof cancellation.catch === 'function') {
        void cancellation.catch(() => {})
      }
    } catch { /* body may already be consumed */ }
  }
}

/**
 * SSE 按空行派发完整帧；event: 行仍立即回调 (name, undefined)，供 chat store
 * 记录 lastEvent。多个 data: 行在帧结束时拼成 JSON。CRLF 可跨 chunk。
 */
export async function consumeSSE(res, onEvent, { path = '' } = {}) {
  if (!res.body?.getReader) throw new TypeError('SSE response body is not readable')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventType = null
  let dataLines = []

  const dispatch = () => {
    const currentEvent = eventType || 'message'
    const currentData = dataLines
    eventType = null
    dataLines = []
    if (currentData.length === 0) return
    const payload = currentData.join('\n')
    let data
    try {
      data = JSON.parse(payload)
    } catch (error) {
      // 兼容服务端把一个帧里的多个 data 行当作多个独立 JSON 事件：
      // 全部能解析才逐行派发；任意一行坏掉则整帧跳过，避免半帧误触发。
      if (currentData.length > 1) {
        try {
          const rows = currentData.map(line => JSON.parse(line))
          for (const row of rows) onEvent(currentEvent, row)
          return
        } catch { /* fall through to one bounded warning */ }
      }
      console.warn('[api][SSE] 跳过无法解析的数据帧', {
        event: currentEvent,
        path,
        error: error?.message || String(error),
      })
      return
    }
    onEvent(currentEvent, data)
  }

  const processLine = line => {
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      eventType = value.trim() || 'message'
      onEvent(eventType, undefined)
    } else if (field === 'data') {
      dataLines.push(value)
    }
  }

  const drainLines = final => {
    for (;;) {
      const cr = buffer.indexOf('\r')
      const lf = buffer.indexOf('\n')
      const index = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf)
      if (index < 0) break
      if (buffer[index] === '\r' && index === buffer.length - 1 && !final) break
      const line = buffer.slice(0, index)
      const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
      buffer = buffer.slice(index + width)
      processLine(line)
    }
    if (final && buffer.length > 0) {
      const tail = buffer
      buffer = ''
      processLine(tail)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        drainLines(true)
        dispatch()
        return
      }
      buffer += decoder.decode(value, { stream: true })
      drainLines(false)
    }
  } catch (error) {
    // 回调异常发生在解析循环里，异步 cancel 可能迟迟不 settle；立即返回，
    // 但挂上 catch 并在后面尝试 releaseLock，避免未处理拒绝。
    try {
      const cancellation = reader.cancel(error)
      if (cancellation && typeof cancellation.catch === 'function') {
        void cancellation.catch(() => {})
      }
    } catch { /* preserve original error */ }
    try { reader.releaseLock() } catch { /* reader remains locked until cancel settles */ }
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* reader already released */ }
  }
}
