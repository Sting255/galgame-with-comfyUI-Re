# 拒答守卫（2026-10-22）

> 触发问题：`backend-2026-10-20.log` 里纳西妲一轮中，模型回了「你好，我无法给到相关内容。」，
> 这条拒答被当正常台词写进 `raw_messages` + `messages`，之后每个请求都把历史原样带上，
> 同一句在 7 个请求的 messages 里反复出现 —— **拒答进了长期上下文，没有任何自动纠偏**。

## 一、判据：什么才算拒答

`agent-core/src/services/refusalDetector.js` 的 `isRefusal(text)`，三个条件同时成立才算：

1. 长度 ≤ 200 字符；
2. 段落数 ≤ 3（拒答不会写成长文）；
3. 命中一条明确话术：`我无法/不能 + 给到/提供/生成/协助…`、`作为 AI…`、
   `无法提供相关内容`、`超出我的能力范围`、`违反政策`、`I can't/cannot/am unable to…`、
   `As an AI/language model`、`violates my policy`。

**刻意做窄**：角色在剧情里说「我做不到……你别逼我了」是台词，不是拒答；带动作、多段、长文本一律放过。
宁可漏判，也不能把正常回复当拒答重写。

实测校验：把 `backend-2026-10-20.log` 里 **215 条真实模型输出**（含 27 条主聊天流正文）
逐条过检测器，命中 0 条 —— 零误判；而那条真拒答样本命中。

## 二、三层拦截

| 层 | 位置 | 行为 |
|---|---|---|
| ① 统一收口 | `llm-client.js` 的 `chatSync` | 拿到结果先问一次；命中就追加 `REFUSAL_RETRY_INSTRUCTION` **重发一次**（只一次）。重发失败或仍拒答 → 按原样返回，不掩盖首次结果 |
| ② 主聊天流 | `routes/chat.js`（reroll 之后、落库之前） | 命中就清空重写一次；仍拒答 → 换成 `……` 兜底；**绝不让拒答进库**。前端用 `replace_last_assistant`（`reason: 'refusal'`）替换已上屏的拒答 |
| ③ 特定转正点 | 见下表 | 拒答在解析层就被判为「无效输出」，不让它变成正文 |

`chatSync` 可传 `refusalRetry: false` 关闭①（逐字校对之类的任务用），默认开启。

## 三、③ 的具体落点

| 位置 | 变化 |
|---|---|
| `imagePromptResponse.extractImagePromptResponse` | 拒答返回 `null`（含 JSON 里 prompt 字段被写成拒答的情况）→ 走「空 → 重试一次 → `generate_error`」，不再把英文拒答送进 CLIP |
| `momentResponseParser.parseMomentResponse` | 拒答返回空 text → 上层兜底「今天天气真好～」 |
| `mailboxScheduler.parseReplyJSON` | 拒答返回 `null` → 上层抛「returned empty」并重试，不写进信件 |
| `momentInteractionService` 三处评论生成 | 拒答返回空串，调用方判空跳过本条（不写空评论、不发拒答） |
| `eventScheduler` 半程紧急联络 | 命中即 `continue`，本轮不发，等下一个检查周期 |
| `proactiveChatScheduler` 主动聊天开场白 | 命中即走 `pickFallbackGreeting` |

## 四、没有覆盖的地方（已知边界）

1. **流式响应已经推给前端**：主聊天流的拒答会先出现在气泡里，重写成功后由 `replace_last_assistant` 换掉。
   前端若不支持该事件，最坏表现是「先看到拒答、随后被替换」或刷新后以落库版本为准。
2. **重发成本**：命中拒答才多一次调用（含生图等待预算链路），低频，不改变正常路径。
3. **判据可能漏判**：模型换一套委婉说法（如「这个我就不展开了」）检测不到 —— 这类只能靠破限词，
   不在本机制的职责内。
4. **历史脏数据**：本次只堵住新增，库里已经存在的拒答消息**没有清理**。要清需单独评估
   （涉及 `raw_messages` / `messages` 一致性，属于数据修复，不在本轮范围）。

## 五、测试

`agent-core/test/refusalDetector.test.js`（14 条）：

- 实测样本、各种中英文拒答话术必须命中；
- 正常角色台词、带动作的多段回复、长文本不得误判；
- 生图 prompt 提取、朋友圈正文解析在拒答时必须返回空；
- 边界输入（空、null、对象、围栏包裹）。

`test/llmOutputTokens.test.js` 的 data: URL stub 表已补 `refusalDetector` 桩
（否则该文件会在加载期 `ERR_UNSUPPORTED_RESOLVE_REQUEST`）。
