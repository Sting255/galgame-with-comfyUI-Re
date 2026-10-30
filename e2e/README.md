# e2e/ —— 浏览器端到端验收（Playwright）

用户要求「自己装浏览器套件、跑真实流程、测完再交付」，这里就是那套东西。

## 一次性准备

```powershell
$r = 'D:\邻舍改'   # ⚠️ 2026-10-17 项目已从旧盘符迁到这里
# 依赖（playwright 1.60.0；浏览器用 %LOCALAPPDATA%\ms-playwright 里已缓存的 chromium-1223，不额外下载）
Set-Location $r\e2e
& "$r\runtime\nodejs\node.exe" "$r\runtime\nodejs\node_modules\npm\bin\npm-cli.js" install
```

## 跑

```powershell
$r = 'D:\邻舍改'   # ⚠️ 2026-10-17 项目已从旧盘符迁到这里
# ① 改了 web-ui/src 就先重建产物（由后端从 agent-core/public 静态托管）
Set-Location $r\web-ui; & "$r\runtime\nodejs\node.exe" build.mjs
# ② 跑
Set-Location $r\e2e; & "$r\runtime\nodejs\node.exe" run-e2e.mjs
```

跑完看 `%TEMP%\e2e-shots\report.md`（人读）与 `report.json`（机读），截图也在同目录。

## 它做了什么（脚本自己负责）

