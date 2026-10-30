/**
 * 使用说明.txt 的**生成链**回归（2026-10-17 新建）
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-17 全项目复查 §三-1 查出的 P0（交付级）：`使用说明.txt` 的生成源早已更新
 * （含破限 / 敏感度 / 每日额度 / 点题 / 重新组织…全部新功能），但**真正的打包链**
 * `scripts/发布-校验并打包.mjs` **完全没有生成这一步** ⇒ 仓库根与交付目录那份
 * 一路停在 2026-10-01 旧版（13208 B、新功能关键词**零命中**），
 * 第五十五~五十七轮 3 个交付包全带旧手册。
 *
 * 用户规则「不手改、只改生成源」没被违反 —— 违反的是「生成源改了以后没人再生成」。
 *
 * ## 本文件钉什么（三条，缺一条就会再断一次）
 *
 *   ① **正源唯一**：正文只住在 `scripts/usage-guide.mjs`，`build-release.mjs` 与打包脚本都 import 它；
 *      任何一处再出现 `function buildUsageGuideText` 的本地实现就是第二份口径 ⇒ 红。
 *   ② **生成链接上**：打包脚本必须在同步**之前**调用正源生成到仓库根，
 *      否则交付目录拿到的还是上一版（旧设计正是漏了这一步）。
 *   ③ **断言打在正文上**：打包脚本对「仓库根」与「交付目录」两份都做关键词断言，
 *      且断言对象是**读回来的文件内容**，不是"生成源里有没有这个词"
 *      —— 后者在生成链断掉时照样绿（这正是当初漏判的原因）。
 *
 * 另：测试门禁补了 `cancelled > 0 即 die`（`--test-force-exit` 会把跑不完的文件掐掉而摘要显示 0 fail，
 * 历史事故见 接手必读 §2「假绿已修」），本条也一并钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const pkgScript = read('../../scripts/发布-校验并打包.mjs')
const releaseScript = read('../../scripts/build-release.mjs')
const guideModule = read('../../scripts/usage-guide.mjs')

// ── ① 正源唯一 ────────────────────────────────────────────────────────────

test('正源只有 scripts/usage-guide.mjs 一份（不许再出现本地 buildUsageGuideText 实现）', () => {
  assert.match(guideModule, /export function buildUsageGuideText\(/, '正源必须导出 buildUsageGuideText')
  for (const [name, src] of [['build-release.mjs', releaseScript], ['发布-校验并打包.mjs', pkgScript]]) {
    assert.equal(/function buildUsageGuideText\(/.test(src), false,
      `${name} 不许自带第二份正文实现（只 import 正源）`)
    assert.match(src, /from ['"]\.\/usage-guide\.mjs['"]/, `${name} 要从 usage-guide.mjs 引入正源`)
  }
})

test('正源的正文不含未插值的 ${VERSION}（版本号必须走参数）', () => {
  assert.equal(/\$\{VERSION\}/.test(guideModule), false,
    '正源模块里没有 VERSION 绑定，必须由调用方传 version 参数')
  // 解构默认值是**从左到右**求值的：把 apkName 的默认值写成引用 version 的模板串会 TDZ
  // （2026-10-17 实测 `ReferenceError: Cannot access version before initialization`）。
  //
  // ⚠️ 判定必须先剥注释：`usage-guide.mjs` 文件头那段长注释里把这条反例**逐字写了出来**
  //    （`` `{ apkName = `…${version}…`, version = 'dev' }` ``），不剥的话断言会命中注释、
  //    把"已经写对了"的正源判成错（本轮实测踩到：正则命中注释 ⇒ 假红）。
  const code = guideModule.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.equal(/apkName = `[^`]*\$\{version\}/.test(code), false,
    'apkName 的默认值不许引用 version（解构默认值从左到右求值 ⇒ TDZ）')
  assert.match(code, /const version = opts\.version \|\| 'dev'/, 'version 要在函数体内先取')
})

// ── ② 生成链接上了打包脚本 ────────────────────────────────────────────────

test('打包脚本在同步之前用正源重新生成使用说明', () => {
  // 找**调用点**（不是顶部 import）：`buildUsageGuideText({ version })`
  const callIdx = pkgScript.indexOf('buildUsageGuideText({ version })')
  assert.ok(callIdx > 0, '打包脚本必须调用正源生成使用说明（这正是当初缺的一步）')
  // 生成必须发生在**真正拷文件之前**，否则同步出去的是上一版
  const copyIdx = pkgScript.indexOf('全量镜像：仓库顶层')
  assert.ok(copyIdx > 0, '要有全量同步段')
  assert.ok(callIdx < copyIdx, '生成要写在同步之前（先写盘、再整份刷到交付目录）')
  assert.ok(callIdx < pkgScript.indexOf('── 打包 ──'), '生成要在 7z 打包之前')

  assert.match(pkgScript, /fs\.writeFileSync\(USAGE_GUIDE, text, 'utf8'\)/, '要真的把正文写进仓库根 使用说明.txt')
})

// ── ③ 关键词断言打在正文上（两份都验） ────────────────────────────────────

test('打包脚本对仓库根与交付目录两份使用说明都做关键词断言', () => {
  assert.match(pkgScript, /const USAGE_KEYWORDS = \[/, '要有关键词清单')
  // 仓库根那份：读回来验
  assert.match(pkgScript, /const missing = USAGE_KEYWORDS\.filter\(\(\[, kw\]\) => !text\.includes\(kw\)\)/,
    '断言对象必须是**读回来的正文内容**（不是生成源文件）')
  // 交付目录那份：同步之后再验一次
  assert.match(pkgScript, /const delivered = path\.join\(DELIVER, '使用说明\.txt'\)/, '要单独验交付目录那份')
  assert.match(pkgScript, /交付目录缺 使用说明\.txt/, '缺文件要 die')
  assert.match(pkgScript, /交付目录的 使用说明\.txt 是旧的/, '交付目录那份是旧的要 die')
})

test('关键词清单覆盖 2026-10-17 复查时零命中的那批新功能', () => {
  const mustHave = ['破限', '敏感度', '私密时刻', '亲密推进', '奇遇', '点题', '动作反应风格', '重新组织语言']
  for (const kw of mustHave) {
    assert.ok(pkgScript.includes(`'${kw}'`), `关键词清单必须含「${kw}」`)
    assert.ok(guideModule.includes(kw), `正源正文必须真的写到了「${kw}」`)
  }
})

// ── ④ 门禁的 cancelled 判红 + skipped 固定原因 ────────────────────────────

test('测试门禁：cancelled > 0 判红，并固定写明 5 个 skipped 的环境原因', () => {
  assert.match(pkgScript, /if \(cancelled > 0\) die\(/, 'cancelled 必须判红（只看 fail 会漏判"用例没跑完"）')
  assert.match(pkgScript, /const KNOWN_SKIPS = \[/, '要有已知 skipped 清单')
  for (const kw of ['intimateAiEditHttp', 'townSevenDay', 'toyWakeAndImage']) {
    assert.ok(pkgScript.includes(kw), `KNOWN_SKIPS 要写明 ${kw} 的原因`)
  }
})

// ── ⑤ 门禁不写死旧数字（防下次又被问一遍） ────────────────────────────────

test('打包脚本不硬编码测试条数（旧脚本写死过"自动自检数字"，一改测试就假告警）', () => {
  assert.equal(/2215|2210|960\b/.test(pkgScript), false, '不许把套件条数写死在门禁脚本里')
})
