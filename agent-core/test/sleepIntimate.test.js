/**
 * 睡眠玩法：睡着也能推进 + 睡眠条 + 催眠禁醒
 *
 * 用户原话：「睡眠情况下也可以推进才对，这也是一种玩法」「触摸或者推进会减少一部分睡眠条，
 * 放置一会又会恢复」「催眠手机里加入一个选项 控制角色无法醒来」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const svc = await import('../src/services/intimateActionService.js')

const base = (patch = {}) => ({
  ...svc.emptySceneState(1),
  active: true,
  penetrating: true,
  positionKey: 'missionary',
  ...patch,
})

test('睡着时：插入类扣 6，轻动作扣 3', () => {
  const heavy = svc.planIntimateAction(base({ sleepBar: 100 }), { actionKey: 'thrust', sleeping: true, now: Date.now() })
  assert.equal(heavy.ok, true)
  assert.equal(heavy.next.sleepBar, 100 - svc.SLEEP_COST_THRUST)

  // 轻动作（禁高潮开关这类）扣 3。
  // 注意「换姿势」在好感低时会被 she_refuses 挡下 —— 被拒的那一下不算推进，本来就不该扣。
  const light = svc.planIntimateAction(base({ sleepBar: 100 }), { actionKey: 'denial', sleeping: true, now: Date.now() })
  assert.equal(light.ok, true)
  assert.equal(light.next.sleepBar, 100 - svc.SLEEP_COST_TOUCH)
})

test('醒着的时候不动睡眠条（条只服务睡眠玩法）', () => {
  const st = base({ sleepBar: 42 })
  const r = svc.planIntimateAction(st, { actionKey: 'thrust', sleeping: false, now: Date.now() })
  assert.equal(r.next.sleepBar, 42)
})

test('★ 条扣到 0 就是醒了', () => {
  const st = base({ sleepBar: 6 })
  const r = svc.planIntimateAction(st, { actionKey: 'thrust', sleeping: true, now: Date.now() })
  assert.equal(r.next.sleepBar, 0)
  assert.equal(r.next.woke, true, '归零必须标记 woke，提示词才能切"刚醒"档')
})

test('★ 催眠禁醒：条封底 1，永远醒不过来', () => {
  const st = base({ sleepBar: 3, forcedSleep: 1 })
  const r = svc.planIntimateAction(st, { actionKey: 'thrust', sleeping: true, now: Date.now() })
  assert.equal(r.next.sleepBar, 1, '封底留 1 点')
  assert.equal(r.next.woke, false, '禁醒时不许醒')
})

test('惰性恢复：按时间差补，不依赖后台 ticker', () => {
  const threeMinAgo = new Date(Date.now() - 180000).toISOString()
  const st = base({ sleepBar: 20, lastActionAt: threeMinAgo })
  const r = svc.recoverSleepBar(st, Date.now())
  assert.ok(r.sleepBar >= 29 && r.sleepBar <= 31, `3 分钟应恢复约 10 点，实际 ${r.sleepBar}`)
})

test('恢复有上限，不会超过 100', () => {
  const hourAgo = new Date(Date.now() - 3600000).toISOString()
  const st = base({ sleepBar: 90, lastActionAt: hourAgo })
  assert.equal(svc.recoverSleepBar(st, Date.now()).sleepBar, svc.SLEEP_BAR_MAX)
})

test('恢复后再扣：停一会儿再推，条先涨回再掉', () => {
  const threeMinAgo = new Date(Date.now() - 180000).toISOString()
  const st = base({ sleepBar: 20, lastActionAt: threeMinAgo })
  const r = svc.planIntimateAction(st, { actionKey: 'thrust', sleeping: true, now: Date.now() })
  assert.ok(r.next.sleepBar >= 23 && r.next.sleepBar <= 25, `应先恢复到约 30 再扣 6，实际 ${r.next.sleepBar}`)
})

test('四档提示词：深睡 / 将醒 / 刚醒 / 催眠锁死各不相同', () => {
  const blockOf = (patch) => svc.buildIntimateSceneBlock(base(patch), { sleeping: true })
    .split('\n').find(l => l.includes('【状态】')) || ''

  const deep = blockOf({ sleepBar: 100 })
  const near = blockOf({ sleepBar: 20 })
  const woke = blockOf({ sleepBar: 0 })
  const locked = blockOf({ sleepBar: 50, forcedSleep: 1 })

  assert.match(deep, /还在睡|没醒/, '深睡档')
  assert.match(deep, /不要写她说完整的句子|梦呓/, '深睡档必须禁止完整句子')

  assert.match(near, /快醒了/, '将醒档')
  assert.match(near, /不要写她完全清醒|不许写完整对话/, '将醒档不能写成完全清醒')

  assert.match(woke, /刚醒/, '刚醒档')
  assert.match(woke, /意识回笼/, '刚醒必须有意识回笼那一瞬')

  assert.match(locked, /醒不过来|催眠锁在睡眠/, '禁醒档')
  assert.notEqual(deep, locked, '禁醒档与深睡档文案不能一样')
})

test('★ 敏感度参与唤醒：越敏感，同样的动作扣得越多（越快被弄醒）', () => {
  const cost = (sens) => {
    const st = base({ sleepBar: 100 })
    const r = svc.planIntimateAction(st, { actionKey: 'thrust', sleeping: true, now: Date.now(), sensitivity: sens })
    return 100 - r.next.sleepBar
  }
  assert.equal(cost(1), svc.SLEEP_COST_THRUST, '基准倍率就是原始消耗')
  assert.ok(cost(1.5) > cost(1), '敏感度 1.5 倍时应当扣得更多')
  assert.ok(cost(2) > cost(1.5), '更敏感扣得更多')
  // 下限保护：再迟钝也不会"一点都弄不醒"
  assert.ok(cost(0.1) >= 1, '消耗不会被压到 0')
})
