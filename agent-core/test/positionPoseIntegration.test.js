/**
 * 体位 → 骨架 JSON（buildPositionPoseJson / buildPositionImageTags）的接线测试
 *
 * 为什么钉这些（2026-11-03 审查 P2-7）：这两个函数全仓 0 覆盖，于是
 * 「新开场景的默认体位 missionary 永远拿不到骨架」这种 P0 一路蒙过去了
 * —— 骨架有、标签空 / 有标签、骨架 null，出图都是正常但姿势不跟，最难发现。
 *
 * 场景一律走 saveIntimateScene 真实落库，不手写 SQL：绕过它等于绕过默认体位、
 * 状态归一化和 active 判定，测出来的绿是假的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const svc = await import('../src/services/intimateActionService.js')
const { config, setPoseFromPosition } = await import('../src/config.js')
const { getDb } = await import('../src/db/index.js')

function seedCharacter(id) {
  getDb().prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (?,?,?,?)`)
    .run(id, `c${id}`, '测试角色', '你是测试角色。')
  return id
}

test('默认体位 missionary：返回非空骨架 + 标签（审查抓到的 P0：以前永远 null）', () => {
  const id = seedCharacter(9101)
  svc.saveIntimateScene(id, { active: true, positionKey: 'missionary', penetrating: true })

  const pose = svc.buildPositionPoseJson(id)
  assert.ok(pose, '默认体位必须能拿到骨架')
  assert.equal(JSON.parse(pose.json).points.length, 133, '必须是 133 点 COCO-WholeBody 骨架')
  assert.equal(pose.group, 'onback')
  assert.ok(svc.buildPositionImageTags(id).trim(), '默认体位也要有英文标签，不能只有骨架')
})

test('精选英文 key doggystyle：骨架非空且形态大类是 frombehind', () => {
  const id = seedCharacter(9102)
  svc.saveIntimateScene(id, { active: true, positionKey: 'doggystyle', penetrating: true })

  const pose = svc.buildPositionPoseJson(id)
  assert.ok(pose, '精选英文 key 必须能解析出骨架')
  assert.equal(pose.group, 'frombehind')
  assert.match(svc.buildPositionImageTags(id), /from behind|doggystyle/i, '标签要能表达后入')
})

test('poseFromPosition 关掉不出骨架，打开后又能出', () => {
  const id = seedCharacter(9103)
  svc.saveIntimateScene(id, { active: true, positionKey: 'doggystyle', penetrating: true })
  try {
    setPoseFromPosition(false)
    assert.equal(config.comfyui.poseFromPosition, false)
    assert.equal(svc.buildPositionPoseJson(id), null, '开关关掉必须完全不注入')

    setPoseFromPosition(true)
    assert.ok(svc.buildPositionPoseJson(id), '开关打开后骨架要回来')
  } finally {
    setPoseFromPosition(true)
  }
})

test('没有进行中的场景：返回 null / 空串，普通配图不受影响', () => {
  const id = seedCharacter(9104)
  assert.equal(svc.buildPositionPoseJson(id), null, '从没开过场景')
  assert.equal(svc.buildPositionImageTags(id), '')

  svc.saveIntimateScene(id, { active: false, positionKey: 'doggystyle' })
  assert.equal(svc.buildPositionPoseJson(id), null, '场景已结束')
  assert.equal(svc.buildPositionImageTags(id), '')

  assert.equal(svc.buildPositionPoseJson(0), null, '非法 id 不抛错')
})
