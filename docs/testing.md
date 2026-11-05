# 测试维护说明

普通睡眠同步回归：`scheduleOverview.test.js` 覆盖请求乱序、旧失败不污染新结果、503／异常响应保留快照、重试、SSE 日程变更／叫醒／重连及取消订阅；`chatSchedule.test.js` 验证聊天完成、切会话、窗口焦点、可见性、30 秒刷新和卸载清理。`chatTools.browser.test.js` 额外实际点击电话叫醒及失败重试，验证私聊头像标记同步、群聊睡眠人数、小憩、暂时清醒，以及三个屏宽下页头状态可见。聊天入口同时检查圆形比例、SVG 图标、悬停名称与无展开文字，防止再回退为文字胶囊。

## 数据边界

程序验收只使用内存库、合成临时库和模拟素材。默认不读取、复制或扫描玩家旧数据；旧立绘缺失不算程序测试失败。`setupIsolationGuard.test.js` 验证配置与 SQLite 实际连接均指向内存，并检查全新库初始化和重建，不再读取玩家数据库文件头。需要磁盘持久化或升级验证时构造版本夹具。

`test/setup.mjs` 在导入业务代码前，为每个进程分配独占的临时 `.env`（`LINSHE_ENV_PATH`），退出时清理。外部传入的配置路径也会被替换，避免测试误写真实配置；需要自定义配置夹具时，在测试进程内显式创建并指定。`contextUsage.test.js` 的真实 HTTP 保存测试已改用该临时路径，不再读取真实文件后还原。

模型配置回归：`web-ui/test/llmProfiles.test.js` 验证配置变更互斥、取消、失败与删除草稿保护；`llmSettings.test.js` 覆盖输出额度、模型发现、上下文窗口及 JSON 对象校验。`llmProfiles.browser.test.js` 按下述 PLAYWRIGHT_MODULE 方式启用，挂载真实设置页，使用模拟接口验证创建失败/重试、快速连点、删除备用配置、切换确认、保存失败保留草稿、免费模式恢复与双主题窄屏。

聊天互动回归：`chatPanelToggles.test.js` 挂载 composable，验证互斥、重复点击、会话切换与 Esc；`groupPanels.test.js` 与 `groupPanelTargetSwitch.test.js` 保留群成员归属和状态清理契约。`chatTools.browser.test.js` 按 PLAYWRIGHT_MODULE 方式启用，实际挂载私聊／群聊，覆盖 1440px 暖色、360px／320px 暗夜、44px 点击范围、输入宽度、长名字、键盘选人、选人后打开原功能、Esc 与切会话收起。还覆盖对话推测在上／输入文本域居中／工具在下的布局、动作分类、玩具页签与折叠、亲密选项折叠、503 后重试及空佩戴列表清除旧展示。接口只用合成桩，且检查无上下文余量请求。已删除的前端 contextUsage 与 contextPrefixFingerprint 测试只服务于移除的面板；后端统计、预算和压缩回归继续保留。

## 运行入口

- 后端：`npm --prefix agent-core test`，收集 `agent-core/test/*.test.js` 和 `agent-core/src/services/*.test.js`。
- 前端：`npm --prefix web-ui test`，收集 `web-ui/test/*.test.js`。
- 前端单文件：在 web-ui 执行 `node --test test/文件名.test.js`；后端单文件必须带下述隔离入口和环境变量。

完整回归优先在仓库根目录执行 `runtime/nodejs/node.exe scripts/test-all.mjs`，它串行运行前后端、固定内存库，并加载后端隔离入口。单跑后端也必须带 `--import ./test/setup.mjs --test-concurrency=1 --test-force-exit --test-timeout=90000`，设置 `DB_PATH=:memory:` 和 `LOG_TO_FILE=false`。不要并发运行两套全量测试。

报告必须包含 tests / pass / fail / skipped / cancelled；`cancelled > 0`、子进程退出码非零或启动异常均判失败。根入口会输出最多 10 个 TAP 失败块，便于直接定位原因（2026-11-04 补）。

跨模块修复回归（2026-11-04）：`llmConcurrency.test.js` 与 `llmConcurrencyClient.test.js` 验证开关切换、凭证释放和取消排队；`replyQueueRecovery.test.js` 用内存库和本机 HTTP 模型桩验证叫醒/延迟回复的批次归属、写库回滚和 UTC 上下文；`imageWorkflowOwnership.test.js` 通过真实角色 HTTP 路由验证延后确认立绘的工作流归因；`servicePort.test.js` 验证端口解析、应用身份和进程归属。启动器基础测试使用 `python -m unittest discover -s launcher/test -v`，不启动真实库。

