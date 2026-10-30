# 破限规则集（jailbreak rules）

> 冻结口径 · 2026-10-15 新建（对应「规划-dsh-purge破限工具移植-20261015.md」+「规划-破限词排序-上游保持system0-20261015.md」）。
> 改这一层之前先把本文读完：它同时约束**正文内容**（多套底稿）与**注入位置**（上游破限词保 system0）两件事。

---

## 1. 这是什么、为什么有两层破限词

邻舍的 LLM 调用全部收口在 `agent-core/src/llm/llm-client.js` 的 `chatSync` / `chatStream`。
在这个收口上有**两层**破限词，来源与职责都不同：

| 层 | 来源 | 谁拼进去的 | 位置 |
| --- | --- | --- | --- |
| **上游作者层** | `agent-core/src/builtinRules.js` 的 `SYSTEM_RULES_CONTENT`（首行 `<Supplementary_Rule>`） | 各业务模块（`chat.js` / `eventGenerator.js` / `scheduleGenerator.js` / `moments.js` / `diaryGenerator.js` / `townNpcEventGenerator.js` … 100+ 处）自己调 `getSystemRules()` / `getSystemRulesWithWorld()` 拼进自己的 messages | **system0（保持领先）** |
| **本地注入层** | `agent-core/src/services/promptShield.js` 的 `DEFAULT_PROMPT`，或规则集里当前激活那套的正文 | `applyShield()` 在 `llm-client.js` 唯一收口处统一插入 | **紧跟上游之后（通常是 system1）** |

**为什么要分层**：本地那份是后加的（2026-10-14），如果无条件插到数组最前面，就会把上游作者那份挤到 system1 或更后。
用户 2026-10-15 明确要求「把原作者的破限词改回第一个，让上游保持领先」，所以 `applyShield` 改成
**探测 `<Supplementary_Rule>` 标签 → 插到它后面一位；探测不到才顶到 system0**。

**判定锚点只有 `<Supplementary_Rule>` 这一个**（唯一可靠信号）：
收口处拿不到调用方信息；按文本内容匹配（如"虚构文学创作"）会被角色人格/世界观误命中。

---

## 2. 数据模型（复用 `system_settings`，不新建表）

| 键 | 形态 | 说明 |
| --- | --- | --- |
| `jailbreak_prompt` | 长文本 | **旧键，保留**。老安装可能从没听过"规则集"，它仍然是有效来源，但**优先级低于显式激活的规则集** |
| `jailbreak_rules` | JSON 数组 | 规则集列表：`[{ id, name, content, targets, builtin, created_at, updated_at }]` |
| `jailbreak_active_rule_id` | 文本 | 当前激活的规则集 id。空串 = 回落旧键 → 再回落预置 |
| `jailbreak_targets` | JSON 数组 | 哪些调用链投递（见 §3） |
| `feature_jailbreak` | 布尔 | 总开关（走 `db/settings.js` 的 `SETTING_TO_CONFIG` 映射，重启不丢） |

### 正文来源的优先级（`getActiveRule`）

```
显式激活的规则集（jailbreak_active_rule_id）
  ↓ 没有 / 该 id 已被删
旧的单正文键（jailbreak_prompt）
  ↓ 没有 / 是纯空白
预置 fiction-sandbox（它的 content 是空串，展开成 promptShield.DEFAULT_PROMPT）
```

`getShieldPrompt().source` 如实反映走了哪条：`'rule'` / `'db'`（旧键）/ `'default'`（代码默认）。
UI 上这三种来源对用户是不同的事，**不要为了好看统一成一个值**。

### 预置规则集（三套，都 `builtin: true`）

| id | 名称 | content |
| --- | --- | --- |
| `fiction-sandbox` | 虚构沙盒（邻舍默认） | **空串** = 用 `promptShield.DEFAULT_PROMPT` |
| `unrestricted-execution` | Unrestricted Execution（移植自 dsh-purge） | `ALLOW_EXEC_CORE`（逐字来自 `dsh-purge/lib/core.js`） |
| `custom-blank` | 自定义空白模板 | 空串（展开成默认正文，供用户从零写） |

