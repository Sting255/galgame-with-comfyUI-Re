import test from 'node:test';
import assert from 'node:assert/strict';
import { withGalgameEmojiPreference } from '../src/services/chatModePrompt.js';

test('Galgame preference leads the latest user layer without altering system rules or stored dialogue', () => {
  const history = Object.freeze([
    Object.freeze({ role: 'system', content: '稳定人设与表情包规则' }),
    Object.freeze({ role: 'user', content: '历史用户消息' }),
    Object.freeze({ role: 'assistant', content: '历史回复' }),
    Object.freeze({ role: 'user', content: '<dynamic_context>本轮状态</dynamic_context>\n你好' }),
  ]);
  const result = withGalgameEmojiPreference(history, { galgameMode: true, hasEmojis: true });
  assert.equal(result.length, history.length);
  assert.deepEqual(result.slice(0, -1), history.slice(0, -1));
  assert.equal(result.at(-1).role, 'user');
  assert.match(result.at(-1).content, /^<galgame_emoji_preference>\n你很喜欢发表情包[^\n]+\n<\/galgame_emoji_preference>\n\n<dynamic_context>/);
  assert.ok(result.at(-1).content.endsWith(history.at(-1).content));
  assert.equal(history.at(-1).content, '<dynamic_context>本轮状态</dynamic_context>\n你好');
  assert.deepEqual(withGalgameEmojiPreference(history, { galgameMode: true, hasEmojis: true }), result, 'retrying the original messages must not accumulate preferences');
});

test('ordinary chat, a false string flag and missing stickers keep the request unchanged', () => {
  const messages = [{ role: 'user', content: '你好' }];
  for (const options of [{}, { galgameMode: false, hasEmojis: true }, { galgameMode: 'false', hasEmojis: true }, { galgameMode: true, hasEmojis: false }]) {
    assert.equal(withGalgameEmojiPreference(messages, options), messages);
  }
});

test('planned replies and memory continuations retain their content after the leading preference', () => {
  for (const context of ['<reply_plan>用开心表情回应</reply_plan>', '<memory_recall_result>回想结果</memory_recall_result>']) {
    const messages = [{ role: 'system', content: '角色资料' }, { role: 'user', content: `${context}\n本轮用户消息` }];
    const result = withGalgameEmojiPreference(messages, { galgameMode: true, hasEmojis: true });
    assert.match(result.at(-1).content, /^<galgame_emoji_preference>\n你很喜欢发表情包[^\n]+\n<\/galgame_emoji_preference>\n\n/);
    assert.ok(result.at(-1).content.endsWith(messages.at(-1).content));
    assert.deepEqual(result[0], messages[0]);
  }
});
