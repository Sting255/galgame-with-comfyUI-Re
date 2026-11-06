/**
 * verify-group-and-god.mjs —— 按需手动跑的验证脚本（不是测试收集链）
 *
 * 覆盖两处容易悄悄坏掉的逻辑：
 *   1. 角色间互动记录（inter_character_events）：抽取、去重、长名优先、注入块
 *   2. 神说定时投递（god_world_deliveries.next_attempt_at）：延后生效、到点前不可见
 *
 * 用法（必须在 agent-core 目录下、用仓库自带 node）：
 *   cd agent-core
 *   DB_PATH=":memory:" ../runtime/nodejs/node.exe ../scripts/verify-group-and-god.mjs
 */
import { getDb } from '../agent-core/src/db/index.js';
import { recordInterCharacterEvents, buildRecentInteractionsBlock } from '../agent-core/src/services/groupInterCharacterEvents.js';
import { createWorldEventService } from '../agent-core/src/services/godSays/worldEvents.js';
import { recordWorldTimeline, buildWorldTimelineBlock } from '../agent-core/src/services/worldTimeline.js';
import { resolveSceneSeed } from '../agent-core/src/services/imageSkill.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
};

const db = getDb();

// ── 造数据：三个角色 + 一个群 ──
const insertChar = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)');
const a = Number(insertChar.run('va', '角色A', 'A 的人格').lastInsertRowid);
const b = Number(insertChar.run('vb', '银狼LV.999', 'B 的人格').lastInsertRowid);
const c = Number(insertChar.run('vc', '银狼', 'C 的人格').lastInsertRowid);
const groupId = Number(db.prepare('INSERT INTO group_chats(name) VALUES (?)').run('验证群').lastInsertRowid);
const insertMember = db.prepare('INSERT INTO group_members(group_id, character_id) VALUES (?,?)');
for (const id of [a, b, c]) insertMember.run(groupId, id);
const members = [{ id: a, display_name: '角色A' }, { id: b, display_name: '银狼LV.999' }, { id: c, display_name: '银狼' }];

// 1) 抽取 + 长名优先（"银狼LV.999"必须命中的是 B，不是 C）
const written = recordInterCharacterEvents({ id: groupId, members }, {
  speakerLines: [
    { characterId: a, text: '银狼LV.999 你今天又通宵了吧' },
    { characterId: a, text: '银狼LV.999 别装睡' },          // 同一个对象，一轮只记一条
    { characterId: b, text: '角色A 少管我' },
  ],
});
check('一轮写入两条（去重后）', written, 2);

const rows = db.prepare('SELECT from_character_id, to_character_id FROM inter_character_events WHERE group_id=? ORDER BY id').all(groupId);
check('第一条指向长名角色 B', Number(rows[0].to_character_id), b);
check('总行数', rows.length, 2);

// 2) 注入块
const block = buildRecentInteractionsBlock(groupId, 6);
check('注入块含双方名字', block.includes('角色A') && block.includes('银狼LV.999'), true);
check('注入块是空时零注入', buildRecentInteractionsBlock(groupId + 999, 6), '');

// 3) 神说定时：延后 90 分钟的世界事件，到点前不可见
const now = new Date('2026-11-06T10:00:00Z');
const repo = { db, now: () => now, timestamp: () => now.toISOString() };
const world = createWorldEventService(repo, {});
const event = world.create({ title: 't', fact: 'f', start_in_minutes: 90, moment_count: 1, group_count: 0 }, { runId: null, effectKey: 'verify-1' });
const expected = new Date(now.getTime() + 90 * 60000).toISOString();
check('事件开始时间顺延', event.created_at, expected);
check('投递时间顺延', event.deliveries[0].next_attempt_at, expected);
const readyNow = db.prepare("SELECT COUNT(*) AS n FROM god_world_deliveries WHERE next_attempt_at<=? AND event_id=?").get(now.toISOString(), event.id).n;
check('到点前不可执行', readyNow, 0);
const readyLater = db.prepare("SELECT COUNT(*) AS n FROM god_world_deliveries WHERE next_attempt_at<=? AND event_id=?").get(new Date(now.getTime() + 91 * 60000).toISOString(), event.id).n;
check('到点后可执行', readyLater, 1);

// 4) 世界时间轴：写入幂等 + 注入块
const t1 = recordWorldTimeline({ kind: 'event', title: '教学楼停电了', summary: '整栋楼黑了十分钟', characterIds: [a], sourceId: 'verify-event-1' });
const t2 = recordWorldTimeline({ kind: 'event', title: '教学楼停电了', summary: '重复写一次', characterIds: [a], sourceId: 'verify-event-1' });
check('时间轴写入成功', Boolean(t1), true);
check('同 sourceId 第二次不写', t2, null);
check('时间轴块包含标题', buildWorldTimelineBlock(3).includes('教学楼停电了'), true);

// 5) 同场景种子：同 key 递增、不同 key 不同基、空 key 走随机
const s1 = resolveSceneSeed('verify:scene');
const s2 = resolveSceneSeed('verify:scene');
const s3 = resolveSceneSeed('verify:other');
check('同场景第二张 seed +1', s2, s1 + 1);
check('不同场景不共用基', s3 === s1, false);
check('空 sceneKey 返回 null', resolveSceneSeed(''), null);

console.log(`\n合计 ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
