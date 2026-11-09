// 全局错误处理：统一 { error } 响应格式。
// 5xx 类错误不透出内部 err.message（可能包含 SQL/路径细节），只记日志。
export function errorHandler(err, req, res, _next) {
  const rid = req?.requestId ? ` [${req.requestId}]` : '';
  console.error(`[ERROR]${rid} ${req.method} ${req.path}:`, err.message);

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body', requestId: req?.requestId });
  }

  const status = err.status || err.statusCode || 500;
  const message = status < 500 && err.message
    ? err.message
    : 'Internal server error';

  // 把请求 id 回给前端：用户截图报错时，日志里能直接对上这一次请求。
  // 只回 id，不回任何内部细节（SQL/路径仍只进服务端日志）。
  res.status(status).json({ error: message, requestId: req?.requestId });
}
