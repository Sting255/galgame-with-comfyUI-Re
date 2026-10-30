# 亲密推进的独立每日额度（intimate-action-quota）

> **这份文件管什么**：性爱动作「立刻反馈」那条**模型调用**的每日上限（成本刹车）。
> 制定日期：2026-10-15。落点：`agent-core/src/services/intimateActionQuota.js` + `routes/intimateActions.js` + `routes/config.js`。
> 配套：`docs/intimate-actions.md`（状态机本体）、`docs/intimate-dashboard.md`（看板）、`docs/testing.md`（测试定位）。

---

## 一、为什么单独开一本账

性爱动作的「立刻反馈」要求**每一下都过一次模型**（`routes/intimateActions.js` ⑤，一次 500 token 的小调用）。
连点推进 / 开自动插送时，这里是唯一会真的花钱的地方。之前只有两个刹车，**都不合适**：

| 现有刹车 | 为什么不能用 |
| --- | --- |
| `features.touchInstant = false` | 那是**触摸系统**的总开关，管不到性爱动作；而且一关就全哑（状态推进也没了） |
| `touch_instant_daily_limit`（100/天） | 那是触摸自己的账；混用会让两个玩法互相吃额度（点几下触摸就没法推进了） |

所以按**同一口径**再开一本账：**默认 200 次/天，0 = 不限制**。

---

## 二、数据模型（复用 `system_settings`，不新建表）

| 键 | 值 | 说明 |
| --- | --- | --- |
| `intimate_action_daily_limit` | 整数 | 每日上限；`0` = 不限制。默认 **200**（没配过时） |
| `intimate_action_quota` | JSON `{ date, used }` | 今日已用次数；**按本地日期**（`localDateKey`）翻篇，跨天自动归零 |

与 `services/intimateAiJudge.js`（AI 判断行为配额）**逐字同口径**：同一个 `system_settings` 裸 SQL 读写习惯、
同样按本地日期、同样「读不到/读坏了回落默认值 + 内存兜底 + 只 warn 一次」。

---

## 三、行为契约（关键：用完**不哑玩法**）

```
POST /api/intimate-actions/:id/:action
  ├─ ① 状态机（纯函数）算下一状态 / 拒绝理由
  ├─ ② 状态落库   ← 这一下**真的发生了**（额度不够也不回滚）
  ├─ ③ 看板记账
  ├─ ③.5 静默推进（silent / 只改速度）→ 早退，**不调模型、不扣额度**
  ├─ ④ 省额度模式（instant 关）→ 早退，**不调模型、不扣额度**
  ├─ ④.5 配额检查 ⇒ 耗尽：状态照常推进 + `mode:'implicit'` + `quotaExhausted:true`
  │        反应留到下一轮聊天补演（与「省额度模式」同一个出口，前端不需要新分支）
  └─ ⑤ 即时反应：**扣额度 → 调模型**（顺序不能反）
```

三条硬约束：

1. **扣额度必须在真正发模型请求之前**（`quotaAfter = consumeIntimateActionQuota()` 在 `chatSync` 之前）。
2. **耗尽早退必须在扣额度之前** —— 否则会白扣一次。
3. **耗尽不报 4xx**：状态已经推进了，报错会让玩法"看起来坏了"。走 `200 + mode:'implicit'`。

---

## 四、接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 顶层多一个 `intimateActionQuota = { dailyLimit, usedToday, remaining, unlimited }` |
| PUT | `/api/config/intimate-action-quota` | body `{ dailyLimit }`；`0` 合法（不限制），负数/小数/字符串/缺失 → **400** |
| GET | `/api/intimate-actions/:id/state` | 回带同一形状的 `quota`（面板据此显示"今天还能点几下"） |
| POST | `/api/intimate-actions/:id/:action` | 回带 `quota`；耗尽时额外带 `quotaExhausted: true` 与 `notice`（人话） |

`remaining` 在 `unlimited=true` 时是 **null**（不编一个大数字）。

---

## 五、前端

- 角色详情页「亲密看板」有 **「亲密推进的每日额度」** 区块：上限输入框 + 旁注（`0 = 不限制；当前已用 N 次，今日还剩 M 次`）。
- 读不到配额时只显示 `0 = 不限制`，**不假装**「已用 0 次」（`known: false` 语义，与 aiJudge 同一写法）。
- 保存失败**回滚输入框**并 toast（与出图档位 / 反应风格同口径）。
- 纯逻辑在 `web-ui/src/components/character/intimateLogic.js`：
  `normalizeIntimateActionQuota` / `intimateActionQuotaNote` / `intimateActionQuotaBanner`。

---

## 六、边界与已知取舍

1. **额度只影响"要不要调模型"**，不影响玩法状态 —— 这一点是刻意设计（用户口径："不哑玩法"，比"严格限制"重要）。
2. **不占触摸的额度**，也不被触摸的额度影响：两本账互不相干。
3. **手动 / 发情来源不受影响**：本配额管的是"这一下要不要调模型"，与 `SEX_DAILY_CAP`（敏感度每日增长上限）**不是同一件事**。
   敏感度那条见 `docs/intimate-actions.md` §7。
4. **跨天口径是本地日期**（不是 UTC）：否则东八区要到早上 8 点才归零。与 aiJudge / 触摸配额一致。
5. **进程内兜底**：库读写成问题时计数暂存内存（重启会丢那一段），只 warn 一次、不刷屏。
