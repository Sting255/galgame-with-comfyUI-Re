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
import { planOfflineChunks } from '../agent-core/src/services/offlineChronicle.js';
import { nudgeBond, readBond, describeBond, nudgeBondsFromText } from '../agent-core/src/services/groupBonds.js';
import { setProgramOffsetMs, resetProgramTime } from '../agent-core/src/services/programTime.js';

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

// 6) 离线编年分片
const base = new Date('2026-11-06T12:00:00Z');
const p2 = planOfflineChunks(base, new Date(base.getTime() - 2 * 3600_000));
check('离线 2 小时不补', p2.shouldRun, false);
const p8 = planOfflineChunks(base, new Date(base.getTime() - 8 * 3600_000));
check('离线 8 小时补 2 片', p8.chunks.length, 2);
check('8 小时无尾段', Boolean(p8.tail), false);
const p72 = planOfflineChunks(base, new Date(base.getTime() - 72 * 3600_000));
check('离线 72 小时补 4 片', p72.chunks.length, 4);
check('72 小时带尾段概况', Boolean(p72.tail), true);
check('分片首尾相接', p72.chunks[0].to.getTime(), p72.chunks[1].from.getTime());

// 7) 关系温度（前面的群聊测试可能已经调过一次，所以全部用相对值断言）
const round1 = (n) => Math.round(Number(n) * 10) / 10;
const bondStart = readBond(a, b);
nudgeBond(a, b, { text: '闭嘴，别烦我' });
check('负面一句扣 0.3', round1(readBond(a, b) - bondStart), -0.3);
const afterNegative = readBond(a, b);
nudgeBond(a, b, { text: '今天的天气不错' });
check('正面向加 0.1', round1(readBond(a, b) - afterNegative), 0.1);
// 一直扣到日预算耗尽，必须出现一次"拒绝变动"
let rejected = false;
for (let i = 0; i < 6; i++) {
  if (!nudgeBond(a, b, { text: '闭嘴' })) { rejected = true; break; }
}
check('日预算耗尽后拒绝继续变动', rejected, true);
check('温度有可读描述', typeof describeBond(readBond(a, b)), 'string');

// 8) 私聊台词提到别人 → 影响她们之间的温度
const bondBefore = readBond(c, a);
nudgeBondsFromText(c, '角色A又迟到了，烦死了');
check('私聊提名字也能影响温度', round1(readBond(c, a) - bondBefore), -0.3);

// 9) 世界钟对齐：拨快一天后写入的时间轴应落在程序时间
setProgramOffsetMs(24 * 3600_000);
const realNow = Date.now();
const beforeOffsetRow = recordWorldTimeline({ kind: 'event', title: '拨钟测试', summary: 's', sourceId: 'verify-clock-1' });
const row = db.prepare('SELECT at FROM world_timeline WHERE id = ?').get(beforeOffsetRow);
const drift = Math.abs(new Date(row.at).getTime() - (realNow + 24 * 3600_000));
check('时间轴按程序时间存储（误差 < 5 秒）', drift < 5000, true);
resetProgramTime();

console.log(`\n合计 ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
