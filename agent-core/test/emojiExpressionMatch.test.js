/**
 * 立绘表情切帧：`facial_expression` → 她的表情名（2026-10-21）
 *
 * 用户原话：「动作倒是有了，表情很僵硬，都只有一个微笑，面部也没有别的反应。」
 *
 * 真机证据（`<本机>/Downloads\测试\backend-2026-10-20.log`）：
 *   · 38 条反应里 `facial_expression` 有 **27 种不同取值**，全部是自由组合词：
 *     失神咬唇 / 潮红失神 / 皱眉咬唇 / 仰头失神 / 眼尾泛红 / 羞怯窃喜 / 湿眼失神 …
 *   · 消费端原来的匹配是三行子串判断（精确 → label 含 key → key 含 label），
 *     候选是她那 15 个表情名（开心/难过/哭/生气/哈哈大笑/卖萌/晕倒/害羞/惊讶/委屈/得意/比心/无语/嫌弃/心虚）
 *   · **实测命中 0/27** ⇒ `driveStandingExpression` 每次返回 null ⇒ 立绘永远停在 `normal` 槽位（那张微笑）
 *
 * 修法两层（本文件都钉住）：
 *   ① 消费端：`matchEmojiKey` 的语义别名（27/27 命中，落点逐个断言）
 *   ② prompt 侧：`formatFacialExpressionRule` 把取值收紧成"必须原样照抄她的某个表情名"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  matchEmojiKey,
  formatFacialExpressionRule,
  facialExpressionChoiceText,
  FACIAL_EMOJI_ALIASES,
} from '../src/services/emojiExpressionMatch.js';
import { buildReactionPrompt, buildConversationReactionPrompt } from '../src/services/touchActionService.js';
import { driveStandingExpression } from '../src/services/standingExpression.js';
import { getStandingDisplay } from '../src/services/standingDisplay.js';
import { getDb } from '../src/db/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 真机库里的 15 个表情名（`emoji_categories`，2026-10-20 快照） */
const KEYS = ['开心', '难过', '哭', '生气', '哈哈大笑', '卖萌', '晕倒', '害羞', '惊讶', '委屈', '得意', '比心', '无语', '嫌弃', '心虚'];

/** 真机日志里出现过的全部 27 种 `facial_expression` 取值 + 应落到的表情名（逐一实测出来的，不是猜的） */
const LOG_CASES = [
  ['憋笑发窘', '开心'],
  ['羞怯窃喜', '害羞'],
  ['脸红发怔', '害羞'],
  ['慌乱潮红', '害羞'],
  ['脸红咬唇', '害羞'],
  ['皱眉抿唇', '生气'],
  ['慌乱咬唇', '害羞'],
  ['皱眉咬唇', '害羞'],
  ['仰头咬唇失神', '害羞'],
  ['失神咬唇', '害羞'],
  ['咬唇忍笑', '害羞'],
  ['仰头失神', '惊讶'],
  ['侧脸潮红', '害羞'],
  ['咬唇失神', '害羞'],
  ['潮红失神', '害羞'],
  ['失神潮红', '害羞'],
  ['失神带笑', '惊讶'],
  ['咬唇潮红', '害羞'],
  ['失神', '惊讶'],
  ['仰颈失神', '惊讶'],
  ['失神张口', '惊讶'],
  ['泛泪失神', '哭'],
  ['眼尾泛红', '害羞'],
  ['湿眼失神', '哭'],
  ['喘息失神', '惊讶'],
  ['失神张嘴', '惊讶'],
  ['失神喘息', '惊讶'],
];

test('① 真机 27 种取值全部命中，且落点固定（不再"只有一个微笑"）', () => {
  const misses = [];
  for (const [value, expected] of LOG_CASES) {
    const hit = matchEmojiKey(KEYS, value);
    if (hit !== expected) misses.push(`${value} → ${hit}（期望 ${expected}）`);
  }
  assert.deepEqual(misses, [], '落点漂了就说明别名表被改坏了；先确认是不是有意的');
  assert.equal(LOG_CASES.filter(([v]) => matchEmojiKey(KEYS, v) === null).length, 0);
});

test('② 落点不是一个表情：真机取值至少覆盖 4 个不同表情（证明真的在换帧）', () => {
  const hits = new Set(LOG_CASES.map(([v]) => matchEmojiKey(KEYS, v)));
  assert.ok(hits.size >= 4, `只落到 ${hits.size} 个表情，等于表情还是死的：${[...hits].join(',')}`);
});

test('③ 模型照抄表情名时走精确/最长优先（"哈哈大笑" 不被 "笑" 抢走）', () => {
  assert.equal(matchEmojiKey(KEYS, '害羞'), '害羞');
  assert.equal(matchEmojiKey(KEYS, '哈哈大笑'), '哈哈大笑');
  assert.equal(matchEmojiKey(KEYS, '有点嫌弃'), '嫌弃');
  assert.equal(matchEmojiKey(KEYS, '她羞得抬不起头'), '害羞');
});

test('④ 匹配不到就不猜（不报错、不硬凑）', () => {
  assert.equal(matchEmojiKey(KEYS, '???'), null);
  assert.equal(matchEmojiKey(KEYS, ''), null);
  assert.equal(matchEmojiKey(KEYS, '   '), null);
  assert.equal(matchEmojiKey([], '害羞'), null);
  assert.equal(matchEmojiKey(null, '害羞'), null);
});

test('⑤ 别名表只映射她真的拥有的表情名（别把用户删掉的表情当真）', () => {
  const withoutShy = KEYS.filter(k => k !== '害羞');
  assert.equal(matchEmojiKey(withoutShy, '潮红失神'), '惊讶', '没有害羞就该落到下一个能用的表情');
  // 别名表里出现的类目名都必须是默认 15 类之一（防止写了不存在的表情名 → 永远匹配不上）
  for (const [key] of FACIAL_EMOJI_ALIASES) {
    assert.ok(KEYS.includes(key), `别名表里有不存在的表情名：${key}`);
  }
});

