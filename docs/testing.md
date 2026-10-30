# 测试维护说明

## 运行入口

- 后端：`npm --prefix agent-core test`，收集 `agent-core/test/*.test.js` 和 `agent-core/src/services/*.test.js`。
- 前端：`npm --prefix web-ui test`，收集 `web-ui/test/*.test.js`。
- 单文件：在对应子项目目录执行 `node --test test/文件名.test.js`。

后端检查应使用内存数据库。PowerShell 中可先执行 `$env:DB_PATH = ':memory:'` 再运行后端测试；测试中的外部服务优先使用本地模拟。

## 保留范围

| 范围 | 代表性入口 | 保留原因 |
| --- | --- | --- |
| 角色人格、外观与生图 | `agent-core/test/characterPersona.test.js`、`globalLoraScene.test.js`、`llmImageInput.test.js`、`hiresTransparentBackground.test.js` | 人格组装兼容性、身份和外观段编辑、图像输入及透明背景回归 |
| 聊天、记忆与数据迁移 | `agent-core/test/consolidation.test.js`、`memoryV3Migration.test.js`、`contextBudget.test.js`、`sseDisconnectAbort.test.js` | 记忆检索与归并、存量数据升级、上下文预算、流式请求断开 |
| 朋友圈与日程 | `agent-core/test/momentUserPostFlow.test.js`、`momentScheduler.test.js`、`scheduleEditor.test.js` | 发帖、配图、调度和日程编辑的真实执行路径 |
| 小镇核心流程 | `agent-core/test/townTravel.test.js`、`townMapReset.test.js`、`townInteractionRuntime.test.js`、`townNpcServiceRuntime.test.js`、`townNpcStock.test.js` | 地图隔离、重置范围、邀请与奇遇、交易及状态恢复 |
| 前端状态与交互 | `web-ui/test/townInteractions.test.js`、`townTravel.test.js`、`townServiceManagerScope.test.js`、`groupLastSeen.test.js`、`githubUpdate.test.js` | 重复提交、迟到响应、地图切换、筛选排序、未读和升级状态 |
| 图像处理与渲染 | `web-ui/test/whiteGapDetection.test.js`、`townImageEditor.test.js`、`townTileUv.test.js`、`townRendererChunkStability.test.js` | 留白误删、编辑回退、UV 稳定性和构建分包依赖 |
| 破限规则集与思考开关 | `agent-core/test/jailbreakRules.test.js`、`promptShield.test.js`、`llmReasoningEffort.test.js`、`web-ui/test/jailbreakSettings.test.js` | 多套底稿 CRUD/激活/投递范围、破限词注入顺序（上游保 system0）、默认关思考的两条路、编辑器纯逻辑与 Linshe 接线 |

表中是代表性入口，其余覆盖不同边界条件的正式测试继续保留。前后端同名测试可能验证不同实现，不能仅凭文件名去重。

### 破限与思考两条链的定位

- `agent-core/test/jailbreakRules.test.js`：规则集 CRUD、内置保护、**旧键 `jailbreak_prompt` 兼容**、投递范围、`escapeInterpolation`。
- `agent-core/test/promptShield.test.js`：注入行为与**顺序契约**（上游 `<Supplementary_Rule>` 保 system0、本地排 system1）；含一条直接 import `builtinRules.js` 的守卫 —— 上游标签改名会让排序静默失效。
- `agent-core/test/llmReasoningEffort.test.js`：**默认关思考**。钉「`thinking:{type:'disabled'}` 与 `reasoning_effort:'low'` 两条路一起发」以及「空串/脏值一律归一回 low，不提供置空出口」。改这两条路前先读 `docs/jailbreak-rules.md` §7 的实测表。
- `web-ui/test/jailbreakSettings.test.js`：编辑器纯逻辑在 `web-ui/src/utils/jailbreakRuleDraft.js`（本仓无组件挂载能力，故拆模块）。核心是「**范围勾选是集合运算，取消一个不影响其余八个**」与「**草稿 targets 是副本，不污染预置**」。

### 浏览器 E2E 里的破限页

`e2e/run-e2e.mjs` 的 `checkJailbreakRules`（J1~J6）真点一遍破限设置页：入口卡片 / 页面打开 / 三套预置+内置标签 / 内置正文只读+复制按钮 / 切换激活项（顶部与后端一致）/ 注入范围关一个后端少一个 + 复原。

