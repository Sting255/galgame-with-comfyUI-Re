import Database from 'better-sqlite3';
import { assertDatabaseAvailable } from './maintenance.js';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { assertNotDowngrade, recordAppRelease, readAppRelease } from './releaseGuard.js';
import { cleanupTownDialogueRequests } from './migrations/legacy/town.js';
import { cleanupInterruptedChestItems } from '../services/itemLifecycle.js';
import { recoverExpressionStandingJobs } from './expressionStandingSchema.js';
import { recoverInterruptedDiaries } from './diarySchema.js';
import { recoverSpeechJobs } from './ttsSchema.js';
import { recoverPhotoStudioFinishes } from './photoStudioSchema.js';
import { initSchema } from './migrations/0001-baseline.js';
import { SCHEMA_VERSION, runSchemaMigrations, prepareMigrationSnapshot, finishMigrationSnapshot } from './migrations/runner.js';
export { initSchema } from './migrations/0001-baseline.js';
export { seedImagePromptKnowledge } from './migrations/legacy/knowledge.js';
export { migrateMomentPostNpcAuthors } from './migrations/legacy/moments.js';
export { migrateMomentPostUserAuthors } from './migrations/legacy/moments.js';
export { migrateNewspaperDropForeignKey } from './migrations/legacy/characters.js';
export { migrateNewspaperWorldDismissed } from './migrations/legacy/settings.js';
export { dropImagePromptPreparations } from './migrations/legacy/knowledge.js';
export { migrateTownEncounterOutcome } from './migrations/legacy/town.js';
export { ensureCharacterScopeColumn } from './migrations/legacy/characters.js';
export { migrateCharacterScope } from './migrations/legacy/characters.js';
export { migrateScheduleSchema } from './migrations/legacy/characters.js';
export { migrateTownMultiMapSchema } from './migrations/legacy/town.js';
export { seedDefaultWorldSetting } from './migrations/legacy/settings.js';
export { migrateChatBgSchema } from './migrations/legacy/chat.js';
export { migrateMomentTopicsSchema } from './migrations/legacy/moments.js';
export { migratePinSchema } from './migrations/legacy/characters.js';
export { migrateIntimateSchema } from './migrations/legacy/intimate.js';
export { migrateIntimateSceneSchema } from './migrations/legacy/intimate.js';
export { migrateTouchSchema } from './migrations/legacy/intimate.js';
export { migrateWornToysSchema } from './migrations/legacy/intimate.js';
export { migrateToyPlaySchema } from './migrations/legacy/intimate.js';
export { migratePrivateMomentSchema } from './migrations/legacy/moments.js';
export { migrateCharacterOutfitScene } from './migrations/legacy/characters.js';
export { migrateHypnosisSchema } from './migrations/legacy/intimate.js';
export { migrateChatMemoryV2Schema } from './migrations/legacy/memory.js';
export { migrateChatMemoryV3Schema } from './migrations/legacy/memory.js';
export { migrateMemoryConsolidationMarks } from './migrations/legacy/memory.js';
export { migrateMemoryConsolidationSettings } from './migrations/legacy/memory.js';
export { migrateMemorySettingsExplicitBlocks } from './migrations/legacy/memory.js';
let db;

/**
 * 语句缓存的**计数器**（只用于观测/测试，不影响行为）。
 * 为什么要它：规划 §一-1 指出 chat.js 一轮聊天里 93 处 `db.prepare()` 都被重复编译
 * （better-sqlite3 每次 prepare 要解析 SQL → 编译字节码 → 建 statement，20~80µs），
 * 要证明"改完真的少编译了"，就得有一个能数出来的指标。
 * `compiles` = 真正编译过的次数；`hits` = 命中缓存复用次数。
 */
const stmtStats = { compiles: 0, hits: 0, size: 0 };
export function stmtCacheStats() {
  return { ...stmtStats };
}
export function resetStmtCacheStats() {
  stmtStats.compiles = 0;
  stmtStats.hits = 0;
}
/**
 * 拿一条**已编译语句**（懒编译 + 按库实例缓存）。
 *
 * 用法：把热路径上的 `getDb().prepare(SQL)` 换成 `stmt(SQL)`，其余 `.get/.all/.run` 照旧。
 *
 * 为什么按库实例缓存（WeakMap 键就是 db 实例）：
 * 测试会换内存库、`closeDb()` 之后也会重开 ⇒ 语句必须跟着实例走，
 * 否则复用到的会是"另一个库（甚至已关闭的库）"编译出来的 statement。
 * WeakMap 让旧实例连同它的语句一起被回收，天然没有清缓存的心智负担。
 *
 * 为什么安全：better-sqlite3 是**同步**执行的，一条语句不会在一轮里被打断，
 * 因此跨轮复用同一个 statement 对象不存在竞态；SQL 全是静态字符串 + 参数绑定（本仓抽查过），
 * 缓存键就是 SQL 全文，没有拼接注入面。
 */