test('⑥ prompt 侧：给了清单就收紧成"必须原样照抄"，空清单返回空串', () => {
  const rule = formatFacialExpressionRule(KEYS);
  assert.match(rule, /必须原样照抄/);
  assert.match(rule, /用于立绘切帧/);
  for (const key of KEYS) assert.ok(rule.includes(key), `清单里缺了 ${key}`);
  assert.match(rule, /image_prompt/, '细节表情要指回 image_prompt（立绘只吃粗粒度表情）');
  assert.equal(formatFacialExpressionRule([]), '');
  assert.equal(formatFacialExpressionRule(), '');
  // 正文版（玩具链用它拼 `- facial_expression：` 前缀）
  const body = facialExpressionChoiceText(KEYS);
  assert.ok(rule.endsWith(body), '整行 = 字段名 + 正文，正文口径只此一份');
  assert.equal(facialExpressionChoiceText([]), '');
});

test('⑦ 触摸 prompt：注入取值要求后 system 里出现它，不注入则保持旧文案逐字不变', () => {
  const base = { actionKey: 'stroke_waist', characterName: '纳西妲', userName: '玩家' };
  const rule = formatFacialExpressionRule(KEYS);

  const tightened = buildReactionPrompt({ ...base, facialExpressionRule: rule });
  assert.ok(tightened.system.includes(rule), '注入的取值要求必须原样进 system');

  const legacy = buildReactionPrompt(base);
  assert.ok(
    legacy.system.includes('- `facial_expression`：一个中文表情词（2~6 字，如 "害羞" / "嫌弃" / "慌乱" / "无奈"），用于立绘切帧。'),
    '不注入时必须还是旧文案（既有调用方与测试的兼容底线）',
  );
  assert.ok(!legacy.system.includes('必须原样照抄'));

  const convTightened = buildConversationReactionPrompt({ ...base, facialExpressionRule: rule });
  assert.ok(convTightened.system.includes(rule), '对话式 builder 也要吃同一个入参');
});

test('⑧ 源码守卫：三条链共用同一个驱动入口，且不许再内联子串匹配', () => {
  // 三条会产出 `facial_expression` 的链都必须调同一个 driver（触摸 / 亲密 / 玩具+她自己玩）
  for (const file of ['src/routes/touch.js', 'src/routes/intimateActions.js', 'src/routes/toys.js']) {
    const src = read(file);
    assert.ok(src.includes('driveStandingExpression'), `${file} 必须用统一驱动入口`);
    assert.ok(
      !/keys\.find\(\s*k\s*=>\s*label\.includes/.test(src),
      `${file} 里还留着内联的"label 含 key"匹配（历史写法，真机 0/27 命中）`,
    );
  }
  // 驱动实现本身只在一个文件里（不许第二份 publishStandingKeys(begin/expression/complete) 组合）
  const driver = read('src/services/standingExpression.js');
  assert.ok(driver.includes('matchEmojiKey'));
  assert.ok(driver.includes('publishStandingKeys'));
  for (const file of ['src/routes/touch.js', 'src/routes/intimateActions.js', 'src/routes/toys.js']) {
    const src = read(file);
    assert.ok(!src.includes("display.begin(characterId, randomUUID())"), `${file} 里还有第二份驱动实现`);
  }
  // prompt 侧：三条链都要把她的表情名交给 builder
  assert.ok(read('src/routes/touch.js').includes('formatFacialExpressionRule'));
  assert.ok(read('src/services/intimateActionService.js').includes('formatFacialExpressionRule'));
  assert.ok(read('src/services/toyService.js').includes('facialExpressionChoiceText'));
  assert.ok(read('src/services/toy/selfPlay.js').includes('facialExpressionChoiceText'));
});

test('⑨ touchActionService 仍然是零 import（守卫不许被这次改动破坏）', () => {
  const src = read('src/services/touchActionService.js');
  assert.equal((src.match(/^import /g) || []).length, 0, '服务层必须零 import（取值要求由调用方传字符串）');
});

test('⑩ 端到端（内存库）：一个自由表情词真的把立绘切到对应表情槽位', () => {
  // 造一个角色 + 一套已完成的表情包（15 类），然后走真实的 driver。
  const db = getDb();
  const charId = Number(db.prepare(
    "INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '测试')"
  ).run(`测试立绘角色_${Date.now()}`, '测试立绘角色').lastInsertRowid);
  const setName = `测试表情包-${Date.now()}`;
  const setId = Number(db.prepare(
    'INSERT INTO emoji_sets (character_id, name, is_active) VALUES (?, ?, 1)'
  ).run(charId, setName).lastInsertRowid);
  const insertEmoji = db.prepare(
    "INSERT INTO character_emojis (character_id, set_id, emoji_key, image_path, status) VALUES (?, ?, ?, ?, 'done')"
  );
  for (const key of KEYS) insertEmoji.run(charId, setId, key, `/tmp/${key}.png`);
  const shyCategory = db.prepare("SELECT id FROM emoji_categories WHERE emoji_key='害羞'").get();

  const hit = driveStandingExpression(charId, '潮红失神', { tag: 'test' });
  assert.equal(hit, '害羞', '「潮红失神」应落到「害羞」');

  const snapshot = getStandingDisplay().characterSnapshot(charId);
  assert.equal(snapshot.slotId, `emoji:${shyCategory.id}`, '立绘槽位必须真的切到「害羞」那一帧');
  assert.equal(snapshot.characterId, charId);
});