测试桩的初始化顺序：内存库首次 `getDb()` 会从 system_settings 回填 config，必须先初始化库，再覆盖本机 HTTP 桩地址。`assetGenerationQueue.test.js` 已按此调整；测试不能靠真实 ComfyUI 在线才通过。

配置持久化回归：`envFile.test.js` 验证注释模板、重复键、特殊字符、多行值、部分写入与替换失败，并启动独立进程验证新安装配置重载；`llmConfig.test.js` 覆盖整批写入、非法窗口整体拒绝、文件失败不修改运行状态/配置选择、同毫秒创建配置的 ID 唯一性和免费模式下个人设置的保存。

奇遇可靠性回归：`agent-core/test/eventLifecycle.test.js` 用内存库、真实 HTTP 与故障触发器验证处理中保护、重复结算、归档回滚、原创建时间保留；`web-ui/test/eventsStore.test.js` 验证排队结果/失败/取消、撤销时列表变化、并发刷新与未读边界。`adventureAcceptance.browser.test.js` 使用同一 PLAYWRIGHT_MODULE 启用，实际点击奇遇重试、自由行动、空筛选恢复与备份面板，覆盖桌面暖色和 360px 暗夜，接口全部模拟。

`linsheTabs.test.js` 编译真实组件，验证整体禁用后的残留焦点事件与单项禁用均不触发切换，重新启用后正常响应。

## 信箱回归

`agent-core/test/mailboxLifecycle.test.js` 通过内存库与真实 HTTP 覆盖失败重投、原文与时间格式保留、详情打开后进入 processing 再删除／重投的 409、完成信件保护、详情已读回执与非法寄信参数。既有失败终态、截断回信解析和群记忆测试继续保留。

`web-ui/test/mailboxStore.test.js` 覆盖乱序列表请求、重投／删除后的旧快照、发送与刷新交错产生的重复记录、请求失败恢复及删除确认期间的互斥。`mailboxAcceptance.browser.test.js` 用 PLAYWRIGHT_MODULE 启用，挂载页面信箱和酒馆信箱，覆盖 1440px 暖色／360px 暗夜下的失败重投、动态详情、删除冲突、发送期间禁用取消、失败保留草稿与成功恢复操作；接口均为合成桩，不发真实信件或调用模型、生图、语音服务。浏览器断言等实际点击完成后再量布局，避免把 0.3 秒滑入动画中途的位置当作最终位置。

## 启动器产物验收

`launcher/build_launcher.py` 由三个构建入口共用。先在独立 venv 验证依赖；清除外部 Python／Qt 环境变量，将 DLL 搜索 PATH 收窄到构建 Python 与 Windows 目录，再在临时目录执行 PyInstaller。避免 Poppler 等工具的同名 ICU 被打进 Qt 程序。生成 EXE 必须在 45 秒内退出成功并输出有效窗口报告，之后才原子替换目标文件；不能用文件存在或体积变化替代启动验收。

```powershell
# 根目录：纯构建逻辑单测
launcher/build_cache/pyinstaller-venv/Scripts/python.exe -m unittest discover -s launcher/test -v
# 单独重建启动器，包含产物窗口自检；不制作完整分发包
launcher/build_cache/pyinstaller-venv/Scripts/python.exe launcher/build_launcher.py --output 邻舍.EXE.exe
# 独立复验已安装 EXE；报告及截图写系统临时目录
$env:LINSHE_LAUNCHER_TEST_RESULT = Join-Path $env:TEMP 'linshe-launcher-selftest.json'
Start-Process -FilePath '.\邻舍.EXE.exe' -ArgumentList '--self-test' -WindowStyle Hidden -Wait
Get-Content -LiteralPath $env:LINSHE_LAUNCHER_TEST_RESULT
Remove-Item Env:LINSHE_LAUNCHER_TEST_RESULT
```

自检使用空白临时项目创建真实 MainWindow 并渲染截图，要求 `ok: true` 且 `pages >= 6`；不访问玩家配置／数据库，不拉 Git，不启动业务服务。它验证 DLL、Qt 控件与窗口初始化，不覆盖点击「启动」后的整套服务。修改构建或启动入口后必须复验 EXE，前端测试不能代替这一层。

## 保留范围

