/**
 * P0-3 · 用户手册覆盖（生成源 + 已提交的使用说明）
 *
 * 审查《审查与改进规划-20260930》缺口 5：本轮新增的用户可见功能在手册里**零命中**。
 * 验收：`buildUsageGuideText`（用户手册的**唯一正源**，生成 `使用说明.txt`）含动作系统与反重复章节；
 * 重新生成后对已提交的使用说明 diff **只增不删**。
 *
 * ⚠️ 2026-10-13 口径更正：本条原先还断言开发侧的 `目标/操作流程.md`。那份文档已随文档清理删除
 * （它和使用说明是同一份东西的两份拷贝，长期不同步：它把智能档概率写成 25%/50%，代码 2026-10-01 起
 * 已是 `SMART_IMAGE_CHANCE = {2:0.5, 3:0.75, 4:0.9}`，见 `services/touchActionService.js`）。
 * ⇒ 现在**只守生成源**，别再把手册的拷贝写进 `目标/`。
 *
 * ⚠️ 2026-10-17 正源搬家：正文从 `scripts/build-release.mjs` 抽到 `scripts/usage-guide.mjs`
 * （原因：build-release 是"整包发布"脚本，跑一次成本极高，而真正的交付链
 * `scripts/发布-校验并打包.mjs` 过去完全没有生成这一步 ⇒ 交付包一路带 2026-10-01 旧手册）。
 * 本文件改为读新正源；"生成链有没有接上打包脚本"由 `releasePackagingGuide.test.js` 单独钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 正源（2026-10-17 起）：scripts/usage-guide.mjs
const buildGuide = (await import(new URL('../../scripts/usage-guide.mjs', import.meta.url).href)).buildUsageGuideText

// 已提交的使用说明（上一版生成结果）：用来证明「只增不删」
const committed = readFileSync(new URL('../../使用说明.txt', import.meta.url), 'utf8')
const committedApk = (committed.match(/压缩包内附带 (.+?)，安装后/) || [])[1] || 'app.apk'
const guide = buildGuide ? buildGuide({ apkName: committedApk }) : ''

const nonEmpty = text => text.split('\n').map(line => line.trim()).filter(Boolean)

/** needle 是否为 haystack 的子序列（允许中间插入新行 ⇒ 只增不删） */
function isSubsequence(needle, haystack) {
  let i = 0
  for (const line of haystack) {
    if (line === needle[i]) i++
    if (i >= needle.length) return true
  }
  return i >= needle.length
}

const MUST_HAVE = [
  ['动作系统', '动作系统'],
  ['动作条入口', '输入框'],
  ['三档动作', '敏感'],
  ['门控置灰', '灰'],
  ['腻烦度', '腻烦'],
  ['连点会不耐烦', '不耐烦'],
  ['腻烦冷却', '30 分钟'],
  ['即时反应 vs 省额度', '省额度'],
  ['每日配额', '100'],
  ['出图档位', '出图'],
  // ⚠️ 2026-10-17 有意替换（「只增不删」纪律的例外，写清理由）：
  // 旧手册写「亲密档约 25%、敏感档约 50%」，与代码不符 —— `SMART_IMAGE_CHANCE`
  // 自 2026-10-01 起就是 {2:0.5, 3:0.75, 4:0.9}（见 services/touchActionService.js:594，
  // 该处注释写明调高理由：0.25/0.5 的观感就是"生图被限制了"）。
  // 现在手册如实写 50%/75%/90%，与代码、docs/touch-system.md 三处一致。
  ['智能档概率 Lv2', '50%'],
  ['智能档概率 Lv3', '75%'],
  ['智能档概率 Lv4', '90%'],
  ['围观插话概率', '围观'],
  ['群聊敏感档', '群聊'],
  ['统计面板', '触摸互动'],
  ['反重复：总开关', '反车轱辘话'],
  ['反重复：钻牛角尖', '钻牛角尖'],
  ['反重复：自动升级', '加强约束'],
  ['penalty 怎么填', 'penalty'],
  ['留空 = 不发送', '留空'],
  ['反重复日志', '[anti-repetition]'],
]

test('使用说明.txt 生成源补齐同一批小节', () => {
  assert.ok(buildGuide, '要能从 scripts/usage-guide.mjs 拿到 buildUsageGuideText')
  const missing = MUST_HAVE.filter(([, keyword]) => !guide.includes(keyword)).map(([name]) => name)
  assert.deepEqual(missing, [], 'buildUsageGuideText 缺这些内容：' + missing.join('、'))
  assert.ok(guide.includes('【动作'), '要有动作系统的【】小节')
  assert.ok(guide.includes('【反重复'), '要有反重复的【】小节')
})

