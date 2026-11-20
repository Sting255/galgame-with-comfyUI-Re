


/**
 * 迁移: 亲密档案与统计看板（v3.6.0）
 *
 * 六张表全部 CREATE IF NOT EXISTS，幂等；导出供回归测试直接调用。
 *
 * 刻意不加 CHECK 约束：场景 / 伙伴类型 / 来源都是会继续扩张的枚举，历史教训是
 * CHECK 一旦写死，加一个取值就要重建表（见 gift_history 的迁移注释）。
 *
 * 幂等键设计：(character_id, source_uid) 唯一。
 *   自动记账 uid = auto:scene:raw<id>:actKey:positionKey:partnerKind:partnerId（确定性）
 *   人工记账 uid = manual:<uuid>
 * 所有"可能为空的维度列"一律 NOT NULL DEFAULT ''，因为 SQLite 视 NULL 互不相等，
 * 用 NULL 会让唯一约束失效 —— 那会导致同一次行为被反复计数。
 *
 * 存量库补列走 PRAGMA + ALTER：CREATE TABLE IF NOT EXISTS 对已存在的表不生效，
 * 老库必须显式补列，否则第一条 SELECT 就会因缺列报错。
 */
export function migrateIntimateSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_body_profile (
        character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        height TEXT NOT NULL DEFAULT '',
        bust TEXT NOT NULL DEFAULT '',
        waist TEXT NOT NULL DEFAULT '',
        hip TEXT NOT NULL DEFAULT '',
        cup TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        sensitive_zones TEXT NOT NULL DEFAULT '[]',
        inject_enabled INTEGER NOT NULL DEFAULT 0,
        ai_edit_fields TEXT NOT NULL DEFAULT '[]',
        view_scope TEXT NOT NULL DEFAULT '["user","character"]',
        backfill_enabled INTEGER NOT NULL DEFAULT 1,
        ai_judge_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS character_intimate_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        source_uid TEXT NOT NULL,
        act_key TEXT NOT NULL,
        position_key TEXT NOT NULL DEFAULT '',
        custom_label TEXT NOT NULL DEFAULT '',
        partner_kind TEXT NOT NULL DEFAULT 'user',
        partner_id INTEGER NOT NULL DEFAULT 0,
        scene TEXT NOT NULL DEFAULT 'chat',
        act_count INTEGER NOT NULL DEFAULT 1,
        climax_count INTEGER NOT NULL DEFAULT 0,
        raw_id INTEGER NOT NULL DEFAULT 0,
        msg_id INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'auto',
        confidence REAL NOT NULL DEFAULT 1,
        occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(character_id, source_uid)
      );
      CREATE INDEX IF NOT EXISTS idx_intimate_log_char_time
        ON character_intimate_log(character_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_intimate_log_raw
        ON character_intimate_log(raw_id);

      CREATE TABLE IF NOT EXISTS character_intimate_firsts (
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        act_key TEXT NOT NULL,
        first_at DATETIME,
        source_raw_id INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'derived',
        note TEXT NOT NULL DEFAULT '',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (character_id, act_key)
      );

      CREATE TABLE IF NOT EXISTS character_intimate_stats (
        character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        stats_json TEXT NOT NULL DEFAULT '{}',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- 历史回填进度（每个角色一行）：last_raw_id 之前的 raw_messages 已扫过，
      -- 回填中断/重跑都从这里续，状态机由回填引擎维护（见 services/intimateBackfill.js）
      CREATE TABLE IF NOT EXISTS character_intimate_backfill (
        character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'idle',
        last_raw_id INTEGER NOT NULL DEFAULT 0,
        scanned INTEGER NOT NULL DEFAULT 0,
        inserted INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // AI 整理的"待确认提议"：AI 未获授权的字段只落这里，等用户在面板上采纳/忽略
    // （见 services/intimateAiEdit.js）。纯新增表、没有存量列要补，
    // 所以只用 CREATE TABLE IF NOT EXISTS，不参与下面的 ALTER 回填逻辑。
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_intimate_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        current_value TEXT NOT NULL DEFAULT '',
        suggestion TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        source TEXT NOT NULL DEFAULT 'ai',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_intimate_suggestions_char
        ON character_intimate_suggestions(character_id, status);
    `);

    // 存量库补列：列已存在就跳过，重复调用不会重复执行
    const addColumnIfMissing = (table, column, ddl) => {
      const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
      if (exists) return false;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      console.log(`[db] Added ${table}.${column} column`);
      return true;
    };

    // 补列那一刻的存量行等于「从未设置过 AI 修改权限」，回填成语义默认值（仅统计可自动写）。
    // 不能把它们留在列默认的空数组上：那样用户只要编辑过一次档案，自动记账就被永久掐断。
    // 只在补列成功时回填一次，用户之后主动清空权限不会被这里再改回来。
    if (addColumnIfMissing('character_body_profile', 'ai_edit_fields', `ai_edit_fields TEXT NOT NULL DEFAULT '[]'`)) {
      db.exec(`UPDATE character_body_profile SET ai_edit_fields = '["stats"]'`);
    }
    addColumnIfMissing('character_body_profile', 'view_scope', `view_scope TEXT NOT NULL DEFAULT '["user","character"]'`);
    addColumnIfMissing('character_body_profile', 'backfill_enabled', `backfill_enabled INTEGER NOT NULL DEFAULT 1`);
    // task-32：亲密看板「AI 判断行为」默认开关（默认关，开了以后每轮异步多一次 LLM 判定）
    addColumnIfMissing('character_body_profile', 'ai_judge_enabled', `ai_judge_enabled INTEGER NOT NULL DEFAULT 0`);

    // 口径默认值变更（task-26）：默认由「只看用户↔角色」扩到「用户↔角色 + 角色↔角色」。
    // 为什么必须迁存量行：口径是**每角色持久化**在 character_body_profile.view_scope 的，
    // 只改服务层 DEFAULT_VIEW_SCOPE 的话，凡是打开过看板 / 保存过设置的角色，库里存的还是旧默认
    // ["user"] —— 群聊流水（partner_kind='character'）就永远默认看不见，那正是用户报的
    // 「群聊的消息没有引入看板」的一层原因。
    // 存量行里的 ["user"] 分不清"旧默认"还是"用户主动只留这一类"，但口径只是一次点击就能改回的
    // 视图过滤（不删任何数据），所以按"默认值变更"处理；打 once 标记只跑一次，用户之后主动收窄不会被改回来。
    // 老库里该列的 SQL 默认值仍是 '["user"]'，但调用方一律写显式值、NULL/空串由服务层回落到新默认，
    // 所以不必为改默认值重建表。
    const viewScopeMarker = db.prepare(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'intimate_view_scope_group_default'`
    ).get();
    if (!viewScopeMarker) {
      try {
        const migrated = db.prepare(
          `UPDATE character_body_profile SET view_scope = '["user","character"]' WHERE view_scope = '["user"]'`
        ).run().changes;
        db.prepare(
          `INSERT INTO system_settings (setting_key, setting_value) VALUES ('intimate_view_scope_group_default', '1')`
        ).run();
        if (migrated > 0) console.log(`[db] intimate 口径默认值迁移：${migrated} 个角色加入「角色↔角色」`);
      } catch (err) {
        // 表结构还没齐（极老库）时不影响其余迁移；标记没落库，下次启动会再试
        console.log('[db] intimate 口径默认值迁移跳过:', err.message);
      }
    }
  } catch (err) {
    console.log('[db] migrateIntimateSchema error:', err.message);
  }
}


