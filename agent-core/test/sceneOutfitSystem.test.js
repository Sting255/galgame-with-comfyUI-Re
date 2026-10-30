/**
 * 场景服装系统（五态 + 身体分层 + 日程驱动选装）—— 2026-10-13 合并上游 v3.9.0 + PR #24。
 *
 * 覆盖口径：
 *   ① 五态枚举与默认名（nude/work/casual/home/sleep）
 *   ② composeOutfitText：身体 + 服装拼成自包含文本（含尾部逗号容错）
 *   ③ upsertSceneOutfits / listSceneOutfits：五套并存、nude 允许 description 为空
 *   ④ body 单一真源：setCharacterBody 同步到全部行，listSceneOutfits 每行 text 都是组合文本
 *   ⑤ getSceneOutfitForNow：日程驱动 / 睡眠硬规则（含优先于显式 nude 标注）/ 兜底绝不落 nude
 *   ⑥ buildOutfitAnnotateLayer：4 个必换时点 + 裸体私密规则 + 无次数上限
 *   ⑦ backfillBodyFromExisting：老数据按锚点反推 body（幂等）
 *   ⑧ characterPersona：auto 通道叠加场景服装；显式 outfits 不叠加
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const {
  OUTFIT_SCENES, PRIVATE_SCENE, DEFAULT_NAME_BY_SCENE, composeOutfitText,
  listSceneOutfits, upsertSceneOutfits, setCharacterBody,
  getSceneOutfitForNow, asPersonaOutfits, buildOutfitAnnotateLayer,
  backfillBodyFromExisting,
} = await import('../src/services/outfitScene.js')
const { parseSceneOutfitDesign, normalizeDesignScenes } = await import('../src/services/sceneOutfitPrompt.js')
const persona = await import('../src/services/characterPersona.js')
const { getLocalDateKey } = await import('../src/utils/localDate.js')

const CHAR_ID = 1

/**
 * 每个用例开工前把该角色的场景服装与日程清干净。
 * ⚠️ 不清就会"内存污染造键"：上一个用例留下的五套会让下一个用例的 listSceneOutfits 多出行，
 *    于是 ⑤f/⑥b/⑦ 这类断言被前一个用例的数据打红（本仓踩过三次的老坑）。
 */
function resetCharacter() {
  const db = getDb()
  db.prepare('DELETE FROM character_outfits WHERE character_id = ?').run(CHAR_ID)
  db.prepare('DELETE FROM daily_schedules WHERE character_id = ?').run(CHAR_ID)
}

/** 造一个带五套场景服装的角色（seed 已建 id=1 的默认助手） */
function seedCharacter({ withBody = true, outfits } = {}) {
  resetCharacter()
  const db = getDb()
  db.prepare("UPDATE characters SET display_name='测试角色', base_prompt=?, short_prompt='测试角色' WHERE id=?")
    .run('你是测试角色。\n\n## 你的外观\nsilver hair, purple eyes, pale skin', CHAR_ID)
  const list = outfits || [
    { scene: 'nude', name: '裸体', description: 'completely nude, wearing no clothing, bare skin' },
    { scene: 'work', name: '日常装', description: 'black tactical suit with cyan accents' },
    { scene: 'casual', name: '便装', description: 'white summer dress, straw hat' },
    { scene: 'home', name: '居家服', description: 'oversized grey sweatshirt' },
    { scene: 'sleep', name: '睡衣', description: 'pale blue nightdress, barefoot' },
  ]
  upsertSceneOutfits(CHAR_ID, list)
  if (withBody) setCharacterBody(CHAR_ID, 'long silver hair, high ponytail, purple eyes, pale skin, slim build')
  return list
}

/** 写今日日程（schedule_date 必须用 getLocalDateKey，否则 UTC/本地差 8 小时） */
function writeSchedule(activities) {
  getDb().prepare(
    'INSERT OR REPLACE INTO daily_schedules (character_id, schedule_date, schedule_json) VALUES (?, ?, ?)'
  ).run(CHAR_ID, getLocalDateKey(new Date()), JSON.stringify(activities))
}

