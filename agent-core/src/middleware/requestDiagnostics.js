// HTTP 请求诊断中间件（2026-11-09 方案 B11）
//
// 目标：出错时能定位「哪一次请求」。已经有 LLM/生图的任务 id 贯通，这里只补一个
// **轻量的请求身份**，不新建一套追踪系统、不引入额外依赖、不写磁盘日志。
//
// 做什么：
// 1. 每个请求分配短 id（复用客户端 `X-Request-Id` 时保持一致，方便前后端对账），
//    写进响应头 `X-Request-Id`。
// 2. 请求结束时记一行状态 + 耗时；只有「5xx」「4xx」和「超过阈值的慢请求」进日志，
//    正常快请求不打，避免刷屏。
// 3. 把 id 挂到 req 上，errorHandler 与异步任务可以带出来。
//
// 不在生产界面暴露底层细节：这些只是服务端日志，前端只拿到请求 id 用于报错引用。

import { randomUUID } from 'crypto';

/** 超过这个耗时（毫秒）就记一条慢请求，即使成功 */
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 5000;
/** 只记录这些路径前缀的慢请求，静态资源（图片/前端包）本来就大，不参与判断 */
const STATIC_PREFIX = /^\/(images|avatars|assets|static)\//;

export function requestDiagnostics() {
  return (req, res, next) => {
    const incoming = String(req.get?.('x-request-id') || '').trim();
    // 客户端传的 id 只接受安全字符，避免被拿来做日志注入
    req.requestId = /^[\w-]{6,64}$/.test(incoming) ? incoming : randomUUID().slice(0, 8);
    const startedAt = process.hrtime.bigint();
    res.setHeader('X-Request-Id', req.requestId);

    let logged = false;
    const finish = (event) => {
      if (logged) return;
      logged = true;
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = res.statusCode || 0;
      const path = String(req.originalUrl || req.url || '').split('?')[0];
      const isStatic = STATIC_PREFIX.test(path);
      const isProblem = status >= 400
        // 客户端主动断开（499/aborted）不算服务端问题，但还是记一行便于排查"为什么没图"
        || event === 'aborted';
      if (isProblem) {
        const level = status >= 500 ? '[req][ERR]' : '[req][WARN]';
        console.warn(`${level} ${req.requestId} ${req.method} ${path} → ${status} ${ms.toFixed(0)}ms${event !== 'finish' ? ` (${event})` : ''}`);
      } else if (!isStatic && ms >= SLOW_MS) {
        console.warn(`[req][SLOW] ${req.requestId} ${req.method} ${path} → ${status} ${ms.toFixed(0)}ms`);
      }
    };

    res.on('finish', () => finish('finish'));
    res.on('close', () => finish(res.writableFinished ? 'finish' : 'aborted'));
    next();
  };
}