/**
 * 统一 SSE 总线
 *
 * 替代 3 个独立 SSE 端点各自维护客户端 Set 的架构：
 *   - /api/events/stream
 *   - /api/moments/stream
 *   - /api/notifications/stream
 *
 * 所有模块广播到同一组客户端，前端只需 1 个 HTTP 连接接收所有事件。
 * 释放 HTTP/1.1 6 连接限制下的 2 个连接位。
 */

const clients = new Set();

/**
 * 单个 SSE 客户端的待写缓冲上限（2026-11-09 方案 B06）。
 *
 * `res.write()` 是非阻塞的：客户端读得慢（后台标签页、手机休眠、网络差）时数据会积压在
 * Node 的 socket 写缓冲里。原来完全不看水位，一个卡住的客户端就能把积压堆到几十 MB，
 * 最后拖垮整个进程 —— 而且拖累的是**所有**连接的用户。
 *
 * 超过上限就只断开这一个客户端（它重连后靠快照把丢掉的事件补回来），不影响其他人。
 * 1MB ≫ 单条 SSE 事件（几百字节到几 KB，配图走 URL 不走 SSE），正常客户端不可能到这个量。
 */
const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

/**
 * @param {string} eventType - SSE event type (e.g. 'new_event', 'new_post', 'proactive_message')
 * @param {object} data - JSON-serializable payload
 */
export function broadcast(eventType, data) {
  if (clients.size === 0) return;
  let payload;
  try {
    payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  } catch (e) {
    console.error(`[unifiedSSE] broadcast failed — JSON.stringify error for ${eventType}:`, e.message);
    return;
  }
  for (const client of clients) {
    // 已结束/已销毁的连接：清掉，别再往里写
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      continue;
    }
    // 慢客户端：积压超过上限就断开这一个，不阻塞全体
    if (Number(client.writableLength) > MAX_CLIENT_BUFFER_BYTES) {
      console.warn(`[unifiedSSE] 客户端待写缓冲 ${client.writableLength} 字节超限（累计事件过多），断开该连接，重连后由快照纠正`);
      clients.delete(client);
      try { client.destroy(); } catch { /* 已关闭 */ }
      continue;
    }
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
      try { client.destroy(); } catch { /* 已关闭 */ }
    }
  }
}

/**
 * 活跃客户端数（调试用）
 *
 * ⚠️ 死导出（2026-10-15 标注，**只标注不删**）：零调用点。
 * 它自己的注释就写了"调试用" —— 真机排查 SSE 是否健在时会手动调一下，
 * 所以刻意保留（不是漏删的残留）。同批清单见 `scripts/scan-dead-code.mjs`。
 */
export function clientCount() {
  return clients.size;
}