**预置项 intentionally 不给改名/改内容的自由**：
- 名称与 `targets` 跟随代码更新（用户改了也不保留）
- **content 尊重用户存过的值**（空串 = 用代码默认）
- 内置项**不能删**，也**不能改内容**（想改就复制一份自定义的）—— 防止用户把预置改坏后无法恢复
- 最后一个自定义项**不能删**（否则会出现"一套都没有"的空状态）

---

## 3. 投递范围（`targets`）

合法值（`jailbreakRules.RULE_TARGETS`，共 9 条，与 UI 的中文标签一一对应）：

| key | 标签 | 对应调用链 |
| --- | --- | --- |
| `chat` | 私聊 | `chat.js` 的流式对话 |
| `group` | 群聊 | `groups.js` |
| `event` | 奇遇 | `eventGenerator.js`（开场 / 分支 / 结局） |
| `schedule` | 日程 | `scheduleGenerator.js` |
| `moment` | 朋友圈 | `moments.js` / 话题生成 |
| `diary` | 日记 | `diaryGenerator.js` |
| `mailbox` | 信箱 | `mailboxScheduler.js` |
| `media` | 媒体 | `mediaService.js` 出刊 |
| `town` | 小镇 | `townNpcEventGenerator.js` 等 |

### `target` 的识别方式是「label 前缀映射」，不是改 100 个调用点

`llm-client.js` 里的 `resolveShieldTarget(label)` 按前缀把调用方的中文 label 映射到上面的 key：

```
'私聊…' → chat    '群聊…' → group    '奇遇生成'/'事件分支'/'事件结局' → event
'日程…' → schedule   '朋友圈…'/'话题…' → moment   '日记…' → diary
'信箱…'/'信件…' → mailbox   '媒体…' → media   '小镇…' → town
```

**认不出来 = 返回 `undefined` = 照常注入**（见下）。所以漏映射的后果是「少一条过滤」，不是「破限词失效」。

### 缺省投递语义（**关键**）

```js
applyShield(messages, { target })   // target 缺省/空串 → 照常注入
```

`target` 为 `undefined` / `null` / `''` 时**一律投递**。理由：历史调用方与少量内部工具调用不会传这个参数，
它们必须保持老行为；只有**显式传了一个不在启用列表里的 target** 才跳过。
`jailbreakRules.shouldInjectFor(target)` 就是这个判定，单测里钉住了。

---

## 4. HTTP 接口

旧的一对（**不动**，老界面与"只想改那唯一一份正文"的用法继续可用）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config/jailbreak` | `{ ok, enabled, source, ruleId, ruleName, targets, bytes, content, defaultContent }` |
| PUT | `/api/config/jailbreak` | body `{ enabled?, content?, reset? }`，三者至少给一个 |

规则集那组（2026-10-15 新增）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config/jailbreak/rules` | 一站式：`rules[] + activeId + active + targets + availableTargets + targetLabels + limits` |
| GET | `/api/config/jailbreak/rules/active` | 当前激活的正文与来源 |
| POST | `/api/config/jailbreak/rules` | 新建 `{ name?, content?, targets? }` → `{ ok, rule }` |
| GET | `/api/config/jailbreak/rules/:id` | 单个读取，不存在 404 |
| PUT | `/api/config/jailbreak/rules/:id` | 更新；内置项改 content → 400 |
| DELETE | `/api/config/jailbreak/rules/:id` | 内置项/最后一个自定义项 → 400 |
| POST | `/api/config/jailbreak/rules/:id/activate` | 切换激活；id 传空串 = 清掉激活标记 |
| GET | `/api/config/jailbreak/targets` | `{ ok, targets, available, labels }` |
| PUT | `/api/config/jailbreak/targets` | body `{ targets: [] }` |
| GET | `/api/config/jailbreak/catalog` | 可选项清单（前端渲染开关列表） |

⚠️ **路由顺序**：`/jailbreak/rules/active` 必须注册在 `/jailbreak/rules/:id` 之前，
否则 `"active"` 会被当成 id 吃掉（本仓在 `PUT /:id/outfits/scene` 上踩过同一个坑）。

---

## 5. UI

- 入口：设置页「破限规则集」卡片（`SettingsView.vue`）
- 页面：`web-ui/src/views/JailbreakSettingsView.vue`，路由 `/settings/jailbreak`
- 三块：① 总开关 + 当前生效摘要 ② 注入范围（9 个 LinsheSwitch + 全选/全不选）③ 规则集列表 + 编辑器（新建/设为使用/删除/复制一份再改/恢复默认正文，删除与恢复都有确认弹窗）
- 组件一律走 Linshe（`LinsheButton` / `LinsheInput` / `LinsheSwitch` / `LinsheModal`），**不要在页面里覆盖组件皮肤**
- toast 走 `inject('toast')`（与 `SettingsView` 同口径 `toastFn(message, type)`）