本轮新增安全回归：`agent-core/test/dataBackup.test.js` 覆盖损坏库、音频、维护锁、失败回滚与重启锁定；`accessControl.test.js` 覆盖配对、远程管理边界、跨站与代理；`httpLifecycle.test.js` 验证 SSE 与超时请求退出。`web-ui/test/deviceAccess.browser.test.js` 使用真实中间件和真实 Vue 组件，覆盖配对失败/成功、Cookie 刷新保持及双主题窄屏；与下述浏览器命令使用同一 PLAYWRIGHT_MODULE。

根目录 `npm run check` 检查文档导航和 Markdown 本地链接，报告最大源码文件，不扫描玩家数据。`.github/workflows/check.yml` 在 Windows / Node 22.18 上串行跑测试、lint、生产构建与文档检查；浏览器专项仍需显式配置 Playwright，不把跳过项算作验收通过。

| 范围 | 代表性入口 | 保留原因 |
| --- | --- | --- |
| 角色人格、外观与生图 | `agent-core/test/characterPersona.test.js`、`globalLoraScene.test.js`、`llmImageInput.test.js`、`hiresTransparentBackground.test.js` | 人格组装兼容性、身份和外观段编辑、图像输入及透明背景回归 |
| 聊天、记忆与数据迁移 | `agent-core/test/consolidation.test.js`、`memoryV3Migration.test.js`、`contextBudget.test.js`、`sseDisconnectAbort.test.js` | 记忆检索与归并、存量数据升级、上下文预算、流式请求断开 |
| 朋友圈与日程 | `agent-core/test/momentUserPostFlow.test.js`、`momentScheduler.test.js`、`scheduleEditor.test.js` | 发帖、配图、调度和日程编辑的真实执行路径 |
| 前端状态与交互 | `web-ui/test/imageTaskRecovery.test.js`、`groupLastSeen.test.js`、`githubUpdate.test.js` | 聊天迟到图片补取、取消与错误终态、未读和升级状态 |
| 图像处理与渲染 | `web-ui/test/whiteGapDetection.test.js`、`standingGeometry.test.js`、`standingInteractionGeometry.test.js` | 留白检测、立绘布局和交互区域 |
| 破限规则集与思考开关 | `agent-core/test/jailbreakRules.test.js`、`promptShield.test.js`、`llmReasoningEffort.test.js`、`web-ui/test/jailbreakSettings.test.js` | 多套底稿 CRUD/激活/投递范围、破限词注入顺序（上游保 system0）、默认关思考的两条路、编辑器纯逻辑与 Linshe 接线 |

表中是代表性入口，其余覆盖不同边界条件的正式测试继续保留。前后端同名测试可能验证不同实现，不能仅凭文件名去重。

### 破限与思考两条链的定位

- `agent-core/test/jailbreakRules.test.js`：规则集 CRUD、内置保护、**旧键 `jailbreak_prompt` 兼容**、投递范围、`escapeInterpolation`。
- `agent-core/test/promptShield.test.js`：注入行为与**顺序契约**（上游 `<Supplementary_Rule>` 保 system0、本地排 system1）；含一条直接 import `builtinRules.js` 的守卫 —— 上游标签改名会让排序静默失效。
- `agent-core/test/llmReasoningEffort.test.js`：**默认关思考**。钉「`thinking:{type:'disabled'}` 与 `reasoning_effort:'low'` 两条路一起发」以及「空串/脏值一律归一回 low，不提供置空出口」。改这两条路前先读 `docs/chat/jailbreak-rules.md` §7 的实测表。
- `web-ui/test/jailbreakSettings.test.js`：编辑器纯逻辑在 `web-ui/src/utils/jailbreakRuleDraft.js`（本仓无组件挂载能力，故拆模块）。核心是「**范围勾选是集合运算，取消一个不影响其余八个**」与「**草稿 targets 是副本，不污染预置**」。

### 浏览器 E2E 里的破限页

`e2e/run-e2e.mjs` 的 `checkJailbreakRules`（J1~J6）真点一遍破限设置页：入口卡片 / 页面打开 / 三套预置+内置标签 / 内置正文只读+复制按钮 / 切换激活项（顶部与后端一致）/ 注入范围关一个后端少一个 + 复原。

跑法与整体纪律见 `e2e/README.md`（真实库只读：`VACUUM INTO` 副本）。

## 浏览器回归样例

