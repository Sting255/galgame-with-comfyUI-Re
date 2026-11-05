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