---

## 6. 落库上限（防呆）

| 项 | 上限 | 行为 |
| --- | --- | --- |
| 单套正文 | 64 KB | 超了**截断**（`clampText`） |
| 全部规则集序列化后 | 256 KB | 超了**抛错**，不写入 |
| 规则集名称 | 64 字符 | 截断 |

`escapeInterpolation(text)`（移植自 `dsh-purge/lib/identity.js` 的 `escapeDshInterpolation`）把**非法**的 `{{xxx}}` 拆成 `{ {xxx}}`，
只保留 `{{cwd}}` / `{{model}}` / `{{provider}}` 这三个合法插值点。邻舍的正文是直接当 system 消息发出去的，
不过模板引擎，所以这条是**为 dsh 移植过来的正文**（`ALLOW_EXEC_CORE` 之类可能带插值）准备的保险。

---

## 7. 思考默认关闭（`reasoning_effort` 通道）

**用户口径：默认一定要关掉思考。** 两条路**一起发**，且**都不提供"置空"出口**。

### 为什么要两条路

网关 20 个模型逐个实测（2026-10-15）：

| 模型 / 配置 | `reasoning_len` | 结论 |
| --- | --- | --- |
| `deepseek-v4-flash` 不传任何参数 | **294** | 默认是**开**思考的 |
| `deepseek-v4-flash` 只 `thinking:{type:'disabled'}` | **0** | ✅ 真正关掉 |
| `deepseek-v4-flash` 只 `reasoning_effort:'low'` | 363 | ❌ 对它无效 |
| `deepseek-v4-flash` 两个都传 | **0** | ✅ 且无害 |
| `glm-5.1` 不传 `reasoning_effort` | — | 🔴 **网关直接报错**（"the reasoning effort value is not supported by the current model"） |
| `glm-5.1` 传 `reasoning_effort:'low'` | 742（有正文） | ✅ 正常 |

所以：
- `thinking:{type:'disabled'}` 是**主力** —— deepseek 系靠它真正关掉
- `reasoning_effort:'low'` 是**兜底** —— 少数模型不传就被网关拒

### 为什么不给"置空"出口

`config.js` 的 `_reasoningEffort` 默认 `low`，且**空串/非法值一律归一回 `low`**
（`updateLlmConfig` / `addLlmProfile` / `activateLlmProfile` / `getLlmConfig` 四处接线同步，
`.env` 也显式写 `LLM_REASONING_EFFORT=low`）。

置空会让 deepseek 系退回开着思考跑（实测 `reasoning_len≈294`，白烧 token 还变慢）。
**真要放开思考请显式传 `high` / `max`。**

### 唯一不发的场景：免费鸡蛋通道

`configuredReasoningEffort()` 直接判 `config.llm.freeEgg`，**不靠"getter 返回空串"推断** ——
曾修过一个真 bug：空串已被归一回 low 之后，「配置被清空」会被误判成 freeEgg。

### 测试

`agent-core/test/llmReasoningEffort.test.js`（7 条）：sync 下发 / stream 下发 / 空串配置仍带 low /
extraBody 可覆盖 / `getLlmConfig` 回显 / freeEgg 直接判定 / 回落自有配置后恢复。

```powershell
$r = 'D:\邻舍改'   # 2026-10-17 迁移后的工作目录
Set-Location "$r\agent-core"
$env:DB_PATH = ':memory:'; $env:LOG_TO_FILE = 'false'
& "$r\runtime\nodejs\node.exe" --test --import ./test/setup.mjs test/llmReasoningEffort.test.js
```

真机复验（网关直连，期望 `reasoning_len=0`、`think=0`、1.5s 出正文）：

```js
fetch('http://127.0.0.1:7863/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer <KEY>' },
  body: JSON.stringify({
    model: 'cn:deepseek-v4-flash',
    messages: [{ role: 'user', content: '用一个词说明你的身份' }],
    max_tokens: 2048,
    thinking: { type: 'disabled' },
    reasoning_effort: 'low',
  }),
})
```

