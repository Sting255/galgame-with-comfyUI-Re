import { ref, computed, nextTick } from 'vue'

export function usePrivateChatScroll({ chat, clock, isMobile }) {
  const msgList = ref(null)

  const msgListInner = ref(null)

  const messageGroups = computed(() => {
  const groups = []
  for (const msg of chat.visibleMessages) {
  const lastGroup = groups[groups.length - 1]
  if (lastGroup) {
  const lastMsg = lastGroup.msgs[lastGroup.msgs.length - 1]
  const diff = Math.abs(new Date(msg.created_at) - new Date(lastMsg.created_at))
  if (diff <= 10 * 60 * 1000) {
    lastGroup.msgs.push(msg)
    continue
  }
  }
  const t = timeLabel(msg.created_at)
  groups.push({ label: t, msgs: [msg] })
  }
  return groups
  })

  // 扁平化列表（时间正序：最旧在上，最新在下）
  const flatItems = computed(() => {
  const items = []
  for (const group of messageGroups.value) {
  items.push({ type: 'divider', label: group.label, id: `d-${group.msgs[0]?.id || group.label}` })
  let prevRole = null
  for (const msg of group.msgs) {
  // 表情包拆成独立气泡，文本和表情包分开展示
  const pieces = []
  if (msg.sticker_images?.length) {
  for (let i = 0; i < msg.sticker_images.length; i++) pieces.push({ kind: 'sticker', index: i })
  }
  if (msg.content) pieces.push({ kind: 'text' })
  if (pieces.length === 0) pieces.push({ kind: 'text' })
    for (const piece of pieces) {
      const sameRole = prevRole !== null && prevRole === msg.role
      const pieceId = piece.kind === 'text' ? `${msg.id}-text` : `${msg.id}-sticker-${piece.index}`
      items.push({ type: 'message', msg, piece, id: pieceId, sameRole })
      // 深度思考块不参与连发头像合并——否则它后面第一条回复的头像会被当作"同角色连发"隐藏
      prevRole = msg.role
    }
  }
  }
  return items
  })

  function timeLabel(iso) {
    if (!iso) return ''
    const d = clock.toProgram(iso); const now = clock.now()
    if (!d) return ''
    const diff = now - d
    const hh = d.getHours().toString().padStart(2,'0'); const mm = d.getMinutes().toString().padStart(2,'0')
    const time = hh + ':' + mm
    if (d.toDateString() === now.toDateString()) return time
    const y = new Date(now); y.setDate(y.getDate()-1)
    if (d.toDateString() === y.toDateString()) return '昨天 ' + time
    y.setDate(y.getDate()-1)
    if (d.toDateString() === y.toDateString()) return '前天 ' + time
    if (Math.floor(diff/86400000) < 7 && d.getDay() !== now.getDay()) {
      return ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()] + ' ' + time
    }
    return d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate()+' '+time
  }

  // ══════════════════════════════════════════════════
  // 滚动管理（正常 column 布局，scrollTop=0 为顶部）
  // ══════════════════════════════════════════════════

  const userScrolledUp = ref(false)

  const scrollTimer = ref(null)

  // 加载更早一页时的重入锁（B04）：滚动事件连续触发时不并发请求同一页
  let loadingOlderLock = false

  let imageScrollFrame = null

  function onChatImageLoaded(message) {
    message.liveImage = false
    scrollToBottom(false, 600)
  }

  function cancelImageScroll() {
    if (imageScrollFrame !== null) cancelAnimationFrame(imageScrollFrame)
    imageScrollFrame = null
  }

  function interruptImageScroll() {
    if (imageScrollFrame === null) return
    cancelImageScroll()
    userScrolledUp.value = true
  }

  function onScrollKeydown(event) {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interruptImageScroll()
  }

  function onScroll() {
    const el = msgList.value
    if (!el) return
    // 图片缓动中离底部较远是正常追赶，不应误判为用户上翻。
    if (imageScrollFrame !== null) return
    const distToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distToBottom > 60) {
      userScrolledUp.value = true
    } else if (distToBottom < 10) {
      userScrolledUp.value = false
    }
    if (scrollTimer.value) clearTimeout(scrollTimer.value)
    scrollTimer.value = setTimeout(() => {
      if (distToBottom < 60) userScrolledUp.value = false
    }, 2000)

    // 滚动到顶部 → 展开渲染窗口；窗口已展开完则向服务端取更早一页（B04）
    if (el.scrollTop < 40 && chat.hasMoreOlder && !loadingOlderLock) {
      const prevHeight = el.scrollHeight
      loadingOlderLock = true
      Promise.resolve(chat.expandWindow()).then((hasMore) => {
        nextTick(() => {
          if (msgList.value) msgList.value.scrollTop += msgList.value.scrollHeight - prevHeight
          // 一次滚动只拉一页，等用户下次再滑到顶
          setTimeout(() => { loadingOlderLock = false }, 300)
        })
        if (!hasMore) loadingOlderLock = false
      }).catch(() => { loadingOlderLock = false })
    }
  }

  // force=true: 瞬间滚底（切角色/首次加载/发消息）
  // force=false: 文字沿用浏览器平滑滚动；图片显式使用更长的 duration（毫秒）
  async function scrollToBottom(force = false, duration = 0) {
    await nextTick()
    const el = msgList.value
    if (!el) return
    if (force || !userScrolledUp.value) {
      if (force) {
        cancelImageScroll()
        el.scrollTop = el.scrollHeight
      } else if (duration > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        cancelImageScroll()
        clearTimeout(scrollTimer.value)
        const from = el.scrollTop
        // 停止尚未结束的原生 smooth，避免两套滚动相互争抢。
        el.scrollTo({ top: from, behavior: 'instant' })
        const started = performance.now()
        const step = now => {
          const progress = Math.min(1, (now - started) / duration)
          const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
          const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
          el.scrollTop = from + (bottom - from) * eased
          imageScrollFrame = progress < 1 ? requestAnimationFrame(step) : null
        }
        imageScrollFrame = requestAnimationFrame(step)
      } else if (imageScrollFrame !== null) {
        // 图片跟随期间新分句共用当前动画，下一帧会读取最新底部。
        return
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: duration > 0 ? 'instant' : 'smooth' })
      }
    }
  }

  // ── 生命周期 ──

  // 移动端键盘适配：键盘弹起/收起时同步滚动消息列表
  // visualViewport.resize 在浏览器原生帧率触发，用 instant scrollTop 与键盘动画同步
  let viewportCleanup = null

  function setupMobileKeyboard() {
    if (!window.visualViewport || !isMobile) return
    let prevH = window.visualViewport.height
    const onResize = () => {
      const el = msgList.value
      if (!el) return
      const h = window.visualViewport.height
      if (Math.abs(h - prevH) < 10) return
      prevH = h
      cancelImageScroll()
      userScrolledUp.value = false
      el.scrollTop = el.scrollHeight
    }
    window.visualViewport.addEventListener('resize', onResize)
    viewportCleanup = () => window.visualViewport.removeEventListener('resize', onResize)
  }

  function teardownMobileKeyboard() {
    viewportCleanup?.()
    viewportCleanup = null
  }

  // ResizeObserver：挂载后临时监听内容区高度变化（图片加载撑高），追底后自毁
  // 只修复"从其他页面切回时历史图片异步加载导致滚动漂移"，不长期驻留
  let resizeObserver = null

  let resizeRaf = null

  let lastObservedSH = 0

  let resizeObserverTimer = null

  const RESIZE_OBSERVER_TTL = 2000

  // 挂载后最多存活 3s

  function setupResizeObserver() {
    const inner = msgListInner.value
    const el = msgList.value
    if (!inner || !el) return
    lastObservedSH = el.scrollHeight
    resizeObserver = new ResizeObserver(() => {
      if (resizeRaf) return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        const el2 = msgList.value
        if (!el2 || pendingCharSwitch.value || chat.streaming || imageScrollFrame !== null) return
        const newSH = el2.scrollHeight
        if (newSH === lastObservedSH) return
        // 用旧 scrollHeight 算 distBefore，避免 userScrolledUp 被 scroll 事件误判污染
        const distBefore = lastObservedSH - el2.scrollTop - el2.clientHeight
        lastObservedSH = newSH
        if (distBefore > 60) return
        el2.scrollTop = el2.scrollHeight
        userScrolledUp.value = false
        // 完成一次追底后延迟自毁：给剩余图片 500ms 缓冲，之后卸载
        clearTimeout(resizeObserverTimer)
        resizeObserverTimer = setTimeout(teardownResizeObserver, 500)
      })
    })
    resizeObserver.observe(inner)
    // 兜底：TTL 到期强制自毁，防止意外长驻
    resizeObserverTimer = setTimeout(teardownResizeObserver, RESIZE_OBSERVER_TTL)
  }

  function teardownResizeObserver() {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = null }
    clearTimeout(resizeObserverTimer)
    resizeObserverTimer = null
    lastObservedSH = 0
  }

  const pendingCharSwitch = ref(false)

  return { msgList, userScrolledUp, scrollTimer, cancelImageScroll, scrollToBottom, setupMobileKeyboard, teardownMobileKeyboard, setupResizeObserver, teardownResizeObserver, pendingCharSwitch, onScroll, interruptImageScroll, onScrollKeydown, flatItems, msgListInner, onChatImageLoaded }
}
