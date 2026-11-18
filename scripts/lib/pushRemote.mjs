/**
 * pushRemote.mjs —— 「推到哪个远端」的唯一口径。
 *
 * 本仓有两个 remote：
 *   origin = 上游 icecranberry/galgame-with-comfyUI，只读镜像，本机没有写权限；
 *   mine   = 用户自己的 fork，所有本地 tag 与 main 都推到这里。
 *
 * 历史问题：`npm run tag` 与 `npm run lasttag` 都写死 push origin，
 * 实际跑到最后一步必然失败，v4.3.1-a ~ -j 这些 tag 全是手工 `git push mine` 推的。
 * 脚本与真实口径分叉后，谁顺手跑一次 tag 就会先改工作区再在推送处报错。
 * 现在统一在这里解析：默认 mine，需要时用环境变量 PUSH_REMOTE 覆盖。
 */

import { execSync } from 'node:child_process'

export const DEFAULT_PUSH_REMOTE = 'mine'

/** 列出已配置的远端，用于报错时给出可选项 */
export function listRemotes(cwd = process.cwd()) {
  try {
    return execSync('git remote', {
      cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean).join(', ') || '(无)'
  } catch {
    return '(读取失败)'
  }
}

/**
 * 解析推送目标。远端不存在时直接抛错——宁可当场停下，也别推到一个不存在/无权限的仓库。
 * @returns {{ name: string, url: string }}
 */
export function resolvePushRemote(cwd = process.cwd()) {
  const name = (process.env.PUSH_REMOTE || DEFAULT_PUSH_REMOTE).trim()
  let url = ''
  try {
    url = execSync(`git remote get-url ${name}`, {
      cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(
      `远端 ${name} 不存在。本仓的推送目标是自己的 fork（默认 mine），`
      + `可用 PUSH_REMOTE=xxx 指定。当前远端：${listRemotes(cwd)}`,
    )
  }
  return { name, url }
}

/**
 * 分支名 → 远端 refspec。
 *
 * `local` 是本地工作分支（父提交挂在上游 tag 之上），在 fork 上对应 `main`；
 * 其余分支按同名推送，避免把临时分支的内容顶掉 main。
 */
export function resolvePushRefspec(branch) {
  return branch === 'local' ? 'local:main' : `${branch}:${branch}`
}