test('手册里的智能档概率与代码同源（三处一致：手册 / 代码 / docs）', () => {
  const code = readFileSync(new URL('../../agent-core/src/services/touchActionService.js', import.meta.url), 'utf8')
  const m = /SMART_IMAGE_CHANCE = Object\.freeze\(\{([^}]+)\}\)/.exec(code)
  assert.ok(m, '要能从 touchActionService.js 读到 SMART_IMAGE_CHANCE')
  const pct = (s) => `${Math.round(Number(s) * 100)}%`
  const chance = Object.fromEntries(
    m[1].split(',').map(pair => pair.split(':').map(s => s.trim())).map(([lv, v]) => [lv, pct(v)]),
  )
  for (const [lv, expect] of Object.entries(chance)) {
    assert.ok(guide.includes(expect), `手册必须写 Lv${lv} 的实际概率 ${expect}（代码是 ${m[1].trim()}）`)
  }
  // 旧数字必须已经消失（否则用户看到的是"被限制"的假象）
  assert.ok(!guide.includes('亲密档约 25%'), '手册不得再留旧的 25%');
  assert.ok(!guide.includes('敏感档约 50%'), '手册不得再留旧的 50%')
})

// 手册口径变更（Lead 2026-09-30 裁决）：旧入口描述**直接替换** —— 「只增不删」是防**误删**，
// 不是让手册同时留着两套互相矛盾的说法。所以下面这几句**允许被删/被替换**：
//   ①~③ 改版前的入口形态；
//   ④~⑤ 专题 §十 新增 Lv4 后的**有意替换**（16 个动作 → 25 个、三段 → 四段）。
// 其余内容仍然逐行保留、顺序不变；**白名单之外出现任何删除都要红**。
const ALLOWED_REMOVED = [
  '- 入口：聊天页输入框正上方有一条动作条，默认收起成一颗「动作」胶囊，点开是一排可以左右滑的动作',
  '- 群聊里也能用，但要先选人：点「动作」先弹成员面板，选好「对 XXX」再选动作',
  '- 动作条上方的「还有 N 个动作等她回应」是正常提示：做下的动作还等着她回应，她回应完就消失',
  '- 三档共 16 个动作：日常（摸头、拍拍肩、拉手、抱抱、挠痒痒、捏脸）/ 亲密（摸头发、摸背、搂腰、亲脸颊、贴贴）/ 敏感（摸胸、摸臀、摸大腿、腰部游走、耳后吹气）',
  '- 点 ✋ 打开的是底部弹层大卡片（形态与动画同送礼面板：底部对齐、点遮罩关闭、0.3 秒渐入渐出，关闭动画跑完才卸载）：日常 / 亲密 / 敏感 三段分组，每段一排大卡片，还是那 16 个动作',
  // 2026-10-17 有意替换（同上：与代码不符的旧概率数字）
  '- 动作出图（设置 →「动作系统（触摸互动）」）：总是＝每个动作都配一张图；智能（默认）＝亲密档约 25%、敏感档约 50%；从不＝只要文字',
]

test('生成的使用说明：替换旧入口描述之外**只增不删**（其余内容逐行保留、顺序不变）', () => {
  assert.ok(buildGuide, '要能找到 buildUsageGuideText')
  const committedLines = nonEmpty(committed)
  assert.ok(committedLines.length > 0, '要有已提交的使用说明.txt 作为基准')
  const generatedLines = nonEmpty(guide)

  // ① 顺序守卫：把「允许被替换的旧入口描述」摘掉后，剩下每一行都必须还在 **且顺序不变**
  const kept = committedLines.filter(line => !ALLOWED_REMOVED.includes(line))
  assert.ok(kept.length >= committedLines.length - ALLOWED_REMOVED.length, '白名单不得吞掉白名单以外的行')
  assert.ok(kept.length >= 60, '剔除白名单后仍要留下绝大部分内容（防白名单被滥用成假绿）')
  assert.ok(isSubsequence(kept, generatedLines), '除旧入口描述外，生成结果删掉了已提交版本里的行')

  // ② 反向守卫：真正被删掉的行**只能**来自白名单，出现白名单之外的删除就红
  const removed = committedLines.filter(line => !generatedLines.includes(line))
  const unexpected = removed.filter(line => !ALLOWED_REMOVED.includes(line))
  assert.deepEqual(unexpected, [], '出现白名单之外的删除：' + JSON.stringify(unexpected))
})