/**
 * 迁移: 性爱交互「可点击推进」进行中状态（task-1，2026-10-01）
 *
 *   character_intimate_scene：**每角色一行**的进行中状态 —— 当前体位 / 是否插入中 / 节奏档 /
 *   累积度 / 这一场的推进次数与高潮次数。落库的意义是「重启后仍在进行中」：
 *   进程内存态一重启就丢，而这一场是跨轮次的（她下一轮聊天必须知道自己还在被插着）。
 *
 * 口径与既有亲密系统对齐（不另造平行体系）：
 *   · position_key 存 `image_prompt_knowledge.adult_pose_vocabulary` 的打包 key（与
 *     character_intimate_log.position_key 同源同形，中文名走 positionLabel）；
 *   · act_key 存 ACT_DEFINITIONS 的键（归类复用 classifyPromptTags）；
 *   · 真正发生的行为由调用方走 recordIntimateActs 记进 character_intimate_log，
 *     本表只存"进行中状态"，不复刻流水。
 *
 * 纯新增表（只 CREATE TABLE IF NOT EXISTS，不参与 ALTER 补列），幂等；首次建表打一行启动日志。
 */
export function migrateIntimateSceneSchema(db) {
  try {
    const existed = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_intimate_scene'"
    ).get();
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_intimate_scene (
        character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        active INTEGER NOT NULL DEFAULT 0,
        penetrating INTEGER NOT NULL DEFAULT 0,
        position_key TEXT NOT NULL DEFAULT '',
        act_key TEXT NOT NULL DEFAULT '',
        pace INTEGER NOT NULL DEFAULT 2,
        accumulation INTEGER NOT NULL DEFAULT 0,
        climax_count INTEGER NOT NULL DEFAULT 0,
        rounds INTEGER NOT NULL DEFAULT 0,
        action_seq INTEGER NOT NULL DEFAULT 0,
        pending_note TEXT NOT NULL DEFAULT '',
        started_at DATETIME,
        last_action_at DATETIME,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // 2026-10-02 四件新玩法（拍打 / 捆绑 / 自动抽插 / 禁止高潮）需要三个开关态列。
    // 2026-10-03 追加 `auto_pace`：**自动速度**是独立旋钮（用户：「自动的速度新增一个单独的」），
    // 老行补成默认 2（正常）= 迁移前的旧行为。
    // 幂等补列：老库直接 ALTER，新库上面 CREATE 里没有这几列 ⇒ 这里补齐（两路都到同一形状）。
    // ⚠️ 判断条件只能是"这一列在不在"（别再嵌进别的 if —— 上次 sensitive 四列就是这么整条失效的）。
    for (const [col, ddl] of [
      ['bondage', 'INTEGER NOT NULL DEFAULT 0'],
      ['auto_thrust', 'INTEGER NOT NULL DEFAULT 0'],
      ['denial', 'INTEGER NOT NULL DEFAULT 0'],
      ['auto_pace', 'INTEGER NOT NULL DEFAULT 2'],
      // 2026-11-03 睡眠玩法：sleep_bar = 睡眠条 0~100（越高越沉），forced_sleep = 催眠「无法醒来」
      ['sleep_bar', 'INTEGER NOT NULL DEFAULT 100'],
      ['forced_sleep', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      const has = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('character_intimate_scene') WHERE name = ?").get(col).n;
      if (!has) {
        db.exec(`ALTER TABLE character_intimate_scene ADD COLUMN ${col} ${ddl}`);
        console.log(`[db] migrateIntimateSceneSchema: +${col}`);
      }
    }
    if (!existed) console.log('[db] migrateIntimateSceneSchema: created character_intimate_scene');
  } catch (err) {
    console.log('[db] migrateIntimateSceneSchema error:', err.message);
  }
}


/**
 * 迁移: 催眠手机（v3.7.0）
 *
 * 两张全新表，纯新增 —— CREATE TABLE IF NOT EXISTS 即幂等，没有存量列要补。
 *
 * 为什么 body_controlled 与 mind_awake 拆成两列：
 *   「只唤醒意志」= 意志清醒（mind_awake=1）而身体仍受控（body_controlled=1）。
 *   两者正交才能表达"身体归用户、意志是她的"这层张力；合成一个枚举会丢状态。
 *
 * 遗忘窗口单独成表（不塞进 character_hypnosis 一行）：同一角色可以有多段被遗忘的历史，
 * 且要可撤销审计（status active→restored）。memory_ids 记录**精确**被归档的 memory_id，
 * 撤销按 id 列表还原，不会误还原同一 raw 区间里被 T3 衰减任务自动归档的无关记忆。
 *
 * session_start_raw_id：本次催眠开始时该会话已存在的最大 raw id，遗忘窗口左端 = 它 + 1。
 *   刻意用 raw id 而不是时间：datetime('now') 只到秒，而"同秒重复催眠"会把 started_at
 *   推到未来 1 秒，用时间当左端会漏掉催眠后那一秒内发出的消息（e2e 实测抓到过）。
 */
/**
 * SLG 动作系统（触摸互动）两张表（阶段一，2026-09-30）。
 *
 *   · character_touch_state：每角色 × 每动作一行——annoyance（腻烦 0~100）+ like_ratio（偏好倍率，默认 1）
 *   · touch_events：一次动作一行——mode / annoyance / like_ratio / reaction / status
 *     status 取值：'pending'（隐式，等下一轮 chat.js 注入）/ 'injected'（已注入那一轮）/ 'done'（即时反应已发出）
 *
 * 纯新增表（只 CREATE TABLE IF NOT EXISTS，不参与 ALTER 补列），幂等；首次建表打一行启动日志。
 * 口径见 docs/characters/touch-system.md §3.2 与 目标/规划/专题-SLG动作系统.md §四。
 */
export function migrateTouchSchema(db) {
  try {
    const existed = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'touch_events'"
    ).get();
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_touch_state (
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        action_key TEXT NOT NULL,
        annoyance INTEGER NOT NULL DEFAULT 0,
        like_ratio REAL NOT NULL DEFAULT 1,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (character_id, action_key)
      );

      CREATE TABLE IF NOT EXISTS touch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        group_id INTEGER,
        action_key TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'implicit',
        annoyance INTEGER NOT NULL DEFAULT 0,
        like_ratio REAL NOT NULL DEFAULT 1,
        reaction TEXT NOT NULL DEFAULT '',
        facial_expression TEXT NOT NULL DEFAULT '',
        emotion_delta TEXT NOT NULL DEFAULT '',
        annoyed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_touch_events_pending ON touch_events(character_id, status, id);
      CREATE INDEX IF NOT EXISTS idx_touch_events_group ON touch_events(group_id, status, id);
    `);
    if (!existed) console.log('[db] migrateTouchSchema: created character_touch_state / touch_events');
  } catch (err) {
    console.log('[db] migrateTouchSchema error:', err.message);
  }
}


/**
 * 迁移: 成人玩具系统 — character_worn_toys（专题-玩具系统与真机反馈三期 §2.2）
 *
 *   · 一行 = 某角色某玩具的**当前佩戴状态**（UNIQUE(character_id, toy_key)：同种玩具一件；
 *     不同部位可叠加，靠多行实现）；
 *   · 摘下 = status='removed'（保留行，equip_count 记「戴过几次」——UNIQUE 约束下没法靠行数统计，
 *     所以显式加一列，这是对专题 §2.2 表结构的必要补强）；
 *   · equipped_at 是「已戴多久」的唯一依据（不随程序时间自动变化，专题 §2.10-3）。
 *
 * 纯新增表（只 CREATE TABLE IF NOT EXISTS，不参与 ALTER 补列），幂等；首次建表打一行启动日志。
 */
export function migrateWornToysSchema(db) {
  try {
    const existed = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_worn_toys'"
    ).get();
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_worn_toys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        toy_key TEXT NOT NULL,
        intensity INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'worn',
        equip_count INTEGER NOT NULL DEFAULT 0,
        equipped_at TEXT,
        updated_at TEXT,
        UNIQUE(character_id, toy_key)
      );
      CREATE INDEX IF NOT EXISTS idx_worn_toys_char ON character_worn_toys(character_id, status);
    `);
    if (!existed) console.log('[db] migrateWornToysSchema: created character_worn_toys');
  } catch (err) {
    console.log('[db] migrateWornToysSchema error:', err.message);
  }
}


