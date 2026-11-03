/**
 * import-pose-library.mjs — 把姿势图库里「性相关」的姿势补成可用的体位条目
 *
 * 背景：那张图库（ai-pose-gallery-SKILL）每张图只有「体系/分类/姿势名称/角度」四个中文字段，
 * 而邻舍的体位系统（positionLibrary → 换姿势 / 生成描写 / 生图）需要的是
 * core / male / female / negative / prompt / frozen 这套英文标签与模板。
 * 这个脚本用本机 LLM 网关把它们补出来，产出与 sexPositions.js 同构的数据文件。
 *
 * 用法：
 *   node scripts/import-pose-library.mjs --limit 10     # 先试跑 10 条看质量
 *   node scripts/import-pose-library.mjs                # 全量
 *   node scripts/import-pose-library.mjs --resume       # 断点续跑（已生成的不重来）
 *
 * 产物：agent-core/src/data/sexPositionsExtra.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'agent-core', 'src', 'data', 'sexPositionsExtra.js')
const RAW_CACHE = path.join(ROOT, '.pai', 'temp', 'pose-gallery-zh.json')
const DONE = path.join(ROOT, '.pai', 'temp', 'pose-import-done.json')

// 只导「明确性行为」的分类；日常姿势（站/坐/趴/卧）不属于体位系统
const SEX_CATEGORIES = [
  '正常位（传教士）', '后入位', '背向坐位', '骑乘位',
  '立位', '立位贴身', '面对面坐位', '坐位贴身',
]

const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 0 : 0
const RESUME = args.includes('--resume')

const LLM_URL = process.env.POSE_LLM_URL || 'http://127.0.0.1:7863/v1/chat/completions'
const LLM_KEY = process.env.POSE_LLM_KEY || process.env.LLM_API_KEY || ''
const LLM_MODEL = process.env.POSE_LLM_MODEL || 'cn:deepseek-v4.1-flash'

const SYSTEM = `你是成人向动漫生图的体位数据整理员。用户给出一个中文姿势名与分类，你要输出这个体位的**生图参数**。

严格按以下 JSON 输出（不要解释、不要代码块）：
{
  "core": ["3~6 个英文 Danbooru 风格标签，描述这个体位的核心动作与姿态"],
  "male": ["1~4 个英文标签，描述男方参与方式（单人姿势可为空数组）"],
  "female": ["2~5 个英文标签，描述女方姿态与暴露部位"],
  "negative": ["3~5 个该体位最容易画崩的负向标签，如 extra limbs / fused fingers / wrong anatomy"],
  "frozen": "一句中文（30~50 字），讲清这一格画面定格在哪一瞬、两人身体如何接触",
  "prompt": "一段英文提示词模板（60~120 词），按 this action > body state > clothing > framing > environment > lighting 的顺序写，用 [a / b] 表示可随机替换的变体"
}

硬要求：
- 全部英文标签用小写，逗号分隔的单条标签，不要整句
- 标签必须是画图模型认识的常见词（如 doggystyle, cowgirl, on back, spread legs, penis, vaginal）
- 不要写年龄、校服、水印、字幕相关词
- 不要在 prompt 里出现中文`

function readKey() {
  if (LLM_KEY) return LLM_KEY
  try {
    const env = fs.readFileSync(path.join(ROOT, 'agent-core', '.env'), 'utf8')
    const m = env.match(/^LLM_API_KEY=(.+)$/m)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

async function callLLM(userPrompt) {
  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readKey()}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt }],
      temperature: 0.5,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const j = await res.json()
  return j.choices?.[0]?.message?.content || ''
}

function parseOne(raw) {
  const clean = String(raw || '').replace(/```(?:json)?/gi, '').trim()
  const tryParse = (t) => {
    try {
      const o = JSON.parse(t)
      const arr = (v, min) => Array.isArray(v) && v.length >= min && v.every(x => typeof x === 'string' && x.trim())
      if (!arr(o.core, 2) || !arr(o.female, 1) || !arr(o.negative, 2) || !o.prompt || !o.frozen) return null
      return {
        core: o.core.map(s => s.trim().toLowerCase()),
        male: Array.isArray(o.male) ? o.male.map(s => String(s).trim().toLowerCase()).filter(Boolean) : [],
        female: o.female.map(s => s.trim().toLowerCase()),
        negative: o.negative.map(s => s.trim().toLowerCase()),
        frozen: String(o.frozen).trim(),
        prompt: String(o.prompt).trim(),
      }
    } catch { return null }
  }
  return tryParse(clean) || (clean.match(/\{[\s\S]*\}/) ? tryParse(clean.match(/\{[\s\S]*\}/)[0]) : null)
}

async function fetchGallery() {
  if (fs.existsSync(RAW_CACHE)) {
    console.log('用本地缓存的图库数据')
    return JSON.parse(fs.readFileSync(RAW_CACHE, 'utf8'))
  }
  console.log('从 GitHub API 拉取图库数据…')
  const url = 'https://api.github.com/repos/aiyaoooo14/ai-pose-gallery-SKILL/contents/data/pose-zh.json'
  const res = await fetch(url, { headers: { 'User-Agent': 'linshe-importer' } })
  if (!res.ok) throw new Error(`图库拉取失败 ${res.status}`)
  const j = await res.json()
  const data = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))
  fs.mkdirSync(path.dirname(RAW_CACHE), { recursive: true })
  fs.writeFileSync(RAW_CACHE, JSON.stringify(data), 'utf8')
  return data
}

function groupByPose(rows) {
  // 同一姿势有多个角度（正面/俯视/仰视/侧面/斜侧）→ 按「姿势编号」归组，只保留一条
  const seen = new Map()
  for (const row of rows) {
    if (!SEX_CATEGORIES.includes(row['分类'])) continue
    const key = `${row['分类']}|${row['姿势编号']}`
    if (seen.has(key)) continue
    seen.set(key, { category: row['分类'], no: row['姿势编号'], name: row['姿势名称'] })
  }
  return [...seen.values()]
}

function loadDone() {
  if (!RESUME || !fs.existsSync(DONE)) return new Set()
  try { return new Set(JSON.parse(fs.readFileSync(DONE, 'utf8'))) } catch { return new Set() }
}

async function main() {
  const rows = await fetchGallery()
  let poses = groupByPose(rows)
  console.log(`图库性相关姿势（按编号去重后）：${poses.length} 条`)
  if (LIMIT) poses = poses.slice(0, LIMIT)

  const done = loadDone()
  const results = []
  fs.mkdirSync(path.dirname(OUT), { recursive: true })

  // 断点：先读回已生成的部分
  if (RESUME && fs.existsSync(OUT)) {
    const prev = fs.readFileSync(OUT, 'utf8')
    const m = prev.match(/export const SEX_POSITIONS_EXTRA = (\[[\s\S]*?\]);/)
    if (m) { try { results.push(...JSON.parse(m[1])) } catch { /* 忽略 */ } }
  }

  let n = 0
  for (const pose of poses) {
    const id = `${pose.category}|${pose.no}`
    n++
    if (done.has(id) || results.some(r => r.no === pose.no && r.category === pose.category)) {
      console.log(`  [${n}/${poses.length}] 跳过（已生成）${pose.name}`)
      continue
    }
    const userPrompt = `分类：${pose.category}\n姿势编号：${pose.no}\n姿势名称：${pose.name}\n\n请输出这个体位的生图参数。`
    let parsed = null
    for (let attempt = 1; attempt <= 4 && !parsed; attempt++) {
      try {
        parsed = parseOne(await callLLM(userPrompt))
        if (!parsed) console.log(`  [${n}/${poses.length}] ${pose.name} 输出不合法，重试 ${attempt}/4`)
      } catch (err) {
        console.log(`  [${n}/${poses.length}] ${pose.name} 调用失败（${err.message.slice(0, 60)}），重试 ${attempt}/4`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    if (!parsed) { console.log(`  [${n}/${poses.length}] ✗ 放弃：${pose.name}`); continue }
    results.push({
      no: pose.no,
      category: pose.category,
      name: pose.name,
      limit: '',
      limitOn: '',
      limitTags: [],
      frozen: parsed.frozen,
      core: parsed.core,
      male: parsed.male,
      female: parsed.female,
      frame: '',
      frames: [],
      negative: parsed.negative,
      prompt: parsed.prompt,
      conflicts: '',
      source: 'pose-gallery',
    })
    done.add(id)
    fs.writeFileSync(DONE, JSON.stringify([...done]), 'utf8')
    // 每 5 条落一次盘，中断不白跑
    if (results.length % 5 === 0) writeOut(results)
    console.log(`  [${n}/${poses.length}] ✓ ${pose.name} → ${parsed.core.slice(0, 3).join(', ')}`)
  }

  writeOut(results)
  execFileSync(process.execPath, ['-e', 'process.exit(0)'])
  console.log(`\n完成：${results.length} 条 → ${path.relative(ROOT, OUT)}`)
}

function writeOut(results) {
  const body = `/**
 * sexPositionsExtra.js — 姿势图库补全的体位（**自动生成，勿手改**）
 *
 * 来源：aiyaoooo14/ai-pose-gallery-SKILL 的中文姿势库，筛出性相关分类后
 * 用本机 LLM 补出 core / male / female / negative / prompt / frozen。
 * 字段口径与 sexPositions.js 完全一致（positionLibrary 会合并两者）。
 * 生成工具：scripts/import-pose-library.mjs
 *
 * 生成时间：${new Date().toISOString().slice(0, 10)}（共 ${results.length} 条）
 */

export const SEX_POSITIONS_EXTRA = ${JSON.stringify(results, null, 2)};
`
  fs.writeFileSync(OUT, body, 'utf8')
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1) })
