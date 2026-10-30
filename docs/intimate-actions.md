# 性爱推进状态机（亲密交互 · 口径与实施）

> **这份文件是什么**：把「可点击推进」的性爱交互链路（累积 / 节奏 / 体位 / 捆绑位掩码 / 门槛 / 余韵 / 记账）一次写清。
> **为什么补**：`docs/` 里此前**零文档** —— `intimate-dashboard.md` 讲看板、`intimate-acceptance-report.md` 讲验收，都默认你已经知道状态机长什么样。新人接手只能读 1432 行的源码。
> **口径来源**：`agent-core/src/services/intimateActionService.js`（零依赖纯函数，唯一来源）。数字以代码为准，本文为对照与解释。
> 制定日期：2026-10-14。

---

## 〇、一页速览

| 项 | 值 |
| --- | --- |
| 动作数 | **16**（`INTIMATE_ACTIONS`） |
| 累积上限 | `MAX_ACCUMULATION = 100` |
| 高潮门槛 | `climaxThreshold(敏感度)` → **45 ~ 60** 之间浮动的**实测**门槛 |
| 边缘 / 过载 | `EDGE_THRESHOLD = 60` / `OVERLOAD_THRESHOLD = 85` |
| 节奏档 | `PACE_MIN=1` ~ `PACE_MAX=4`，默认 `DEFAULT_PACE=2` |
| 体位 | 由 `listPositionOptions()` + 词表提供，默认 `DEFAULT_POSITION_KEY='missionary'` |
| 捆绑 | **位掩码 0~31**（5 处可叠加） |
| 闲置自动结束 | `SCENE_IDLE_TTL_MS = 45 分钟` |
| 入口前缀 | `GET/POST /api/intimate-actions/...`（**刻意独立前缀**，见 §八） |

---

## 一、状态机：一场是怎么推进的

### 1.1 状态载体

一场「进行中」的性爱交互是**每角色一行**的 `character_intimate_scene`（迁移 `migrateIntimateSceneSchema`）：

| 字段 | 含义 |
| --- | --- |
| `position_key` | 当前体位（默认 `missionary`） |
| `inserted` | 是否插入中 |
| `pace` | 节奏档 1~4 |
| `accumulation` | **累积度**（0~100，禁止高潮时可涨到 200） |
| `bondage` | **捆绑位掩码**（0~31） |
| `action_seq` | 这一场的推进序号（每次点击 +1） |
| `climax_count` | 这一场的高潮次数 |
| `updated_at` | 闲置判定用（超过 45 分钟自动结束） |

> **为什么要落库**：进程内存态一重启就丢，而这一场是**跨轮次**的 —— 她下一轮聊天必须知道自己还在被插着。

### 1.2 累积度与门槛

```
0 ──────── 45~60 ──────── 60 ──────── 85 ──────── 100
            高潮门槛      边缘(EDGE)    过载(OVERLOAD)   满格
```

- **高潮门槛是浮动的**：`climaxThreshold(sensitivity)` 把 `CLIMAX_MIN_ACCUMULATION(60)` 往下压，
  压到 `CLIMAX_THRESHOLD_MIN(45)` 为止 —— **越敏感的她越早点得动「一起到」**。
- **边缘（≥60）**：`state.edge = true`，界面与她的反应都进"就差一点"的状态。
- **过载（≥85）**：`OVERLOAD_THRESHOLD`，文案与倍率再上一档。
- **满格（100）**：正常玩法到此为止。

**只有累积过门槛才允许「一起到」** —— `CLIMAX_MIN_ACCUMULATION = 60` 是硬下限，
即使敏感度拉满（门槛降到 45）也要求累积 ≥60 才放行（两个数各管一段，别混）。

### 1.3 余韵

高潮后不是立刻归零：

| 函数 | 作用 |
| --- | --- |
| `climaxResidual(敏感度)` | 高潮后**残留**多少累积（越敏感留得越多） |
| `climaxStrength(敏感度)` | 这一下的**强度**（供文案与倍率使用） |
| `afterglowMultiplier(敏感度)` | 余韵期的**倍率**（余韵里继续刺激的增益） |

### 1.4 敏感度会调门槛，也会衰减

见 §五。

---

## 二、16 个动作（`INTIMATE_ACTIONS`）

