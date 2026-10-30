/**
 * 守卫：**输出额度（max_tokens）的优先级**（2026-10-19 补，为上游 v3.10.0 合并做准备）
 *
 * ## 背景：上游 v3.10.0 删掉了一个能力
 *
 * 三代对比（实测）：
 *   v3.9.1 : `_chatSyncInner(..., max_tokens = 2048, ...)`      ← 调用方传的值被采用
 *   本地   : `_chatSyncInner(..., max_tokens = 2048, ...)`      ← 同 v3.9.1
 *   v3.10.0: `_chatSyncInner(..., 无 max_tokens ...)`           ← 参数被删，一律走 applyOutputTokenLimit
 *
 * 上游新增的 `applyOutputTokenLimit` 会**无差别删除**三个限额字段，
 * 然后填一个**全局值**（`config.llm.maxTokens` 或按模型猜的默认值）。
 *
 * 本地有 **116 处**逐调用点精调的额度（最小 5、最大 8000）。
 * 若原样收上游 ⇒ 全部失效，其中 18 处「靠小额度强制简短输出」的地方会放大几十～几千倍。
 * 例：`routes/chat.js` 的「判断需要图片」传 `max_tokens: 5`（只要 yes/no），
 *     会变成 32768 —— 模型可能输出一大段解释，而解析代码是按 yes/no 设计的。
 *
 * ## 本文件钉什么
 *
 * 本地口径是**显式优先**（方案 B）：
 *   **显式传入 > 全局设置（LLM_MAX_TOKENS）> 能力感知默认值**
 *
 * 这三条**必须都钉住**，因为它们是三种不同的失败模式：
 *   · 显式那条坏了 ⇒ 116 处全部失效（本文件存在的理由）
 *   · 全局那条坏了 ⇒ 用户设了 LLM_MAX_TOKENS 却不生效
 *   · 默认那条坏了 ⇒ 没传额度时用错值（可能超过模型上限，直接被网关拒）
 *
 * ## ⚠️ 依赖状态
 *
 * `modelCapabilities.js` 属上游 v3.10.0。**本仓尚未合并它** ⇒ 本文件会优雅 skip。
 * 合并后自动生效（与 `shieldLorebookOrder.test.js` 同一处理方式）。
 * 若上游改了模块路径，**跟着改 import**，不要删测试 —— 优先级风险还在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// ── 载入上游的 modelCapabilities（纯函数、无 I/O）──────────────────────
let caps = null
let importErr = null
try {
  caps = await import('../src/llm/modelCapabilities.js')
} catch (e) { importErr = e }

const has = () => Boolean(caps && typeof caps.defaultMaxTokens === 'function'
  && typeof caps.isValidMaxTokens === 'function')

/**
 * 本地口径的 applyOutputTokenLimit（方案 B）。
 *
 * 与上游唯一的差别：删之前先把「调用方显式传的值」取出来，作为**最高优先级**。
 * 上游的 `defaultMaxTokens` 退化为「没传时」的兜底 —— 能力感知仍然保留。
 *
 * ⚠️ 本函数是**复刻**，用于在 modelCapabilities 尚未合并时也能验证优先级逻辑。
 *    合并后应改为 import 真实的 llm-client.js，否则测的是复刻品而不是实现。
 */
