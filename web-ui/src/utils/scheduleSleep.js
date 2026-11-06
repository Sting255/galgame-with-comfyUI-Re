/** 只使用普通日程状态；临时叫醒优先于原有睡眠时段。 */
export function describeScheduleSleep(state) {
  if (!state) return '状态未知'
  if (state.is_temp_woken) return '暂时清醒'
  if (state.is_sleeping) return '睡眠中'
  if (state.sleep_kind === 'nap') return '小憩中'
  return '清醒'
}

export function summarizeScheduleSleep(states, group = false) {
  if (!group) return describeScheduleSleep(states[0])
  if (!states.length) return '状态未知'
  const counts = new Map()
  for (const state of states) {
    const label = describeScheduleSleep(state)
    if (label !== '清醒') counts.set(label, (counts.get(label) || 0) + 1)
  }
  return counts.size ? [...counts].map(([label, count]) => `${count} 人${label}`).join(' · ') : '全员清醒'
}
