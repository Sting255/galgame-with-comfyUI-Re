import http from 'node:http';
import { once } from 'node:events';

/** 本地 OpenAI 协议替身：可编排分片、长度截断、HTTP 失败与主动断流。 */
export async function startLlmStub(t, responses = []) {
  const queue = [...responses];
  const requests = [];
  const closedStreams = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    requests.push(payload);
    const next = queue.shift();
    if (!next) { res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'LLM stub response queue exhausted' } })); return; }
    const reply = typeof next === 'function' ? await next(payload) : next;
    if (reply.status) { res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: reply.error || 'fixture error' } })); return; }
    if (payload.stream) {
      res.on('close', () => closedStreams.push({ completed: res.writableEnded }));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      for (const text of reply.chunks || [reply.text || '']) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
        if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay));
      }
      if (reply.disconnect) { res.destroy(); return; }
      res.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: reply.finish || 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content: reply.text || '' }, finish_reason: reply.finish || 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, closedStreams, enqueue: (...items) => queue.push(...items) };
}
