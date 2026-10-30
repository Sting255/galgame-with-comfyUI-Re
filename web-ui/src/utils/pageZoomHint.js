const SEEN_KEY = 'linshe.pageZoomHint.seen'

/**
 * 保守估算桌面页面缩放，不把 DPR 当成缩放比例（它也包含系统缩放 / 高分屏）。
 * 同时看宽高比例，避免仅因侧边栏或底部开发者工具挤占空间就提醒。
 * 浏览器没有统一的页面缩放 API；外窗尺寸也随缩放变化的浏览器可能不触发。
 */
export function shouldSuggestZoomOut({ innerWidth, innerHeight, outerWidth, outerHeight, desktop }) {
  if (!desktop) return false
  const sizes = [innerWidth, innerHeight, outerWidth, outerHeight]
  if (!sizes.every(value => Number.isFinite(value) && value > 0)) return false
  const estimatedZoom = Math.min(outerWidth / innerWidth, outerHeight / innerHeight)
  return estimatedZoom >= 1.45 && (innerWidth < 1280 || innerHeight < 720)
}

export function observePageZoomHint(win, notify) {
  let shown = false
  let timer
  try { shown = win.sessionStorage.getItem(SEEN_KEY) === '1' } catch {}

  function check() {
    if (shown || win.document.visibilityState === 'hidden') return
    const desktop = win.matchMedia('(hover: hover) and (pointer: fine)').matches
      && !/Android|iPhone|iPad|iPod/i.test(win.navigator.userAgent)
    if (!shouldSuggestZoomOut({
      innerWidth: win.innerWidth,
      innerHeight: win.innerHeight,
      outerWidth: win.outerWidth,
      outerHeight: win.outerHeight,
      desktop,
    })) return

    shown = true
    try { win.sessionStorage.setItem(SEEN_KEY, '1') } catch {}
    const shortcut = /Mac/i.test(win.navigator.platform) ? '⌘ + −' : 'Ctrl + −'
    notify({
      message: '页面显示偏大，适当缩小可获得更好的体验',
      description: `可按 ${shortcut}，或在浏览器菜单中调低缩放比例。`,
      type: 'info',
      duration: 8000,
    })
  }

  function schedule() {
    win.clearTimeout(timer)
    if (!shown) timer = win.setTimeout(check, 600)
  }

  win.addEventListener('resize', schedule)
  win.addEventListener('focus', schedule)
  schedule()
  return () => {
    win.clearTimeout(timer)
    win.removeEventListener('resize', schedule)
    win.removeEventListener('focus', schedule)
  }
}
