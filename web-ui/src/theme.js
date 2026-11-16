// 主题定义与应用。主题变量组在 styles/tokens.css 的 :root / [data-theme] 中。
// 本模块保持无依赖（不引 pinia），供 main.js 在挂载前同步应用主题，避免首帧闪烁。
export const THEME_MODE_STORAGE_KEY = 'linshe_theme_mode'
// 旧版主题键保留兼容：新的选择统一走 THEME_MODE_STORAGE_KEY。
export const THEME_STORAGE_KEY = 'linshe_theme'

export const THEME_MODES = [
  { id: 'warm', name: '暖色' },
  { id: 'dark', name: '暗夜' },
  { id: 'auto', name: '按时间' },
]

export const THEMES = [
  {
    id: 'warm',
    name: '暖色',
    desc: '珊瑚暖纸，默认配色',
    swatches: ['#e07b6c', '#f0a89a', '#f0ece8', '#ffffff'],
  },
  {
    id: 'dark',
    name: '暗夜',
    desc: '深色玻璃，夜间低亮度',
    swatches: ['#ff7a64', '#ffa58f', '#221e28', '#16131a'],
  },
]

const NIGHT_START_HOUR = 18
const NIGHT_END_HOUR = 6

export function isValidTheme(id) {
  return THEMES.some(t => t.id === id)
}

export function isValidThemeMode(mode) {
  return THEME_MODES.some(m => m.id === mode)
}

export function resolveThemeByTime(hour = new Date().getHours()) {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR ? 'dark' : 'warm'
}

export function getSavedThemeMode() {
  try {
    const mode = localStorage.getItem(THEME_MODE_STORAGE_KEY)
    return isValidThemeMode(mode) ? mode : 'warm'
  } catch {
    return 'warm'
  }
}

export function getSavedTheme() {
  const mode = getSavedThemeMode()
  return mode === 'auto' ? resolveThemeByTime() : mode
}

export function applyTheme(id) {
  if (!isValidTheme(id)) id = 'warm'
  document.documentElement.dataset.theme = id
  try { localStorage.setItem(THEME_STORAGE_KEY, id) } catch { /* 隐私模式等场景忽略 */ }
}

// 应用主题模式：暖色 / 暗夜 / 按时间（auto 由当前本地时间决定实际主题）
export function applyThemeMode(mode) {
  if (!isValidThemeMode(mode)) mode = 'warm'
  try { localStorage.setItem(THEME_MODE_STORAGE_KEY, mode) } catch { /* 隐私模式等场景忽略 */ }
  applyTheme(mode === 'auto' ? resolveThemeByTime() : mode)
}

// 应用启动时调用：应用本地保存的主题模式
export function initTheme() {
  applyThemeMode(getSavedThemeMode())
}

/**
 * 跨标签页同步主题（P2-03）。
 *
 * 场景：用户在标签 A 切成暗夜，标签 B 仍停在暖色，直到刷新。
 * localStorage 的 storage 事件只在**其它**标签页写入时触发（本页写入不触发），
 * 所以这里不会和本页的 setThemeMode 打架。
 *
 * @returns {() => void} 取消监听
 */
export function watchThemeAcrossTabs() {
  if (typeof window === 'undefined') return () => {}
  const onStorage = event => {
    // key 为 null = 整个 localStorage 被清空（clear()），同样回到默认主题
    if (event.key !== null && event.key !== THEME_MODE_STORAGE_KEY) return
    const mode = getSavedThemeMode()
    // 只改 DOM 与主题属性，不再回写 localStorage（避免 ping-pong）
    applyTheme(mode === 'auto' ? resolveThemeByTime() : mode)
    try {
      window.dispatchEvent(new CustomEvent('linshe:theme-changed', { detail: { mode } }))
    } catch { /* 事件派发失败不影响主题已生效 */ }
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
