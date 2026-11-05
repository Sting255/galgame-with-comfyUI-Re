# 上下文统计与压缩接口

2026-11-05 按用户要求移除聊天上下文余量条及展开卡片，包括前端轮询、手动压缩入口、专用格式化工具和对应 UI 测试。App 不再挂载上下文面板，私聊与群聊不再为此请求 /api/context/usage。后端统计、上下文预算、自动摘要和记忆整理继续保留；模型设置不因移除展示而改变。

## 代码入口

- 路由：agent-core/src/routes/context.js。
- 用量快照、窗口回退与分项标定：agent-core/src/services/contextUsage.js。
- 私聊组装：routes/chat.js；群聊组装：services/groupChatEngine.js。
- 回归：agent-core/test/contextUsage.test.js、contextBudget.test.js；前端移除挂载由 web-ui/test/chatTools.browser.test.js 验证。

## 数据口径

窗口按用户声明 declared → 上游探测 provider → 默认 default 回退。真实 prompt_tokens 通过请求作用域关联会话；没有真实 usage 时按字符估算，不能当成实际计费量。

source 为 last-request（本进程真实请求）、estimate（估算）、snapshot（持久化历史快照）、none（无快照）。内存上限 500 条；持久化只留最近 200 个会话，同会话写入合并，失败不阻断聊天。重启读取的数据保留更新时间，不冒充新的请求结果。

breakdown 中 tokens 为字符估算；tokensCalibrated 为按真实总量比例分摊，breakdownCalibrated 标明是否可用。这不等于上游逐块计量。stablePrefixHash、fullPrefixHash、requestHash 可辅助排查提示词变化；未记录时为空，不能由缺失值推断缓存命中。

## 保留接口

| 接口 | 行为 |
| --- | --- |
| GET /api/context/usage?conversationId=char_2 | 返回窗口、来源、用量、余量、分项、更新时间和指纹；会话无快照时返回 none |
| POST /api/context/compress，正文包含 conversationId | 复用滚动摘要与记忆整理；同会话并发返回 409；无可处理内容或记忆关闭时不宣称已压缩 |

窗口处于默认值时接口可短超时探测上游并缓存结果，失败保持默认值。压缩超过 HTTP 等待预算（默认 8 秒）转后台，summaryCreated 为 null，表示尚无结果；false 表示未生成摘要。当前聊天界面没有手动调用这些接口的入口。

本文件只描述保留的服务能力；本轮验证结果与待办统一见 [项目现状](../项目现状.md)。