/**
 * 玩具玩法状态（2026-10-02 玩法扩充 task-2 交付；从 `toyService.ensureToyPlaySchema` 搬进来）：
 *   · `toy_play_state`      —— 每（角色,玩具）一行：振动模式 / 强度曲线 / 曲线起点 / 上次结算档位
 *   · `toy_self_play_log`   —— 她自己主动玩的流水（判定码、分数、是否偷偷/当面）
 * 为什么搬进迁移：原来靠 `toyService` 懒建（WeakSet 记账）—— 那是"没有迁移"的权宜，
 * 谁先碰库谁建表，真空库 + 别的模块先读就会 `no such table`。真实库走这里建，懒建保留作兜底。
 */
export function migrateToyPlaySchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS toy_play_state (
        character_id INTEGER NOT NULL,
        toy_key TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'steady',
        curve_json TEXT NOT NULL DEFAULT '',
        curve_started_at DATETIME,
        last_intensity INTEGER NOT NULL DEFAULT 0,
        last_tick_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (character_id, toy_key)
      );

      CREATE TABLE IF NOT EXISTS toy_self_play_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        toy_key TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'equip',
        intensity INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'steady',
        curve_json TEXT NOT NULL DEFAULT '',
        secret INTEGER NOT NULL DEFAULT 0,
        bold INTEGER NOT NULL DEFAULT 0,
        code TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        score REAL NOT NULL DEFAULT 0,
        at DATETIME NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_toy_self_play_char ON toy_self_play_log (character_id, at DESC);
    `);
  } catch (err) {
    console.log('[db] migrateToyPlaySchema error:', err.message);
  }
}


export function migrateHypnosisSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_hypnosis (
        character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        body_controlled INTEGER NOT NULL DEFAULT 0,
        mind_awake INTEGER NOT NULL DEFAULT 0,
        active_until DATETIME,
        started_at DATETIME,
        session_start_raw_id INTEGER NOT NULL DEFAULT 0,
        sleep_lock INTEGER NOT NULL DEFAULT 0,
        sleep_lock_until DATETIME,
        pending_directive TEXT NOT NULL DEFAULT '',
        pending_at DATETIME,
        command_count INTEGER NOT NULL DEFAULT 0,
        last_command TEXT NOT NULL DEFAULT '',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS hypnosis_forgotten_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        from_raw_id INTEGER NOT NULL DEFAULT 0,
        to_raw_id INTEGER NOT NULL DEFAULT 0,
        from_at DATETIME,
        to_at DATETIME,
        memories_archived INTEGER NOT NULL DEFAULT 0,
        memory_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_hypnosis_forgotten ON hypnosis_forgotten_windows(character_id, status);
    `);

    // 存量库补列：用户的真实库可能已经建过 character_hypnosis（v3.7.0 首版没有这一列），
    // 只改上面的 CREATE TABLE 对已存在的表不生效 → 缺列会 500。ALTER + PRAGMA 判存在，幂等。
    const exists = db.prepare('PRAGMA table_info(character_hypnosis)').all().some(c => c.name === 'session_start_raw_id');
    if (!exists) {
      db.exec(`ALTER TABLE character_hypnosis ADD COLUMN session_start_raw_id INTEGER NOT NULL DEFAULT 0`);
      console.log('[db] Added character_hypnosis.session_start_raw_id column');
    }

    // 2026-11-03 催眠手机「无法醒来」：睡眠锁（角色级，跨亲密场景存活）
    const lockCols = db.prepare('PRAGMA table_info(character_hypnosis)').all().map(c => c.name);
    if (!lockCols.includes('sleep_lock')) {
      db.exec(`ALTER TABLE character_hypnosis ADD COLUMN sleep_lock INTEGER NOT NULL DEFAULT 0`);
      console.log('[db] Added character_hypnosis.sleep_lock column');
    }
    if (!lockCols.includes('sleep_lock_until')) {
      db.exec(`ALTER TABLE character_hypnosis ADD COLUMN sleep_lock_until DATETIME`);
      console.log('[db] Added character_hypnosis.sleep_lock_until column');
    }
  } catch (err) {
    console.log('[db] migrateHypnosisSchema error:', err.message);
  }
}