| key | 中文 | 干什么 |
| --- | --- | --- |
| `enter` | 进入她 | 插进去，正式开始这一轮 |
| `thrust` | 继续抽插 | 保持现在的节奏往里推 |
| `faster` | 加速抽插 | 节奏升一档（最高「冲刺」） |
| `slower` | 慢下来 | 节奏降一档，把她的感觉吊住 |
| `stop` | 停下 | 退出来，让两个人都喘口气 |
| `position` | 换姿势 | 点下面的体位让她换过去 |
| `climax` | 一起到 | 在边缘直接把她推过去（`tone: danger`） |
| `command` | 命令她自己动 | 不许他动手，全要她自己来 —— 被束着时她只能照做（SM 服从玩法） |
| `spank` | 拍打 | 一记落在臀上：痛感与羞耻也在把她往高潮推（`SPANK_GAIN = 6`） |
| `bondage` | 捆手 | 束手腕（再点一次解开） |
| `bind_box` | 龟甲缚 | 绳从颈后绕到胸前再收去胯下（再点一次解开） |
| `bind_legs` | 束脚 | 脚踝并拢束住、腿分不开（再点一次解开） |
| `bind_body` | 全身束 | 手腕、脚踝与躯干一起固定（再点一次解开） |
| `bind_gag` | 口球 | 嘴里被塞住（再点一次取下） |
| `auto` | 自动插入 | 按「自动速度」一下一下插送（再点一次停下） |
| `denial` | 禁止高潮 | 不许她到（再点一次解开）：憋着能涨过满格 |

**开关型动作**（再点一次回到相反状态）：`bondage` / `bind_box` / `bind_legs` / `bind_body` / `bind_gag` / `auto` / `denial`。
其余是**一次性**动作（点了就产生一轮反应）。

---

## 三、节奏档（`PACE_LEVELS`）

| 档 | 语义 | 自动插入间隔（`AUTO_PACE_INTERVALS`） |
| --- | --- | --- |
| 1 | 缓 | 5000 ms |
| 2 | 正常（`DEFAULT_PACE`） | 3000 ms |
| 3 | 快 | 2000 ms |
| 4 | 冲刺 | 1500 ms |

- `AUTO_THRUST_TICK_MS = 3000`：**自动插入的心跳周期**（服务端 tick）。
- `AUTO_MAX_CATCHUP_TICKS = 2`：服务重启或长 tick 后**最多补 2 拍** —— 防止"关掉一小时再打开，一口气补 1200 拍"把她瞬间推满。
- `autoTickGain(pace)`：每一拍涨多少累积（随档位上升）。
- 手动 `faster` / `slower` 在 1~4 之间夹取。

> 文档里"缓 2 / 正常 3 / 快 4 / 冲刺 5"是**展示层**的说法；代码里档位是 **1~4**，别把展示序号当常量。

---

## 四、体位

- 默认 `DEFAULT_POSITION_KEY = 'missionary'`。
- 清单与中文名由**词表**提供：`getPositionVocabularyMap()` / `resolvePositionKey(tag)` / `positionLabel(key)` / `listPositionOptions()`。
- 词表可重载：`resetPositionVocabularyCache()`。
- 「换姿势」是**两段式**：点 `position` 进入选姿势，再点具体体位才真的换（`positionKey` 必带，`POST` body 里给）。
- `PENETRATIVE_ACTS = ['vaginal', 'anal']` —— 只有这两个算"插入类"，影响插入态判定与记账。

---

## 五、敏感度与发情（`services/sensitivityService.js`）

### 5.1 敏感度

| 项 | 值 |
| --- | --- |
| 范围 | `SENSITIVITY_MIN=0` ~ `SENSITIVITY_MAX=100` |
| 衰减 | `DECAY_PER_HOUR = 0.125`（**按小时线性衰减**，读的时候现算，不写库） |
| 自动 tick 最小间隔 | `AUTO_TICK_MIN_INTERVAL_MS = 15000` |
| 每日上限 | `SEX_DAILY_CAP = 20`（`manual` / `heat_mode` **不占**这个额度） |

- 读路径用 `decayedSensitivity(raw, updatedAt)` 现算衰减值；`getSensitivity(id)` 是入口。
- 分档：`SENSITIVITY_TIERS` / `sensitivityTier(value)` / `sensitivityMultiplier(value)`。
- 增长：`addSensitivity(id, source, { weight })`，各来源权重见 `GROWTH` 表。
- 注入：`buildSensitivityPromptLine(id)` 产出聊天里那一行敏感度提示。

### 5.2 发情模式（heat）

| 项 | 值 |
| --- | --- |
| 效果 | 直接把敏感度**拉满**（`HEAT_SENSITIVITY = 100`） |
| 默认时长 | `HEAT_DEFAULT_MINUTES = 120` 分钟 |
| 开关 | `setHeatMode(id, on, { minutes })` |
| 查询 | `getHeatUntil(id)` → 到期时间 |
| 生效判定 | `heat_mode=1` **且** `now < heat_until`（`heatActive()`） |

