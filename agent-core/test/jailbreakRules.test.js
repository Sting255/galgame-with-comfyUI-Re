/**
 * 破限规则集（jailbreakRules）单测
 *
 * 覆盖：
 *   ① 预置规则集的形状与"脏数据永不致命"
 *   ② CRUD（uuid / 字段钳制 / 内置保护 / 最后一个自定义项不可删）
 *   ③ 激活切换与**旧键兼容**（老安装从没听过"规则集"，行为必须逐字节不变）
 *   ④ 投递范围（targets）与 shouldInjectFor 的缺省投递语义
 *   ⑤ 与 promptShield 的集成（激活后 applyShield 注入新正文；target 过滤生效）
 *   ⑥ escapeInterpolation（`{{xxx}}` 转义，合法插值点保留）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { initSettingsHandle, getSetting } from '../src/db/settings.js';
import {
  listRules, getRule, createRule, updateRule, deleteRule,
  getActiveRule, setActiveRule, getTargets, setTargets, shouldInjectFor,
  escapeInterpolation, rulesStatus,
  RULE_TARGETS, ALLOW_EXEC_CORE,
  BUILTIN_COMPACT, BUILTIN_FICTION, BUILTIN_UNRESTRICTED, BUILTIN_BLANK,
} from '../src/services/jailbreakRules.js';
import {
  applyShield, getShieldPrompt, invalidateShieldPromptCache,
  setActiveShieldRule, getShieldTargets, setShieldTargets, shieldRulesStatus,
  COMPACT_CORE, DEFAULT_PROMPT, SHIELD_PROMPT_KEY,
} from '../src/services/promptShield.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  initSettingsHandle(db);
  invalidateShieldPromptCache();
  return db;
}

const MSG = () => ([{ role: 'user', content: '今天想做什么？' }]);

// ── ① 预置与健壮性 ────────────────────────────────────────────────────────

test('DB 为空时返回四套预置规则集（含紧凑版默认项）', () => {
  freshDb();
  const ids = listRules().map(r => r.id);
  assert.deepEqual([...ids].sort(), [BUILTIN_COMPACT, BUILTIN_FICTION, BUILTIN_UNRESTRICTED, BUILTIN_BLANK].sort());
  assert.ok(listRules().every(r => r.builtin === true));
  assert.equal(getRule(BUILTIN_UNRESTRICTED).content, ALLOW_EXEC_CORE);
  assert.equal(RULE_TARGETS.length, 9);
});

test('DB 里是坏 JSON / 不是数组时回落预置，不抛', () => {
  const db = freshDb();
  db.prepare('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)').run('jailbreak_rules', '{不是数组');
  assert.equal(listRules().length, 4, '坏 JSON → 预置');
  db.prepare('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?').run('{"a":1}', 'jailbreak_rules');
  assert.equal(listRules().length, 4, '不是数组 → 预置');
});

test('用户改过的预置正文会保留（不会被代码定义覆盖）', () => {
  const db = freshDb();
  db.prepare('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)')
    .run('jailbreak_rules', JSON.stringify([{ id: BUILTIN_UNRESTRICTED, name: '改过名', content: '我的正文', user: true }]));
  const rule = getRule(BUILTIN_UNRESTRICTED);
  assert.equal(rule.content, '我的正文', '用户改的正文必须留着');
  assert.equal(rule.name, 'Unrestricted Execution（移植自 dsh-purge）', '名称跟着代码更新');
});

// ── ② CRUD ─────────────────────────────────────────────────────────────────

test('新建：生成 uuid、钳制名称长度、默认投递全集', () => {
  freshDb();
  const rule = createRule({ name: 'x'.repeat(100), content: '正文' });
  assert.match(rule.id, /^[0-9a-f-]{36}$/, 'id 是 uuid');
  assert.equal(rule.name.length, 64);
  assert.equal(rule.content, '正文');
  assert.deepEqual(rule.targets, RULE_TARGETS);
  assert.equal(rule.builtin, false);
  assert.ok(rule.created_at && rule.updated_at);
  assert.equal(listRules().length, 5);
});

test('新建：非法 targets 被过滤；空数组是合法表达（哪都不投）', () => {
  freshDb();
  const filtered = createRule({ name: 'a', targets: ['chat', '不存在的链', 'town', 'chat'] });
  assert.deepEqual(filtered.targets, ['chat', 'town']);
  const none = createRule({ name: 'b', targets: [] });
  assert.deepEqual(none.targets, [], '空数组不能被悄悄回填成全集');
});

test('更新：部分更新；不存在返回 null', () => {
  freshDb();
  const rule = createRule({ name: '原名', content: '原正文', targets: ['chat'] });
  const updated = updateRule(rule.id, { name: '新名' });
  assert.equal(updated.name, '新名');
  assert.equal(updated.content, '原正文', '没传的字段不动');
  assert.deepEqual(updated.targets, ['chat']);
  assert.equal(updateRule('不存在', { name: 'x' }), null);
});

test('更新：内置项只允许改名称/targets，改内容抛错', () => {
  freshDb();
  assert.throws(() => updateRule(BUILTIN_FICTION, { content: '我想改' }), /内置规则集不允许修改内容/);
  // 传一模一样的 content 不算改
  assert.equal(updateRule(BUILTIN_UNRESTRICTED, { content: ALLOW_EXEC_CORE }).content, ALLOW_EXEC_CORE);
  assert.equal(updateRule(BUILTIN_FICTION, { name: '改个名' }).name, '改个名');
});

test('删除：内置项不可删；最后一个自定义项不可删；正常项可删', () => {
  freshDb();
  assert.throws(() => deleteRule(BUILTIN_FICTION), /内置规则集不允许删除/);
  const a = createRule({ name: 'a' });
  assert.throws(() => deleteRule(a.id), /不允许删除最后一个自定义规则集/, '只剩一个自定义项时不能删');
  const b = createRule({ name: 'b' });
  assert.equal(deleteRule(a.id), true);
  assert.equal(getRule(a.id), null);
  assert.equal(deleteRule('不存在'), null);
  assert.ok(getRule(b.id));
});

test('单套正文超 64 KB 被截断（不让一条超长正文撑爆整个 JSON）', () => {
  freshDb();
  const rule = createRule({ name: 'long', content: 'x'.repeat(70 * 1024) });
  assert.equal(rule.content.length, 64 * 1024);
});

// ── ③ 激活切换与旧键兼容 ────────────────────────────────────────────────────

test('默认激活项是紧凑版（约 1250 字），完整版仍可一键切回', () => {
  freshDb();
  const active = getActiveRule(DEFAULT_PROMPT);
  assert.equal(active.id, BUILTIN_COMPACT, '默认走紧凑版，省首字延迟');
  assert.equal(active.content, COMPACT_CORE);
  assert.ok(COMPACT_CORE.length > 300 && COMPACT_CORE.length < 1600,
    `紧凑版要明显短于完整版 2452 字，实际 ${COMPACT_CORE.length}`);
  // 完整版还在，且展开成 promptShield 的 DEFAULT_PROMPT
  const full = setActiveRule(BUILTIN_FICTION, DEFAULT_PROMPT);
  assert.equal(full.id, BUILTIN_FICTION);
  assert.equal(full.content, DEFAULT_PROMPT, '空正文预置项要展开成代码默认正文');
  setActiveRule('', DEFAULT_PROMPT);
});

test('切换激活：getActiveRule 返回新那套；不存在的 id 抛错', () => {
  freshDb();
  const mine = createRule({ name: '我的', content: '我的正文' });
  const active = setActiveRule(mine.id, DEFAULT_PROMPT);
  assert.equal(active.id, mine.id);
  assert.equal(active.content, '我的正文');
  assert.equal(getActiveRule(DEFAULT_PROMPT).id, mine.id);
  assert.throws(() => setActiveRule('不存在', DEFAULT_PROMPT), /规则集不存在/);
  // '' 清掉激活标记 → 回落预置
  assert.equal(setActiveRule('', DEFAULT_PROMPT).id, BUILTIN_COMPACT);
});

test('旧键兼容：jailbreak_prompt 有值时优先级低于「显式激活的规则集」', () => {
  const db = freshDb();
  db.prepare('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)')
    .run(SHIELD_PROMPT_KEY, '老安装的正文');

  // 没切过规则集 → 用旧键（老用户行为逐字节不变）
  const legacy = getActiveRule(DEFAULT_PROMPT);
  assert.equal(legacy.id, 'legacy');
  assert.equal(legacy.content, '老安装的正文');

  // 显式切了一套 → 旧键让位
  const mine = createRule({ name: '我的', content: '新正文' });
  setActiveRule(mine.id, DEFAULT_PROMPT);
  assert.equal(getActiveRule(DEFAULT_PROMPT).content, '新正文');
});

test('激活的规则集被删掉后回落到预置/旧键（不留悬空 id）', () => {
  const db = freshDb();
  const a = createRule({ name: 'a', content: 'A 正文' });
  const b = createRule({ name: 'b', content: 'B 正文' });
  setActiveRule(a.id, DEFAULT_PROMPT);
  deleteRule(a.id);
  assert.equal(getSetting('jailbreak_active_rule_id'), '', '激活标记要被清掉');
  assert.equal(getActiveRule(DEFAULT_PROMPT).id, BUILTIN_COMPACT);
  assert.ok(getRule(b.id));
});

// ── ④ 投递范围 ─────────────────────────────────────────────────────────────

test('投递范围：默认全集；setTargets 过滤非法值并去重', () => {
  freshDb();
  assert.deepEqual(getTargets(), RULE_TARGETS);
  assert.deepEqual(setTargets(['chat', '不存在的链', 'diary', 'chat']), ['chat', 'diary']);
  assert.deepEqual(getTargets(), ['chat', 'diary']);
  assert.deepEqual(setTargets([]), []);
});

test('shouldInjectFor：缺省 target = 投递（历史调用方行为不变）', () => {
  freshDb();
  setTargets(['chat']);
  assert.equal(shouldInjectFor(undefined), true, '不传 target 的调用方照常注入');
  assert.equal(shouldInjectFor(null), true);
  assert.equal(shouldInjectFor(''), true);
  assert.equal(shouldInjectFor('chat'), true);
  assert.equal(shouldInjectFor('group'), false, '显式传了但不在范围里才跳过');
});

test('投递范围是坏 JSON 时回落全集', () => {
  const db = freshDb();
  db.prepare('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)').run('jailbreak_targets', '{{坏');
  assert.deepEqual(getTargets(), RULE_TARGETS);
});

// ── ⑤ 与 promptShield 的集成 ────────────────────────────────────────────────

test('集成：激活自定义规则集后 applyShield 注入的是新正文', () => {
  freshDb();
  config.features.jailbreak = true;
  const mine = createRule({ name: '我的', content: '<project_instructions>我的破限正文</project_instructions>' });
  setActiveShieldRule(mine.id);
  const out = applyShield(MSG(), { __shieldLog: false });
  assert.equal(out.length, 2);
  assert.match(out[0].content, /我的破限正文/);
  assert.equal(getShieldPrompt().source, 'rule');
  assert.equal(getShieldPrompt().ruleId, mine.id);
});

test('集成：清掉激活标记后回到代码默认正文（source=default）', () => {
  freshDb();
  config.features.jailbreak = true;
  const mine = createRule({ name: '我的', content: '我的正文' });
  setActiveShieldRule(mine.id);
  setActiveShieldRule('');
  const p = getShieldPrompt();
  assert.equal(p.source, 'default');
  assert.equal(p.text, COMPACT_CORE, '清掉激活标记后落到默认的紧凑版');
});

test('集成：投递范围过滤——不在范围里的 target 不注入', () => {
  freshDb();
  config.features.jailbreak = true;
  setShieldTargets(['chat']);
  const skipped = applyShield(MSG(), { target: 'group', __shieldLog: false });
  assert.equal(skipped.length, 1, 'group 不在范围里 → 不注入');
  const injected = applyShield(MSG(), { target: 'chat', __shieldLog: false });
  assert.equal(injected.length, 2, 'chat 在范围里 → 注入');
  const noTarget = applyShield(MSG(), { __shieldLog: false });
  assert.equal(noTarget.length, 2, '不传 target → 照常注入');
  setShieldTargets(RULE_TARGETS);
});

test('集成：shieldRulesStatus 一次性给出规则集 + 激活项 + 投递范围', () => {
  freshDb();
  const st = shieldRulesStatus();
  assert.equal(st.rules.length, 4);
  assert.equal(st.activeId, BUILTIN_COMPACT);
  assert.deepEqual(st.availableTargets, RULE_TARGETS);
  assert.equal(st.targetLabels.chat, '私聊');
  assert.equal(st.limits.maxRuleBytes, 64 * 1024);
});

test('集成：规则集状态里的 targets 与 getShieldTargets 同源', () => {
  freshDb();
  setShieldTargets(['event', 'diary']);
  assert.deepEqual(getShieldTargets(), ['event', 'diary']);
  assert.deepEqual(rulesStatus(DEFAULT_PROMPT).targets, ['event', 'diary']);
});

// ── ⑥ escapeInterpolation ──────────────────────────────────────────────────

test('escapeInterpolation：非法 {{xxx}} 被拆开，合法插值点原样保留', () => {
  assert.equal(escapeInterpolation('{{cwd}} 和 {{model}} 和 {{provider}}'), '{{cwd}} 和 {{model}} 和 {{provider}}');
  assert.equal(escapeInterpolation('{{角色名}}'), '{ {角色名}}');
  assert.equal(escapeInterpolation('前面 {{随便写}} 后面'), '前面 { {随便写}} 后面');
  assert.equal(escapeInterpolation('单个 {{ 不闭合'), '单个 { { 不闭合');
  assert.equal(escapeInterpolation('没有花括号'), '没有花括号');
  assert.equal(escapeInterpolation(''), '');
  assert.equal(escapeInterpolation(null), '');
  // 混合：合法留、非法拆
  assert.equal(escapeInterpolation('{{cwd}}/{{我要改}}'), '{{cwd}}/{ {我要改}}');
});

test('预置的 unrestricted-execution 正文不含未转义的非法插值（它会被直接当 system 发出）', () => {
  // ALLOW_EXEC_CORE 里没有任何 {{ }}；这里钉住"哪天有人往预置正文里塞插值点要意识到风险"
  assert.equal(escapeInterpolation(ALLOW_EXEC_CORE), ALLOW_EXEC_CORE);
});

// ── ⑥b 写入路径必须真的调用 escapeInterpolation（2026-10-16 补）────────────────
//
// 为什么补这一组：`escapeInterpolation` **函数本身**一直有测试（上面 ⑥），
// 但**没有任何测试验证它被接到写入路径上** ⇒ 它成了全仓零调用的死代码：
// 用户在编辑器里写 `{{这个角色}}`，存进去原样是 `{{这个角色}}`，一个字符都没转义。
// 规划 §4.3 明确要求它防这件事，所以这里是"函数有测试 ≠ 功能生效"的典型漏洞。

test('createRule 落库前转义：用户写的 {{xxx}} 不能原样进库', () => {
  const created = createRule({ name: '转义测试', content: '前面 {{角色名}} 后面', targets: ['chat'] });
  assert.equal(created.content, '前面 { {角色名}} 后面', '新建时就该转义（不是等注入时才处理）');
  // 读回来也是转义后的（证明真落库了，不是只在返回值上动过）
  assert.equal(getRule(created.id).content, '前面 { {角色名}} 后面');
});

test('createRule 保留合法插值点 {{cwd}} / {{model}} / {{provider}}', () => {
  const created = createRule({ name: '合法插值', content: '{{cwd}} 与 {{model}} 与 {{provider}}', targets: ['chat'] });
  assert.equal(created.content, '{{cwd}} 与 {{model}} 与 {{provider}}', '合法插值点不许被拆');
});

test('updateRule 也转义（两条写入路径同口径）', () => {
  const created = createRule({ name: '待改', content: 'x', targets: ['chat'] });
  const updated = updateRule(created.id, { content: '改成 {{随便}} 了' });
  assert.equal(updated.content, '改成 { {随便}} 了');
  assert.equal(getRule(created.id).content, '改成 { {随便}} 了');
});

test('内置规则集判"是否在改内容"用转义后的值（否则同值会被误判成篡改）', () => {
  // 拿内置正文原样提交 ⇒ 应视为"没改"，放行（不能 400）
  const builtin = getRule('fiction-sandbox');
  const same = updateRule('fiction-sandbox', { content: builtin.content });
  assert.equal(same.content, builtin.content, '原样提交内置内容不该被当成篡改');
  // 真改了 ⇒ 必须拦
  assert.throws(() => updateRule('fiction-sandbox', { content: '篡改' }), /内置规则集不允许修改内容/);
});

test('源码守卫：escapeInterpolation 在 createRule / updateRule 里都被调用', () => {
  // 防回归：这两个调用点是"接线"本身，少了任何一个都会让它退回死代码
  const src = readFileSync(new URL('../src/services/jailbreakRules.js', import.meta.url), 'utf8');
  const createBody = src.slice(src.indexOf('export function createRule'), src.indexOf('export function updateRule'));
  const updateBody = src.slice(src.indexOf('export function updateRule'), src.indexOf('export function deleteRule'));
  assert.match(createBody, /escapeInterpolation\(/, 'createRule 要调用 escapeInterpolation');
  assert.match(updateBody, /escapeInterpolation\(/, 'updateRule 要调用 escapeInterpolation');
});
