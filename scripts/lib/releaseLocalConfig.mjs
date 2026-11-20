import fs from 'node:fs'
import path from 'node:path'

// 通用同步始终排除凭据；仅自用包在这里显式同步当前配置，避免沿用旧 Key。
export function syncReleaseEnv(sourceDir, targetDir, keepEnv = false) {
  const result = { copied: [], removed: [] }
  for (const name of ['.env', '.env.local']) {
    const source = path.join(sourceDir, name)
    const target = path.join(targetDir, name)
    if (keepEnv && fs.existsSync(source)) {
      fs.mkdirSync(targetDir, { recursive: true })
      fs.copyFileSync(source, target)
      result.copied.push(name)
    } else if (fs.existsSync(target)) {
      fs.rmSync(target)
      result.removed.push(name)
    }
  }
  return result
}

export function inspectReleaseEnv(listing, keepEnv = false) {
  // 不依赖交付目录名；同时支持 Windows / POSIX 的归档路径。
  const envInPkg = /(?:^|[\\/])agent-core[\\/]\.env(?:\.local)?(?:\s|$)/m.test(listing)
  const exampleInPkg = /(?:^|[\\/])agent-core[\\/]\.env\.example(?:\s|$)/m.test(listing)
  if (envInPkg && !keepEnv) throw new Error('包内含 agent-core/.env（真实 API Key）⇒ 交付链剥离失败，拒绝交付')
  return { envInPkg, exampleInPkg }
}