1. **真实库只读**：把 `agent-core/data/agent.db` 拷成 `%TEMP%\e2e.db`，后端用 `DB_PATH` 指副本 + 空闲端口起来；**从不写真实库**。
2. **fixture**（可关）：默认把副本库里 char 1 的好感压到 30，用来复现清单里「亲密/敏感灰且带 🔒」那条；`E2E_NO_FIXTURE=1` 可关掉（这是**改副本**，不是改真实库）。
3. **真调一次模型**：用副本库里用户自己的 LLM 配置（`agent-core/.env` 的 `LLM_BASE_URL` / `LLM_API_KEY`）发一句话等她回；失败会在报告里写清楚**哪几步是真、哪几步是假**，并用本地 OpenAI 兼容桩（`E2E_NO_FAKE_FALLBACK=1` 可禁止回落）再跑一遍同一条路径。
4. 断言逐条记录 `PASS / FAIL / BLOCKED / INFO`：动作条（分级、亮/灰、置灰 toast）、设置页 HiresFix 的 turbo 开关 → `GET /api/config`、工作流模式弹窗三档、暖色/暗夜双主题截图、控制台 error、网络 4xx/5xx。
5. 截图与报告一律写 `%TEMP%\e2e-shots\`，**不进仓库**。

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `E2E_PORT` | 3399 | 后端端口。⚠️ 本机 **3399–3411 落在 Windows 排除端口段**（`listen EACCES`）⇒ 脚本会先探 bind，不能绑就自动换 3210~3259 并打印实际端口 |
| `E2E_DB` | `%TEMP%\e2e.db` | 副本库路径 |
| `E2E_FRESH_DB` | — | =1 强制重新拷副本 |
| `E2E_NO_FIXTURE` | — | =1 不改副本好感度 |
| `E2E_SHOTS` | `%TEMP%\e2e-shots` | 截图/报告目录 |
| `E2E_HEADLESS` | 1 | =0 开有头浏览器 |
| `E2E_BUILD` | — | =1 跑之前先 `web-ui/build.mjs` |
| `E2E_REAL_LLM` | 1 | =0 跳过真实模型，直接走假 LLM |
| `E2E_NO_FAKE_FALLBACK` | — | =1 真实失败后不切假 LLM |
| `E2E_LLM_TIMEOUT_MS` | 90000 | 等真模型回复的上限 |

## 边界

- 这个脚本**不是** `npm test` 的一部分（它要起真后端、可能调真模型，不适合进单测）。
- `e2e/node_modules/` 已被 .gitignore 覆盖，不会进版本库。
- 只跑"能机器验的部分"：模型演得好不好、体感如何，仍然要人来点（L6）。

---

# 补：2026-10-02 新增的四个小脚本（各自独立、都很快）

上面那份 `run-e2e.mjs` 是"大而全"的验收流程；下面这四个是**针对具体入口的定点检查**，
每个只跑 1~3 分钟，改完前端就能立刻验一遍。**它们同样要 playwright**（在源仓 `e2e/` 下跑，
交付包 `C:\3.6.2-r\e2e\` 里没带 `node_modules/playwright` ⇒ 在包里跑不起来，这是有意的）。

## 先起后端（用**副本库**，绝不碰真库）
```powershell
$src='D:\邻舍改'
$pkg='C:\3.6.2-r'
$snap="$env:TEMP\e2e.db"
& "$src\runtime\nodejs\node.exe" --input-type=module -e "import {createRequire} from 'node:module'; const r=createRequire('file:///C:/3.6.2-r/agent-core/package.json'); const D=r('better-sqlite3'); const s=new D('C:/3.6.2-r/agent-core/data/agent.db',{readonly:true,fileMustExist:true}); s.prepare('VACUUM INTO ?').run(process.argv[1]); s.close()" $snap
$env:DB_PATH=$snap; $env:PORT='3199'; $env:NODE_ENV='production'; $env:LOG_TO_FILE='false'
Start-Process -FilePath "$src\runtime\nodejs\node.exe" -ArgumentList 'app.js' -WorkingDirectory "$pkg\agent-core" -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\e2e.log" -RedirectStandardError "$env:TEMP\e2ee.log"
# 等 /api/config 能访问，再跑脚本
```
⚠️ **要停服务就单独一条命令只做停进程** —— 别和重活混在同一次调用里（本仓为此让作业运行器崩过 5 次）。

| 脚本 | 验什么 | 期望 |
|---|---|---|
| `check-panels.mjs` | **私聊**三个入口：❤ 推进面板 / 🧸 玩具面板 / 设置页程序时间 | **11 项全 PASS**（含"无页面 JS 报错"与"无控制台 error"两项，后者专抓 Vue 把 setup 异常 catch 掉改用 `console.error` 打印的情况） |
| `check-group-panels.mjs` | **群聊** 🧸/❤ 入口：未选目标不打开 + 人话提示 + **不回落 members[0]** / 选中后作用在**那个人** / 群里「戴上」真的接上 / 关掉后原有 UI 还在 | **18 PASS / 0 FAIL / 1 SKIP**（SKIP 见下） |
| `check-assets.mjs` | 静态资源：**404 里不许出现 `.js/.css/.woff2`**（图片 404 允许）+ 字体分块逐个可服务 + `index.html` 引用一致 | 产物类零失败 |
| `check-event-images.mjs` | 库里的 `/images/**` 引用与磁盘文件对账（只读副本库）⇒ 量化死链 | 只输出统计，不判 PASS/FAIL |
| `probe-intimate.mjs` | **诊断探针**：不做 PASS/FAIL，只把页面报错原文与"点击点最上层元素"打出来 | 排查"点了没反应"用 |
| `check-merge-v310.mjs` | **v3.10.0 合并收尾的入口回归**（2026-10-19 新增，当晚扩到 A~H 八组）：酒馆搜索/计数/空态、立绘管理卡片、SillyTavern 预设、世界观→世界书、日报「重新生成今日日报/配图」、私聊 galgame 进场与层叠顺序、**设置页（最大输出 tokens / 接入方式 / Vertex 切换 / 额度清空禁保存 / 工作流弹窗）**、**场景立绘上传（详情弹窗胶囊 → 上传本场景 → 图换成 `_upload`）** | **52 项全 PASS**（H10 视 `workflow/` 是否有非内置工作流记 INFO）。**自己起后端**（`VACUUM INTO` 副本库 + 端口 3212 + `IMAGES_DIR` 隔离），不需要预先有服务；**不点会花钱的按钮**（重生成日报/配图只断言存在与显隐）。跑法：`node e2e/check-merge-v310.mjs`。⚠️ 设置页有多个数字输入/保存按钮，**必须限定在 `.card` 内**找；H 组开头若检测到「跳过 DeepSeek，使用其他接口」会先点掉。B 组视口用 1600×1000（≥1532 才是桌面浮窗布局）；会给副本库**每个角色塞一套 work 场景立绘**（只写副本 + `%TEMP%` 图片目录），否则空库没有场景胶囊、上传入口无从出现 |
| `full-tour.mjs` | **全站逐页巡游**（2026-10-19 新增）：13 条路由（私聊/朋友圈/奇遇/媒体/日程/相册/酒馆/信箱/背包/设置×4）+ 日报/世界观/SillyTavern 预设/立绘管理弹窗 + 设置页五张卡，收集 console error / pageerror | **22 PASS / 0 FAIL / 2 INFO**（入口随数据变化时记 INFO）。与 `run-e2e.mjs` 分工：它只保证「每页都进得去、不报错」，深功能链路仍归 run-e2e。跑法：`node e2e/full-tour.mjs`；真机时先 `$env:COMFYUI_URL='http://127.0.0.1:8199'`（本机 8188 被系统服务占用） |

## 两个"允许"与一个"故意不判"
1. **图片 404 允许**：用户库里有 **606 条死图引用**（`/images/**`，清一色 `ComfyUI_temp_*`，文件真的没了）。
   前端已做坏图兜底（`web-ui/src/imageFallback.js`：缺图不再显示碎图，默认隐藏），
   但**浏览器仍会为 404 记一条 console error** ⇒ 脚本按**资源类型**区分：
   `image` 允许并**如实计数**；其它类型（`script`/`stylesheet`/`font`/`xhr`/`fetch`，以及类型拿不到的）**一条就红**。
2. **「换目标 ⇒ 面板自动关掉」只能人工点**：面板一开，它自己的 modal 遮罩压在底部图标排上，脚本点不到「换人」
   （`elementFromPoint` 探到最上层是 `modal-overlay`）。本仓没有组件挂载能力（无 `@vue/test-utils`/jsdom）
   ⇒ 人工路径：进群 → 选中某人 → 开 🧸 → 关掉 → 点 ✋ 里的「换人」→ 看两个面板是否自动收起。

## 环境变量
`PANEL_CHECK_BASE` / `GROUP_PANEL_CHECK_BASE`：覆盖被测地址（默认 `http://127.0.0.1:3199`）。

## 这些检查自己也被验过（红测）
"守卫必须真的会红"是本仓的硬纪律（假绿栽过两次）。做法：复制一份包 → 把副本里的产物改坏 →
指向副本端口跑 → 确认变红。实测结论：
- 只改**最大的 3 个 `.woff2`** ⇒ **不会红** ✗ —— 因为字体是 `unicode-range` 分块的，
  浏览器只为"页面实际渲染到的字"去拉那几块，改掉的块压根没被请求 ⇒ **这是红测做法无效，不是守卫没问题**；
- 改**全部 298 个 `.woff2`** ⇒ **真的红了** ✓ `⑨ 产物类失败=51（font 404 …）`，
  且"允许的图片 404×1"**单独计数、没被混进去** ⇒ 严格性与例外同时成立；
- 字体改回来后 ⇒ 回到 18 PASS / 0 FAIL / 1 SKIP ⇒ 红绿由**被测对象**决定，不是脚本自己在抖。
