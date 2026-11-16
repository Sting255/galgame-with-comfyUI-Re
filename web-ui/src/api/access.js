async function request(path, options) {
  const response = await fetch(`/api/access${path}`, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '连接失败，请重试')
  return data
}
export const getDeviceAccess = () => request('')
export const pairDevice = code => request('/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }),
})

/**
 * 申请设备令牌（P0-02）。
 *
 * 原生 SSE 用 HttpURLConnection，拿不到网页里的 HttpOnly Cookie，
 * 所以配对成功后要为它单独取一个可撤销的令牌。
 * 返回的 `token` 只出现这一次：调用方必须立刻交给原生桥，不要存 localStorage。
 */
export const requestDeviceToken = label => request('/device-token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: String(label || '').slice(0, 60) }),
})

/** 列出已签发的设备令牌（不含原文，只给元数据） */
export const listDeviceTokens = () => request('/device-tokens')

/** 撤销设备令牌；不传 id 等于撤销全部（仅本机可用） */
export const revokeDeviceToken = id => request('/device-tokens/revoke', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(id ? { id } : {}),
})
