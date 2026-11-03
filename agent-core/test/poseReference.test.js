/**
 * 姿势参考图落盘：ComfyUI 的 LoadImage 只认它自己 input/ 目录里的文件
 *
 * 钉住三件事：
 *   ① 没配置 input 目录时必须明确报错（猜路径会变成「出图没姿势」的静默失败）
 *   ② data URL 落盘成固定前缀 + 短哈希的文件名，同图重复上传不重复写
 *   ③ 只保留最近若干张，不能无限堆积
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.DB_PATH = ':memory:'
const { config } = await import('../src/config.js')
const { savePoseReference, resolvePoseInputDir, prunePoseReferences, POSE_REF_PREFIX } = await import('../src/services/poseReference.js')

const dir = mkdtempSync(path.join(tmpdir(), 'pose-ref-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))

// 2KB 的合法 data URL（内容不要求是真 PNG，落盘只校验类型与体积）
const PNG_1x1 = `data:image/png;base64,${Buffer.alloc(2048, 7).toString('base64')}`
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('没配置 input 目录：明确报错，不猜路径', () => {
  config.comfyui.inputDir = ''
  assert.equal(resolvePoseInputDir(), '')
  assert.throws(() => savePoseReference(PNG_1x1), /未配置 ComfyUI 的 input 目录/)
})

test('配置后可保存，文件名带固定前缀', () => {
  config.comfyui.inputDir = dir
  const { name } = savePoseReference(PNG_1x1)
  assert.match(name, new RegExp(`^${POSE_REF_PREFIX}[0-9a-f]{12}\\.png$`))
  assert.ok(existsSync(path.join(dir, name)))
})

test('同一张图重复上传不重复写文件', () => {
  const a = savePoseReference(PNG_1x1).name
  const b = savePoseReference(PNG_1x1).name
  assert.equal(a, b)
  assert.equal(readdirSync(dir).filter(f => f.startsWith(POSE_REF_PREFIX)).length, 1)
})

test('格式与体积校验：非图片 / 空内容都拒绝', () => {
  assert.throws(() => savePoseReference('not-a-data-url'), /必须是图片/)
  assert.throws(() => savePoseReference('data:image/gif;base64,R0lGOD'), /格式不支持/)
  assert.throws(() => savePoseReference(TINY), /内容为空/)
})

test('只保留最近 N 张，旧的被清掉', () => {
  const d2 = mkdtempSync(path.join(tmpdir(), 'pose-prune-'))
  try {
    for (let i = 0; i < 12; i++) {
      const f = path.join(d2, `${POSE_REF_PREFIX}old${i}.png`)
      writeFileSync(f, 'x')
      const t = new Date(Date.now() - (12 - i) * 1000)
      utimesSync(f, t, t)
    }
    const keep = path.join(d2, `${POSE_REF_PREFIX}newest.png`)
    writeFileSync(keep, 'x')
    prunePoseReferences(d2, path.basename(keep))
    const left = readdirSync(d2).filter(f => f.startsWith(POSE_REF_PREFIX))
    assert.ok(left.length <= 8, `应只留 8 张，实际 ${left.length}`)
    assert.ok(left.includes(path.basename(keep)), '最新的那张不能被删')
  } finally {
    rmSync(d2, { recursive: true, force: true })
  }
})
