/**
 * useProgramClock —— 把「程序时间」推广到所有面向用户的时间显示
 *
 * 背景（2026-10-30 用户反馈）：程序时间被调过之后，角色住在另一个时间线上——
 * 她可能说「晚上好」，而聊天时间戳显示现实里的中午；日程写着今天，消息列表写着明天。
 * 割裂感来自**同一屏里混用了两套时钟**：角色状态走程序时间，消息时间走真实时间。
 *
 * 口径：程序时间 = 真实时间 + offsetMs（后端 routes/time.js 的既有定义）。
 * 这里只负责把这个 offset 拉到前端并换算，不改任何记录本身——DB 里存的仍是真实时间，
 * 关掉程序时间（offsetMs = 0）时显示立刻回到真实时间。
 *
 * 用法：
 *   const clock = useProgramClock()
 *   await clock.ensureLoaded()          // 进页面拉一次，之后走缓存
 *   clock.toProgram(msg.created_at)     // 展示用
 *   clock.now()                         // 「刚刚 / N 分钟前」这类相对时间要拿它做基准
 */
import { ref } from 'vue'
import { getProgramTime } from '../api/timeControl.js'

const offsetMs = ref(0)
const loaded = ref(false)
let inflight = null

async function ensureLoaded({ force = false } = {}) {
  if (loaded.value && !force) return offsetMs.value
  if (inflight && !force) return inflight
  inflight = (async () => {
    try {
      const state = await getProgramTime()
      offsetMs.value = Number(state?.offsetMs) || 0
      loaded.value = true
    } catch {
      // 拿不到就退回真实时间：宁可显示真实时间，也不要显示一个来路不明的偏移
      offsetMs.value = 0
    } finally {
      inflight = null
    }
    return offsetMs.value
  })()
  return inflight
}

/** 真实时间 → 程序时间（入参可以是 Date、时间戳或 ISO 字符串） */
function toProgram(input) {
  if (input == null || input === '') return null
  const base = input instanceof Date ? input.getTime() : new Date(input).getTime()
  if (!Number.isFinite(base)) return null
  return new Date(base + offsetMs.value)
}

/** 程序时间下的「现在」 */
function now() {
  return new Date(Date.now() + offsetMs.value)
}

export function useProgramClock() {
  return { offsetMs, loaded, ensureLoaded, toProgram, now }
}
