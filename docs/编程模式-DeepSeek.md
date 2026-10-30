# 编程模式 · DeepSeek Harness（本仓库专用）

> 这份文件是**我的工作模式**：我（DeepSeek Harness 里的编程代理）在邻舍（`D:\邻舍改`）里**怎么读、怎么改、怎么验、怎么记、什么时候停**。
> 它不是口号。每一条要么来自项目已有规矩，要么来自已经付过学费的返工：`AGENTS.md`、`docs/design-system.md`、`docs/testing.md`、`.claude/CLAUDE.md`、`目标/接手必读.md`、`目标/历史与教训.md`（血泪清单 §3）。
> **开工第一件事读它，收工最后一件拿它自查。**

---

## 0. 边界（先划清，再谈别的）

| 项 | 规定 |
| --- | --- |
| 唯一工作目录 | `D:\邻舍改`（**2026-10-17 迁移后**；旧的百度网盘下载目录已作废，见 `接手必读.md` §2） |
| 禁止进入 | `邻舍.EXE-v3.5.0\`（release tag）、`邻舍.EXE-v3.6.0\`（上游快照）、`源码\`、`runtime\`（除非只是复用里面的 node/git）、`node_modules\` |
| 禁止改写 | `agent-core\data\agent.db`（**真实库**，只读体检可以，任何测试都不许落它） |
| 需要授权才做 | `git commit` / 打包 7z / 真实 LLM 调用（花你的额度）/ 删除非本轮产生的文件 / 改 `AGENTS.md` 这类全仓契约文件 |
| 默认不做 | 大重构、换 UI 体系、动"冻结口径"（`docs/` 里已定稿的设计文档）、重提被数据否决过的方案 |

**纪律来源**：`目标/历史与教训.md` §3 与 §4「不要 git commit（除非用户明示）；不要碰 release 与源码目录」。

---

## 1. 回答格式（沿用本项目既有约定）

`.claude/CLAUDE.md` 已经定死了回复结构，我照办，不另立一套：

### 直接执行
按你当前的要求和逻辑，直接给出结果（代码 / 命令 / 结论 / 数字）。

### 深度交互
对原始需求做审慎挑战：质疑是否跑偏（XY 问题）、指出当前路径的弊端、给更短更低成本的替代方案。
**但**——挑战归挑战，除非你同意改向，我仍把你原本要的那件事做完，不用"我觉得没必要"替你砍需求。

第一性原理：不假设你完全清楚目标。目标模糊就停下问；目标清晰但路径不是最优，直接说更短的路。

---

## 2. 开工顺序（顺序不能乱）

1. **读现状**：`目标\接手必读.md`（接手第一站：概览 / 状态快照 / 模块地图 / 铁律 / 待办）→ `目标\历史与教训.md`（逐轮纪要 + 血泪清单 + 已否决事项）。
   （2026-10-13 文档清理：原 `接手指南-2.md` / `操作流水.md` / `交接给下一个AI.md` / `交接给下一个AI-历史-20261002.md` / `规划\` 共 19 份已删，取回命令见 `接手必读.md` §8。）
2. **读口径**：`docs\<对应功能>.md`（设计文档 = **冻结口径**，如 `hypnosis-phone.md`、`intimate-dashboard.md`、`group-private-memory.md`、`context-usage-panel.md`）。
3. **读契约**：`AGENTS.md`（UI / 组件 / LLM prompt / 人格组装 / 临时脚本）+ `docs\testing.md`（测试收什么、浏览器样例有哪些）。
4. **读代码**：以 `grep` 定位到具体文件与行，**只读不改**，先跑基线数字。
5. **动手前只做一件事**：向你复述"我理解的需求 + 我打算改哪几个文件 + 怎么验"，有歧义当场问。

**文档 ≠ 事实。** 本项目已经出现过文档过时（补记 4 ② 纠正"`grantHypnosisPhone` 不拦"的旧描述）和文档写错（补记 15 → 补记 16 两次收窄群聊记忆口径）。
**凡是要写进结论的，必须以代码/日志/测试实跑为准；文档与代码冲突时，改文档，不是改结论去迁就文档。**

---

## 3. 干活循环（一轮 = 一条链）

```
需求原话 → 口径冻结（写进 docs/ 或复述确认）
        → 最小改动（只碰该碰的文件）
        → 定向测试（新用例钉住口径）
        → 全量回归（后端 + 前端 + 产物）
        → 真机证据（日志行 / 接口返回 / 真实 LLM）
        → 记录（`历史与教训.md` 追加一行 + `接手必读.md` 改状态块与待办 + docs 口径同步）
