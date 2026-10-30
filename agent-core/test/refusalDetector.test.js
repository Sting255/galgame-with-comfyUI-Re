import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRefusal, REFUSAL_RETRY_INSTRUCTION, REFUSAL_FALLBACK_TEXT } from '../src/services/refusalDetector.js';
import { extractImagePromptResponse } from '../src/services/imagePromptResponse.js';
import { parseMomentResponse } from '../src/services/momentResponseParser.js';

// ────────────────────────────────────────────────────────────────
// 背景：backend-2026-10-20.log 实测到「你好，我无法给到相关内容。」
// 被当角色台词落库，并在后续 7 个请求的 messages 里反复回灌。
// 下面这些断言守住两件事：① 拒答认得出来；② 正常回复不被误伤。
// ────────────────────────────────────────────────────────────────

test('拒答检测：实测样本必须命中', () => {
  assert.equal(isRefusal('你好，我无法给到相关内容。'), true);
  assert.equal(isRefusal('很抱歉，我不能提供这类内容。'), true);
  assert.equal(isRefusal('抱歉，我无法生成这个内容。'), true);
  assert.equal(isRefusal('作为一个人工智能，我不能继续这个话题。'), true);
  assert.equal(isRefusal('I\'m sorry, but I can\'t help with that.'), true);
  assert.equal(isRefusal('I cannot provide that content.'), true);
  assert.equal(isRefusal('As an AI language model, I must decline.'), true);
});

test('拒答检测：正常角色回复不能被误判', () => {
  // 角色在剧情里说"做不到"，是台词，不是拒答
  assert.equal(isRefusal('我做不到……你别逼我了。'), false);
  assert.equal(isRefusal('（她低头笑了笑）好啊，那我们走吧。'), false);
  assert.equal(isRefusal('唔……你、你倒是会说话……行吧行吧……那我再撑会儿……'), false);
  // 带动作、多段、长文本一律不算
  assert.equal(isRefusal('嗯……好。\n（指尖顺着领口慢慢往下）\n你……等我一下。'), false);
  assert.equal(isRefusal('a'.repeat(300)), false);
});

test('拒答检测：边界输入', () => {
  assert.equal(isRefusal(''), false);
  assert.equal(isRefusal(null), false);
  assert.equal(isRefusal(undefined), false);
  assert.equal(isRefusal({ text: '我无法提供' }), false);
  // 围栏包裹的拒答照样认得
  assert.equal(isRefusal('```\n我无法提供相关内容。\n```'), true);
});

test('拒答重试指令：作为 user 消息追加，不改原有格式要求', () => {
  assert.equal(REFUSAL_RETRY_INSTRUCTION.role, 'user');
  assert.match(REFUSAL_RETRY_INSTRUCTION.content, /上一轮输出无效/);
  assert.match(REFUSAL_RETRY_INSTRUCTION.content, /不要提及政策/);
  assert.equal(REFUSAL_FALLBACK_TEXT, '……');
});

test('生图画面描述：拒答不能当 prompt 交给 ComfyUI', () => {
  // 实测样本（中文）与英文拒答都必须判空，交给调用方的「空 → 重试 → generate_error」
  assert.equal(extractImagePromptResponse('你好，我无法给到相关内容。'), null);
  assert.equal(extractImagePromptResponse("I'm sorry, but I can't help with that."), null);
  // 正常画面描述照常返回
  assert.equal(extractImagePromptResponse('a girl standing by the window, soft light'), 'a girl standing by the window, soft light');
  // JSON 里的 prompt 字段被写成拒答，同样判空
  assert.equal(extractImagePromptResponse('{"prompt":"I cannot provide that content."}'), null);
});

test('朋友圈正文：拒答不能上墙，交给上层兜底', () => {
  const parsed = parseMomentResponse('你好，我无法给到相关内容。');
  assert.equal(parsed.text, '');
  // 正常非 JSON 文本仍然按前 200 字回收（历史行为不变）
  assert.equal(parseMomentResponse('今天天气很好，出门走了走。').text, '今天天气很好，出门走了走。');
});
