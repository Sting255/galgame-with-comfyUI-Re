/**
 * 交付包里**不许带本机配置文件**的守卫（2026-10-18 新建）
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-18 修 `.env` 那一类问题时查出的**同类漏网**：`launcher_config.json`。
 * 它是启动器的**本机用户配置**（`launcher/launcher/config_manager.py` 读写，跟 exe 同目录），
 * `.gitignore:31` 明确忽略它，`DEFAULT_CONFIG` 里 `comfyui_exe` 默认是**空串**，
 * 路径由用户在启动器「设置」页自己填。
 *
 * 但它住在**仓库根**，而打包脚本顶层的全量同步**原样把它拷进交付目录**
 * ⇒ 包里的 `comfyui_exe` 指向**打包这台机器**的路径
 *   （实测：`<某台机器>/ComfyUI-aki-v3/绘世启动器.exe`）
 * ⇒ 别人拿到包一开启动器就指着一个不存在的地址，而且看起来"就是坏的"。
 *
 * 与 `.env`（真实 API Key）是**同一类事故**：本机配置混进交付包。
 * `.env` 在 2026-10-17 修了，`launcher_config.json` 当时**漏了**。
 *
 * ## 本文件钉什么（三处一起，缺一条就还会漏）
 *
 *   ① **同步时跳过**：`syncDir` 的文件级排除名单里必须有 `launcher_config.json`
 *      —— 只靠这一条不够（下面 ② 就是为什么），但它是第一道；
 *   ② **主动删交付目录里遗留的那份**：`syncDir` 跳过 ≠ 交付目录里没有它。
 *      **全量同步不清理多余文件**（脚本头写明这条限制），所以上一次同步留下的那份
 *      照样进 7z —— 必须显式删，否则等于没修（`.env` 当年就是靠这一步才真正生效）；
 *   ③ **打包后从包内清单断言"没有它"**：前两条是"我以为它没进去"，
 *      真正要证明的是"包里确实没有"。门禁历史上三处先例都是"排除了但实际还在"。
 *      而且这条断言必须**会 die**（只是 log 一句就不算门禁）。
 *
 * ## 另钉：轮次号越界不许拼出乱码文件名
 *
 * 同一个脚本里 `cnNum` 对 n ≥ 100 会输出 `undefined十`（`d[Math.floor(n/10)]` 越界）。
 * 2026-10-18 我用 `--round 999` 验门禁，**真的产出了 `…-第undefined十九轮.7z`**，只能手工删。
 * 交付包名是用户会看到的东西，不许是乱码 ⇒ 现在 ≥100 主动 die。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../../scripts/发布-校验并打包.mjs', import.meta.url), 'utf8')

/** 剥注释：说明文字里会引述这些写法（甚至举反例），不剥会自己判自己 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

test('① syncDir 的文件级排除必须包含 launcher_config.json', () => {
  assert.match(code, /e\.name\s*===\s*'launcher_config\.json'[\s\S]{0,40}?continue/,
    'syncDir 要跳过 launcher_config.json（它是本机配置，含打包机器的 ComfyUI 绝对路径）')
})

test('② 必须主动删交付目录里遗留的那份（跳过 ≠ 不在）', () => {
  // 全量同步不清多余文件 ⇒ 上一次同步留下的那份会照样进包
  assert.match(code, /path\.join\(DELIVER,\s*'launcher_config\.json'\)/,
    '③-1 段要把交付目录（仓库根镜像）里遗留的 launcher_config.json 删掉')
  assert.match(code, /fs\.rmSync\(f,\s*\{\s*force:\s*true\s*\}\)/,
    '要真的删除（rmSync），不是只打印一句')
})

test('③ 打包后要从包内清单断言"没有它"，且断言会 die', () => {
  assert.match(code, /lcInPkg/, '⑤ 段要有 launcher_config 的包内清单判定变量')
  assert.match(code, /lcInPkg\)\s*die\(/,
    '判定命中必须 die（只是 log 一句就不算门禁）')
  // 断言要打在「包内清单」（解压后的 `l` 输出）上，不是打在交付目录上
  assert.match(code, /launcher_config\\\.json/, '断言的正则要匹配包内清单里的路径')
})

test('④ 原有的 .env 剥离仍在（别改回只判目录名的老写法）', () => {
  assert.match(code, /e\.name\s*===\s*'\.env'[\s\S]{0,80}?continue/, 'syncDir 仍要跳过 .env')
  assert.match(code, /envInPkg\)\s*die\(/, '⑤ 段 .env 的断言仍在且会 die')
  assert.match(code, /e\.name\s*===\s*'settings\.local\.json'/, 'settings.local.json 的排除也还在')
})

test('⑤ 轮次号 ≥100 必须主动 die，不许拼出 undefined 文件名', () => {
  // 找出 cnNum 函数体
  const fn = code.match(/const cnNum = \(n\) => \{[\s\S]*?\n\}/)
  assert.ok(fn, '要能找到 cnNum 函数')
  assert.match(fn[0], /n\s*>=\s*100[\s\S]{0,120}?die\(/,
    'n ≥ 100 要 die —— 否则 d[Math.floor(n/10)] 越界会输出 undefined 拼进文件名')
  assert.match(fn[0], /Number\.isInteger\(n\)/, '非整数/非法值也要挡住')
})

test('⑥ 真正干掉越界：把实现抽出来跑，断言行为', () => {
  // 为什么用 new Function 而不是 assert 源码正则：正则只能证明"代码里写了 >=100 的判断"，
  // 证明不了"它真的挡住了"。这里把 cnNum 的实现从源码里抠出来**真跑一遍**，
  // 避免"源码改了但测试还在断言旧写法"这种脱节。
  const fnSrc = code.match(/const cnNum = \(n\) => \{[\s\S]*?\n\}/)[0]
  const make = new Function('die', `${fnSrc}; return cnNum;`)
  const died = []
  const cnNum = make((m) => { died.push(m); throw new Error('DIE') })

  assert.equal(cnNum(1), '一')
  assert.equal(cnNum(9), '九')
  assert.equal(cnNum(19), '十九')
  assert.equal(cnNum(57), '五十七')
  assert.equal(cnNum(99), '九十九')
  // 合法范围内一个 undefined 都不许出现（这才是当初真出事的形态）
  for (let n = 1; n <= 99; n++) {
    assert.ok(!String(cnNum(n)).includes('undefined'), `cnNum(${n}) 不许含 undefined`)
  }

  for (const bad of [100, 999, 0, -1, 1.5]) {
    died.length = 0
    assert.throws(() => cnNum(bad), /DIE/, `cnNum(${bad}) 应当 die`)
    assert.ok(died.length > 0, `cnNum(${bad}) 要给出 die 原因（不能静默）`)
  }
})
