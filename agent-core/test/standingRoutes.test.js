/**
 * 场景立绘 API（与上游 v3.10.0 统一后的 `/:id/standings…`）与图片批量删除。
 *
 * 钉住的东西：
 *   · 规范路径 `GET/POST/DELETE /:id/standings…` 行为（含 scenes 清单、上传校验、删完回 standings）
 *   · 旧 `/scene-standings…` 兼容别名仍然可用（前端已切新路径，但旧缓存包不能 404）
 *   · `delete-batch` 的幂等（同一 URL 删两次都算成功）与 .avif 孪生一起删
 *
 * 注意：IMAGES_DIR 必须在 import imagePaths 之前指向临时目录 —— 否则测试会往
 * 真实 `agent-core/data/images` 里写文件（本仓库的硬纪律：真实数据只读）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_IMAGES = path.join(os.tmpdir(), `linshe-standing-test-${process.pid}`)
process.env.IMAGES_DIR = TMP_IMAGES

const { getDb, closeDb } = await import('../src/db/index.js')
const charactersRouter = (await import('../src/routes/characters.js')).default
const imagesRouter = (await import('../src/routes/images.js')).default
const { getImageDir } = await import('../src/services/imagePaths.js')

const app = express()
app.use(express.json({ limit: '12mb' }))
app.use('/api/characters', charactersRouter)
app.use('/api/images', imagesRouter)
const server = http.createServer(app)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

after(() => {
  server.close()
  closeDb?.()
  fs.rmSync(TMP_IMAGES, { recursive: true, force: true })
})

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function seedCharacter() {
  const db = getDb()
  const info = db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run(`t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, '测试角色', 'a young woman with long black hair, standing in a sunlit room')
  return info.lastInsertRowid
}

async function jsonFetch(url, options) {
  const res = await fetch(BASE + url, options)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

const postJson = (url, body) => jsonFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('GET /:id/standings 返回五套场景清单，旧别名同样可用', async () => {
  const id = seedCharacter()
  const fresh = await jsonFetch(`/api/characters/${id}/standings`)
  assert.equal(fresh.status, 200)
  assert.ok(fresh.body.scenes.length >= 5)
  assert.ok(Array.isArray(fresh.body.standings))

  const legacy = await jsonFetch(`/api/characters/${id}/scene-standings`)
  assert.equal(legacy.status, 200)
  assert.deepEqual(legacy.body.standings, fresh.body.standings)

  const missing = await jsonFetch('/api/characters/999999/standings')
  assert.equal(missing.status, 404)
})

test('POST /:id/standings/upload 校验场景与图片格式，成功后落库并可删除', async () => {
  const id = seedCharacter()
  const scene = (await jsonFetch(`/api/characters/${id}/standings`)).body.scenes[0].key ?? 'work'

  const badScene = await postJson(`/api/characters/${id}/standings/upload`, { scene: 'not-a-scene', base64: PNG_1PX })
  assert.equal(badScene.status, 400)
  assert.match(badScene.body.error, /场景/)

  const badImage = await postJson(`/api/characters/${id}/standings/upload`, { scene, base64: 'not-an-image' })
  assert.equal(badImage.status, 400)
  assert.match(badImage.body.error, /PNG|JPG|WEBP/)

  const ok = await postJson(`/api/characters/${id}/standings/upload`, { scene, base64: PNG_1PX })
  assert.equal(ok.status, 200)
  assert.match(ok.body.image_url, /^\/images\//)
  const stored = path.join(getImageDir('standing'), path.basename(ok.body.image_url))
  assert.equal(fs.existsSync(stored), true, '上传后图片应落盘')
  assert.ok(ok.body.standings.some(row => row.scene === scene), '返回里应带上最新的 standings')

  const removed = await jsonFetch(`/api/characters/${id}/standings/${scene}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.equal(fs.existsSync(stored), false, '删除后文件应被清掉')
  for (const row of removed.body.standings || []) assert.notEqual(row.image_url, ok.body.image_url)
})

test('POST /api/images/delete-batch 逐张复用删除逻辑：幂等 + 清 .avif 孪生 + 报非法 URL', async () => {
  const dir = getImageDir('chat')
  fs.mkdirSync(dir, { recursive: true })
  const filename = `batch_${Date.now()}.png`
  const filePath = path.join(dir, filename)
  fs.writeFileSync(filePath, Buffer.from(PNG_1PX.split(',')[1], 'base64'))
  const twin = filePath.replace(/\.png$/i, '.avif')
  fs.writeFileSync(twin, Buffer.from('fake-avif'))
  const url = `/images/${path.basename(dir)}/${filename}`

  const result = await postJson('/api/images/delete-batch', { urls: [url, url, 'not-a-url'] })
  assert.equal(result.status, 200)
  assert.equal(result.body.success, true)
  assert.equal(result.body.deleted, 2, '同一张删两次都应算成功（幂等）')
  assert.equal(result.body.failed, 1)
  assert.equal(fs.existsSync(filePath), false)
  assert.equal(fs.existsSync(twin), false, '.avif 孪生必须一起删')

  const notArray = await postJson('/api/images/delete-batch', { urls: 'nope' })
  assert.equal(notArray.status, 400)
})
