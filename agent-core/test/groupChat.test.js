import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './harness/appHarness.js';
import { planTouchBystander } from '../src/services/groupTouchConsumption.js';
import { writeGroupUserMessage } from '../src/services/groupChatEngine.js';

test('群聊按剧本顺序落库，非成员发言不能冒充群成员', async t => {
  const h = await appHarness(t, [{ chunks: ['甲: 先去河边吧。\n', '陌生人: 我不该发言。\n', '乙: 好，我带相机。\n[END]'] }], { groups: true });
  const first = h.character('甲');
  const second = h.character('乙');
  const created = await h.post('/api/groups', { name: '合成群聊', member_ids: [first, second] });
  assert.equal(created.status, 200);
  const groupId = JSON.parse(created.text).group.id;
  assert.ok(groupId);
  const result = await h.post(`/api/groups/${groupId}/chat`, { message: '去哪里玩？', client_msg_id: 'group-fixture' });
  assert.equal(result.status, 200);
  assert.doesNotMatch(result.text, /event: error\n/);
  const rows = h.db.prepare("SELECT speaker_character_id,content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id").all(`group_${groupId}`);
  assert.deepEqual(rows.map(row => row.speaker_character_id), [first, second]);
  assert.equal(rows[0].content, '先去河边吧');
  assert.equal(rows[1].content, '好，我带相机');
});

test('群聊同一 client_msg_id 的用户输入只落库一次', async t => {
  const h = await appHarness(t, [], { groups: true });
  const a = h.character('幂等甲');
  const b = h.character('幂等乙');
  const created = await h.post('/api/groups', { name: '幂等群', member_ids: [a, b] });
  const groupId = JSON.parse(created.text).group.id;
  const first = writeGroupUserMessage(groupId, '只写一次', 'same-group-turn');
  const again = writeGroupUserMessage(groupId, '只写一次', 'same-group-turn');
  assert.equal(again.duplicate, true);
  assert.equal(again.rawId, first.rawId);
  assert.equal(again.msgId, first.msgId);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM raw_messages WHERE conversation_id=? AND role='user'").get(`group_${groupId}`).n, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='user'").get(`group_${groupId}`).n, 1);
});

test('围观决策只选择另一位成员，关闭或未命中时无人插话', () => {
  const members = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const picked = planTouchBystander({ members, excludeId: 1, chance: 1, random: () => 0 });
  assert.equal(picked.allowed, true);
  assert.equal(picked.member.id, 2);
  assert.equal(planTouchBystander({ members, excludeId: 1, chance: 0, random: () => 0.5 }).member, null);
  assert.equal(planTouchBystander({ members, excludeId: 1, chance: null }).allowed, false);
  assert.equal(planTouchBystander({ members: [{ id: 1 }], excludeId: 1, chance: 1 }).allowed, false);
});
