# HiresFix 细化（精度档 + 工作流版本）

> 2026-11-04 合并自原 `hires-quality.md` 与 `hires-workflow.md`。两项设置互相独立：先选工作流版本，再选细化步数。

## 一、细化精度（设置项 `hiresQuality`）

HiresFix 是「成图之后再放大细化一遍」那一步。它每一步都由 **anima_turboV10** 蒸馏模型重画，**步数越多越慢、细节越干净**。

| 档位 | 值 | 细化步数 | 说明 |
| --- | --- | --- | --- |
| 高 | `high` | 12 | 细节最干净，最慢 |
| 中 | `medium` | 10 | 与「高」肉眼几乎无差别 |
| 低 | `low` | **8（默认）** | 最快；细结构轻微并线/发软 |

turbo 模型必须 CFG 1.0，所以 CFG 不开放；关掉 `hiresTurbo` 才回到旧的 `hiresSteps` / `hiresCfg` 口径。

### D1 实测（同角色卡 · 同 prompt · 同 seed，只改步数）

RTX 3060 12G / ComfyUI 0.37 / 源图 768×512 → 细化 2000×1328 / denoise 0.35：

| 步数 | 耗时 | 相对 12 步 |
| --- | --- | --- |
| 12 | 38.51s | — |
| 10 | 33.60s | −13% |
| 8 | 24.31s | **−37%** |

100% 逐区对比：12 ↔ 10 肉眼几乎无差别；8 步是拐点——右侧领口细白饰带缝隙被填掉、发丝末端与耳坠链边缘发软。用户据此裁决默认 8 步。

### 配置口径

| 项 | 值 |
| --- | --- |
| 设置键 | `features.hiresQuality` |
| 取值 | `high` / `medium` / `low`（默认 `low`），其它值回落 `low` |
| env | `FEATURE_HIRES_QUALITY` |
| 落库键 | `feature_hiresQuality`（`db/settings.js`，type string） |
| 接口 | `GET /api/config` → `features.hiresQuality`；`PUT /api/config/features` body `{ key: 'hiresQuality', value: 'high' }` |

**优先级**：`config.comfyui.hiresTurboSteps` 是底层逃生门——被显式改成非默认（12）时完全以它为准；保持默认时由 `hiresQuality` 决定（`imageRefine.resolveTurboSteps()`）。

实现落点：`agent-core/src/config.js`、`services/imageRefine.js`、`db/settings.js`。

## 二、基础版与进阶版工作流

设置 → HiresFix 细化设置 →「使用进阶 HiresFix 工作流」。默认关闭（基础版），选择存数据库、重启保留。

| 模式 | 文件 | 依赖 |
| --- | --- | --- |
| 基础版（默认） | `workflow/放大细化工作流.json` | 官方节点流程，沿用已有生图模型 |
| 进阶版 | `workflow/放大细化工作流-进阶.json` | RealESRGAN 超分模型 + Ultimate SD Upscale 节点包 |

基础版原样保留旧图谱：Lanczos → VAEEncode → KSampler → VAEDecode，使用细化步数/CFG，不继承采样、不融合原图。两套都沿用全局/角色/细化 LoRA 配置，切换不会清空进阶设置。

### 进阶版安装

1. 下载 `RealESRGAN_x4plus_anime_6B.pth`，放入 ComfyUI 已配置的 `upscale_models` 目录（不能放 `loras`）。
2. ComfyUI Manager 安装 Ultimate SD Upscale，重启 ComfyUI。
3. 开启进阶版，确认模型文件名并保存。开关不会自动下载或安装。

### 进阶链路与参数

`LoadImage → UpscaleModelLoader / ImageUpscaleWithModel → Lanczos 缩至目标长边 → UltimateSDUpscaleNoUpscale（1024 分块） → 可选原图融合 → PreviewImage`

- 放大模型可换成任意本机兼容超分模型；留空时明确走 Lanczos，运行图谱移除超分节点。模型缺失时 ComfyUI 报错，不悄悄降级。
- Anime6B 是动漫超分模型，不是画风 LoRA；可能抹去纸纹与笔触，不保证所有风格适合。
- 模型原生 4 倍与最终尺寸分开：1600×1200 原图、长边 3200 才是 2 倍。
- 原图融合默认 **0**（混入原图可能削弱锐度、产生重影）；新安装重绘默认 0.2。
- 分块 1024×1024、padding 128、mask blur 24、Chess 顺序；减少整图重绘的碎线，但仍可能有接缝或内容漂移。

### 采样与 LoRA

跟随原图模式继承源工作流唯一 KSampler 的步数、CFG、采样器、调度器，不继承 denoise=1；源模板缺失、参数不全或多 KSampler 时回退显式细化参数。自定义模式使用细化步数/CFG 与模板采样器。

LoRA 合并顺序：全局（按场景过滤，乘显式倍率，默认 1）→ 角色 → 细化专用；同路径后者覆盖前者。零权重项移除并停止注入对应触发词，不修改提示词正文。

### 分发与回退

内置基础与进阶模板用于新安装/缺失文件恢复，不覆盖客户自行编辑的现存文件；`workflow/` 被 git 忽略，发版需同步两份 JSON。旧版备份 `workflow/放大细化工作流-v1备份.json` 可替换回主文件。`agent-core/src/services/workflowTemplates.js` 是内置恢复模板位置。

## 三、测试

- `agent-core/test/hiresQuality.test.js`：默认 low、三档映射、非法值回落、`hiresTurboSteps` 覆盖优先、接口线路与落库。
- `agent-core/test/hiresTurboMode.test.js`：turbo 开关的旧口径回归。
- `agent-core/test/hiresWorkflow.test.js`：两套模板的分发、恢复与节点差异。
