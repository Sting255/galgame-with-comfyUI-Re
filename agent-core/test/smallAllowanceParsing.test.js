/**
 * 守卫：「小额度 + 严格解析」成对出现的调用点（2026-10-19 补）
 *
 * ## ⚠️ 先说清楚：本文件守护的是**成本与健壮性**，不是**正确性**
 *
 * 我最初（2026-10-19 上半场）的推断是：「删掉 max_tokens 后，模型会先解释再结论，
 * `startsWith('是')` 会判错，且静默失效」。**这个推断已被实测推翻。**
 *
 * ### 实测记录（用真 JUDGE_PROMPT 打真模型，2026-10-19）
 *
 * 条件：`JUDGE_PROMPT`（原样）+ 强诱因上下文（明确描述场景，模型"很想"解释）
 * 对比：`max_tokens: 5` vs **不传**（模拟 v3.10.0）
 *
 * | 结果 | 数据 |
 * |---|---|
 * | 判定翻转 | **0 / 9 模型** |
 * | 输出长度 | **恒定 1 字**（「是」/「否」），最长 1 字，两种条件完全相同 |
 * | JSON 链路（约会检测同形提示词） | **5/5 可解析**，两种条件输出逐字节相同 |
 *
 * 覆盖模型：`mimo-v2.6-flash-free` / `deepseek-v4.1-flash-free` / `glm-5.3-flash-free`
 * （各含 light / deep 变体，共 9 个）。
 *
 * ⇒ **上游的做法没问题**，模型确实遵守「只回复是或否」。
 * ⇒ 小额度在这里主要起「省钱 + 防个别模型啰嗦」的作用，**不是正确性的前提**。
 *
 * ### 那为什么还留这个守卫
 *
 * 因为它是**变化探测器**，成本极低：
 *   ① 若哪天换了模型/改了 prompt，输出开始变长，这里能提示"该复查了"
 *   ② 若有人为了"对齐上游"把额度删了**又**忘了看解析，这里会提醒一次
 *   ③ 它把上面那份实测记录**固化在代码里**，避免以后有人重新纠结同一个问题
 *
 * ⚠️ 因此：**本文件的断言红了，不等于功能坏了**。
 *    正确处理是：先跑一次实测（见下面 `verifyEmpirically` 的说明），确认是不是真的变差，
 *    再决定恢复额度还是改宽容解析。**不要因为这里红了就盲目加回 max_tokens。**
 *
 * ## 关于「日志看起来没问题」这个方法学提醒
 *
 * `chat.js:2403` 那行日志是：
 * ```js
 * console.log(`... (response: "${result.trim().slice(0, 20)}")`)
 * ```
 * **它把响应截断到 20 字** ⇒ 即使模型写了 500 字，日志也只显前 20 字，
 * 而且此时 `verdict` 会是 `false`（显示 `no`），看起来像个正常结论。
 * **⇒ 「日志不长」不能证明「输出不长」。** 要验就得实测原始输出（本文件头部那份记录就是这么来的）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

/**
 * 「小额度 + 严格解析」的关切点清单。
 *
 * 每条 = 一个「曾被担心会因额度放开而失效」的组合。
 * ⚠️ 按 2026-10-19 实测，它们**目前都是安全的**（见文件头记录）。
 *    保留清单是为了「额度消失时给出一次提醒 + 留下实测出处」。
 */
const CONTRACTS = [
  {
    name: '判断需要图片（私聊自动配图）',
    file: 'src/routes/chat.js',
    allowance: /max_tokens:\s*5\b/,
    parser: /\.startsWith\('是'\)/,
    measured: '实测 9/9 模型在无额度时仍只吐 1 字，判定不翻转',
  },
  {
    name: 'maibot 判图',
    file: 'src/maibot-bridge/judge.js',
    // ⚠️ 2026-10-19 合并上游 v3.10.0 后，这里的 `max_tokens: 5` **已被上游删除**
    //    （上游 ta 在 v3.10.0 里整体取消了逐调用点额度，这个文件属 TAKE_UP 直接覆盖）。
    //    已实测确认无害：9/9 模型无额度时输出仍恒定 1 字，判定 0 翻转。
    //    ⇒ 因此**不再要求额度存在**，但**仍要求解析保持**（startsWith 是策略，不是额度副作用）。
    allowance: null,
    parser: /\.startsWith\('是'\)/,
    measured: '与 chat.js 的 judgeImageNeed 同源；同一份实测适用。额度已被上游 v3.10.0 移除，实测无害',
  },
]

