# 项目文档导航

不需要从头读完所有文档。先按你要做的事进入。

| 你要做什么 | 从这里开始 |
| --- | --- |
| 看项目现在能用什么、还欠什么 | [项目现状](项目现状.md) |
| 找代码、启动项目、运行检查 | [项目结构与开发入口](operations/project-structure.md) |
| 修改代码 | [编程模式](编程模式-DeepSeek.md) → [全仓契约](../AGENTS.md) |
| 改页面或交互 | [设计系统](design-system.md) |
| 跑测试、浏览器验收 | [测试说明](testing.md) |
| 配置本机联调环境 | [本机验收环境](验收环境-凭据与路径.md)（含凭据，不外发） |
| 备份、恢复或连接手机 | [数据备份](operations/data-backup.md)、[设备访问](operations/device-access.md) |

## 聊天、提示词与记忆

| 文档 | 内容 |
| --- | --- |
| [神说](chat/god-says.md) | 神说的工具调用、会话与界面口径 |
| [记忆系统](chat/memory-upgrade-progress.md) | Memory v3 的召回、整理与存储实现状态 |
| [群聊与私聊记忆](chat/group-private-memory.md) | 两种会话如何交换记忆，注入预算与边界 |
| [上下文统计](chat/context-usage-panel.md) | 后端 token 用量与压缩接口；聊天余量条已移除 |
| [反重复](chat/anti-repetition.md) | 检测、提示词与采样参数如何减少重复 |
| [世界书](chat/lorebook-adaptation.md) / [预设](chat/preset-adaptation.md) | SillyTavern 导入、触发与提示词插槽 |
| [规则集](chat/jailbreak-rules.md) / [拒答守卫](chat/refusal-guard.md) | 规则投递顺序、输出识别与重试 |

## 角色与互动

| 文档 | 内容 |
| --- | --- |
| [奇遇](characters/adventures.md) | 故事推进、自由行动、排队与撤销、结算保护 |
| [触摸动作](characters/touch-system.md) | 动作、门控、即时反应及配图链路 |
| [立绘互动](characters/standing-interaction-plan.md) | 立绘窗口、区域、触摸台词 |
| [催眠与睡眠](characters/hypnosis-phone.md) | 手机面板、睡眠锁、唤醒与遗忘 |
| [亲密推进](characters/intimate-actions.md) | 连续动作、状态机、体位与节奏 |
| [亲密看板](characters/intimate-dashboard.md) / [每日额度](characters/intimate-action-quota.md) | 统计、判定、编辑与成本限制 |
| [玩具](characters/toys.md) | 穿戴、持久状态与对话接线 |
| [衣服库](characters/clothing-library.md) | 服饰数据与生效外观 |

## 生图与运行维护

| 文档 | 内容 |
| --- | --- |
| [聊天出图](images/chat-image-no-filter.md) | 配图触发、描述器与工作流入口 |
| [细化](images/hiresfix.md) / [NovelAI](images/novelai-integration.md) | 细化参数、提供商配置与排错 |
| [软状态](operations/soft-state.md) | 运行时快照如何持久化 |
| [规则集手工验收](operations/jailbreak-manual-qa.md) | 页面操作检查表 |
| [本地语音](../tts-service/README.md) | TTS 运行时、模型安装及离线包 |
| [浏览器 E2E](../e2e/README.md) | 隔离环境与真实点击验收 |

## 历史资料

[网关 system 丢失调查](archive/网关system丢失-20261022.md)只用于解释历史兼容代码，不作为当前环境配置。

维护规则：当前状态只写进「项目现状」；功能行为写进对应专题；测试命令只在「测试说明」维护。一次性调查不再新增报告。专题中的旧验收记录是历史证据，当前行为以源码和本轮测试为准。
