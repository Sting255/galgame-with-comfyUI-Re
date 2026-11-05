# 项目结构与开发入口

邻舍是五个协作程序组成的仓库。不要把运行时、用户数据和源码当成同一类文件整理。

| 位置 | 职责 | 修改入口 |
| --- | --- | --- |
| `agent-core/app.js` | HTTP 应用组装、路由挂载、启动与退出 | 路由顺序与启动接线 |
| `agent-core/src/server/` | 设备访问、HTTP 生命周期、后台服务注册 | 新调度器在 `backgroundServices.js` 成对登记启停 |
| `agent-core/src/routes/` | HTTP 参数、响应与协议 | 业务算法放 services，路由保持薄 |
| `agent-core/src/services/` | 聊天、角色、记忆、生图与玩法 | 已有 `memory/`、`godSays/` 等按功能分组；备份辅助模块在 `backup/` |
| `agent-core/src/db/` | schema、仓储、设置与维护锁 | 通过 `getDb()` 访问；恢复期间禁止绕过维护锁 |
| `agent-core/src/utils/envFile.js` | 配置文件路径、无损序列化与原子替换 | 配置写入统一走 `persistEnvValues`；运行状态在写入成功后更新 |
| `web-ui/src/main.js` | 路由与前端启动 | 页面按路由懒加载 |
| `web-ui/src/views/` | 页面组装 | 页面专用子组件逐步下沉到 components 的功能目录 |
| `web-ui/src/components/settings/` | 设置页分区 | 设备连接、数据备份、模型配置列表已独立；配置切换逻辑在 composables/useLlmProfiles.js |
| `web-ui/src/components/ui/` | Linshe 基础控件 | 所有表单与弹窗的统一入口 |
| `web-ui/src/components/chat/ChatActionToolbar.vue` | 私聊／群聊输入区底部互动入口 | 显隐互斥在 composables/useChatActionPanels.js；业务操作继续由页面与原有面板负责 |
| `web-ui/src/components/chat/ChatSleepStatus.vue` | 私聊／群聊页头普通睡眠状态 | 刷新生命周期在 composables/useChatSchedule.js；日程请求顺序与 SSE 在 stores/schedule.js；状态文案在 utils/scheduleSleep.js |
| `web-ui/src/components/LetterFailure.vue`、`composables/useMailboxActions.js` | 两个信箱入口的失败状态、删除与重投 | 列表请求顺序与写入后的过期快照防护在 stores/mailbox.js；服务端状态检查在 agent-core/src/routes/mailbox.js |
| `web-ui/src/api/`、`stores/`、`utils/` | 网络、页面状态与纯逻辑 | 网络请求放 api；可独立计算的逻辑放 utils |
| `launcher/` | Python 桌面启动器 | 服务管理、托盘、日志 |
| `launcher/build_launcher.py` | 启动器统一构建与窗口验收 | 隔离 DLL 搜索路径，临时构建；生成 EXE 通过真实窗口自检后才替换输出 |
| `tts-service/` | 本地语音进程与模型安装 | [语音说明](../../tts-service/README.md) |
| `vector-service/` | 向量检索进程 | 记忆派生索引，可重建 |
| `android-shell/` | Android WebView 壳 | 手机容器，业务页面仍来自 web-ui |
| `scripts/` | 开发、构建、发布与检查命令 | 从根 `package.json` 找统一命令 |
| `agent-core/test/`、`web-ui/test/`、`e2e/` | 回归与浏览器检查 | [测试说明](../testing.md) |
| `docs/` | 文档导航与功能口径 | [文档首页](../README.md) |

## 常用命令（仓库根目录）

```powershell
runtime/nodejs/node.exe scripts/dev.mjs
runtime/nodejs/node.exe scripts/test-all.mjs
runtime/nodejs/node.exe scripts/project-health.mjs
```

单独构建前端请在 `web-ui` 工作目录运行 `../runtime/nodejs/node.exe build.mjs`。不要用 PATH 上 ABI 不匹配的 Node 跑数据库测试。

启动器三个构建入口（`launcher/build.bat`、`scripts/build.mjs`、`scripts/build-release.mjs`）统一调用 `launcher/build_launcher.py`，使用 `launcher/build_cache/pyinstaller-venv`。构建时 PATH 只含该 Python 和 Windows 系统目录，避免其它工具的同名 ICU／CRT 混入。窗口自检在空白临时目录运行，不启动业务服务或读取玩家库；命令和验收范围见 [测试说明](../testing.md#启动器产物验收)。

配置默认仍使用 `agent-core/.env`。后端与 Node 启动辅助工具支持 `LINSHE_ENV_PATH` 指定独立配置路径；测试隔离入口会强制分配每进程独占的临时文件，不读取或回写真实配置。该变量只隔离配置文件，磁盘库仍需单独设置 `DB_PATH`。备份使用同一路径；桌面启动器仍沿用默认路径。

## 本地内容与生成物

- `agent-core/data/`：玩家数据库、图片、音频、配对凭证与备份。不是代码，禁止拿来跑测试或按“无引用文件”批量删除。
- `runtime/`、各级 `node_modules/`、`tts-service/runtime/`：运行时与依赖。不是需要重构的业务代码。
- `agent-core/public/assets/`：前端构建产物；改源码后重建，不能手工维护 hash 文件。
- `完整/`、`release/`、EXE、APK：分发产物，沿用打包路径，不挪动用户现有包。
- `.pai/`、`.mimosa/`、`.learnings/`：本地工具记录，不是产品功能目录。

## 程序优化方案

按用户要求，优化对象是程序，不是旧玩家数据。默认验证从空白库或合成版本夹具开始；旧数据留在原位置，排除出质量检查。`npm run check` 只遍历文档和前后端源码，不扫描 data、runtime、node_modules 或旧分发包。

| 优先级 | 工作范围 | 验收标准 |
| --- | --- | --- |
| P0 | 新安装与隔离：初始化、默认配置、外部服务不可用 | 无旧存档也能建库；缺少模型/生图服务给出明确状态；测试不读取玩家数据库或真实配置 |
| P2 | 设置页后续拆分：按明确缺陷或新增需求推进 | 模型设置本轮已收尾，按用户要求不再单独扩改；优先完成聊天组件和现有玩法的可靠性 |
| P1 | 聊天链拆分：上下文准备、流式响应、结果保存 | HTTP/SSE 契约保持兼容；断连、取消、重试与持久化不重复或丢失消息 |
| P1 | 现有玩法可靠性：奇遇、日程、信箱、朋友圈 | 每项异步操作有处理中/成功/失败终态；失败可恢复；跨页状态一致；禁止重复扣费或重复写入 |
| P2 | 数据库入口：schema、迁移、种子分别管理 | 新库初始化与合成旧版本升级均通过；迁移失败可重试；不使用玩家库作夹具 |
| P2 | API 按领域拆分，保留原兼容导出 | 调用方逐步迁移，错误语义一致，避免一次移动所有模块 |
| P2 | 遗留模块与依赖环 | 先证明生产入口不可达再移除；共享能力迁入明确的领域目录 |
| 持续 | 文档、lint 与构建规模 | 一个导航、一个现状、每个功能一份主要说明；新改模块不增加警告；按路由测量加载体积 |

实施按上表逐条完成：先复现具体问题，再拆分或修复，然后做定向回归和必要的全量、构建、浏览器验收。文件行数用于定位职责过载，不作为机械拆文件的目标。新增玩法规则前先确认产品意图；完善现有玩法的反馈、恢复和状态一致性可直接推进。

当前完成情况只维护在 [项目现状](../项目现状.md)，不在这里重复测试数字或旧数据问题。
