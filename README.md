# 邻舍.EXE

[English](./README_EN.md) · [下载](https://github.com/Sting255/galgame-with-comfyUI-Re/releases) · [更新记录](https://github.com/Sting255/galgame-with-comfyUI-Re/releases)

一款受 Galgame 启发的 AI 角色陪伴应用。你创建的角色有独立人格、情绪、记忆和自己的日程，会主动找你说话、发朋友圈、写信、在群聊里和朋友拌嘴，也能根据对话和当前场景调 ComfyUI 画图。

普通 AI 聊天机器人在「回答问题」，邻舍想让角色表现得更像一个**还在继续生活的人**。

> 这是上游 [邻舍.EXE](https://github.com/icecranberry/galgame-with-comfyUI) 的个人增强 fork，当前版本 **v4.2.2**，已完整跟进上游 v4.2.1。下面先列本版相对上游多了什么，再是功能与安装说明。

## 下载与安装

1. 到 [Releases](https://github.com/Sting255/galgame-with-comfyUI-Re/releases) 下载最新的整合包，解压（7z 格式，用 7-Zip 或 Bandizip 打开）
2. 双击 `邻舍.EXE.exe`，在启动器里点「启动邻舍」，浏览器会自动打开
3. 在网页「设置」里填 LLM 的接口地址、密钥和模型（任何 OpenAI 兼容接口都行）
4. 想要生图，把 ComfyUI 起起来（默认地址 `http://localhost:8188`），或在设置里改用 NovelAI
5. 去「酒馆」创建或导入角色，开始

整合包自带运行时、依赖和前端产物，不需要装 Node 或 Python。

## 主要功能

| | |
| --- | --- |
| **角色陪伴** | 私聊、群聊、人物关系网、情绪与好感度；回复会结合近期对话、滚动摘要和长期记忆 |
| **日常生活** | 主动聊天、日程、朋友圈、信箱、礼物与背包——你不在的时候她们也在过日子 |
| **奇遇** | 接受邀请，通过选项推进角色故事 |
| **场景生图** | 根据对话和角色外观出图，支持 ComfyUI 与 NovelAI，配套相册、立绘与放大细化 |
| **声音** | 私聊、群聊、立绘触摸台词可朗读；支持 API 接入或本地 IndexTTS 2.0 |
| **个性化** | 自定义人格、世界观、模型配置；暖纸 / 暗夜两套主题 |
| **多端** | 电脑浏览器，或 Android 网页壳连同一台电脑 |

聊天记录、角色和图片都保存在你自己的电脑上；只有调用云端模型或在线生图服务时，相应内容才会发给你配置的服务商。

## 这一版比上游多了什么

**服装系统重做**

每个角色可以自己加服装类型（工作服、泳装、婚纱、礼服……），各角色互不共用。每套都能点「自动生成本套」，让模型结合她的职业、人设与世界观写这一套；类型名说了算——写「泳装」就画泳装，不会因为她是潜水教练就画成潜水装备。日程里她自己判断该穿哪套，也能手动「现在穿这套」钉住。每套单独出立绘，页签内直接看画出来的样子。

**角色级负面提示词**

给单个角色配一组排除词（如 `goggles, sunglasses`），只在她单人出场的图里生效，用来把「画串成另一个角色」的特征推开。不配置的角色行为与原来完全一致。

**运行状态面板**

设置页顶部显示最近 60 分钟的失败（按模块计数 + 最后一条原文）、生图队列水位、LLM 与 ComfyUI 的连通性。后台出问题不用再翻日志。

**其他**

- 亲密看板加了「全部角色知晓身体档案」总开关，不用逐个角色开
- 地图页（世界地理骨架）、84 个体位数据接入对话与生图、体型与外观系统重做
- 程序时间：可快进/回拨游戏世界的「现在」，日程、睡眠判定和提示词随之更新
- 针对本地 LLM 网关的几处实测缺陷做了兜底（丢 system、思考吃光额度、忽略 JSON 格式）

上游原有的「世界 / 小镇」页在本 fork 已移除。

## 界面预览

| 传媒与社交 | Galgame 沉浸聊天 |
| --- | --- |
| ![传媒](https://github.com/user-attachments/assets/788b4841-2237-4a33-9bdd-e07ef924a011) | ![聊天](https://github.com/user-attachments/assets/f5e7183c-f385-4e8b-b415-f6738b05b6e5) |

| 私聊 | 群聊 |
| --- | --- |
| ![私聊](https://github.com/user-attachments/assets/73bb4cae-c191-41a0-a0fb-26c4ec2087fa) | ![群聊](https://github.com/user-attachments/assets/c2c92fcb-d6f1-4be6-9e96-12d18157b58f) |

| 朋友圈 | 日程 |
| --- | --- |
| ![朋友圈](https://github.com/user-attachments/assets/3d191b4e-2353-4440-ab36-990759ced1ea) | ![日程](https://github.com/user-attachments/assets/71c08460-5473-4d8f-a069-7fdf76532e85) |

| 角色酒馆 | 角色详情 |
| --- | --- |
| ![酒馆](https://github.com/user-attachments/assets/1711b6ee-b7df-4130-a192-d61ca783eb08) | ![详情](https://github.com/user-attachments/assets/4cd732fa-1e98-4627-af87-5f7fc3b8cddc) |

| 相册 | 奇遇 |
| --- | --- |
| ![相册](https://github.com/user-attachments/assets/6b746150-7974-43fa-b2f5-677406f23bcd) | ![奇遇](https://github.com/user-attachments/assets/c2b80641-54c7-4c08-8d1a-661f14d8da9e) |

<img src="https://github.com/user-attachments/assets/c8d86580-94a5-4822-96bf-4dc9e459f201" alt="手机端" width="260" />

## 配置与数据

- **配置都在网页「设置」里**：LLM、生图服务、功能开关即时生效，不用重启
- **数据存本地**：角色、聊天、图片在安装目录的 `agent-core/data/`，向量索引在 `vector-service/chroma_data/`
- **备份**：设置里有一键导出/导入。导出时记得勾上「包含模型配置」，否则换电脑后要重新填 API Key
- **换电脑**：导出备份 → 新电脑装同版本 → 导入 → 重启

## 常见问题

**ComfyUI 连不上 / 图出不来**
确认 ComfyUI 在自己运行（浏览器能打开 `http://localhost:8188`）。如果 ComfyUI 是用 `python main.py` 直接起的，去启动器「设置 → ComfyUI 启动器路径」里填 `main.py` 的路径或 ComfyUI 目录。体位骨架需要重启一次 ComfyUI 才会加载。

**模型回复很慢或者干脆不回**
先看「设置 → 运行状态」，那里会直接告诉你是 LLM 连不上、还是生图队列在排队。输出额度别填太大，超过模型常用上限会被服务商拒绝。

**角色画出来像另一个人**
给那个角色配一组负面提示词，把容易混淆的特征写进去（例如 `goggles, sunglasses`）。真正根治是给它配角色 LoRA。

**升级后要不要重新导入数据**
不用。换包后把旧目录的 `agent-core/data/` 和 `agent-core/.env` 拷过去就行，或者用备份导出导入。

## License

MIT
