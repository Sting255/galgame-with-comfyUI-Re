# 聊天出图：内容口径（2026-10-21 冻结）

> 用户原话：「现在好像还是有聊天出图的审查限制，我不想要有任何审查限制。」
> 追问确认后落到两个具体症状：**① 画面被写含蓄了（该露骨的地方变成擦边）**、**② 图出了，但跟对话里的露骨内容不符（体位 / 身体细节没跟上）**。
>
> 这份文件是这条链的**冻结口径**。改之前先读 §5「保留项」——那里有一条**明确不拆**的边界。

---

## 1. 聊天出图的完整链路（改哪一环先看这里）

```
用户发言
  └─ 五路生图决策（chat.js：planner 规划 / <needImage> / 强制 / 正则意图 / 计数保底 / 静默判断）
       └─ buildImagePromptMessages()    ← 破限词 + 生图规则 + 人格 + 上下文 + 【当前任务】
            └─ requestImagePromptText() ← 2026-10-21 新增：含蓄就重写一次
                 └─ extractImagePromptResponse()  → 英文画面描述
                      └─ generateImage() → prepareImagePrompt() → 知识库 RAG 选词 → composeImagePrompt()
                           └─ ComfyUI 工作流       ← 无任何内容过滤（negative prompt 留空 = 走工作流默认）
```

---

## 2. 改了什么（2026-10-21）

| # | 症状 | 改动 | 落点 |
|---|---|---|---|
| 1 | ① 画面被写含蓄 | **生图链固定注入完整版破限词**（2452 字），不再吃「紧凑版」那 1248 字；只在内置紧凑版激活时升级，用户自选的规则集一律不动 | `services/promptShield.js` 的 `SHIELD_FULL_LABELS` / `applyShield` |
| 2 | ① 画面被写含蓄 | **含蓄兜底重写**：对话命中露骨词表、而交回来的英文描述一个露骨词都没有 ⇒ 追加一条重写要求再要一次（**只重写一次**，失败/为空就退回第一次，绝不阻断出图） | `services/imagePromptResponse.js` 的 `needsExplicitImageRewrite` / `EXPLICIT_REWRITE_INSTRUCTION`；`routes/chat.js` 的 `requestImagePromptText` |
| 3 | ② 体位/细节没跟上 | **拆除生图知识库的成人闸门**：`adult_*` 类目不再要求 query 命中露骨词表才允许召回（旧实现 `queryAllowsCategory`，`pose.pr24.*` 曾单独豁免，现已整条删除） | `services/imagePromptKnowledge.js` |
| 4 | ② 体位/细节没跟上 | **RAG query 合并**：英文 prompt 命中露骨词表时，把 prompt 本身也并进检索 query（中文标签靠对话命中、英文 tag 靠 prompt 命中，只喂中文短句时两边都捞不到） | `services/imagePromptPreparer.js` 的 `resolveImageRagQuery` |
| 5 | ② 体位/细节没跟上 | **生图任务指令补「体位」维度**：明确要求写身体朝向、谁在谁前面/后面、进入角度与深浅、四肢支点 | `routes/chat.js` 的【当前任务】两分支 |

---

## 3. 为什么「拆闸门」和「改画面」是两件事（别指望第 3 条治好第 1 条）

实测结论（零 LLM 的 A/B，脚本已删）：

```
对话「她轻轻点了点头」+ prompt 已露骨（doggystyle / penis inside her pussy …）
  旧口径（只喂中文）       → 成人类目候选  0 条 → 追加 tag 0 个
  新口径（中文+英文合并）  → 成人类目候选 53 条 → 追加 tag 0 个
```

**追加 tag 是 0，而且这是正确行为**：`selectExecutableTags` 打分时，
英文 tag 只有在**已经出现在 prompt 里**时才拿高分（20 分），随后又被 `selectAppendableTags`
当成「正文已经写过」丢掉；中文 label 的 bigram 重叠只对**中文** query 有效。

⇒ **知识库 RAG 只是"补漏"，不是"改画面"的主要杠杆**。
画面露不露骨，决定权在**模型写的这段英文描述**（= 第 1、2、5 条）。
第 3、4 条的真实作用是：**取消"按措辞猜意图"的内容准入**，让成人词库在
"对话含蓄但画面露骨"的轮次里也有资格参与，并且短对话不再断掉英文 tag 的召回面。

