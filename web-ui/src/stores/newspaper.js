import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '../api/index.js'
import { onEvent } from './unifiedStream.js'
import { createPoller } from '../utils/poller.js'

/**
 * 《邻舍日报》未读状态（唯一来源）
 *
 * 报纸每天清晨由后端印出，前端「未读」＝ 今天已有报纸 && 这一期还没被打开看过。
 * 已读日期记在 localStorage，沿用历史键名（升级不丢已读状态）；
 * 未读标志同时驱动酒馆页入口卡红点与 NavBar 酒馆项红点（同一套 nav-dot 语言）。
 */

/** 已读期号日期（YYYY-MM-DD）：与历史版本同键，不要改 */
const READ_KEY = 'linshe.newspaper.last_read'
/** 报纸一天一期，60s 一次足以在印出后亮起点（与 mailbox store 同频） */
const POLL_INTERVAL_MS = 60000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function readStoredDate() {
  try {
    return localStorage.getItem(READ_KEY) || ''
  } catch {
    return '' // 隐私模式 / 无 localStorage 环境静默
  }
}

function writeStoredDate(date) {
  try {
    localStorage.setItem(READ_KEY, date)
  } catch { /* 隐私模式静默 */ }
}

export const useNewspaperStore = defineStore('newspaper', () => {
  const todayPaper = ref(null)
  const lastReadDate = ref(readStoredDate())
  const loading = ref(false)

  let unsubscribeRollover = null
  let unsubscribeConnected = null
  let _pollingRefs = 0
  let _requestSeq = 0
  let _worldRevision = 0
  // 世界钟允许回拨；不能用日期大小判断新旧，只能校验响应属于当前世界日期。
  let _expectedWorldDate = ''
  // 统一轮询：请求结束后才排下一次（不重叠）、后台降频、回前台立即补一次
  const poller = createPoller({ task: fetchToday, intervalMs: POLL_INTERVAL_MS })

  /** 今天的报纸已印出、且这一期没看过 */
  const unread = computed(() => {
    const date = todayPaper.value?.publish_date
    return Boolean(date) && date !== lastReadDate.value
  })

  async function fetchToday() {
    const request = ++_requestSeq
    const worldRevision = _worldRevision
    loading.value = true
    try {
      const data = await api.getTodayNewspaper()
      if (request !== _requestSeq || worldRevision !== _worldRevision) return
      const next = data?.newspaper || null
      const nextDate = next?.publish_date || ''
      // /today 的 programDate 与 newspaper 来自同一次同步读取；空日报也有世界日期。
      // 兼容旧后端时退回报纸自身的 publish_date。
      const responseDate = DATE_RE.test(String(data?.programDate || ''))
        ? String(data.programDate)
        : nextDate
      // 已知当前世界日期时，只接受属于那一期的响应。这样前进、回拨和反序响应
      // 都不会把别的程序日期的报纸误认成当前一期；空期只更新快照归属，不拿旧日报补位。
      if (_expectedWorldDate && responseDate && responseDate !== _expectedWorldDate) return
      if (!_expectedWorldDate && responseDate) _expectedWorldDate = responseDate
      todayPaper.value = next
    } catch (err) {
      console.error('[newspaper] fetchToday error:', err)
    } finally {
      if (request === _requestSeq) loading.value = false
    }
    return todayPaper.value
  }

  function onProgramDayRollover(data) {
    const date = DATE_RE.test(String(data?.to || '')) ? String(data.to) : ''
    if (date) {
      if (date !== _expectedWorldDate) {
        _expectedWorldDate = date
        _worldRevision++
      }
      poller.kick()
      return
    }
    // 旧后端或异常载荷没有目标日期时，清期望并重锚；新快照有 programDate 用 programDate，
    // 没有时退回报纸 publish_date，仍能恢复到当前世界日期。
    reanchorWorldDate()
  }

  function reanchorWorldDate() {
    // 断线、轮询停止后重启、旧后端无 to 的 rollover 都可能错过真实日期变化。
    // 清掉旧期望并提升代际，让下一条完整快照重新锚定。
    _expectedWorldDate = ''
    _worldRevision++
    poller.kick()
  }

  const onConnected = reanchorWorldDate

  /** 打开看过即消红点（同一期内不再提醒；配图补印不重新点亮） */
  function markRead(paper) {
    const target = paper || todayPaper.value
    const date = target?.publish_date
    if (!date) return
    if (date === lastReadDate.value) return
    lastReadDate.value = date
    writeStoredDate(date)
  }

  function startPolling() {
    _pollingRefs++
    if (_pollingRefs > 1) return
    // 世界翻篇（程序日期变了）立刻拉新一期，不用等下一个 60s 轮询
    //（2026-10-01 用户：「日报的板块如果日期更新了也要去更新日报」；后端在 programDayRollover 里广播）
    unsubscribeRollover = onEvent('program_day_rollover', onProgramDayRollover)
    unsubscribeConnected = onEvent('connected', onConnected)
    // stopPolling 期间可能跨日或调时；每次重新开始轮询都必须接受新一轮完整快照。
    _expectedWorldDate = ''
    _worldRevision++
    // /today 自带 programDate；断线和世界翻篇都由新快照完成确认。
    poller.start()
  }

  function stopPolling() {
    _pollingRefs = Math.max(0, _pollingRefs - 1)
    if (_pollingRefs > 0) return
    poller.stop()
    if (unsubscribeRollover) {
      unsubscribeRollover()
      unsubscribeRollover = null
    }
    if (unsubscribeConnected) {
      unsubscribeConnected()
      unsubscribeConnected = null
    }
  }

  return {
    todayPaper, lastReadDate, loading, unread,
    fetchToday, markRead, startPolling, stopPolling,
  }
})