const stmtCaches = new WeakMap();
export function stmt(sql, database = getDb()) {
  let cache = stmtCaches.get(database);
  if (!cache) {
    cache = new Map();
    stmtCaches.set(database, cache);
  }
  const cached = cache.get(sql);
  if (cached) {
    stmtStats.hits++;
    return cached;
  }
  const compiled = database.prepare(sql);
  cache.set(sql, compiled);
  stmtStats.compiles++;
  // WeakMap 不可迭代（拿不到 values()），所以条目数自己记：只用于观测。
  stmtStats.size++;
  return compiled;
}

/** getDb 自愈只提醒一次（见下）；测试要能重置 */
let reopenedAfterCloseWarned = false;

/** 测试用：重置"已提醒过自愈"标志 */
export function resetDbReopenWarning() {
  reopenedAfterCloseWarned = false;
}

export function getDb() {
  assertDatabaseAvailable();
  // 2026-10-02 自愈（真机日志：某个路径直接 `db.close()` 之后，调度器每分钟刷一条
  // `The database connection is not open`）：这里是**唯一入口**，句柄被关掉就地重开，
  // 而不是让每个调用方自己判断。只提醒一次，避免刷屏（根因仍应在调用方查）。
  if (db && !db.open) {
    if (!reopenedAfterCloseWarned) {
      reopenedAfterCloseWarned = true;
      console.warn('[db] 检测到库句柄已被关闭（有人直接 db.close()？）—— 已自动重开；这条只提醒一次。');
    }
    db = undefined;
  }
  if (!db) {
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(config.dbPath);
    try {
    // 降级检查先于任何可能写库的 pragma；迁移快照也必须先于旧版兼容修复。
    assertNotDowngrade(db, { schemaVersion: SCHEMA_VERSION });
    const snapshot = prepareMigrationSnapshot(db);
    // ⚠️ 顺序有讲究（2026-10-15 实测踩到）：`auto_vacuum` 必须在 `journal_mode = WAL` **之前**设置，
    //    否则静默失效（实测设了还是 0=NONE）。所以先定 auto_vacuum，再切 WAL。
    applyAutoVacuumPolicy(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // P1-13：并发与耐久性基线。
    //
    // busy_timeout：WAL 下读写可以并发，但写-写仍互斥。没有 busy_timeout 时第二个写者
    // 会立刻拿到 SQLITE_BUSY 而不是排队等待——调度器 tick、路由请求、索引 worker
    // 同时落库时会出现「偶发的 database is locked」。
    // synchronous=NORMAL：WAL 下的推荐档位，提交不必 fsync 到盘（断电最多丢最后一个事务，
    // 不会损坏库），比默认 FULL 快一个数量级；本应用的数据都能从业务上重建或重试。
    try {
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');
    } catch (err) {
      console.warn('[db] pragma 设置失败（不影响启动）:', err.message);
    }
    // 建表之后的轻量维护（详见 runStartupDbMaintenance）
      initSchema(db);
      cleanupOrphanedInFlight(db);
      runStartupDbMaintenance(db);
      // P1-13：结构迁移在业务维护之后跑，且失败直接抛出去关库。
      // 旧版修复每次启动仍运行；新版本的 DDL 由 runner 分版本事务化。
      runSchemaMigrations(db, { baselineApplied: true });
      // 全部成功才记下「被哪个版本打开过」（只升不降），供将来的旧版本拒绝打开
      if (recordAppRelease(db)) console.log(`[db] 数据版本标记更新为 v${readAppRelease()}`);
      finishMigrationSnapshot(db, snapshot);
    } catch (error) {
      db.close();
      db = undefined;
      throw error;
    }
  }
  return db;
}

/**
 * `auto_vacuum` 策略（2026-10-15）：
 *   · 新库 ⇒ 设成 INCREMENTAL（配合 PRAGMA incremental_vacuum 可以"按需回收"，不必整库 VACUUM）；
 *   · 老库 ⇒ 不动它（切换要整库 VACUUM，用户库 9.5MB / 5000+ 消息，不值得为这点空间冒重写风险），
 *     只记一行日志让运维知道"可以手动做一次"。
 *
 * ⚠️ **必须在 `journal_mode = WAL` 之前调用** —— SQLite 的规则：auto_vacuum 在 WAL 模式下设置会静默失效。
 *    （本轮第一版就是先切 WAL 再设，实测新库仍是 0=NONE，白写。）
 * ⚠️ 本文件里是 `db.exec(\`...\`)` 的模板字符串上下文，注释里**别写反引号**（会截断字符串，踩过两次）。
 */
function applyAutoVacuumPolicy(database) {
  let current = 0;
  try {
    current = database.pragma('auto_vacuum', { simple: true });
  } catch {
    return; // 老 SQLite 没这个 pragma：跳过，不影响启动
  }
  // 0=NONE 1=FULL 2=INCREMENTAL
  const isEmptyDb = (() => {
    try {
      const n = database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
      return n === 0;
    } catch {
      return false;
    }
  })();

  if (isEmptyDb && current !== 2) {
    try {
      database.pragma('auto_vacuum = INCREMENTAL');
      console.log('[db] 新建库：auto_vacuum = INCREMENTAL（可随时用 incremental_vacuum 按需回收）');
    } catch (err) {
      console.warn('[db] 设置 auto_vacuum 失败（不影响使用）:', err?.message || err);
    }
    return;
  }
  if (!isEmptyDb && current === 0) {
    // 只说一次、且不吓人：老库不切换是完全正常的取舍
    console.log('[db] 已有库 auto_vacuum = NONE（正常）：如需回收空洞，关机后手动执行一次 VACUUM 即可');
  }
}

/**
 * 启动时的轻量维护（2026-10-15）：
 *   · PRAGMA optimize —— 官方推荐的启动动作，按需更新统计信息（无统计信息时查询计划会退化）；
 *   · INCREMENTAL 模式且 WAL 积累较多时，回收一页（一次调用只回收少量，绝不阻塞启动）。
 * 两条都包在 try 里、失败只 warn：维护动作**绝不允许**挡住启动。
 *
 * ⚠️ 本文件里有 db.exec 的模板字符串，**注释里一律不写反引号**（一个就截断整段 SQL，踩过三次）。
 */
function runStartupDbMaintenance(database) {
  try {
    database.pragma('optimize');
  } catch (err) {
    console.warn('[db] PRAGMA optimize 失败（不影响使用）:', err?.message || err);
  }
  try {
    if (database.pragma('auto_vacuum', { simple: true }) === 2) {
      const reclaimed = database.pragma('incremental_vacuum(16)', { simple: true });
      if (reclaimed) console.log(`[db] 启动回收空闲页: ${reclaimed} 页`);
    }
  } catch {
    // 空库 / 不支持：静默跳过
  }
}

/** 当前库的 schema 版本（排障与备份 manifest 用） */
export function getSchemaVersion(database = getDb()) {
  try {
    return Number(database.pragma('user_version', { simple: true })) || 0;
  } catch {
    return 0;
  }
}

export { SCHEMA_VERSION };

// ── 启动清理：进程中断后，"生成中/处理中" 状态永远不会被完成，统一回收 ──
// moment_posts、mailbox_letters 自带启动自愈逻辑，不在此重复处理
function cleanupOrphanedInFlight(database) {
  recoverPhotoStudioFinishes(database);
  database.prepare("UPDATE photo_studio_jobs SET status = 'failed', stage = 'failed', error = '服务重启导致拍摄中断，请重新拍摄', finished_at = datetime('now') WHERE status = 'running'").run();
  recoverInterruptedDiaries(database);
  recoverSpeechJobs(database);
  recoverExpressionStandingJobs(database);
  cleanupTownDialogueRequests(database);
  const tasks = [
    // 表名, 中断状态, 回收为（interrupted 后可重新生成的状态）
    ['character_emojis', `status = 'generating'`, `status = 'failed', error_message = '服务重启导致生成中断，请重新生成'`],
    ['image_tasks', `status IN ('pending','running')`, `status = 'failed', error_message = '服务重启导致任务中断', finished_at = datetime('now')`],
    ['reply_queue', `status = 'processing'`, `status = 'waiting'`],
    ['character_dreams', `status = 'generating'`, `status = 'failed'`],
    ['town_npc_service_sessions', `status = 'generating'`, `status = 'failed'`],
  ];
  for (const [table, where, set] of tasks) {
    try {
      const result = database.prepare(`UPDATE ${table} SET ${set} WHERE ${where}`).run();
      if (result.changes > 0) {
        console.log(`[db] 启动清理: ${table} ${result.changes} 条中断状态已回收`);
      }
    } catch (err) {
      console.warn(`[db] 启动清理 ${table} 失败:`, err.message);
    }
  }

  // 宝箱道具：中断的 generating 未完成图片，也不应占用冷却；直接清掉，允许下次重新开箱
  try {
    const interruptedItems = cleanupInterruptedChestItems(database);
    if (interruptedItems > 0) {
      console.log(`[db] 启动清理: backpack_items ${interruptedItems} 条中断生成任务已清理`);
    }
  } catch (err) {
    console.warn(`[db] 启动清理 backpack_items 失败:`, err.message);
  }

  // 延迟评论队列（P1-04）：processing 行重启后没人接管，必须回收成 waiting。
  // 评论落库与队列置 done 已在同一事务里，所以这里不需要判断「是否已经插过」——
  // 事务保证了 processing 状态下的行一定还没有落评论。reply_comment_id 非空的
  // processing 行（理论上不存在，留给旧库）直接补成 done，避免重复回。
  try {
    const alreadyDone = database.prepare(
      `UPDATE moment_comment_queue SET status = 'done', processed_at = datetime('now')
       WHERE status = 'processing' AND reply_comment_id IS NOT NULL`
    ).run();
    const recovered = database.prepare(
      `UPDATE moment_comment_queue SET status = 'waiting' WHERE status = 'processing'`
    ).run();
    const total = alreadyDone.changes + recovered.changes;
    if (total > 0) {
      console.log(`[db] 启动清理: moment_comment_queue ${recovered.changes} 条恢复为等待、${alreadyDone.changes} 条补记为完成`);
    }
  } catch (err) {
    // 老库可能还没有 reply_comment_id 列（迁移顺序不同）；不是致命错误
    if (!/no such column/.test(String(err?.message || ''))) {
      console.warn(`[db] 启动清理 moment_comment_queue 失败:`, err.message);
    }
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * 库句柄是否还开着（2026-10-02，真机日志：调度器每分钟刷一条
 * `The database connection is not open` —— 那是**次生噪音**，根因在别处；
 * 调度器用它做自愈判断：句柄被关掉时自己重开，而不是一路报错）。
 */
export function isDbOpen() {
  try {
    return Boolean(db && db.open);
  } catch {
    return false;
  }
}

/**
 * 强制重建 FTS5 索引。当写入操作（DELETE/INSERT/UPDATE on messages）
 * 因 FTS 虚拟表损坏（SQLITE_CORRUPT_VTAB）而失败时，路由层可调用此函数
 * 完全重建 FTS 表结构和索引，之后重试原操作即可成功。
 */
export function repairFtsIndex() {
  const database = getDb();
  console.log('[db] repairFtsIndex: full FTS rebuild...');

  // 1. 删触发器（它们依赖 messages_fts）
  database.exec(`DROP TRIGGER IF EXISTS messages_ai`);
  database.exec(`DROP TRIGGER IF EXISTS messages_ad`);
  database.exec(`DROP TRIGGER IF EXISTS messages_au`);

  // 2. 删损坏的虚拟表
  database.exec(`DROP TABLE IF EXISTS messages_fts`);

  // 3. 重建 FTS 表结构
  database.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id'
    );
  `);

  // 4. 重建触发器
  database.exec(`
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  database.exec(`
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `);
  database.exec(`
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  // 5. 全量重建索引
  const msgs = database.prepare(`SELECT id, content FROM messages`).all();
  if (msgs.length > 0) {
    const insert = database.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`);
    for (const m of msgs) {
      insert.run(m.id, m.content);
    }
    console.log(`[db] repairFtsIndex: ${msgs.length} messages re-indexed`);
  }
  console.log('[db] repairFtsIndex: done');
}

// ── 世界观 / 全局规则仓储已下沉到 db/worldRepository.js（缩小本模块体积）──
// 函数由 worldRepository 提供，此处兼容再导出；db 句柄在 getDb() 打开时注入。
export {
  getActiveGlobalRules,
  getWorldSetting,
  getSystemRulesWithWorld,
  getGlobalRule,
  getSystemRules,
  listWorldSettings,
  getActiveWorldSetting,
  getWorldSettingById,
  createWorldSetting,
  updateWorldSetting,
  deleteWorldSetting,
  activateWorldSetting,
} from './worldRepository.js';

// ── 系统设置已下沉到 db/settings.js（打破 config↔db 循环依赖）──
// getSetting/setSetting/SETTING_TO_CONFIG/loadSystemSettings 均由 settings.js 提供，
// 此处仅做兼容再导出，既有 import 路径不受影响。
export { getSetting, setSetting, SETTING_TO_CONFIG } from './settings.js';

// ── 2026-10-14 补漏合并：上游 v3.9.0 把这两支迁移直接 export 在本模块 ──
// 本地已分别下沉到 db/soulSchema.js 与 db/mediaSchema.js（内容与上游逐字节一致），
// 但漏了从本模块再导出；上游测试按 `import ... from '../src/db/index.js'` 取，故补回。
export { migrateSoulSchema } from './soulSchema.js';
export { migrateMediaOutletLayouts } from './mediaSchema.js';

// loadSystemSettings 已移至 db/settings.js（config 作为参数传入，避免反向依赖 config 之外的耦合）