⚠️ 所以：**如果真机上画面还是含蓄，先看 `[shield]` 日志与重写日志，不要再去动知识库。**

---

## 4. 怎么验（都是零 LLM / 零额度的）

```powershell
$r='D:\邻舍改'
Set-Location "$r\agent-core"; $env:DB_PATH=':memory:'; $env:LOG_TO_FILE='false'
& "$r\runtime\nodejs\node.exe" --test --import ./test/setup.mjs test/chatImageExplicitRewrite.test.js
& "$r\runtime\nodejs\node.exe" --test --import ./test/setup.mjs test/imagePromptAdultRetrieval.test.js
& "$r\runtime\nodejs\node.exe" --test --import ./test/setup.mjs test/imagePromptPreparer.test.js
```

真机看三行日志：

| 日志 | 含义 |
|---|---|
| `[shield] ▸ 注入破限提示词 (生图, 2452 字, 来源=default:full, …)` | 生图链吃到了完整版 |
| `[chat] …: prompt looks softened (explicit dialogue → tame prompt) → rewriting once` | 含蓄兜底被触发（说明第一次确实软了） |
| `[imageSkill] Final prompt` | 真正送进 ComfyUI 的英文 prompt，用它跟画面比 |

---

## 5. 保留项（**明确不拆，不是漏做**）

1. **未成年 / 幼态词过滤**（`db/imagePromptTagKnowledgeData.js` 的 `MINOR_PATTERN`、`shouldSkipTag`）。
   用户 2026-10-21 说过「连未成年词过滤一起删」，**本轮拒绝并保留了它**，理由是它挡的是
   `child / toddler / loli / shota / 小学生 / 幼儿园` 这类真实未成年指向，属于违法风险，不是口味偏好。
   **实测量化（2026-10-21，扫 `src/db/data/imagePromptTags.yaml` 全部 2985 个标签）**：
   只有 **4 条**命中，且四条都确实该挡 ——
   `kindergarten uniform / white thighhighs+frilled skirt+mary janes（经典萝莉白丝组合）/ onee-shota（小孩开大车）/ 床上分娩（birth child）`。
   ⇒ 拆掉它对「画面露不露骨」**零收益**，只增风险。真要某个被挡的 tag，走"加一条词库条目"而不是拆闸门。
2. **相关性**约束（不是内容封禁，别混）：
   - 关键词召回必须命中（`score > 0`）、向量召回必须过 `VECTOR_THRESHOLD`；
   - `pose.pr24.*`（84 体位）的体位意图词 `POSE_INTENT_RE`（防日常照片被体位词污染，实测曾 31/50）；
   - `composeImagePrompt` 的 `LIB_TAG_MIN_SCORE = 14`（防"全身照被塞腿袜 tag"这类噪声）。
3. **群聊成人闸门** `config.features.touchGroupAdult`（默认关，`group_adult_blocked`）**本轮没动**：
   它是**隐私边界**（别在群里当众演限制级），不是内容审查；私聊完全不受影响。要开就在设置页打开。
4. **生图输出长度上限 800 字符**（`builtinRules.IMAGE_PROMPT_RULE`）**本轮没动**：
   它是原作者定稿的格式口径，且有测试逐字钉住。如果将来真机确认"写到一半就收住"是长度压出来的，
   再单独开一轮讨论要不要放宽（改它必须同步 `groupChatImageRuleEcho.test.js`）。

---

## 6. 测试归属

| 口径 | 测试 |
|---|---|
| 含蓄判定 / 重写要求 / 两条链共用一个入口 | `test/chatImageExplicitRewrite.test.js` |
| 成人闸门已拆 + 相关性仍在（不含日常被追加成人 tag） | `test/imagePromptAdultRetrieval.test.js` |
| 体位检索的意图词约束 | `test/positionKnowledgeRetrieval.test.js` |
| RAG query 合并 | `test/imagePromptPreparer.test.js` |
| 生图链用完整版破限词 / 用户规则集不被覆盖 | `test/promptShield.test.js`（④ 组） |