跑法与整体纪律见 `e2e/README.md`（真实库只读：`VACUUM INTO` 副本）。

## 浏览器回归样例

以下是持续维护的浏览器样例，依赖 Canvas / WebGL 或真实 Vue 组件，不由 `node --test` 收集。启动 `npm --prefix web-ui run dev` 后，在其开发服务器地址打开：

- `/test/fixtures/townSpriteColor.html`：角色肤色、昼夜、画质档位与色彩输出，页面显示 PASS / FAIL。
- `/test/fixtures/townObjectColor.html`：建筑、道具、灯具的材质与色彩输出，页面显示 PASS / FAIL。
- `/test/fixtures/whiteGaps.html`：图像编辑器的留白预览、恢复与保存失败交互，使用合成图片和模拟保存接口。
- `/test/fixtures/intimatePanel.html`：亲密看板（双主题 / 兼容 360px 窄屏 / 组件级漂移自检）。页面直接挂载真实 `IntimatePanel.vue`，用 `fetch` 打桩后端接口（离线可跑，不连本地服务），加 `?theme=dark` 可以暗夜主题打开。
- `/test/fixtures/intimatePanelLive.html`：亲密看板 live 端到端（真实组件 + 真实后端数据，需先起 agent-core 与 vite；与上面的 stub 版互补，不做 fetch 打桩）。

两者分工：`intimatePanel.html` 离线可跑，覆盖组件结构漂移与暖色 / 暗夜双主题、360px 窄屏；`intimatePanelLive.html` 依赖真实服务，验证真实数据读数与真实写路径。

浏览器样例及其 HTML / SVG 配套资源共同保留；算法单测不能替代 GPU 和画布交互检查。修改相关渲染或编辑功能后应额外运行这些样例。

写这类"读计算样式"或"驱动真实页面"的自检时注意三点：① 切换主题后立刻读 `getComputedStyle` 会拿到过渡起点而不是最终色（面板、开关、`body` 都带 0.3s 过渡），必须先冻结 `transition` 并 `cancel()` 掉已在跑的动画再断言；② `Page.navigate` 到同一个 hash URL 不等于重载（同文档导航），验证"页面是否跟随后端"必须用 `Page.reload{ignoreCache:true}`，否则会得到假阴性；③ 新库首次打开设置页会弹出「更新说明」模态遮罩、吃掉 CDP 鼠标点击的坐标，自动化点击前先发 Escape 关掉它。用 CDP 驱动时若后端端口被队友占用，另开端口 + 在 `%TEMP%` 放一份 import 真实 `vite.config.js` 并只覆盖 proxy target 的临时配置，比改仓库文件再还原更稳。

驱动环境本身还有三条坑：① 无 BOM 的 `.ps1` 会被本机 PowerShell 按 ANSI 解码，中文注释会吃掉引号导致解析失败（临时驱动脚本请写 UTF-8 BOM）；② PS7 的 `Invoke-RestMethod` 对 JSON 数组不做枚举，拉 `/json/list` 多 target 时会把整个数组当成一个 target（需 `@()` 包一层）；③ 样例 Chrome 异常退出会残留并占住调试端口，下次拿到的是旧实例的 target 列表（起之前先按命令行特征清掉自己的 Chrome）。

## 清理记录与后续准则

2026-09-22 清理了 9 个没有调用方的后端 fixture / worker / 旧验收脚本，以及引用已删除组件的旧挣钱玩法预览页。交易命令用例并入 `townInteractions.test.js`；原先分散在两处的人格测试统一放入 `agent-core/test/characterPersona.test.js`，保留原有行为覆盖。

同时移除仅逐句检查静态提示词常量的断言，保留动态提示词组装、解析及发帖流程测试；补齐服务管理筛选测试所需的地图状态，并验证同镇排序不会改写原名单。

- 保留真实行为、失败路径、数据安全和曾发生过的 bug 回归；不按文件长短或测试数量决定去留。
- 同一功能的小用例优先合并到已有测试中；不要复制生产逻辑再验证复制品。
- 删除功能或测试时同步检查其 fixture、worker、预览资源和文档入口是否仍有调用方。
- 临时验证脚本和日志用完即删；需反复使用的回归逻辑按 `AGENTS.md` 约定纳入正式测试。
