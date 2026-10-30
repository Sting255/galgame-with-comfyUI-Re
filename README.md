# 邻舍.EXE

[English](./README_EN.md) · [下载](https://github.com/Sting255/galgame-with-comfyUI-Re/releases) · [夸克网盘](https://pan.quark.cn/s/f1f723d0d983?pwd=1ssP)（提取码 `1ssP`）

邻舍.EXE 是一款受 Galgame 启发的 AI 角色陪伴应用。用户可以创建具有独立人格、情绪、记忆和生活节奏的角色，与她们聊天，并在朋友圈、信箱、日程、群聊和随机事件中持续互动。角色还能够根据对话和当前场景主动调用 ComfyUI 生成图片，让文字交流自然延伸成视觉体验。

它想解决的问题很简单：普通 AI 聊天机器人往往只是在“回答问题”，而邻舍.EXE 希望让角色表现得更像一个持续生活着的人。

> [!NOTE]
> **本仓库是 [邻舍.EXE](https://github.com/icecranberry/galgame-with-comfyUI) 的个人增强 fork**：上游基线 v3.10.0，当前版本 **v3.10.2**。
> 除上游功能外，本 fork 重做了外观与体型系统、新增「地图」页（世界地理骨架）、把 84 个体位数据融进对话与生图链路、全站修了一轮文字对比度，并针对本地 LLM 网关的几处缺陷加了兜底；上游原有的「世界 / 小镇」页已在本 fork 移除。
> 下面先列本 fork 的改动，再是上游原有功能介绍（内容与上游保持同步，仅下载与克隆地址指向本仓库）。

## 🧩 本 Fork 新增功能

以下为本 fork 新增的功能（截至 v3.10.2），上游原有功能见后文各章节：

### 📱 催眠手机与睡眠控制

- 聊天页内置「催眠手机」：深度催眠（意志压制、按指定优先级反应）、只唤醒意志（意识清醒但身体受限）、遗忘与遗忘记录；群聊里可单选一人进入完整面板，或多人同时下达指令、逐个回执。
- 睡眠控制：随时让角色入睡或唤醒，实时显示睡眠状态与预计醒来时间；睡着时发消息会照常收下、排队等她醒来（可能先收到一句梦话）。
- 睡梦唤醒：她睡着时触发特殊指令，会先进入 5 分钟临时唤醒窗口，呈现「从深睡里被硬拉起来」的专属反应。

### ⏰ 程序时间

在设置中拨动游戏世界的「现在」：「+N 天」快进（1~3650 天，所有角色一起过完）、切白天/黑夜、直接设定具体日期时刻、一键回到真实时间。所有角色的日程与睡眠判定、白天/黑夜时段、提示词时间标签、日程页与小镇显示全部联动。

### ✋ 触摸动作系统

- 四档共 25 个动作（日常/亲密/敏感/私密）的浮动小窗：可拖动、支持角标提醒（还有 N 个动作等她回应）、连点不会误关。
- 她有自己的耐受度与偏好：同一动作短时间连点会越来越不耐烦，动作卡片上直接标出「喜欢/讨厌」；好感不够时她会用一句剧情化的对话拒绝你，而不是报错。
- 「即时反应」开启时点一下她立刻单独回一条；关闭则进入省额度模式，反应并入下一轮回复。
- 群聊支持围观插话（可调概率）与敏感档开关；动作可按「总是/智能/从不」策略自动配图；角色详情页有完整统计面板（次数、等级分布、偏好与耐受度、配图数）。
- 立绘触摸互动：在角色立绘小窗上直接触摸互动，带涟漪动效与专属台词，台词可在立绘管理中自定义。

### 💞 亲密推进与亲密看板

- **可连续推进的互动**，不是一次性单发：进入她 → 继续抽插 → 加速 / 慢下来（缓、正常、快、冲刺四档节奏）→ 换姿势 → 一起到，也可以让她「自己动」（被束着时只能照做）。每一下都按当下状态实时回应，节奏和她的反应会随推进变化。
- **独立每日配额**：这套动作用单独的成本刹车，不会把聊天额度吃光；配额按本地日期翻篇，重启不重置。
- **体位随时切换**：内置 84 条体位数据（逐条标注了插入判定与冲突位，避免点不动或描述打架），换姿势时从当前可选体位里挑，体位会同时影响身体细节描述与配图。
- **亲密看板**：角色详情里持续记录亲密行为与等级，支持「AI 判断行为」自动判定每轮互动、手动补判最近轮次、每日判定上限、AI 润色与自动记录，形成可演进的档案。

### 🧸 玩具系统

每件玩具需要「钥匙」解锁，穿戴后按强度持续影响角色状态，反应写进聊天记录，与动作系统共用同一套好感度/耐受度数据；私聊与群聊各自独立。

### 🎨 表情包与立绘

- 表情立绘可按「全部重新生成 / 只补齐缺失」两种模式批量出图，也能单独重生成某一槽；任务可断点续做，重启后失败的槽会标出来重试。
- 每张立绘可单独配一套「空手触摸」台词，在立绘小窗上直接点她就有反应（带涟漪动效）。
- 立绘与当前世界观绑定：换过世界观后，旧图会被标成「不吻合当前世界观」，提醒你重出而不是混着用。

### 💾 数据备份

设置页一键导出全部数据为 `tar.gz` 归档（可选是否包含含 API Key 的模型配置——含密钥的备份注意不要外发），一键导入恢复；导入前自动生成回滚备份。

### 📊 上下文余量面板

左上角胶囊实时显示当前会话 token 用量与剩余（环形进度 + 百分比），点开可看分项明细与窗口来源；快满时可手动触发「压缩上下文」（滚动摘要 + 记忆整理）。添加/编辑模型时可声明上下文窗口，留空则由程序向上游探测。

### 💬 群聊与对话质量增强

- **群聊 ↔ 私聊记忆互通**：双向同步（每人/每节/合计均有硬性字数预算，避免撑爆上下文）。
- **反重复与话题推进**：反车轱辘话、反钻牛角尖、连续复述时自动升级约束，可选 presence/frequency penalty，全部在提示词层实现、不额外调用模型。
- 群聊相册、群聊图片流水线、脚本协议与插话等群聊体验增强。
- 朋友圈记忆回想：角色发动态时会想起与该话题相关的共同经历。

### 🗺️ 地图页（世界地理骨架）

与游戏化小镇刻意分开的「叙事地理」：一句话描述你的世界，AI 先出大地区 → 子地区大纲，点开某个子地区再逐层展开场景与生活地点（POI）。层级不设上限、任意层可增删改、支持复制已有地图当模板、导出 Markdown 贴回知识库。骨架是纯文本、秒级生成，不消耗生图额度；地点带准入/分区/开放时间等结构化属性，供日程生成时按「谁能去哪」过滤。

### 🧬 外观与体型

- 五态场景服装（常服/私服/居家/睡衣/裸体），**身体描述是五套共用的单一真源**，换衣服不改身体特征；居家强制室内拖鞋、睡衣强制赤脚，写库与读取两处都过一遍，存量脏数据零迁移即刻修好。
- 体型按「人工填的身高 > AI 预填 > 卡面文本推断」三态取值；多人同屏时自动生成身高对照块，避免把全场角色画成同一高度。
- 84 个体位数据（含逐条标注的插入判定与冲突位）融进亲密动作与生图提示词，与本地精选的 17 条并存。

### 🛡️ 网关兜底

针对本地 OpenAI 兼容网关的实测缺陷做的防御：网关丢弃 system 消息、思考型模型把 `max_tokens` 吃光导致正文为空、`response_format` 被忽略而返回 Markdown —— 分别用「格式纠正重试（回灌上一版、只要求改写成 JSON）」「思考饥饿时放大额度重发」「拒答话术追加纠正指令重发」兜住；用量异常时打告警而不是静默采信。

### 🧪 工程化

新增 `e2e/` 浏览器端到端验收（Playwright，覆盖全部主要模块的真实流程），`docs/` 下沉淀 20+ 篇专题设计文档（小镇经济、触摸系统、催眠手机、数据备份、记忆升级等）。

## 项目演示视频

**[🤯这一定是一个不同以往的浪漫AI小镇♪~【超自定义的素材生成】【邻舍3.5】](https://www.bilibili.com/video/BV1tKab6CEp2/)**

完整链接：[https://www.bilibili.com/video/BV1tKab6CEp2/](https://www.bilibili.com/video/BV1tKab6CEp2/)

## 项目截图

### 传媒与社交平台

浏览报纸、数字报刊与社交平台，在不同频道发现角色动态和街巷新闻。

![传媒与社交平台](https://github.com/user-attachments/assets/788b4841-2237-4a33-9bdd-e07ef924a011)

### Galgame 沉浸聊天

以场景背景、角色立绘和逐字对话呈现聊天，支持历史回顾、表情变化与直接输入回复。

![Galgame 沉浸聊天](https://github.com/user-attachments/assets/f5e7183c-f385-4e8b-b415-f6738b05b6e5)

### 小镇互动

在地图上与居民相遇，通过人物对话了解近况、接受奇遇邀请，或进行打工与交易。

![小镇居民互动](https://github.com/user-attachments/assets/5cd70530-a961-4770-84c7-bcc9d9aa7a09)

### 更多界面

| 私聊 | 群聊 |
| --- | --- |
| ![私聊界面](https://github.com/user-attachments/assets/73bb4cae-c191-41a0-a0fb-26c4ec2087fa) | ![群聊界面](https://github.com/user-attachments/assets/c2c92fcb-d6f1-4be6-9e96-12d18157b58f) |

| 朋友圈 | 日程 |
| --- | --- |
| ![朋友圈界面](https://github.com/user-attachments/assets/3d191b4e-2353-4440-ab36-990759ced1ea) | ![日程界面](https://github.com/user-attachments/assets/71c08460-5473-4d8f-a069-7fdf76532e85) |

| 角色酒馆 | 角色详情 |
| --- | --- |
| ![角色酒馆界面](https://github.com/user-attachments/assets/1711b6ee-b7df-4130-a192-d61ca783eb08) | ![角色详情界面](https://github.com/user-attachments/assets/4cd732fa-1e98-4627-af87-5f7fc3b8cddc) |

| 相册 | 奇遇 |
| --- | --- |
| ![相册界面](https://github.com/user-attachments/assets/6b746150-7974-43fa-b2f5-677406f23bcd) | ![奇遇界面](https://github.com/user-attachments/assets/c2b80641-54c7-4c08-8d1a-661f14d8da9e) |

**手机端**

<img src="https://github.com/user-attachments/assets/c8d86580-94a5-4822-96bf-4dc9e459f201" alt="手机端界面" width="260" />

## 主要功能

- **角色陪伴**：私聊、群聊、人物关系、情绪与好感度，结合近期对话、滚动摘要和长期记忆生成回复。
- **日常互动**：主动聊天、日程、朋友圈、信件、礼物与背包，让角色在对话之外也有自己的生活。
- **小镇与奇遇**：探索小镇、与 NPC 对话、接受邀请，在奇遇页通过选项推进故事与建筑服务；支持金币、赠礼和交易。
- **场景生图**：根据对话与角色外观生成配图，支持 ComfyUI 与 NovelAI，配套相册、立绘和放大细化功能。
- **个性化与多端**：自定义人格、世界观和模型配置；暖色 / 暗夜主题，可按时间切换；支持浏览器与 Android 网页壳。

聊天、角色和图片保存在本地；使用云端模型或在线生图、嵌入、重排服务时，相应内容会发送给所配置的服务商。

## 快速开始

### Windows 整合包

1. 下载整合包，二选一：
   - [GitHub Releases](https://github.com/Sting255/galgame-with-comfyUI-Re/releases) — `EXE-vX.Y.Z.zip`
   - [夸克网盘](https://pan.quark.cn/s/f1f723d0d983?pwd=1ssP)（提取码 `1ssP`）— 国内下载更快，内容与 Releases 一致
   解压后运行 `邻舍.EXE.exe`。
2. 在启动器首页点击「启动邻舍」，浏览器会自动打开。
3. 在网页「设置」中配置 LLM 的 API 地址、密钥和模型，支持 OpenAI 兼容接口。
4. 按需配置生图服务：ComfyUI 需另行准备工作流所需模型与节点（默认地址 `http://localhost:8188`）；使用 NovelAI 时配置对应接口与密钥。
5. 在「酒馆」创建或导入角色，开始聊天。

整合包包含便携运行时、依赖和前端产物。Android 端连接电脑上的服务，需保持电脑运行并处于同一局域网；APK 以对应版本的发布附件为准，详见 [Android 说明](./android-shell/README.md)。

### 源码运行

以下为 **Windows PowerShell** 步骤。环境建议与打包脚本对齐：**Node.js 22.18+（22.x）**、**Python 3.12（含 venv）**、**Git**。

```powershell
git clone https://github.com/Sting255/galgame-with-comfyUI-Re.git
cd galgame-with-comfyUI-Re

npm --prefix agent-core install
npm --prefix web-ui install

python -m venv vector-service/venv
./vector-service/venv/Scripts/python.exe -m pip install -r vector-service/requirements.txt
./vector-service/venv/Scripts/python.exe vector-service/download_model.py

npm run dev
```

访问 [localhost:5173](http://localhost:5173)，按上面的步骤完成配置。开发脚本启动前端 `5173`、后端 `3099` 和向量服务 `8765`，ComfyUI 需单独启动。首次下载向量模型需要网络；缺失时开发脚本也会尝试下载。

macOS / Linux 使用 `python3 -m venv vector-service/venv` 创建环境，激活 `source vector-service/venv/bin/activate` 后，以 `python` 执行安装依赖、下载模型，再运行 `npm run dev`。桌面 EXE 与整合包构建面向 Windows。

## 配置与数据

- **配置入口**：网页「设置」管理 LLM、生图服务和功能开关，按配置项保存到数据库或 `agent-core/.env`；环境变量可参考 [`.env.example`](./agent-core/.env.example)。
- **工作流**：内置 ComfyUI 模板在后端启动时自动补齐到 `workflow/`，模型与自定义节点仍需在 ComfyUI 中安装。
- **备份**：停止服务后备份 `agent-core/data/`、`agent-core/.env` 和 `vector-service/chroma_data/`；如修改了工作流或自定义数据路径，一并备份对应目录。

## 开发

| 命令（项目根目录） | 用途 |
| --- | --- |
| `npm run dev` / `npm run stop` | 启动 / 停止开发服务 |
| `npm run restart-core` | 单独重启后端 |
| `npm --prefix web-ui run build` | 构建前端到 `agent-core/public/` |
| `npm --prefix web-ui test` | 前端测试 |
| `npm --prefix web-ui run lint` | 前端静态检查 |
| `npm run build` | 构建前端与 Windows 启动器 |
| `npm run apk` | 构建 Android 网页壳 |
| `npm run release` | 打包 Windows 整合包到 `release/` |

后端测试使用内存数据库，避免影响本地数据（PowerShell）：

```powershell
$env:DB_PATH = ':memory:'
npm --prefix agent-core test
Remove-Item Env:DB_PATH
```

| 目录 | 职责 |
| --- | --- |
| `web-ui/` | Vue 3 + Pinia + Vite 前端，Three.js 小镇渲染 |
| `agent-core/` | Node.js + Express 后端，SQLite / FTS5、LLM 调用与任务调度 |
| `vector-service/` | FastAPI + ChromaDB + ONNX 语义记忆检索 |
| `launcher/` / `android-shell/` | PySide6 启动器 / Android WebView 客户端 |
| `scripts/` | 开发、构建与发布脚本 |

开发前阅读 [协作约定](./AGENTS.md)；UI 修改遵循 [设计系统](./docs/design-system.md)。其他说明：[测试](./docs/testing.md) · [小镇互动](./docs/town-interactions.md) · [小镇经济](./docs/town-economy.md) · [放大细化](./docs/hires-workflow.md)。

## License

MIT
