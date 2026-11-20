/** 统一跟踪 HTTP 响应，退出时先结束 SSE，再等待普通请求，超时也执行资源收尾。 */
export function createHttpLifecycle() {
  const responses = new Set();
  let stopping = false;
  return {
    middleware(req, res, next) {
      if (stopping) return res.status(503).json({ error: '邻舍正在退出' });
      responses.add(res);
      res.once('close', () => responses.delete(res));
      next();
    },
    async close(server, { timeoutMs = 4000 } = {}) {
      stopping = true;
      const closed = new Promise(resolve => server.close(() => resolve(true)));
      for (const res of responses) {
        if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) res.end();
      }
      server.closeIdleConnections?.();
      let timer;
      const graceful = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
      clearTimeout(timer);
      if (!graceful) {
        for (const res of responses) res.destroy();
        server.closeAllConnections?.();
      }
      return graceful;
    },
  };
}
