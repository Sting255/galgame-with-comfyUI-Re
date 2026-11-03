/**
 * 日程生成：**主睡眠块不许压到白天**
 *
 * 用户原话（2026-11-03）：「角色还在大白天睡觉」
 * 真机样本：三月七的日程模板是「03:00–11:00 就寝安眠」—— 上午十点整座城一半人在睡，
 * 根因是生成提示词原来**明着鼓励**「凌晨 3-4 点睡、中午 11-12 点起」「下午 2-4 点起」。
 *
 * 现在：提示词改成硬约束 + 校验层拦截。本文件钉校验层：
 *   · 主睡（≥3 小时）压到白天 → 判无效（返回 null，上层重生成）
 *   · 跨零点的正常作息（23:00–07:00）→ 通过
 *   · 夜猫子但在窗口内（01:00–09:00）→ 通过
 *   · 白天小憩（≤40 分钟）→ 不算主睡，不拦
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { parseAndValidateSchedule } = await import('../src/services/scheduleGenerator.js')

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** 24 小时全覆盖、8 段以上，睡眠块可配（还能额外插一段午间小憩） */
function makeSchedule(sleepStart, sleepEnd, { nap = null } = {}) {
  const acts = []
  const push = (s, e, a) => acts.push({
    startTime: s, endTime: e, activity: a, location: '某处', replyDelay: 0, tags: [], description: '描述文字描述文字描述文字。',
  })
  if (nap) {
    acts.push({ startTime: nap[0], endTime: nap[1], activity: '午间小憩——趴桌上眯一会', location: '教室', replyDelay: -1, tags: ['小憩'], description: '趴在桌上眯了一小会。' })
  }
  // 睡醒之后到睡前之间的活动，等分成 7 段
  const awakeStart = toMin(sleepEnd)
  const awakeEnd = toMin(sleepStart)
  const span = ((awakeEnd - awakeStart) + 1440) % 1440
  const step = Math.floor(span / 7)
  const slots = ['上午课', '午餐', '下午课', '社团', '晚餐', '自习', '夜聊']
  let s = awakeStart
  for (let i = 0; i < 7; i++) {
    const e = (s + step) % 1440
    push(fmt(s), fmt(e), slots[i])
    s = e
  }
  if (s !== awakeEnd) push(fmt(s), fmt(awakeEnd), '收尾')
  acts.push({ startTime: sleepStart, endTime: sleepEnd, activity: '就寝安眠', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: '裹着被子沉入睡眠，呼吸慢慢平稳下来。' })
  acts.sort((a, b) => a.startTime.localeCompare(b.startTime))
  return JSON.stringify({ activities: acts })
}

test('★ 主睡压到白天 → 判无效（这就是"大白天睡觉"的真机样本）', () => {
  assert.equal(parseAndValidateSchedule(makeSchedule('03:00', '11:00'), '三月七'), null,
    '03:00–11:00 必须被判无效，否则会在上午十点整座城躺着睡觉')
  assert.equal(parseAndValidateSchedule(makeSchedule('05:00', '13:00'), '测试'), null, '睡到下午更不行')
})

test('正常跨零点作息 / 窗口内的夜猫子 → 通过', () => {
  assert.ok(parseAndValidateSchedule(makeSchedule('23:00', '07:00'), '标准型'), '23:00–07:00 应通过')
  assert.ok(parseAndValidateSchedule(makeSchedule('22:00', '06:00'), '早睡型'), '22:00–06:00 应通过')
  assert.ok(parseAndValidateSchedule(makeSchedule('01:00', '09:00'), '夜猫子'), '01:00–09:00 在窗口内，应通过')
  assert.ok(parseAndValidateSchedule(makeSchedule('02:00', '09:30'), '重度夜猫子'), '起床上限 09:30，应通过')
})

test('白天小憩（≤40 分钟）不算主睡，不被拦', () => {
  const ok = parseAndValidateSchedule(makeSchedule('23:00', '07:00', { nap: ['13:00', '13:30'] }), '有小憩')
  assert.ok(ok, '午间 30 分钟小憩应通过')
})