> ⚠ **历史坑（已在源码注释里记着）**：`heat_until` 解析失败会让发情模式**既关不掉也过期不了**。
> 该守卫已加，改动解析逻辑时务必保留。

- 发情期间额外增益见 `privateMomentProbability`（私密时刻概率）与 `intimateStimulus`。

---

## 六、捆绑：位掩码（不是新表）

`bondage` 字段从"0/1 开关"升级成**位掩码**（2026-10-02）：

| 位 | 值 | 含义 |
| --- | --- | --- |
| `bondage` | 1 | 手腕 |
| `bind_box` | 2 | 龟甲缚 |
| `bind_legs` | 4 | 脚踝 |
| `bind_body` | 8 | 全身 |
| `bind_gag` | 16 | 口球 |

- 取值为 **0~31**（`clampInt(row.bondage, 0, 31, 0)`）。
- **零 schema 改动**、可任意叠加；**老数据里的 `1` 自动等于"捆了手腕"**。
- **每多绑一处，累积倍率再 +25%，封顶 2×**（`bondageMultiplier(bondage)`）。
- `BONDAGE_SENSITIVITY = 1.25`：被束着时敏感度按 1.25 倍参与。
- 语义正确性由 `bondage: current.bondage > 0` 判定「是否被绑着」——**别拿 `=== 1` 判断**，那是旧口径。

---

## 七、禁止高潮（denial）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `DENIAL_MAX_ACCUMULATION` | 200 | 憋着时累积的**天顶**（正常上限是 100） |
| `DENIAL_RELEASE_MIN` | 100 | 解开那一瞬间，"释放"至少要放到这个量才算成立 |

玩法：`denial` 开着时累积可以**涨过满格**到 200；解开时一次性释放 ——
「憋着能涨过满格，解开那一瞬间才是释放」（源码原话）。

---

## 八、HTTP 接口

### 8.1 可点击推进（`routes/intimateActions.js`，task-1 · 2026-10-01）

```
GET  /api/intimate-actions/:id/state      面板一次读取：进行中状态 + 她的状态 + 体位清单 + 逐动作可用性
POST /api/intimate-actions/:id/:action    body { positionKey? }（换姿势必带）
```

- **刻意用独立前缀**：`/api/characters` 那一族里 `intimateRoutes` 与 `charactersRoutes` 必须紧邻
  （`test/intimateApi.test.js` 断言两者之间不夹别的挂载），塞进去会把冻结契约打破。
  独立前缀也不受 `/:id` 通配吞子路径影响。
- **每次点击立刻产出一轮反应**：`chatSync(label='intimate-action')` → `parseReactionOutput`
  （与触摸反应同一套 JSON 解析）→ `writeProactiveMessage` 落 `char_<id>` 会话 → `broadcastProactiveMessage` 推前端。
  她的一轮反应因此在聊天里**立刻可见**（与触摸「即时反应」完全同一条上屏链路，前端零改动）。
- **错误口径**（与触摸门控同款）：
  - 门控拒绝 = **HTTP 200** + `{ allowed:false, code, message }`（message 已是人话，前端直接 toast）
  - 非法动作 / 非法体位 = **400**；角色不存在 = **404**；总开关关闭 = **409**
- **立绘**：复用服务端独占通道 `standingDisplay.publishStandingKeys`。

### 8.2 看板与档案（`routes/intimate.js`，挂 `/api/characters`）

```
GET    /api/characters/:id/intimate              档案总览
PUT    /api/characters/:id/intimate/profile      身体档案
PUT    /api/characters/:id/intimate/settings     设置
PUT    /api/characters/:id/intimate/inject       注入开关
PUT    /api/characters/:id/intimate/ai-judge     AI 判定开关
POST   /api/characters/:id/intimate/ai-judge/run 手动跑一次 AI 判定
GET    /api/characters/:id/intimate/vocabulary   体位词表
GET    /api/characters/:id/intimate/log          流水
POST   /api/characters/:id/intimate/log          手工补录
POST   /api/characters/:id/intimate/record       记账
POST   /api/characters/:id/intimate/classify     标签归类
POST   /api/characters/:id/intimate/rollback     按 rawId 回滚
PUT    /api/characters/:id/intimate/firsts/:actKey  首次标记
GET/POST /api/characters/:id/intimate/backfill   历史回填
POST   /api/characters/:id/intimate/backfill/reset
DELETE /api/characters/:id/intimate/log/:logId   删一条流水
DELETE /api/characters/:id/intimate              清空
```

---

## 九、拒绝码（`INTIMATE_REJECT_CODES`）

门控拒绝走 **HTTP 200 + `{ allowed:false, code, message }`**；`code` 供前端 `switch`，
`message` 一律是人话（可直接 toast）。**完整 10 个**：