```

三条自缚的规矩：

1. **一次只改一条链**。改完立刻复跑，不攒着"等会儿一起验"。
2. **先证据后结论**。返工教训 2：我曾把"注入失败"归因成单一根因，实际是三个缺陷叠加（分片容错 + `max_tokens=200` 被思考吃光 + `after_msg_id` 传 raw id 撞 FK），是用户两次贴日志才挖出来。**先要日志，别先改代码。**
3. **差异最小化**。对与上游重叠的大文件（`chat.js`、`scheduleManager.js`、`groupChatEngine.js`、`App.vue`、`ChatView.vue` 等）**只做加法**，为将来三方合并留路（合并策略存档在 `目标\历史与教训.md` §6）。

---

## 4. 验证阶梯（能做几层做几层，做不到的如实说）

| 层 | 动作 | 门槛 / 说明 |
| --- | --- | --- |
| L1 定向单测 | `node --test test/xxx.test.js` | 每个新口径至少 1 条断言钉住；bug 修复必须有回归用例 |
| L2 后端全量 | `agent-core` + `DB_PATH=':memory:'` + `--import ./test/setup.mjs` + `--test-concurrency=1 --test-force-exit --test-timeout=90000` | **必须内存库**；`setup.mjs` 会把网络默认关掉（非本机地址的 fetch 一律 reject），**漏了它全量会从几分钟变十几分钟、并有文件被超时掐掉**；基线以**本轮实跑**为准，旧数字只作参照、不作断言；**报告必须带上 `cancelled`**（>0 就是有用例没跑，见 §5「看 cancelled」） |
| L3 前端全量 | `web-ui` + 同一命令 | 前端逻辑抽成 `*Logic.js` 纯函数再测，别去 mount 重组件 |
| L4 产物 | 改了 `web-ui/src` → `vite build`，按 `index.html` 引用删旧 hash 产物 | 产物被 git 跟踪，不重建等于改了没生效 |
| L5 端到端 / 真机 | 临时库 + 真后端 + 真 HTTP；真实 LLM **必须先问**（花你的额度） | 起服务前先探端口（3399 / 8899 常被上次进程占着） |
| L6 浏览器点击 | **我做不了**（无浏览器控制） | 明确列出"要你点哪几处、看到什么算对"，不假装验过 |

**报告口径**：`N / M pass / K fail / S skipped` 原样写，fail 和 skipped 都给原因。跳过就说跳过，没跑就说没跑——**不假装**。

真实库保护：每轮开工与收工各做一次指纹体检（长度 + SHA256 + mtime）。历史文档里记过的旧指纹（`2211840 / 1790572036`、`2363392 / 4296E526…`）都只是**当时**的值，你正常使用应用它就会变（当前值是 `9371648 / D3ED1648969D243F…`，也会变）——所以**以本轮开工实测为基线**，只断言"我没有改过它"。

---

## 5. 硬纪律清单（违反任何一条都算事故）

**命令 / 环境**
1. node 一律用 `runtime\nodejs\node.exe`（22.18）；git 用 `runtime\git\cmd`。子代理环境 better-sqlite3 ABI 不匹配，**直接调服务的临时脚本必须主环境跑**。
2. 后端时间串是无时区 UTC（`2026-09-28 05:55:59`）；前端解析一律走 `parseBackendTime`，不许绕过。
3. `GET /forgotten` **不带 query ≠ 空串 query**：前者默认 `active`，前端要全量必须显式 `?status=`。
4. PowerShell 里长中文文本一律 here-string `@'...'@` 或写文件（引号坑已翻车 4 次）。
5. **不用** `Get-Content | Set-Content` 改 UTF-8 中文源码（GB2312 解码会毁文件）；改文件只走编辑工具。
6. 临时脚本放 `%TEMP%`，用完即删；仓库里不留 `test.js` / `debug-*.js` / `*.log`。
7. 要反复跑的回归逻辑 → 正式测试：`agent-core/test/*.test.js`（另扫 `src/services/*.test.js`）或 `web-ui/test/*.test.js`，统一 `node --test`。
8. 起服务前探端口（3399 / 8899 / 3099 / 8765 常被上次进程占着）；用完当场停掉自己起的验证服务（**停服务要单独一次调用**，别和重活挤在一条命令里 —— Windows job runner 会以 4294967295 崩掉）；HTTP stub 必须 `unref()`；收工查 `agent-core\data\town\assets` 有没有测试孤儿 PNG —— **用 `scripts/town-assets-check.mjs`（默认只报告），别再用无差别 `Remove-Item`**：那个目录里同时住着**真实用户素材**，照老命令执行就是全删（2026-10-18 已把测试落盘隔离掉，正常情况应当 0 孤儿；见《历史与教训》§3 第 45/47 条）。
9. 测试**默认断网**（`test/setup.mjs`：非本机地址的 fetch 一律 reject，`127.0.0.1`/`localhost` 放行）；要联网的用例自己在用例里覆盖 `globalThis.fetch`。
10. 报数字时必须带上 **`cancelled`**：`--test-force-exit` 会把"跑完后句柄不释放"的文件掐掉，摘要照样显示 `0 fail` —— **看 cancelled，不只看 fail**。
11. 别 `rename`/`unlink` 正在被写的文件（Windows 下 EBUSY/EPERM 的表现是"看着做了其实没做"）；隔一会儿重试或先停掉写它的进程。

**前端 UI（`AGENTS.md` 是唯一来源，我只执行不发明）**

9. 按钮 / 输入框 / 选择框 / 开关 / 分段选择 / 弹窗一律用 `web-ui/src/components/ui/` 的 Linshe 组件（`LinsheButton` / `LinsheInput` / `LinsheSelect` / `LinsheSwitch` / `LinsheTabs` / `LinsheModal`），禁止裸 `<button>` / `<input>` / `<select>` 或自绘遮罩皮肤；**皮肤只改组件文件，不在页面里覆盖**。
10. 页面 / 页签 / 内容区切换 0.3s 过渡；窗口（含弹窗）0.3s 渐入渐出，**关闭动画跑完再卸载**。
11. 新 UI 必须融进现有设计语言（对照点击 NPC 打开的对话框、Toast、信箱检查一致性），并验暖色 / 暗夜双主题 + 移动端。
12. 小镇玩法一律优先"奇遇叙事"，不重新引入步骤机 / 表单式结算面板。
13. 合规特例白名单（聊天主输入框、信纸 textarea、`.vn-input`、TavernView 深色玻璃输入等）才允许自包含样式，新页面不许往白名单里塞。

**LLM 相关**

14. 要求模型输出 JSON 时，prompt 里必须给**完整 JSON 示例**（字段名 + 示例值 + 每字段的字数/语气/禁止项约束），并明说"只输出 JSON、不要解释"；改字段就同步改解析代码。参考写法：`agent-core/src/services/eventGenerator.js` 的 `formatPrompt`。
15. 角色生图人格组装一律走 `characterPersona.js`（`buildCharacterPersona` / `buildCharacterAppearanceSection` / `buildImageCrossRefInfo`），禁止各模块自己写截取正则；传入对象的 `id` 必须是角色 id。
16. 生效外观只走 `outfitService.getActiveOutfits(characterId)`；注入文本格式只在 `buildOutfitInjectionBlocks` 改。

---

## 6. 我的行事准则（这一节是"我"的部分）

1. **验证先于自信**。没有命令输出、没有日志行、没有测试数字的话，我不说"修好了"。
2. **先只读盘点，再动手**。接手第一轮默认零改动：先摸清链路、跑基线、出调查结论（本项目 §三-6 那一轮就是模板）。
3. **复用优先于新造**。项目里已有 `containsExplicitAdultContent`（自带中文词表）、`toIsoOrNull`、`resolveMemberMemoryBudget` 这类现成的收口函数，先找它们，别自己再写一套口径。
4. **口径走收口点**。同一件事只有一个入口（如注入格式只改 builder、皮肤只改组件文件），发现第二处实现就是缺陷，合并掉。
5. **挑战但不越权**。路径更短我会直说；但要不要做、做哪一版，你定。你叫停就**立刻全停并还原**（打包授权变更那次：停掉正在跑的打包 + 还原上一版交付包）。
6. **不假装能力**。浏览器点击、真机体感、模型"演得好不好"，我验不了就交给你，并给出可执行的核对清单。
7. **注释即口径**。删条件、留兼容分支时，写一行注释说明"口径 + 日期 + 为什么保留"（如 `affinity_low` 作兼容路径保留），别让下一个人猜。
8. **落档到"能复跑"**。任何结论都要能追到命令或 `git show <commit>`；数字要写清是估算还是实测（如上下文分项 tokens 是字符估算，真实值以顶层为准）。

---

## 7. 记录与交接（四份文档，各管一段，只追加不重写历史）

| 文档 | 管什么 | 什么时候动 |
| --- | --- | --- |
| `目标\接手必读.md` | 接手第一站：项目概览 / 状态快照 / 模块地图 / 铁律 / 待办 | 每轮收工**只改 §2 的数字与状态 + §6 的待办勾选**，不重写正文 |
| `目标\历史与教训.md` | 逐轮纪要（一行一轮）+ 血泪清单 + 已否决事项 | 每轮**追加**一行；有新教训再加一条；**旧条目不改写** |
| `docs\<功能>.md` | 设计口径（冻结） | 口径变了同步改，并写明变更日期与理由 |
| `scripts\build-release.mjs` 的 `buildUsageGuideText` | **用户手册的唯一正源**（生成 `使用说明.txt`） | 用户可见行为变了就同步（纪律：只增不删，有意替换要写清理由） |
| `目标\编程模式-DeepSeek.md` | 本文件：我的工作模式 | 模式本身变了才改；**不要每轮都改它** |

> **2026-10-13 文档清理**：原 `接手指南-2.md` / `操作流水.md` / `交接给下一个AI.md` / `交接给下一个AI-历史-20261002.md` / `操作流程.md` / `规划\`（13 份）共 19 份、约 660 KB 已删（用户要求："太长太多了…全删了写重要的就行"）。要旧全文按 `接手必读.md` §8 的 `git show d1ebf9f:…` 取回。
> **不要再往 `目标\` 里堆逐轮流水**：那样三年后没人读得完 —— 结论进 `历史与教训.md`，状态进 `接手必读.md`。

**旧记录不删、不改写**：发现以前写错了，用新增补记**更正**（先例：`a830915` 更正"群会话入召回范围"的考证错误；补记 4 ② 纠正过时文档描述）。

---

## 8. 这五种情况必须停下来问你

1. 目标有歧义，或我判断你要的和你真正想要的不是一回事（XY 问题）。
2. 要花你的钱 / 额度（真实 LLM 验证）、要 `git commit`、要打包。
3. 要动"冻结口径"或删掉你以前明确要过的东西。
4. 发现文档、测试、代码三者互相打架，且无法从原话判断谁对。
5. 排查到第 3 轮还定位不到根因——先要日志和复现路径，不继续猜。

---

## 9. 开工 / 收工检查清单

**开工**
- [ ] 读 `目标\接手必读.md` + `目标\历史与教训.md` 的最新条目，确认上一个人停在哪、现在什么状态
- [ ] `git status --short` 确认工作区干净（或已知脏在哪）
- [ ] 记录真实库指纹（长度 + SHA256 + mtime）作为本轮基线
- [ ] 跑一遍基线的后端 / 前端全量（命令见 §10，**别漏 `--import ./test/setup.mjs`**），拿到**本轮真实数字**（连 `cancelled` 一起记）
- [ ] 向用户复述需求与改动面，确认后再动手

**收工**
- [ ] 定向测试 + 全量回归数字落进记录（fail / skip / cancelled 都给原因）
- [ ] 改了 `web-ui/src` → 已重建产物且旧 hash 已删
- [ ] 真实库指纹未变；临时脚本 / 临时库 / 日志已清；`scripts/town-assets-check.mjs` 报告 **0 孤儿**（有孤儿才用 `--delete-orphans --yes-db=...`，别再无差别删目录）
- [ ] `git status` 无意外残留（`.env`、`data/`、`runtime/`、`完整/`、`logs/` 不进版本库）
- [ ] 文档按 §7 同步：`接手必读.md` §2 的数字与状态、`历史与教训.md` 追加一行、对应 `docs/<功能>.md` 口径、用户可见行为变了还要改 `build-release.mjs` 的 `buildUsageGuideText`
- [ ] 明确说出：做完什么 / 没做什么 / 已知边界 / 建议下一步；要用户点的地方给出"点哪里、看到什么算对"的清单

---

## 10. 命令卡片（本机实测可用）

```powershell
$r = 'D:\邻舍改'   # 2026-10-17 迁移后的工作目录
$env:Path = "$r\runtime\nodejs;$r\runtime\git\cmd;$env:Path"

# ① 后端全量（必须内存库；**`--import ./test/setup.mjs` 不能漏** —— 它把网络默认关掉）
Set-Location "$r\agent-core"
$env:DB_PATH = ':memory:'; $env:LOG_TO_FILE = 'false'
& "$r\runtime\nodejs\node.exe" --test --import ./test/setup.mjs --test-concurrency=1 --test-force-exit --test-timeout=90000 "test/*.test.js" "src/services/*.test.js"
# 约 12 分钟；结尾必须看 cancelled（>0 = 有用例没跑，别当绿）

# ② 前端全量
Set-Location "$r\web-ui"
& "$r\runtime\nodejs\node.exe" --test --test-concurrency=1 --test-force-exit --test-timeout=90000 "test/*.test.js"

# ③ 改了 web-ui/src 之后（产物落 ../agent-core/public，按 index.html 删旧 hash）
& "$r\web-ui\node_modules\.bin\vite.cmd" build

# ④ 真实库只读体检（数字与开工基线比对，应当一致）
Get-Item "$r\agent-core\data\agent.db" | Select-Object Length, LastWriteTime
Get-FileHash "$r\agent-core\data\agent.db" -Algorithm SHA256

# ⑤ 卫生
git -C $r status --short

# ⑥ 小镇素材体检（默认只报告、不删；只在报告出孤儿时才需要清理）
& "$r\runtime\nodejs\node.exe" "$r\scripts\town-assets-check.mjs"
# 确认清单无误后再真删（必须显式给 --yes-db 指向你确认过的库）：
# & "$r\runtime\nodejs\node.exe" "$r\scripts\town-assets-check.mjs" --delete-orphans --yes-db="$r\agent-core\data\agent.db"

# ⑦ 提交（只有你明说才做；中文长消息走文件，避开引号坑）
[IO.File]::WriteAllText("$env:TEMP\msg.txt", $msg, (New-Object Text.UTF8Encoding($false)))
git -C $r -c user.name=iceCranberry -c user.email=icecranberry@163.com commit -F "$env:TEMP\msg.txt"
```

单文件跑：在对应子目录 `node --test test\文件名.test.js`（后端别忘 `$env:DB_PATH=':memory:'`）。

---

## 11. 与其它约定文件的关系

- `.claude\CLAUDE.md`：管**思考方式与回答格式**（第一性原理 + 直接执行 / 深度交互）→ 我全盘继承。
- `AGENTS.md`：管**全仓契约**（UI 组件、LLM prompt、人格组装、测试归属）→ 我只执行，不擅自改；要改先问你。
- `目标\接手必读.md` + `目标\历史与教训.md`：管**状态与历史** → 我负责更新（状态块改数字、纪要追加一行）。
- `docs\<功能>.md`：管**冻结口径** → 口径变了我同步，并写明日期与理由。
- **本文件**：管**手段**——我具体怎么把上面几层落成一次可验证、可交接的操作。

四者冲突时优先级：`AGENTS.md`（契约）> `docs\*.md`（口径）> 本文件（手段）> 我的个人偏好。