function at(h, m = 0) {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

test('① 五态枚举：nude/work/casual/home/sleep，各有中文标签与默认名', () => {
  assert.deepEqual(OUTFIT_SCENES.map(s => s.key), ['nude', 'work', 'casual', 'home', 'sleep'])
  assert.equal(PRIVATE_SCENE, 'nude')
  for (const s of OUTFIT_SCENES) {
    assert.ok(s.label, `${s.key} 缺 label`)
    assert.ok(s.defaultName, `${s.key} 缺 defaultName`)
    assert.ok(DEFAULT_NAME_BY_SCENE[s.key], `${s.key} 缺默认名映射`)
  }
})

test('② composeOutfitText：身体 + 服装拼接，尾部逗号/空格容错', () => {
  assert.equal(
    composeOutfitText('silver hair, purple eyes', 'black hoodie, denim shorts'),
    'silver hair, purple eyes, black hoodie, denim shorts',
  )
  assert.equal(composeOutfitText('silver hair', ''), 'silver hair')
  assert.equal(composeOutfitText('', 'black hoodie'), 'black hoodie')
  assert.equal(composeOutfitText('fair skin,', 'wearing a dress,'), 'fair skin, wearing a dress')
  assert.equal(composeOutfitText('  ', '  '), '')
})

test('③ 五套并存写入与列出；nude 允许 description 为空（纯身体）', () => {
  seedCharacter({
    outfits: [
      { scene: 'nude', name: '裸体', description: '' },
      { scene: 'work', name: '日常装', description: 'black suit' },
    ],
    withBody: false,
  })
  const list = listSceneOutfits(CHAR_ID)
  assert.equal(list.length, 2)
  // nude 在前（排序 CASE nude→0）
  assert.equal(list[0].scene, 'nude')
  assert.equal(list[1].scene, 'work')
})

test('④ body 单一真源：一次写入同步全部行，text 都是组合文本', () => {
  seedCharacter()
  setCharacterBody(CHAR_ID, 'long silver hair, high ponytail, purple eyes')
  const list = listSceneOutfits(CHAR_ID)
  assert.equal(list.length, 5)
  for (const o of list) {
    assert.equal(o.body, 'long silver hair, high ponytail, purple eyes', `${o.scene} 的 body 应是同一份`)
    assert.ok(o.text.startsWith('long silver hair'), `${o.scene} 的 text 应以身体开头`)
  }
  assert.ok(list.find(o => o.scene === 'work').text.includes('black tactical suit'))
  assert.ok(list.find(o => o.scene === 'work').text.includes('long silver hair'))
})

test('⑤ 日程驱动选装：标注了哪套就穿哪套', () => {
  seedCharacter()
  writeSchedule([
    { startTime: '08:00', endTime: '18:00', activity: '上班', location: '公司', replyDelay: 0, outfit: '日常装' },
    { startTime: '22:00', endTime: '08:00', activity: '就寝', location: '公寓', replyDelay: -1, outfit: '睡衣' },
  ])
  const now = getSceneOutfitForNow(CHAR_ID, at(12))
  assert.equal(now.scene, 'work')
  assert.equal(now.source, 'schedule')
  assert.equal(now.outfit.name, '日常装')
})

test('⑤b 睡眠硬规则：replyDelay=-1 强制睡衣，优先于任何标注', () => {
  seedCharacter()
  writeSchedule([
    { startTime: '08:00', endTime: '18:00', activity: '上班', location: '公司', replyDelay: 0, outfit: '日常装' },
    { startTime: '22:00', endTime: '08:00', activity: '就寝', location: '公寓', replyDelay: -1, outfit: '睡衣' },
  ])
  const now = getSceneOutfitForNow(CHAR_ID, at(23, 30))
  assert.equal(now.scene, 'sleep')
  assert.equal(now.source, 'sleep')
})

test('⑤c 睡眠硬规则甚至优先于日程显式标的 nude', () => {
  seedCharacter()
  writeSchedule([
    { startTime: '22:00', endTime: '08:00', activity: '就寝', location: '公寓', replyDelay: -1, outfit: '裸体' },
  ])
  const now = getSceneOutfitForNow(CHAR_ID, at(23, 30))
  assert.equal(now.scene, 'sleep', '睡觉一律穿睡衣，哪怕日程标了裸体')
})

test('⑤d 洗浴时段显式标 nude ⇒ 能选到裸体', () => {
  seedCharacter()
  writeSchedule([
    { startTime: '07:00', endTime: '07:30', activity: '洗澡', location: '公寓浴室', replyDelay: 0, outfit: '裸体' },
    { startTime: '08:00', endTime: '18:00', activity: '上班', location: '公司', replyDelay: 0, outfit: '日常装' },
  ])
  const now = getSceneOutfitForNow(CHAR_ID, at(7, 15))
  assert.equal(now.scene, 'nude')
  assert.equal(now.source, 'schedule')
})

test('⑤e 兜底绝不落 nude：没日程 / 没标注都只能落到白天服装', () => {
  seedCharacter()
  getDb().prepare('DELETE FROM daily_schedules WHERE character_id = ?').run(CHAR_ID)
  const noSchedule = getSceneOutfitForNow(CHAR_ID, at(12))
  assert.ok(noSchedule)
  assert.notEqual(noSchedule.scene, 'nude', '没日程时兜底不能是裸体')

  writeSchedule([{ startTime: '08:00', endTime: '20:00', activity: '闲逛', location: '公园', replyDelay: 0 }])
  const noMark = getSceneOutfitForNow(CHAR_ID, at(12))
  assert.ok(noMark)
  assert.notEqual(noMark.scene, 'nude', '没标注时兜底不能是裸体')
})

test('⑤f 只有裸体一套时，非私密时段兜底仍不落 nude', () => {
  seedCharacter({ outfits: [{ scene: 'nude', name: '裸体', description: 'completely nude' }], withBody: true })
  const now = getSceneOutfitForNow(CHAR_ID, at(12))
  // 只有一套且它是 nude ⇒ 白天服装集合为空、睡衣也没有 ⇒ 返回 null（调用方回落原外观）
  assert.equal(now, null, '只有裸体一套时应返回 null，让调用方回落角色卡原外观')
})

test('⑥ 标注层：4 个必换时点 + 裸体私密规则 + 不再有次数上限', () => {
  seedCharacter()
  const layer = buildOutfitAnnotateLayer(CHAR_ID)
  assert.ok(layer, '配了两套以上就应有标注层')
  assert.ok(layer.includes('4 个时点'), '应写明 4 个必换时点')
  assert.ok(layer.includes('一个都不能漏'))
  assert.ok(layer.includes('裸体'), '应含裸体的私密规则')
  assert.ok(layer.includes('洗浴'), '裸体规则应点名洗浴')
  assert.ok(layer.includes('睡眠时段绝不标裸体'))
  assert.ok(!layer.includes('最多 4 次'), '不应再出现次数上限（PR #24 修的就是这个）')
  assert.ok(layer.includes('住所外'), '应有室内外自检')
})

test('⑥b 只配一套时不生成标注层', () => {
  seedCharacter({ outfits: [{ scene: 'work', name: '日常装', description: 'black suit' }], withBody: true })
  assert.equal(buildOutfitAnnotateLayer(CHAR_ID), null)
})

test('⑦ 老数据回填：以已填分项为锚反推 body，且幂等', () => {
  resetCharacter()
  const db = getDb()
  db.prepare("UPDATE characters SET base_prompt=? WHERE id=?").run('你是测试角色。\n\n## 你的外观\nlong silver hair, purple eyes', CHAR_ID)
  upsertSceneOutfits(CHAR_ID, [
    { scene: 'work', name: '日常装', description: 'long silver hair, purple eyes, black tactical suit' },
    { scene: 'sleep', name: '睡衣', description: 'long silver hair, purple eyes, pale blue nightdress' },
  ])
  const first = backfillBodyFromExisting(CHAR_ID, { baseAppearance: '' })
  assert.ok(first.updated >= 1, '应回填至少一行')
  assert.ok(['work', 'casual', 'nude', 'card'].includes(first.source) || first.source === 'work')
  const body = listSceneOutfits(CHAR_ID).find(o => o.scene === 'work')?.body
  assert.ok(body && body.includes('long silver hair'), 'body 应取自已填的 work')
  // 幂等：已有 body 再跑一次不动
  const second = backfillBodyFromExisting(CHAR_ID, { baseAppearance: '' })
  assert.equal(second.source, 'already')
  assert.equal(second.updated, 0)
})

test('⑧ characterPersona：auto 通道叠加场景服装', () => {
  seedCharacter()
  writeSchedule([{ startTime: '08:00', endTime: '18:00', activity: '上班', location: '公司', replyDelay: 0, outfit: '日常装' }])
  const basePrompt = '你是测试角色。\n\n## 你的外观\nsilver hair, purple eyes'
  const full = persona.buildCharacterPersona({ id: CHAR_ID, display_name: '测试角色', base_prompt: basePrompt }, { variant: 'full' })
  assert.ok(full.includes('black tactical suit'), 'full variant 应含场景服装')
  assert.ok(full.includes('long silver hair'), 'full variant 应含身体')
  const appearance = persona.buildCharacterAppearanceSection({ id: CHAR_ID, base_prompt: basePrompt })
  assert.ok(appearance.includes('black tactical suit'), 'appearance section 应含场景服装')
})

test('⑧b 显式传 outfits 时不叠加场景服装（调用方要完全掌控）', () => {
  seedCharacter()
  const out = persona.buildCharacterPersona(
    { id: CHAR_ID, display_name: '测试角色', base_prompt: '你是测试角色。\n\n## 你的外观\nsilver hair' },
    { variant: 'full', outfits: { limited: [{ name: '女仆装', description: 'maid dress, white apron' }], exclusive: null } },
  )
  assert.ok(out.includes('maid dress'))
  assert.ok(!out.includes('black tactical suit'), '显式 outfits 不该叠加场景服装')
})

test('⑧c asPersonaOutfits 输出组合文本', () => {
  seedCharacter()
  writeSchedule([{ startTime: '08:00', endTime: '18:00', activity: '上班', location: '公司', replyDelay: 0, outfit: '日常装' }])
  const ap = asPersonaOutfits(getSceneOutfitForNow(CHAR_ID, at(12)))
  assert.ok(ap.limited[0].description.includes('long silver hair'), '组合文本含身体')
  assert.ok(ap.limited[0].description.includes('black tactical suit'), '组合文本含衣服')
})

test('⑨ sceneOutfitPrompt：解析时 body 一律以真源为准，nude 强制声明', () => {
  const raw = JSON.stringify({ outfits: [
    { scene: 'nude', name: '裸体', body: '模型瞎改的身体', description: 'a girl with no clothes' },
    { scene: 'work', name: '警服', body: '另一份瞎改的', description: 'black police uniform, cap' },
  ] })
  const out = parseSceneOutfitDesign(raw, ['nude', 'work'], { bodySource: 'long silver hair, purple eyes' })
  assert.equal(out.length, 2)
  for (const o of out) {
    assert.equal(o.body, 'long silver hair, purple eyes', `${o.scene} 的 body 必须用真源，不用模型瞎改的`)
  }
  assert.match(out[0].description, /nude|no clothing|bare skin/i, 'nude 必须显式声明裸体')
  assert.equal(out[1].description, 'black police uniform, cap')
})

test('⑨b sceneOutfitPrompt：场景白名单与去重', () => {
  assert.deepEqual(normalizeDesignScenes(['work', 'work', 'home']), ['work', 'home'])
  assert.throws(() => normalizeDesignScenes(['bogus']), /只支持设计/)
})
