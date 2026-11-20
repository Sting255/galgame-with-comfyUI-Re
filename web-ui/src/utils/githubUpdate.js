/**
 * githubUpdate.js — 「有更新噢」标签的数据源。
 * 本地版本由 GET /api/version 提供，远端版本通过 /api/github 使用工坊的 GitHub 代理。
 *
 * 两个接口：
 *   GET /api/github/tags        → 全部 tag 引用（附注 tag 的 object.sha 指向 tag 对象本身）
 *   GET /api/github/tags/{sha}  → 单个附注 tag 的注释正文（tag message）
 * 弹层只展示「tag 版本号 + 该 tag 的注释」，不列提交内容。注释只能逐个 tag 取，
 * 所以只对「比本地版本新」的那几个 tag 发请求，并用 MAX_ANNOTATIONS 封顶。
 *
 * 缓存：未认证接口按来源 IP 限流（60 次/小时），一次检查要发 1 + N 个请求，
 * 反复重启应用很容易把额度耗光 —— 内存 + localStorage 双份缓存（TTL 见
 * CACHE_TTL_MS），本地版本号变了（升级后）自动失效重查。
 */

// 2026-11-07 改：原来写死上游仓库，导致本 fork 装的包永远收不到更新提示
// （本地 4.2.1 对上游最新 4.2.1，判定「不比远端旧」；就算上游发新版，提示也会把用户引到上游去）。
// fork 自己的发布放在这里，tag 命名沿用 vX.Y.Z（跟随上游）+ 必要时 vX.Y.Z.N（本地补丁）。
const REPO = 'Sting255/galgame-with-comfyUI-Re'
const REPO_URL = `https://github.com/${REPO}`
const API_BASE = '/api/github'
const REQUEST_TIMEOUT_MS = 18000
const CACHE_TTL_MS = 30 * 60 * 1000
// 缓存键带版本号：payload 结构变了、或要丢弃旧的一份坏结果时把它 +1
const CACHE_KEY = 'linshe:update-check:v2'
const SEEN_KEY = 'linshe:update-seen'   // 已读版本（看过一次就不再提醒的那条）
const MAX_ANNOTATIONS = 30       // 逐个 tag 取注释，封顶避免打满未认证限流
const MAX_ANNOTATION_CHARS = 400 // 单条注释截断长度，防止长注释把弹层撑爆

let memoryCache = null // { key: string, at: number, data: object }

/** 去掉前面的 v，trim 成纯版本号：'v3.4.2' → '3.4.2' */
export function normalizeVersion(raw) {
  return String(raw ?? '').trim().replace(/^[vV]/, '')
}

/**
 * 版本号拆成「数字段 + 本地迭代后缀」：
 *   '4.3.1'   → { nums: [4, 3, 1], suffix: '' }   上游正式版
 *   '4.3.1-j' → { nums: [4, 3, 1], suffix: 'j' }  本仓第 j 次本地修复
 *
 * 为什么后缀必须参与比较：本仓 tag 有两段结构（上游 vX.Y.Z + 本地 vX.Y.Z-<字母>），
 * 旧实现 split('-')[0] 把后缀直接丢掉，4.3.1 与 4.3.1-j 判成同一版本，
 * 于是 v4.3.1-a ~ -j 全部不算「更新」，「有更新噢」对这些版本永远静默。
 */
function parseVersion(raw) {
  const text = normalizeVersion(raw)
  const dash = text.indexOf('-')
  const base = dash === -1 ? text : text.slice(0, dash)
  const suffix = dash === -1 ? '' : text.slice(dash + 1).toLowerCase()
  const nums = base.split('.').map(seg => {
    const n = Number.parseInt(seg, 10)
    return Number.isFinite(n) ? n : 0
  })
  return { nums, suffix }
}

/**
 * 后缀比较：同一 base 版本下，'i' < 'j'；无后缀（正式版）小于任何本地迭代。
 * 逐段比较，纯数字段按数值（'2' < '10'），字母段按字典序；段数多的更新。
 */