function applyOutputTokenLimit(params, maxTokens, baseURL) {
  const field = Object.hasOwn(params, 'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens'
  // ← 本地扩展：删之前先记住显式值
  const explicit = params.max_tokens ?? params.max_completion_tokens ?? params.max_output_tokens
  delete params.max_tokens
  delete params.max_completion_tokens
  delete params.max_output_tokens
  // 优先级：显式传入 > 全局设置 > 能力感知默认值
  params[field] = caps.isValidMaxTokens(explicit) ? explicit
    : caps.isValidMaxTokens(maxTokens) ? maxTokens
      : caps.defaultMaxTokens(baseURL, params.model)
}

const BASE = 'http://127.0.0.1:7863/v1'
const MODEL = 'cn:deepseek-v4-flash'

// ── ① 显式优先（最重要的一条）──────────────────────────────────────────
test('①-a 调用方显式传的值必须原样发出（本地 116 处靠这条活着）', (t) => {
  if (!has()) return t.skip(`modelCapabilities 未合并（${importErr?.code || '未知'}）：合并 v3.10.0 后本用例自动生效`)
  // 覆盖本地真实取值谱：最小 5 到最大 8000
  for (const v of [5, 8, 24, 60, 100, 128, 500, 1024, 2048, 4096, 8000]) {
    const params = { model: MODEL, messages: [], max_tokens: v }
    applyOutputTokenLimit(params, undefined, BASE)
    assert.equal(params.max_tokens, v,
      `调用方传 ${v}，却发出 ${params.max_tokens} —— 逐调用点额度失效（这正是上游 v3.10.0 的行为）`)
  }
})

test('①-b 显式传值优先于全局设置（LLM_MAX_TOKENS 不许盖掉调用点）', (t) => {
  if (!has()) return t.skip('modelCapabilities 未合并')
  for (const global of [1024, 4096, 8192, 32768]) {
    const params = { model: MODEL, messages: [], max_tokens: 128 }
    applyOutputTokenLimit(params, global, BASE)
    assert.equal(params.max_tokens, 128,
      `全局设置 ${global} 盖掉了调用点的 128 —— 调用点约束失效`)
  }
})

test('①-c 三字段变体都走显式优先（max_completion_tokens / max_output_tokens）', (t) => {
  if (!has()) return t.skip('modelCapabilities 未合并')
  const a = { model: MODEL, messages: [], max_completion_tokens: 64 }
  applyOutputTokenLimit(a, undefined, BASE)
  assert.equal(a.max_completion_tokens, 64, 'max_completion_tokens 变体丢了显式值')

  const b = { model: MODEL, messages: [], max_output_tokens: 32 }
  applyOutputTokenLimit(b, undefined, BASE)
  assert.equal(b.max_output_tokens ?? b.max_tokens, 32, 'max_output_tokens 变体丢了显式值')
})

// ── ② 全局设置（调用方没传时生效）──────────────────────────────────────
test('② 调用方没传时，LLM_MAX_TOKENS 生效', (t) => {
  if (!has()) return t.skip('modelCapabilities 未合并')
  const params = { model: MODEL, messages: [] }
  applyOutputTokenLimit(params, 4096, BASE)
  assert.equal(params.max_tokens, 4096, '全局设置没生效')
})

// ── ③ 能力感知默认值（都没给时的兜底）──────────────────────────────────
test('③-a 都没给时用能力感知默认值（与上游逐字一致）', (t) => {
  if (!has()) return t.skip('modelCapabilities 未合并')
  const cases = [
    ['https://api.deepseek.com', 'deepseek-chat', 393216],
    [BASE, 'cn:deepseek-v4-flash', 32768],
    [BASE, 'gemini-2.5-pro', 65536],
    [BASE, 'some-unknown-model', 8192],
  ]
  for (const [base, model, expected] of cases) {
    const params = { model, messages: [] }
    applyOutputTokenLimit(params, undefined, base)
    assert.equal(params.max_tokens, expected,
      `${model} @ ${base} 应为 ${expected}，实际 ${params.max_tokens}`)
  }
})

test('③-b 能力感知默认值不被"显式优先"逻辑破坏（升级后仍与上游一致）', (t) => {
  if (!has()) return t.skip('modelCapabilities 未合并')
  // 关键：本地的改动只影响"有显式值时"的分支；
  // 没显式值时必须与上游**完全一致**，否则我们就把上游的能力也弄坏了。
  for (const model of ['deepseek-chat', 'cn:deepseek-v4-flash', 'gemini-2.5-flash', 'unknown-x']) {
    const p = { model, messages: [] }
    applyOutputTokenLimit(p, undefined, BASE)
    const upstreamValue = caps.defaultMaxTokens(BASE, model)
    assert.equal(p.max_tokens, upstreamValue,
      `${model}：本地算出 ${p.max_tokens}，上游 ${upstreamValue} —— 本地扩展污染了上游逻辑`)
  }
})

// ── ④ 删除语义（三个字段不许同时存在）─────────────────────────────────
test('④ 发出时限额字段有且只有一个（避免网关同时收到两个）', (t) => {
  if (!has()) return t.skip('modelCapabilities 未合并')
  const params = { model: MODEL, messages: [], max_tokens: 128, max_output_tokens: 256 }
  applyOutputTokenLimit(params, undefined, BASE)
  const present = ['max_tokens', 'max_completion_tokens', 'max_output_tokens']
    .filter((k) => Object.hasOwn(params, k))
  assert.equal(present.length, 1,
    `限额字段应只剩一个，实际 ${present.length} 个：${present.join(', ')}`)
})

// ── ⑤ 非法值不许发出去 ──────────────────────────────────────────────────
test('⑤ 显式传非法值（0 / 负数 / NaN）时回落，不许原样发出', (t) => {
  if (!has()) return t.skip('modelCapabilities 未合并')
  for (const bad of [0, -1, NaN, 1.5, '128']) {
    const params = { model: MODEL, messages: [], max_tokens: bad }
    applyOutputTokenLimit(params, 4096, BASE)
    assert.ok(caps.isValidMaxTokens(params.max_tokens),
      `非法值 ${String(bad)} 被原样发出：${params.max_tokens}`)
    assert.equal(params.max_tokens, 4096, `非法值 ${String(bad)} 应回落到全局设置`)
  }
})

// ── ⑥ 真实来源守卫 ──────────────────────────────────────────────────────
test('⑥ 上游常量仍是实测的值（改了要重新评估影响面）', (t) => {
  if (!has()) return t.skip('modelCapabilities 未合并')
  assert.equal(caps.DEEPSEEK_MAX_TOKENS, 393216,
    'DEEPSEEK_MAX_TOKENS 变了 ⇒ 走官方域名时的额度会变，需重跑影响面量化')
  assert.equal(caps.FALLBACK_MAX_TOKENS, 8192,
    'FALLBACK_MAX_TOKENS 变了 ⇒ 未知模型额度会变')
})
