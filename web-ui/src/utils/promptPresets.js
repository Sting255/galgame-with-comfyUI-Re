export const markerIds = new Set(['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'personaDescription', 'scenario', 'dialogueExamples', 'chatHistory', 'agentSystemPrompt', 'agentTask', 'agentResults'])
export const isPresetMarker = prompt => !!prompt?.marker || markerIds.has(prompt?.identifier)
export const presetSnapshot = item => JSON.stringify([item.name, item.orderId, item.document])
export function presetOrder(item) {
  return item?.document.prompt_order.find(p => String(p.character_id) === String(item.orderId))?.order || []
}
export function presetRows(item) {
  if (!item) return []
  const prompts = new Map(item.document.prompts.map(p => [p.identifier, p]))
  const order = presetOrder(item)
  const included = new Set(order.map(p => p.identifier))
  return [
    ...order.map((entry, index) => ({ entry, prompt: prompts.get(entry.identifier), index })),
    ...item.document.prompts.filter(p => !included.has(p.identifier)).map(prompt => ({ prompt, entry: { identifier: prompt.identifier, enabled: false }, index: -1 })),
  ]
}
export function setPresetEntryEnabled(item, identifier, enabled) {
  const order = presetOrder(item)
  const entry = order.find(p => p.identifier === identifier)
  if (entry) entry.enabled = enabled
  else order.push({ identifier, enabled })
}
export function movePresetEntry(item, identifier, delta) {
  const order = presetOrder(item)
  const from = order.findIndex(p => p.identifier === identifier)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return
  order.splice(to, 0, ...order.splice(from, 1))
}
export function removePresetEntry(item, identifier) {
  item.document.prompts = item.document.prompts.filter(p => p.identifier !== identifier)
  for (const profile of item.document.prompt_order) profile.order = profile.order.filter(p => p.identifier !== identifier)
}
// 显示文本与实际输出逐字节一致，仅为有输出的条目添加定位锚点。
export function presetPreviewSegments(result, selectedId) {
  const content = result?.content || '', segments = []
  const selectedEntry = result?.entries?.find(entry => entry.identifier === selectedId)
  const ranges = selectedEntry?.ranges || (selectedEntry?.reason === 'included' ? [selectedEntry] : [])
  const append = (start, end, identifier) => {
    const boundaries = [...new Set([start, end, ...ranges.flatMap(r => [r.start, r.end]).filter(n => n > start && n < end)])].sort((a,b) => a-b)
    for (let i=1;i<boundaries.length;i++) {
      const from=boundaries[i-1], to=boundaries[i]
      segments.push({identifier,text:content.slice(from,to),selected:ranges.some(r=>r.start<=from && r.end>=to)})
    }
  }
  let cursor = 0
  for (const entry of result?.entries || []) {
    if (entry.reason !== 'included' || !Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.start < cursor || entry.end > content.length) continue
    if (entry.start > cursor) append(cursor,entry.start)
    append(entry.start,entry.end,entry.identifier)
    cursor = entry.end
  }
  if (cursor < content.length) append(cursor,content.length)
  return segments
}

// 显式控制滚动时长，避免浏览器对长距离跳转的处理不一致。
// 切换目标时从当前位置继续滚动，手动滚动则取消动画。
export function createPresetScroller({requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, reducedMotion = () => false} = {}) {
  let frame
  const cancel = () => { if (frame != null) cancelFrame(frame); frame = undefined }
  const scroll = (element, top) => {
    cancel()
    const from = element.scrollTop, to = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight))
    if (reducedMotion() || Math.abs(to-from) < 1) { element.scrollTo({top:to,behavior:'instant'}); return }
    const duration = Math.min(650, 300 + Math.abs(to-from) * .025)
    let started
    const step = time => {
      started ??= time
      const progress = Math.min(1,(time-started)/duration)
      const eased = progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
      element.scrollTo({top:from+(to-from)*eased,behavior:'instant'})
      frame = progress < 1 ? requestFrame(step) : undefined
    }
    frame = requestFrame(step)
  }
  return {scroll,cancel}
}
