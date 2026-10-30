/**
 * 测试全局准备（用法：`node --test --import ./test/setup.mjs …`）
 *
 * 为什么需要（2026-10-02，两轮全量被测出来的坑）：
 *   `townCharacterAssetsForce` / `toyPlayModes` / `toyRoutes` 三个文件在**文件级 90s 超时**，
 *   日志里是 `Connection error` 打到旧网关 `127.0.0.1`。它们**自己装了 fetch 桩**，
 *   但请求是在**模块 import 阶段**发出去的（comfyClient 轮询、玩具反应）——桩还没装上就出去了。
 *   网关一换 IP，这些请求就一路重试到超时；换回可达地址又"自己好了"，属于**假绿**。
 *
 * 这里在任何测试模块之前把网络**默认关掉**：
 *   · 非本机地址的 fetch 一律 reject（本机 127.0.0.1 / localhost 放行 —— 路由测试要起本地服务）；
 *   · DB 用内存库、不写文件日志（与各测试文件里的设置一致，重复设置无副作用）；
 *   · LLM 地址默认指向本机死端口（见下）。
 *
 * 149 个测试文件自己装了桩 ⇒ 它们会覆盖这里，行为不变；要联网的用例自己 `globalThis.fetch = …` 即可。
 *
 * ── 2026-10-14 补：fetch 桩拦不住 LLM（SDK 不走 globalThis.fetch）──────────────
 * 症状：`townCharacterAssetsForce` / `toyPlayModes` / `toyRoutes` 仍然文件级超时，
 *   `ensureCharacterTownAssets({force:true})` 实测耗时 **193s**（连续 3 次 LLM 调用 ×
 *   每次 3 次重试，全打在 `.env` 里那个「路由可达但没人监听」的网关 `127.0.0.1:7863`，
 *   每次都卡在 TCP 连接超时）。断言本身是对的，纯粹被 90s 超时掐掉 → **假绿**。
 * 成因：`src/llm/llm-client.js` 走 `new OpenAI(...).chat.completions.create()`，
 *   用的是 SDK 自带的 undici/node:http 栈，**不经过 `globalThis.fetch`**，
 *   所以上面那个 fetch 桩对它完全无效。
 * 修法：这里把 `LLM_BASE_URL` 预设成 `127.0.0.1:9`（discard 端口，无人监听 →
 *   **33ms 即 ECONNREFUSED**，而不是几十秒的超时）。`dotenv.config()` 默认
 *   `override:false`，所以预设值优先于 `.env`，SDK 立刻失败、用例秒过。
 *   需要真实网关的用例，自己在 import config 之后设 `config.llm.baseURL`（仓库既有 15 个
 *   小镇测试都是这个写法：`config.llm.baseURL = 'http://127.0.0.1:9/v1'`）。
 */
process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'
// LLM 走 OpenAI SDK，绕过下面的 fetch 桩 → 必须在 import config 之前预设死端口，
// 否则会用 .env 的真实网关地址一路重试到超时（实测单文件 193s，全量下就是 3 个 cancelled）。
process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://127.0.0.1:9/v1'

// ── 小镇默认值：生产 false / 测试 true（2026-10-19 补）──────────────────────
// 背景：`config.features.town` 的默认值从「默认开」改成了「默认关」
//   （`!== 'false'` → `=== 'true'`，见 目标/20261019-小镇剥离方案v2.md）。
// 影响：仓库里有 **83 个 `town*.test.js`** 以及若干直接读小镇数据的用例，
//   它们在测试环境里需要小镇是**开**的，否则会大面积变红（假红，不是真问题）。
//
// 口径：**生产默认关，测试默认开**。两者解耦。
//   · 测试关心的是"这些代码还能不能正确工作"，不是"生产该不该默认开"
//   · 要测"关了之后会怎样"的用例（如 townGating.test.js），**自己设 false** 即可
//   · 与上面 `DB_PATH` / `LLM_BASE_URL` 同一套思路：测试环境显式钉住前提，不依赖 .env
if (process.env.FEATURE_TOWN === undefined) process.env.FEATURE_TOWN = 'true'

// ── 落盘目录隔离（2026-10-18 补：测试写进真实用户素材目录）──────────────────
// 症状（实测复现）：跑 `test/townWizardAssetClaim.test.js` + `...Route.test.js` 会让
//   `agent-core/data/town/assets/` **净增 2 个** `asset_N_<key>_<uuid>.png`，
//   文件名里带的正是测试夹具的 `shared_dwelling` / `inn`。
// 成因：`townAssetService.TOWN_ASSETS_DIR` 当时没有环境变量出口（现已补），
//   于是用例走到 createAsset 的落盘路径就直接写真实目录 —— 与 DB 用 `:memory:` 相比，
//   这块**一直没隔离**，只靠收工纪律手工清孤儿兜底（治标不治本，且污染用户素材库）。
// 修法：在这里统一指到系统临时目录（与 `DB_PATH=':memory:'` 同一套思路）。
//
// ⚠️ 必须用**同一个**固定子目录、且**不**在退出时删：
//   多个测试文件会在各自进程里 import 本模块，用随机名会制造一堆残留；
//   而删的时机很难做对（有测试在 after() 之后还会落盘）。放在 %TEMP% 下由系统兜底清理。
// 单文件跑（不带 --import 本文件）时自行设 `TOWN_ASSETS_DIR=<临时目录>`。
if (!process.env.TOWN_ASSETS_DIR) {
  const os = await import('node:os')
  const path = await import('node:path')
  process.env.TOWN_ASSETS_DIR = path.join(os.tmpdir(), 'linshe-test-town-assets')
}

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i
const realFetch = globalThis.fetch?.bind(globalThis)

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ? String(input.url) : String(input))
  if (LOCAL.test(url)) {
    if (!realFetch) throw new Error(`测试里没有可用的 fetch，本地请求也无法发出：${url}`)
    return realFetch(input, init)
  }
  throw new Error(
    `测试禁止联网：${url}\n` +
    '  这是**故意**的 —— 测试必须离线可跑。要用真实网络请在该用例里自己覆盖 globalThis.fetch。'
  )
}
