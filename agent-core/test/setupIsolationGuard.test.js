/** 程序测试的隔离与新库初始化；不读取玩家数据。 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { resolveEnvPath } from '../src/utils/envFile.js'

const CORRECT_CMD = 'node --test --import ./test/setup.mjs --test-concurrency=1 test/setupIsolationGuard.test.js'
const hint = `请加载隔离入口：${CORRECT_CMD}`

test('配置读写只指向测试进程的临时文件', () => {
  assert.ok(process.env.LINSHE_ENV_PATH, hint)
  assert.equal(resolveEnvPath(), process.env.LINSHE_ENV_PATH)
  const relative = path.relative(os.tmpdir(), resolveEnvPath())
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), hint)
})

test('数据库环境必须指向内存库', () => {
  assert.equal(process.env.DB_PATH, ':memory:', hint)
})

test('模型环境必须指向隔离地址', () => {
  assert.equal(process.env.LLM_BASE_URL, 'http://127.0.0.1:9/v1', hint)
})

test('素材目录必须位于系统临时目录内', () => {
  assert.ok(process.env.TOWN_ASSETS_DIR, hint)
  const relative = path.relative(os.tmpdir(), path.resolve(process.env.TOWN_ASSETS_DIR))
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), hint)
})

test('文件日志必须关闭', () => {
  assert.equal(process.env.LOG_TO_FILE, 'false', hint)
})

let closeDb
// 先断言隔离，再 import 配置/数据库；裸跑绝不打开默认玩家库。
async function isolatedDatabase() {
  assert.equal(process.env.DB_PATH, ':memory:', hint)
  process.env.COMFYUI_URL = 'http://127.0.0.1:9'
  const { config } = await import('../src/config.js')
  assert.equal(config.dbPath, ':memory:', '实际配置不能覆盖测试隔离')
  const dbModule = await import('../src/db/index.js')
  closeDb = dbModule.closeDb
  return dbModule
}
after(() => closeDb?.())

test('全新库创建核心表，SQLite 实际连接没有磁盘文件', async () => {
  const { getDb } = await isolatedDatabase()
  const db = getDb()
  const main = db.pragma('database_list').find(row => row.name === 'main')
  assert.equal(main.file, '', '内存库不能绑定磁盘路径')
  for (const table of ['characters', 'messages', 'character_events', 'event_history', 'system_settings']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table)
  }
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
})

test('关闭后重新初始化得到新内存库，不继承前一次运行数据', async () => {
  const { getDb, closeDb } = await isolatedDatabase()
  getDb().exec("CREATE TABLE isolation_probe(value TEXT); INSERT INTO isolation_probe VALUES('fixture')")
  closeDb()
  const fresh = getDb()
  assert.equal(fresh.pragma('database_list').find(row => row.name === 'main').file, '')
  assert.equal(fresh.prepare("SELECT name FROM sqlite_master WHERE name='isolation_probe'").get(), undefined)
  assert.ok(fresh.prepare("SELECT name FROM sqlite_master WHERE name='characters'").get())
})
