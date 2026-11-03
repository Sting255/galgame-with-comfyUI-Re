/**
 * 体位 → 生图：性爱场景里配图必须按当前体位画
 *
 * 为什么钉：不注入的话生图助手只会看到中文聊天记录，画出来的姿势跟面板上
 * 正在用的体位对不上 —— 而用户明确说过「生图是最重要的」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const svc = await import('../src/services/intimateActionService.js')
const { getDb } = await import('../src/db/index.js')

function seedCharacter(id = 9001) {
  const db = getDb()
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (?,?,?,?)`)
    .run(id, `c${id}`, '测试角色', '你是测试角色。')
  return id
}

test('没有进行中的场景：返回空串（普通聊天配图不受影响）', () => {
  const id = seedCharacter()
  assert.equal(svc.buildPositionImageBlock(id), '')
})

test('有场景时：中文名 + 英文标签 + 定格 + 硬要求都在块里', () => {
  const id = seedCharacter(9002)
  svc.saveIntimateScene(id, {
    active: true,
    positionKey: 'pr24.gP061.vaginal',
    pace: 3,
    accumulation: 20,
    penetrating: true,
  })
  const block = svc.buildPositionImageBlock(id)
  assert.ok(block.includes('当前体位'), '要有一个明确的标题')
  assert.ok(block.includes('前倾弯腰'), '要有中文体位名')
  assert.match(block, /doggystyle|from behind|bent over/i, '要带上该体位的英文标签')
  assert.ok(block.includes('这一格定在哪一瞬'), '要有定格描述')
  assert.ok(/画面必须按这个姿势画|不要画成别的姿势/.test(block), '要有硬要求，别让模型自由发挥')
})

test('非插入体位也会如实标注（避免配图画成插入）', () => {
  const id = seedCharacter(9003)
  svc.saveIntimateScene(id, { active: true, positionKey: 'paizuri', pace: 2, accumulation: 10, penetrating: false })
  const block = svc.buildPositionImageBlock(id)
  assert.ok(block.includes('非插入'), '非插入体位必须写明，否则生图会画错')
})

test('场景已结束（active=false）：不注入', () => {
  const id = seedCharacter(9004)
  svc.saveIntimateScene(id, { active: false, positionKey: 'pr24.gP061.vaginal', pace: 1, accumulation: 0 })
  assert.equal(svc.buildPositionImageBlock(id), '')
})

test('非法 characterId：安全返回空串，不抛错', () => {
  assert.equal(svc.buildPositionImageBlock(0), '')
  assert.equal(svc.buildPositionImageBlock('abc'), '')
  assert.equal(svc.buildPositionImageBlock(null), '')
})