| code | 触发条件 | HTTP |
| --- | --- | --- |
| `unknown_action` | 动作不存在 | 400（路由层） |
| `invalid_position` | 体位不在词表里 | 400（路由层） |
| `not_penetrating` | 还没插进去就点「继续抽插 / 加速 / 慢下来 / 一起到」 | 200 |
| `already_penetrating` | 已经在里面了还点「进入她」 | 200 |
| `position_not_penetrative` | 当前体位插不进去（口交 / 手交 / 乳交 / 69） | 200 |
| `pace_max` | 已经是「冲刺」，没有更快的档 | 200 |
| `pace_min` | 已经是最慢档 | 200 |
| `not_edge` | 还没到高潮边缘，「一起到」点不动 | 200 |
| `not_active` | 这一场还没开始 | 200 |
| `she_refuses` | **好感太低，她按住手不让换**（`REFUSE_AFFINITY = 20` 是这条的阈值） | 200 |

> 注意 `unknown_action` / `invalid_position` 是**路由层 400**，其余 8 个是**门控层 200**——
> 前端要按这个分界处理（400 是"你请求错了"，200+allowed:false 是"她/规则不让你做"）。

---

## 十、记账与幂等（重要）

写完源码就最容易被搞错的一段：

- **幂等锚点** = `intimateAction:<角色>:<action_seq>:<actKey>`
  - `action_seq` 是这一场的推进序号（每次点击 +1，**落库在同一行**）⇒ **一次点击最多一笔**，
    重放（网络重试 / 前端连点）不会把看板刷高。
- **`raw_id` 保持 0**：本仓 `raw_id` 语义固定指向 `raw_messages.id`，塞别的会污染「按撤回删流水」链路。
- **`source='manual'`**：用户自己点出来的，与触摸 Lv3 动作、面板人工补录同待遇；
  **绕过 `aiEditFields` 权限闸门，但尊重 `features.intimate`**。
- **`scene` 复用既有枚举**（`'chat'`），不新增值。
- **失败只 `warn`**：记账是旁路，绝不能影响这一下本身。
- **心情**：走既有 `emotionEngine` 链路（`loadEmotionState → evolveEmotion → saveEmotionSnapshot`），
  **锚点用刚落库的 `messages.id`**（不能塞 raw id，会撞 FK —— 催眠手机踩过这个坑）。

---

## 十一、相关文件

| 文件 | 职责 |
| --- | --- |
| `services/intimateActionService.js`（1432 行） | **状态机 / 档位 / prompt 全在这**（零依赖纯函数，可脱离 HTTP 单测） |
| `services/intimateService.js`（1288 行） | `ACT_DEFINITIONS` / 流水与统计 / 身体档案 / 词表 |
| `services/intimateStimulus.js` | 刺激模型 |
| `services/intimateAutoThrust.js` | 自动插入的 tick 逻辑 |
| `services/sensitivityService.js` | 敏感度 + 发情 |
| `services/intimatePrompt.js` | 注入块与 prompt |
| `services/intimateAiJudge.js` / `intimateAiEdit.js` | AI 判定 / AI 编辑档案 |
| `services/intimateAutoRecord.js` / `intimateBackfill.js` | 自动记账 / 历史回填 |
| `services/intimateActionQuota.js` | **推进动作的独立每日额度**（成本刹车；口径与接法见 `docs/intimate-action-quota.md`） |
| `routes/intimateActions.js`（707 行） | 可点击推进 HTTP |
| `routes/intimate.js`（369 行） | 看板与档案 HTTP |

---

## 十二、已知边界

1. **门控拒绝返回 200**（不是 403）—— 这是与触摸系统统一的口径，别"顺手改成 403"。
2. **展示序号 ≠ 常量**：界面上"缓 2 / 正常 3 / 冲刺 5"与代码 `PACE_MIN..PACE_MAX = 1..4` 不是一个东西。
3. **`bondage` 必须按位判定**（`> 0` 或按位与），裸 `=== 1` 只覆盖"捆手腕"。
4. **`heat_until` 解析失败 = 关不掉** —— 解析逻辑有守卫，别绕开它。
5. **`AUTO_MAX_CATCHUP_TICKS = 2` 是防爆上限** —— 放宽它会让久置后重开直接把人推满。
6. 本文数字取自 **2026-10-14 工作树快照**；改动后请用函数名/常量名重新定位，不要按行号找。

---

**维护口径**：本文件是 `docs/` 中性爱推进状态机的**唯一入口文档**。改动状态机常量或动作清单时，
同步更新 §〇 速览表与 §二 动作表（两处都列了全部动作，改一处必改另一处）；改完跑
`node --test test/intimateAction*.test.js "test/intimate*.test.js"`（agent-core）。