function compareSuffix(a, b) {
  if (a === b) return 0
  if (!a) return -1
  if (!b) return 1
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? ''
    const y = pb[i] ?? ''
    if (x === y) continue
    const nx = Number.parseInt(x, 10)
    const ny = Number.parseInt(y, 10)
    if (Number.isFinite(nx) && Number.isFinite(ny)) return nx > ny ? 1 : -1
    return x > y ? 1 : -1
  }
  return 0
}

/** 版本号比较：a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return compareSuffix(pa.suffix, pb.suffix)
}

/** 从 tag 列表里挑出最新 tag（版本号最大的那个） */
export function pickLatestTag(tags) {
  return tags.reduce((best, tag) => (!best || compareVersions(tag.version, best.version) > 0 ? tag : best), null)
}

/**
 * 挑出「比本地版本新」的 tag，按版本降序返回（最新在最前）—— 也就是从最新版本
 * 往回数经过的每一个版本，弹层按这个顺序逐条展示 tag 与注释。
 */
export function selectNewTags(tags, currentVersion) {
  return tags
    .filter(tag => compareVersions(tag.version, currentVersion) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** refs 接口的一条引用 → { tag, version, sha, annotated }；不是 tag 引用返回 null */
export function parseTagRef(ref) {
  const full = String(ref?.ref || '')
  const prefix = 'refs/tags/'
  if (!full.startsWith(prefix)) return null
  const tag = full.slice(prefix.length)
  const version = normalizeVersion(tag)
  if (!tag || !version) return null
  return {
    tag,
    version,
    // 附注 tag：object.sha 是 tag 对象自身的 sha，取注释要用它；轻量 tag 则直接指向提交
    sha: ref?.object?.sha || '',
    annotated: ref?.object?.type === 'tag',
  }
}

/** tag 注释：统一换行、去掉首尾空白，过长的截断 */
export function tagAnnotation(message) {
  const text = String(message ?? '').replace(/\r\n?/g, '\n').trim()
  if (!text) return ''
  return text.length > MAX_ANNOTATION_CHARS ? `${text.slice(0, MAX_ANNOTATION_CHARS)}…` : text
}

async function fetchJson(url) {
  let res
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    // 网络层失败（断网 / 代理不通 / 被拦）——对外统一成一句人话，原始错误挂在 cause 上
    throw new Error(`连不上 GitHub：${err.message}`, { cause: err })
  }
  if (!res.ok) {
    const result = await res.json().catch(() => ({}))
    throw new Error(result.error || `GitHub 接口返回 ${res.status}`)
  }
  return res.json()
}

/**
 * 逐个附注 tag 取注释，写回各自对象的 annotation 字段。
 * 只对需要展示的 tag 发请求；超过 MAX_ANNOTATIONS 时保留最新的一批
 * （列表已是降序，取前 N 个即最新的一批）。单条失败只让这一条空着，不影响其他条。
 * 返回失败原因：调用方据此判断这次是不是降级结果（降级的不落缓存，
 * 否则一次网络抖动会被缓存住，弹层在半小时里一直是空白的）。
 */
async function fillAnnotations(tags) {
  const limited = tags.slice(0, MAX_ANNOTATIONS)
  const errors = []
  await Promise.all(limited.map(async item => {
    if (!item.annotated || !item.sha) return
    try {
      const detail = await fetchJson(`${API_BASE}/tags/${encodeURIComponent(item.sha)}`)
      item.annotation = tagAnnotation(detail?.message)
    } catch (err) {
      errors.push(err.message)
    }
  }))
  return { shown: limited, errors }
}

// 缓存：内存优先，miss 时回落到 localStorage（跨重启复用，省限流额度）。
// 隐私模式 / 存储被禁用时 localStorage 会抛异常，退化成只有内存缓存。
function readCache() {
  if (memoryCache) return memoryCache
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY)
    memoryCache = raw ? JSON.parse(raw) : null
  } catch {
    memoryCache = null
  }
  return memoryCache
}

function writeCache(key, data) {
  memoryCache = { key, at: Date.now(), data }
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(memoryCache))
  } catch {
    // 存不进去不影响本次展示
  }
}

/**
 * 已读版本：用户看过「有更新噢」弹层后记下的版本号，跟着浏览器走（跨会话保留）。
 * 记的是版本号而不是 tag 名，比较时走同一套 compareVersions。
 */
