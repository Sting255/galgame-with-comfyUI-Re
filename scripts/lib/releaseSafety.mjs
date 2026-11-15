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

/**
 * 返回归档中禁止交付的文件。目录条目不代表数据内容，直接跳过。
 * keepEnv 只允许显式自用包携带 agent-core 配置；根级或其它目录的 env 仍拒绝。
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
    if (base === '.env' || base === '.env.local') {
      const allowedSelfUseEnv = keepEnv && (lowerRel === 'agent-core/.env' || lowerRel === 'agent-core/.env.local')
      if (!allowedSelfUseEnv) reason = '本机密钥配置'
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
