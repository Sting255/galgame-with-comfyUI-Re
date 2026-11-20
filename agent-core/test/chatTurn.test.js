import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './harness/appHarness.js';
import { hasActiveChatStream } from '../src/services/chatActivity.js';

test('私聊流式回复完整落库，client_msg_id 重试不重复写入或请求模型', async t => {
  const h = await appHarness(t, [{ chunks: ['你好，', '今天一起散步吧。'] }]);
  const id = h.character('私聊样本');
  const body = { message: '你好', client_msg_id: 'turn-fixture', image_mode: 'off' };
  const result = await h.post(`/api/characters/${id}/chat`, body);
  assert.equal(result.status, 200);
  assert.doesNotMatch(result.text, /event: error\n/);
  const rows = h.db.prepare('SELECT role,content FROM raw_messages WHERE conversation_id=? ORDER BY id').all(`char_${id}`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, '你好');
  assert.equal(rows[1].content, '你好，今天一起散步吧。');
  const requests = h.stub.requests.length;
  const retried = await h.post(`/api/characters/${id}/chat`, body);
  assert.equal(retried.status, 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM raw_messages WHERE conversation_id=?').get(`char_${id}`).n, 2);
  assert.equal(h.stub.requests.length, requests);
});

test('长度截断自动续写，保持一条完整 assistant 原文', async t => {
  const h = await appHarness(t, [{ text: '我们沿着小路', finish: 'length' }, { text: '走到了河边。' }]);
  const id = h.character('续写样本');
  const result = await h.post(`/api/characters/${id}/chat`, { message: '继续故事', image_mode: 'off' });
  assert.equal(result.status, 200);
  const reply = h.db.prepare("SELECT content FROM raw_messages WHERE conversation_id=? AND role='assistant'").pluck().get(`char_${id}`);
  assert.equal(reply, '我们沿着小路走到了河边。');
  assert.equal(h.stub.requests.filter(r => r.stream).length, 2);
});

test('无效私聊输入不写库、不请求模型', async t => {
  const h = await appHarness(t);
  const result = await h.post('/api/characters/999/chat', { message: '  ' });
  assert.equal(result.status, 400);
  assert.equal(h.stub.requests.length, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM raw_messages').get().n, 0);
});

test('客户端取消后及时中止上游生成，不把未完成回复记成完整一轮', async t => {
  const h = await appHarness(t, [{ chunks: ['第一句已经送达。', '第二句尚未生成。', '最后一句。'], delay: 500 }]);
  const id = h.character('取消样本');
  const controller = new AbortController();
  const response = await fetch(`${h.url}/api/characters/${id}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '开始讲故事', image_mode: 'off', client_msg_id: 'cancel-fixture' }),
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('第一句已经送达')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.equal(hasActiveChatStream(), true);
  controller.abort();
  // 以真实 HTTP 断连为证据，不能只检查路由是否注册了 abort 监听器。
  const deadline = Date.now() + 1000;
  while (!h.stub.closedStreams.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(h.stub.closedStreams, [{ completed: false }]);
  assert.equal(hasActiveChatStream(), false);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM raw_messages WHERE conversation_id=? AND role='user'").get(`char_${id}`).n, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM private_chat_replies').get().n, 0);
});

test('上游异常断流报告失败，原 client_msg_id 可重试且不重复写入用户消息', async t => {
  const h = await appHarness(t, [
    { chunks: ['这段回答尚未结束。'], delay: 30, disconnect: true },
    { text: '重新生成的完整回答。' },
  ]);
  const id = h.character('断流样本');
  const body = { message: '讲一个故事', client_msg_id: 'disconnect-fixture', image_mode: 'off' };
  const first = await h.post(`/api/characters/${id}/chat`, body);
  assert.match(first.text, /event: error\n/);
  assert.equal(hasActiveChatStream(), false);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM private_chat_replies').get().n, 0);
  const retry = await h.post(`/api/characters/${id}/chat`, body);
  assert.doesNotMatch(retry.text, /event: error\n/);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM raw_messages WHERE conversation_id=? AND role='user'").get(`char_${id}`).n, 1);
  assert.equal(h.db.prepare("SELECT content FROM raw_messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1").get(`char_${id}`).content, '重新生成的完整回答。');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM private_chat_replies').get().n, 1);
});
