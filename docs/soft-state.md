# 软状态落库（softStateStore）

> **这份文件管什么**：那些"挂在进程里、重启就丢"的小状态，如何统一落库。
> 制定日期：2026-10-15。落点：`agent-core/src/services/softStateStore.js`。
> 相关背景：`git show HEAD:目标/接手必读.md` §6.3-11「软状态还在进程内（`lastHighTime` / `imageJudgeCounters` / `guessCooldowns` 等，重启即丢）」。

---

## 一、为什么要它

这些状态都**很小、很短期**，但丢掉会有具体表现：

| 状态 | 归属 | 丢掉的后果 |
| --- | --- | --- |
| `lastHighTime` | `services/imageSkill.js` | 归零 ⇒ 低优生图队列的静默期判定被绕过（后台图会在用户正在玩的时候抢资源） |
| `imageJudgeCounters` | `routes/chat.js` | 变空 ⇒ 下一次读取回落到"满额"默认值（判定配额被重置） |
| `guessCooldowns` | `routes/chat.js` | 变空 ⇒ 候选词冷却失效（重启后立刻又能生成一次） |

**不给每个状态开一张表**：计数几小时归零、冷却 20 秒、静默期 3 分钟 —— 按行写库反而是负担。
一个 `system_settings` 里的 JSON 键足够，且完全复用既有读写口径。

---

## 二、契约

```js
import { createSoftState } from './softStateStore.js'

const state = createSoftState('image_skill_last_high')   // 自动加 soft_state_ 前缀
state.set('lastHighTime', Date.now())   // 写内存 + 安排落库（去抖 1s）
state.get('lastHighTime')               // 读（第一次会懒加载读库）
state.delete('someKey')
state.clear()                           // 清空并**立刻**落库
state.flush()                           // 手动落库（收尾 / 测试用）
```

| 特性 | 行为 |
| --- | --- |
| 键名前缀 | 自动加 `soft_state_`，避免与其它设置撞名（已带则不重复加） |
| 懒加载 | 第一次 `get`/`set`/`size` 才读库 —— 模块 import 期不碰 DB（避开迁移顺序问题） |
| 落库时机 | `set`/`delete` 后**去抖**（默认 1000ms 合并一次）；`clear` 立刻落库 |
| 去抖期被杀 | 最多丢 1 秒内的增量（软状态，可接受） |
| 读失败 | 一律回空 Map（软状态丢了不该拖垮主流程），只 warn 一次 |
| 读坏数据 | 数组 / 非对象 / 坏 JSON 一律当空（防脏数据把 Map 变成垃圾箱） |
| 大小上限 | 序列化后 > 64KB ⇒ **只留内存不落库**（防某个键把 `system_settings` 撑爆） |
| 定时器 | `unref()`，不拖住进程退出 |

---

## 三、当前接入情况

| 状态 | 状态 | 说明 |
| --- | --- | --- |
| `imageSkill.lastHighTime` | ✅ 已落库（2026-10-15） | 读走 `readLastHighTime()`、写走 `markLastHighTime()`，语义与纯内存版一致 |
| `chat.imageJudgeCounters` | ✅ 已落库（2026-10-15） | 原地换成 `createSoftState('chat_image_judge_counters')`；**既有读写点一行没改** |
| `chat.guessCooldowns` | ✅ 已落库（2026-10-15） | 同上，`createSoftState('chat_guess_cooldowns')` |

**`chat.js` 那两处是怎么接的（后来者照这个来）**：`createSoftState` 的 `get` / `set` / `delete` 与 `Map`
**完全兼容**，所以只需把 `new Map()` 换成 `createSoftState('键名')` —— 下面所有
`xxx.get(conversationId)` / `xxx.set(...)` / `xxx.delete(...)` 一行都不用动。
前置检查（**改之前先跑这三条，否则会踩坑**）：

1. `grep` 一下这两个名字有没有用到 `.size` / `.forEach` / `instanceof Map` —— 软状态**只有** `get/set/delete/clear/flush/load/size()/key`（`size` 是**方法**不是属性）；
2. 确认键是有界的（这里都是 `char_<id>` 形式）；无界键靠 `maxEntries`（默认 500，插入顺序淘汰）兜底，但那说明调用方该修；
3. 有这个文件对应的源码守卫测试就顺带跑一遍（如 `imageQuotaAndRolloverUi.test.js` 会扫 `chat.js` 源码）。

守卫测试：`agent-core/test/chatSoftState.test.js`（8 条）—— 钉住"两处确实是 createSoftState"、
"只用了 Map 兼容 API"、"`?? imageJudgeQuota()` 的回落语义保留"。

---

## 四、测试

`agent-core/test/softStateStore.test.js`（12 条）钉住：前缀、懒加载、读坏回空、
去抖只落一次、跨"重载"仍在、`clear` 立刻落库、超限不落库、只碰自己前缀的键。

跑法：`node --test --import ./test/setup.mjs test/softStateStore.test.js`