小镇已于 2026-10-20 剥离，原有 town 测试与浏览器样例不再作为验收入口。以下 HTML 样例需要手动打开，不由 `node --test` 收集。启动 `npm --prefix web-ui run dev` 后，在其开发服务器地址打开：

- `/test/fixtures/whiteGaps.html`：图像编辑器的留白预览、恢复与保存失败交互，使用合成图片和模拟保存接口。
- `/test/fixtures/intimatePanel.html`：亲密看板（双主题 / 兼容 360px 窄屏 / 组件级漂移自检）。页面直接挂载真实 `IntimatePanel.vue`，用 `fetch` 打桩后端接口（离线可跑，不连本地服务），加 `?theme=dark` 可以暗夜主题打开。
- `/test/fixtures/intimatePanelLive.html`：亲密看板 live 端到端（真实组件 + 真实后端数据，需先起 agent-core 与 vite；与上面的 stub 版互补，不做 fetch 打桩）。

两者分工：`intimatePanel.html` 离线可跑，覆盖组件结构漂移与暖色 / 暗夜双主题、360px 窄屏；`intimatePanelLive.html` 依赖真实服务，验证真实数据读数与真实写路径。

浏览器样例及其 HTML / SVG 配套资源共同保留；算法单测不能替代 GPU 和画布交互检查。修改相关渲染或编辑功能后应额外运行这些样例。

自动浏览器测试：在 `web-ui` 下设置 `$env:PLAYWRIGHT_MODULE='D:\邻舍改\e2e\node_modules\playwright'`，再用 bundled Node 执行 `--test --test-concurrency=1 test/repairAcceptance.browser.test.js`。该用例自行启动隔离 Vite 服务与模拟接口，点击真实 Vue 组件，验证场景外观参数和工作流注入说明，并覆盖桌面暖色与手机暗夜。`standingLayout.browser.test.js`、`standingSpeech.browser.test.js` 同样可显式启用；未设置变量时跳过，不代表已通过浏览器验收。

写这类"读计算样式"或"驱动真实页面"的自检时注意三点：① 切换主题后立刻读 `getComputedStyle` 会拿到过渡起点而不是最终色（面板、开关、`body` 都带 0.3s 过渡），必须先冻结 `transition` 并 `cancel()` 掉已在跑的动画再断言；② `Page.navigate` 到同一个 hash URL 不等于重载（同文档导航），验证"页面是否跟随后端"必须用 `Page.reload{ignoreCache:true}`，否则会得到假阴性；③ 新库首次打开设置页会弹出「更新说明」模态遮罩、吃掉 CDP 鼠标点击的坐标，自动化点击前先发 Escape 关掉它。用 CDP 驱动时若后端端口被队友占用，另开端口 + 在 `%TEMP%` 放一份 import 真实 `vite.config.js` 并只覆盖 proxy target 的临时配置，比改仓库文件再还原更稳。

驱动环境本身还有三条坑：① 无 BOM 的 `.ps1` 会被本机 PowerShell 按 ANSI 解码，中文注释会吃掉引号导致解析失败（临时驱动脚本请写 UTF-8 BOM）；② PS7 的 `Invoke-RestMethod` 对 JSON 数组不做枚举，拉 `/json/list` 多 target 时会把整个数组当成一个 target（需 `@()` 包一层）；③ 样例 Chrome 异常退出会残留并占住调试端口，下次拿到的是旧实例的 target 列表（起之前先按命令行特征清掉自己的 Chrome）。

## 清理记录与后续准则

2026-09-22 清理了 9 个没有调用方的后端 fixture / worker / 旧验收脚本，以及引用已删除组件的旧挣钱玩法预览页。交易命令用例并入 `townInteractions.test.js`；原先分散在两处的人格测试统一放入 `agent-core/test/characterPersona.test.js`，保留原有行为覆盖。

同时移除仅逐句检查静态提示词常量的断言，保留动态提示词组装、解析及发帖流程测试；补齐服务管理筛选测试所需的地图状态，并验证同镇排序不会改写原名单。

- 保留真实行为、失败路径、数据安全和曾发生过的 bug 回归；不按文件长短或测试数量决定去留。
- 同一功能的小用例优先合并到已有测试中；不要复制生产逻辑再验证复制品。
- 删除功能或测试时同步检查其 fixture、worker、预览资源和文档入口是否仍有调用方。
- 临时验证脚本和日志用完即删；需反复使用的回归逻辑按 `AGENTS.md` 约定纳入正式测试。