export function getSeenVersion() {
  try {
    return normalizeVersion(globalThis.localStorage?.getItem(SEEN_KEY) || '')
  } catch {
    // 隐私模式 / 存储被禁用：退化成每次打开都提醒，功能不受影响
    return ''
  }
}

/** 记下已读版本，返回归一化后的版本号 */
export function markUpdateSeen(version) {
  const seen = normalizeVersion(version)
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, seen)
  } catch {
    // 存不进去就只在本次会话内生效
  }
  return seen
}

/**
 * 该不该提醒：远端有更新，并且这个版本还没被看过。
 * 看过之后标签和红点一起消失；直到远端又出比本地版本更高的新 tag 才再提醒一次。
 */
export function shouldNotify(updateInfo, seenVersion) {
  if (updateInfo?.hasUpdate !== true || !updateInfo.latest) return false
  return compareVersions(updateInfo.latest, normalizeVersion(seenVersion || '')) > 0
}

/**
 * 查询更新状态。currentVersion 是本地装着的版本（由 GET /api/version 给出），必传。
 * 返回结构直接对应前端弹层，不再二次加工。
 */
export async function checkForUpdate({ force = false, currentVersion } = {}) {
  const current = normalizeVersion(currentVersion)
  // 拿不到本地版本就没法判断「新不新」：宁可什么都不显示，也别拿错版本去比。
  // 不以数字开头的一律当没有版本（如未打 tag 时写进发布包的 'dev'）—— 那种值拿去比
  // 会得出「落后几十个版本」的假警报，而这标签一弹就要用户跑去更新。
  if (!/^\d/.test(current)) throw new Error(`缺少可用的本地版本号（拿到的是「${current}」，先看 GET /api/version）`)
  // 缓存按本地版本分键：升级后版本号变了必须重新比对，不能复用旧结论
  const cached = readCache()
  if (!force && cached && cached.key === current && Date.now() - cached.at < CACHE_TTL_MS) return cached.data

  const rawRefs = await fetchJson(`${API_BASE}/tags`)
  const tags = (Array.isArray(rawRefs) ? rawRefs : []).map(parseTagRef).filter(Boolean)

  const latest = pickLatestTag(tags)
  const base = {
    repo: REPO,
    repoUrl: REPO_URL,
    current,
    latest: latest ? latest.version : '',
    latestTag: latest ? latest.tag : '',
    hasUpdate: false,
    tagCount: 0,
    annotationsTrimmed: false,
    annotationsFailed: false,
    compareUrl: REPO_URL,
    tags: [],
    fetchedAt: new Date().toISOString(),
  }

  // 本地已经不比远端旧（或远端根本没有版本 tag）：什么都不用提示，结论也要缓存
  if (!latest || compareVersions(latest.version, current) <= 0) {
    writeCache(current, base)
    return base
  }

  const newTags = selectNewTags(tags, current)
  const { shown, errors } = await fillAnnotations(newTags)
  // 该有注释的 tag 一条都没取到、或者中途有失败 —— 这次算降级结果
  const expected = shown.filter(item => item.annotated && item.sha).length
  const got = shown.filter(item => item.annotation).length
  const degraded = errors.length > 0 || (expected > 0 && got === 0)
  if (degraded) console.warn(`[update] 版本注释没取全（${errors[0] || '接口返回为空'}），本次结果不落缓存`)

  const result = {
    ...base,
    hasUpdate: true,
    latest: latest.version,
    latestTag: latest.tag,
    tagCount: newTags.length,
    annotationsTrimmed: newTags.length > shown.length,
    annotationsFailed: degraded,
    compareUrl: `${REPO_URL}/compare/v${current}...${latest.tag}`,
    tags: shown.map(item => ({
      tag: item.tag,
      version: item.version,
      annotation: item.annotation || '',
    })),
  }

  // 降级结果不落缓存：下次打开页面重新取一遍，而不是把空白缓存半小时
  if (!degraded) writeCache(current, result)
  return result
}

/** 清空缓存（测试用） */
export function resetCache() {
  memoryCache = null
  try {
    globalThis.localStorage?.removeItem(CACHE_KEY)
  } catch {
    // 没存过或存不了都不用管
  }
}