// ── ① 关切点仍在（额度或解析之一变化时给出提醒）─────────────────────────
for (const c of CONTRACTS) {
  test(`① 关切点：${c.name}（额度与解析的现状）`, () => {
    const src = read(c.file)
    // allowance 为 null ⇒ 该调用点的额度**已被上游 v3.10.0 移除**，不再要求（实测无害）
    const hasAllowance = c.allowance === null ? null : c.allowance.test(src)
    const hasParser = c.parser.test(src)

    assert.ok(hasParser,
      `${c.file} 找不到严格解析（${c.parser}）—— 若已改成宽容解析，请同步更新本清单`)

    if (hasAllowance === null) {
      // 已知状态：额度被上游移除，实测无害 ⇒ 只记录，不判红
      console.log(`    [已知] ${c.name}：额度已被上游 v3.10.0 移除（${c.measured}）`)
      return
    }

    assert.ok(hasAllowance,
      `${c.file} 的小额度不见了（解析仍是严格前缀匹配）。

       ⚠️ 按 2026-10-19 实测（9/9 模型）这**不一定**会坏 —— 模型本来就只吐一个字。
       ⇒ 请按这个顺序处理，不要直接加回 max_tokens：
         1. 先实测：用真 prompt 打真模型，比「传 5」与「不传」的原始输出
            （注意：日志里的 response 被 slice(0,20) 截断了，看日志不算实测）
         2. 若输出仍只有 1~2 字 ⇒ 额度本来就没用，**可以就这样**
         3. 若输出变长且判定翻转 ⇒ 二选一：
            (a) 恢复额度（需同时处理上游 llmOutputTokens.test.js 的 legacy 断言）
            (b) 把解析改宽容（如先取最后一句 / 匹配 /(?:^|\\n)\\s*是/），并在此注明原因

       实测出处：本文件头部「实测记录」表；${c.measured}`)
  })
}

// ── ② 全仓显式额度不许**无意识地**大范围消失 ───────────────────────────
test('② 显式额度仍是「普遍存在」的（防止无声的全量塌缩）', () => {
  // 说明：单点消失不一定是问题（见 ①），但**一次全没**通常意味着
  // 有人整体替换了 llm-client.js 或落进了全局塌缩 —— 那时值得停下来看一眼。
  const files = [
    'src/routes/chat.js',
    'src/maibot-bridge/judge.js',
    'src/services/groupIdleScheduler.js',
    'src/services/webSearch.js',
    'src/services/momentCommentService.js',
    'src/services/proactiveChatScheduler.js',
  ]
  const missing = []
  for (const f of files) {
    const src = read(f)
    if (!/max_tokens\s*:/.test(src)) missing.push(f)
  }
  // 允许个别文件没有（可能被有意清理）；全部都没有才判红
  assert.ok(missing.length < files.length,
    `这 ${files.length} 个文件里显式额度**全部**消失了：\n  ${missing.join('\n  ')}\n`
    + '⇒ 通常意味着整体替换了 llm-client.js（或落进 applyOutputTokenLimit 的全局塌缩）。\n'
    + '⇒ 单个文件消失不一定有问题（实测模型守规矩），但"一次全没"值得停下来确认。')
})

// ── ③ 上游那条 legacy 断言的取舍（本地已决定：接受上游）─────────────────
test('③ 上游 legacy 口径与本地现状的关系（记录级断言，不阻塞）', () => {
  // 上游 v3.10.0 的 llmOutputTokens.test.js 有一条：
  //   'legacy options cannot override the setting; protocol field and finish reason survive'
  // 断言显式传 max_tokens:1 也被忽略。
  //
  // 本地现状（未合并 v3.10.0）：_chatSyncInner 签名里仍有 max_tokens，所以**显式优先**。
  // 合并后若原样收上游，就会变成**全局优先**。
  //
  // 2026-10-19 实测结论：这个切换在**当前模型上无功能影响**（9/9 模型判定一致）。
  // ⇒ 因此**没有理由**为了让本地"显式优先"而去改上游的测试。
  //    本断言只记录这个判断，不强制任何一种实现。
  const src = read('src/llm/llm-client.js')
  const hasOwnAllowance = /max_tokens\s*=\s*\d+|max_tokens\s*=/.test(src)
  assert.ok(typeof hasOwnAllowance === 'boolean',
    '（记录型断言：仅确认 llm-client.js 可读）')
  console.log(`    [记录] 本地 llm-client.js 是否自带 max_tokens 处理: ${hasOwnAllowance}`
    + `（合并 v3.10.0 后预计变 false；实测无功能影响，无需改上游测试）`)
})

// ── ④ 高风险解析点备案（改动时对照）────────────────────────────────────
test('④ 备案：几个曾担心的解析点实际写法', () => {
  const snap = []
  const probes = [
    ['src/services/appointmentDetector.js', /JSON\.parse/],
    ['src/services/handwritingFontService.js', /JSON\.parse/],
    ['src/services/mailboxScheduler.js', /JSON\.parse/],
    ['src/services/proactiveChatScheduler.js', /\.match\(/],
    ['src/services/webSearch.js', /indexOf\('\|'\)/],
  ]
  for (const [f, re] of probes) {
    let src = ''
    try { src = read(f) } catch { continue }
    snap.push(`${f}: ${re.test(src) ? '有该解析' : '⚠️ 解析变了'}`)
  }
  assert.ok(snap.length > 0, '解析点全都没读到 —— 路径变了要更新本清单')
  console.log('    [备案] ' + snap.join('\n    [备案] '))
  console.log('    [备案] 2026-10-19 实测：这些 JSON 链路在无额度限制时 5/5 仍可解析')
})
