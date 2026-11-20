import { selectedLocalTtsModel } from './localTtsModels.js';
import { ttsServiceToken, peekTtsServiceToken } from './ttsServiceToken.js';

const base = () => (process.env.TTS_SERVICE_URL || 'http://127.0.0.1:7861').replace(/\/+$/, '');
export async function ttsRequest(route, body, timeout = 10000) {
  let response;
  try {
    response = await fetch(`${base()}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TTS-Token': ttsServiceToken() },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
  } catch (cause) {
    const timedOut = cause.name === 'TimeoutError' || cause.name === 'AbortError';
    throw new Error(timedOut
      ? '本地语音服务响应超时，请稍后重试'
      : '无法连接本地语音服务，请启动服务后重试', { cause });
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `TTS 服务错误 (${response.status})`);
  return data;
}
export async function ttsHealth(timeout = 10000) {
  try {
    const status = await ttsRequest('/health', undefined, timeout);
    return { ...status, online: true, compatible: status.model_version === selectedLocalTtsModel().version };
  } catch (e) { return { online: false, compatible: false, error: e.message }; }
}
export const unloadTts = (options = {}) => ttsRequest('/unload', options, 30000);

/**
 * 让 TTS adapter 自行退出（P1-15）。
 *
 * 由 agent-core 的优雅退出调用。服务没启动时本函数**不抛错**——
 * 那是最常见的情况，不该被当成退出失败。
 *
 * 关键细节：**退出流程不能创建凭证**。
 * `ttsServiceToken()` 在文件不存在时会生成并落盘，而退出时的探活请求会顺带调用它，
 * 结果就是「只是关个程序」却在 data/ 里写入一个新的 Token 文件。
 * 所以这里先用 peek 版本：没有 Token ⇒ 这一轮根本没配过语音服务 ⇒ 直接返回。
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok:boolean, running:boolean, unloaded?:boolean, error?:string}>}
 */
export async function shutdownSpeechService({ timeoutMs = 8000 } = {}) {
  // 没有 Token 说明本进程从未配置/使用过语音服务：不探活、不创建任何文件
  if (!peekTtsServiceToken()) return { ok: true, running: false };
  const health = await ttsHealth(Math.min(timeoutMs, 3000));
  if (!health.online) return { ok: true, running: false };
  try {
    const result = await ttsRequest('/shutdown', { idle_only: true }, timeoutMs);
    return { ok: true, running: true, unloaded: result?.unloaded === true, error: result?.unload_error };
  } catch (error) {
    // 超时/连接被重置都可能出现在「服务正在退出」的过程中，如实回报但不影响主进程退出
    return { ok: false, running: true, error: error?.message || String(error) };
  }
}