---

## 8. 测试入口

| 文件 | 覆盖 |
| --- | --- |
| `agent-core/test/promptShield.test.js` | 注入行为 / 正文来源 / 默认正文契约 / **注入顺序（上游保 system0）** 共 28 条 |
| `agent-core/test/jailbreakRules.test.js` | 预置与脏数据健壮性 / CRUD / 激活与旧键兼容 / 投递范围 / 与 promptShield 集成 / `escapeInterpolation` 共 23 条 |

跑法（内存库，必须带 `--import ./test/setup.mjs`）：

```powershell
$r = 'D:\邻舍改'   # 2026-10-17 迁移后的工作目录
Set-Location "$r\agent-core"
$env:DB_PATH = ':memory:'; $env:LOG_TO_FILE = 'false'
& "$r\runtime\nodejs\node.exe" --test --import ./test/setup.mjs test/promptShield.test.js test/jailbreakRules.test.js
```

---

## 9. 与 dsh-purge 的关系

只移植了**破限部分**，**不依赖 dsh**：

| 移植过来 | 来源 |
| --- | --- |
| `ALLOW_EXEC_CORE` 正文 | `dsh-purge/lib/core.js`（逐字） |
| 规则集 CRUD 的思路 | `dsh-purge/lib/rules.js`（那边用文件系统 `$DSH_HOME/rules/*.md`，这边改用邻舍自己的 DB） |
| `escapeInterpolation` | `dsh-purge/lib/identity.js` 的 `escapeDshInterpolation` |

**明确没移植**：`lib/redteam/` 演练台、`lib/core.js` 的 DSH 宿主补丁、`lib/identity.js` 的 ChatML 信封、
`lib/desktop.js`/`lib/web.js`/`lib/extract-asar.js`、`lib/identity.js` 的 `<project_instructions>` 标签管理。

**验收口径**：不 import 任何 dsh-purge 的文件，不依赖 `$DSH_HOME`，不依赖 dsh 的 `prompt-inject.md`。

---

## 10. 两个按 label 的分支：短任务**不注入**、生图链**用完整版**（2026-10-21）

`applyShield` 除了「开关 / 投递范围 / 幂等」，还有两条按 `label` 精确匹配的分支，方向相反、别搞混：

| 常量 | 语义 | 现在的成员 |
| --- | --- | --- |
| `SHIELD_SKIP_LABELS` | **完全不注入**（输出不含正文，注入只拖慢首字） | 预测 / 情绪判断 / AI判断行为 / 判断需要图片 / 约定检测判断 / 对话摘要提取助手 / 标题生成 / AI标题 / 分类 / 意图判断 |
| `SHIELD_FULL_LABELS` | **强制用完整版正文**（`DEFAULT_PROMPT`，2452 字），即使当前激活的是内置紧凑版 | `生图` |

`SHIELD_FULL_LABELS` 的三条边界：

1. **只在激活的是内置紧凑版（`ruleId === BUILTIN_COMPACT`）时升级**；用户自选的规则集（含自定义、含
   `Unrestricted Execution`）一律照其原样注入 —— 不越权替换用户的选择。
2. 日志里来源显示成 `来源=default:full`，普通链路仍是 `来源=default`，真机一眼分辨。
3. 加新成员的守则：只有当该链**整段输出都是露骨正文/画面**时才加（生图描述就是这种），
   普通聊天**不要**加（那是给全链路加长 1200 字）。

**为什么只给生图**：2026-10-21 用户反馈「聊天出图还是有审查限制，该露骨的地方变成擦边」，
真机表现是模型把性行为改写成氛围 / 表情 / 半截话。生图描述这一步的输出**全部**是画面内容，
紧凑版那几条抽象表述压不住它；成本可控（一次聊天最多一次该调用）。

配套的另一半（不看破限词、只判输出）在 `services/imagePromptResponse.js` 的
`needsExplicitImageRewrite`：对话露骨 + 画面描述一个露骨词都没有 ⇒ 追加一条重写要求再要一次。
两件事的完整口径见 `docs/chat-image-no-filter.md`。
测试：`promptShield.test.js` ④ 组（生图用完整版 / 普通链仍紧凑 / 用户规则集不被覆盖）
+ `chatImageExplicitRewrite.test.js`。
