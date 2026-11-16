import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const TOP_LEVEL_DIRS = new Set([
  'agent-core', 'android-shell', 'launcher', 'runtime', 'scripts', 'tts-service',
  'vector-service', 'web-ui', 'workflow', '.git',
])

function normalizeMemberPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/** 同时兼容 build-release 的 zip 根目录和主发布链的 <交付目录>/ 前缀。 */
export function archiveRelativePath(member) {
  const normalized = normalizeMemberPath(member)
  const first = normalized.split('/', 1)[0].toLowerCase()
  if (TOP_LEVEL_DIRS.has(first) || !normalized.includes('/')) return normalized
  return normalized.slice(normalized.indexOf('/') + 1)
}

/** 只取 7z -slt 的成员 Path；普通 7z l 的 Name 列不参与敏感路径判断。 */
export function parse7zMemberPaths(listing) {
  return [...String(listing || '').matchAll(/^\s*Path = (.+?)\s*$/gm)]
    .map(match => normalizeMemberPath(match[1]))
}

/** 源文件复制阶段的统一排除口径；.env.example 是唯一明确放行的配置模板。 */
export function isSensitiveSourceFile(fileName) {
  const name = String(fileName || '').toLowerCase()
  const envFile = (name === '.env' || name.startsWith('.env.')) && name !== '.env.example'
  return envFile || name === 'local.properties' || /\.(?:jks|keystore|p12|pfx)$/.test(name)
}

/**
 * 返回归档中禁止交付的文件。目录条目不代表数据内容，直接跳过。
 * keepEnv 只允许显式自用包携带 agent-core/.env 或 .env.local，不放行其它变体。
 */
export function findSensitiveArchiveMembers(members, {
  keepEnv = false,
  allowData = false,
  allowedDataFiles = [],
} = {}) {
  const allowedData = new Set(allowedDataFiles.map(item => normalizeMemberPath(item).toLowerCase()))
  const violations = []
  for (const member of members || []) {
    const normalized = normalizeMemberPath(member)
    if (!normalized || normalized.endsWith('/')) continue
    const rel = archiveRelativePath(normalized)
    const lowerRel = rel.toLowerCase()
    const base = rel.split('/').pop().toLowerCase()
    let reason = ''
    if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') {
      const allowedSelfUseEnv = keepEnv && (lowerRel === 'agent-core/.env' || lowerRel === 'agent-core/.env.local')
      if (!allowedSelfUseEnv) reason = '本机密钥配置或 env 变体'
    } else if (base === 'local.properties' || lowerRel.startsWith('android-shell/keystores/') || /\.(?:jks|keystore|p12|pfx)$/.test(base)) {
      reason = 'Android 签名材料或本机配置'
    } else if (base === 'launcher_config.json') {
      reason = '本机启动器配置'
    } else if (base === '.access-token') {
      reason = '设备配对凭证'
    } else if (base === 'settings.local.json') {
      reason = '本机工具配置'
    } else if (lowerRel.endsWith('.tar.gz')) {
      reason = '本地备份归档'
    } else if (lowerRel.startsWith('agent-core/data/') && !allowData && !allowedData.has(lowerRel)) {
      reason = '玩家数据库或媒体数据'
    } else if (lowerRel.startsWith('vector-service/chroma_data/')) {
      reason = '用户向量库'
    }
    if (reason) violations.push({ path: normalized, reason })
  }
  return violations
}

export function backendDependenciesPresent(coreDir) {
  return ['express', 'better-sqlite3'].every(name =>
    fs.existsSync(`${coreDir}/node_modules/${name}/package.json`))
}

/**
 * 扫描仓库历史里的敏感文件路径（P0-08）。
 *
 * 为什么必须有这一步：`findSensitiveArchiveMembers` 只能看 zip 里的**文件路径名**，
 * 而交付包保留了 `.git`（用于客户端版本更新）。`.git/objects/ab/cdef...` 这种哈希路径
 * 永远不会命中「*.keystore」这类规则，但 `git rev-list --objects` 能还原出原始路径。
 *
 * 实测背景：`git rev-list --objects --all -- android-shell/release.keystore` 在本仓
 * 能列出 136 条记录，最早那条距当时 HEAD 只有 15 个提交——而发布链用 `--depth 50`
 * 浅克隆，窗口足以把已声明废弃的旧签名私钥继续分发出去。
 *
 * 必须在**发布目录**（含实际会被打包的 .git）上调用，而不是开发仓库，
 * 因为浅克隆的历史窗口决定了包里到底有什么。
 *
 * @param {string} repoDir 含 .git 的目录
 * @returns {{scanned:boolean, sensitive:Array<{path:string, blobs:number}>, commits:number, error?:string}}
 */
export function findSensitiveGitObjects(repoDir) {
  const gitDir = `${repoDir}/.git`
  if (!fs.existsSync(gitDir)) return { scanned: false, sensitive: [], commits: 0, error: '没有 .git 目录' }

  const revList = spawnSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd: repoDir, encoding: 'utf8', windowsHide: true, timeout: 60000,
  })
  if (revList.status !== 0) {
    return { scanned: false, sensitive: [], commits: 0, error: String(revList.stderr || '').trim().slice(0, 200) }
  }
  const commits = Number(revList.stdout.trim()) || 0

  // --objects 每行 `<sha> <path>`；没有 path 的行是 tree/blob 自身，跳过
  const objects = spawnSync('git', ['rev-list', '--objects', '--all'], {
    cwd: repoDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (objects.status !== 0) {
    return { scanned: false, sensitive: [], commits, error: String(objects.stderr || '').trim().slice(0, 200) }
  }

  const hits = new Map()
  for (const line of objects.stdout.split('\n')) {
    const space = line.indexOf(' ')
    if (space < 0) continue
    const filePath = line.slice(space + 1).trim()
    if (!filePath) continue
    if (!isSensitiveHistoryPath(filePath)) continue
    hits.set(filePath, (hits.get(filePath) || 0) + 1)
  }

  return {
    scanned: true,
    commits,
    sensitive: [...hits].map(([path, blobs]) => ({ path, blobs })).sort((a, b) => a.path.localeCompare(b.path)),
  }
}

/** 历史路径判定：与 isSensitiveSourceFile 同口径，另外补上发布/备份产物。 */
export function isSensitiveHistoryPath(filePath) {
  const normalized = normalizeMemberPath(filePath).toLowerCase()
  const base = normalized.split('/').pop()
  if (!base) return false
  if (isSensitiveSourceFile(base)) return true
  if (base === 'launcher_config.json' || base === '.access-token' || base === 'settings.local.json') return true
  if (normalized.endsWith('.tar.gz')) return true
  if (normalized.startsWith('agent-core/data/')) return true
  if (normalized.startsWith('vector-service/chroma_data/')) return true
  return false
}

// 只加载依赖并创建内存库；不要在这里导入 app.js 或读取 DB_PATH 指向的文件。
export const BACKEND_PROBE_SCRIPT = "require('express');const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('SELECT 1').get();db.close();"

export function probePackagedBackend({ nodeExe, coreDir }) {
  const result = spawnSync(nodeExe, ['-e', BACKEND_PROBE_SCRIPT], {
    cwd: coreDir,
    env: { ...process.env, DB_PATH: ':memory:', LOG_TO_FILE: 'false' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return { ...result, ok: !result.error && result.status === 0 }
}
