/**
 * 体位骨架（positionPoseSkeletons + positionPose）的契约测试
 *
 * 盯的是三件事，任何一件破了生图都会画出错姿势：
 *   1. 骨架数据本身合法：POSTURE_GROUPS 的 11 类都有骨架、点集非空、坐标在画布内且是整数；
 *   2. buildPoseJson 展开口径对：恰好 133 点（COCO-WholeBody），用到的点 score=1、未用点 score=0，
 *      否则 AnimaPoseControl 会把 [0,0] 当成"手在左上角"硬画出来；
 *   3. 映射无空洞：词库里每一条体位都能落到某个形态大类并拿到骨架，认不出的输入一律 null 不抛错。
 *
 * ⚠ 只读现有实现，不改。三处「现状与预期不一致」的地方在断言旁标了 `已知`，
 *   是为了让缺口在测试里留痕，不是把 bug 钉死 —— 上层补了映射/校验后按注释改成新口径即可。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'

const pose = await import('../src/services/positionPose.js')
const lib = await import('../src/services/positionLibrary.js')
const skeletonData = await import('../src/data/positionPoseSkeletons.js')
const { POSTURE_SKELETONS, SKELETON_CANVAS } = skeletonData
const { POSE_POINT_COUNT, buildPoseJson, skeletonOf, poseJsonForPositionKey, poseJsonForPositionObject, listSkeletons } = pose
const { POSITIONS, POSTURE_GROUPS, postureOf, getPosition, resolvePositionKey } = lib

/** COCO-18 的 18 个基础身体点（0-16 身体 / 17-22 脚 / 23+ 脸与手） */
const COCO18 = Array.from({ length: 17 }, (_, i) => i)

test('每个形态大类在骨架表里都存在，且每个骨架点集非空', () => {
  // 大类数量会随分类规则演进（2026-11-03 加了 onside 侧卧），所以不写死数字，只要求一一对应
  assert.ok(POSTURE_GROUPS.length >= 11, 'POSTURE_GROUPS 至少 11 类（含 other）')
  assert.ok(POSTURE_GROUPS.some(g => g.key === 'other'), '必须有兜底大类 other')
  assert.deepEqual(
    POSTURE_GROUPS.map(g => g.key).sort(),
    Object.keys(POSTURE_SKELETONS).sort(),
    '骨架表的 key 必须与 POSTURE_GROUPS 一一对应，不能多也不能少',
  )
  for (const g of POSTURE_GROUPS) {
    const s = POSTURE_SKELETONS[g.key]
    assert.ok(s, `缺少 ${g.key} 的骨架`)
    assert.equal(typeof s.label, 'string')
    assert.ok(['front', 'side', 'back', 'top'].includes(s.view), `${g.key}.view 非法：${s.view}`)
    assert.ok(s.points && Object.keys(s.points).length > 0, `${g.key} 的 points 不能为空`)
  }
})

test('骨架坐标是归一化值（0~1），索引落在 COCO-18 身体点范围内', () => {
  for (const [key, s] of Object.entries(POSTURE_SKELETONS)) {
    for (const [rawIdx, xy] of Object.entries(s.points)) {
      const idx = Number(rawIdx)
      assert.ok(Number.isInteger(idx) && idx >= 0 && idx < POSE_POINT_COUNT, `${key} 抽出非法索引 ${rawIdx}`)
      assert.ok(COCO18.includes(idx), `${key} 用了身体点之外的索引 ${idx}（当前只画 0-16）`)
      assert.ok(Array.isArray(xy) && xy.length >= 2, `${key}#${idx} 坐标格式错`)
      for (const v of xy.slice(0, 2)) {
        assert.ok(typeof v === 'number' && v >= 0 && v <= 1, `${key}#${idx} 归一化坐标越界：${v}`)
      }
    }
  }
})

test('buildPoseJson：恰好 133 点，用到的点 score=1，未用点 score=0', () => {
  for (const [key, s] of Object.entries(POSTURE_SKELETONS)) {
    const out = buildPoseJson(s)
    assert.equal(out.canvas, SKELETON_CANVAS)
    assert.equal(out.points.length, POSE_POINT_COUNT)
    assert.equal(POSE_POINT_COUNT, 133, 'AnimaPoseControl 吃的是 COCO-WholeBody 133 点')
    const used = new Set(Object.keys(s.points).map(Number))
    out.points.forEach((p, i) => {
      assert.equal(Array.isArray(p) && p.length, 3, `${key} 第 ${i} 点不是 [x,y,score]`)
      if (used.has(i)) assert.equal(p[2], 1, `${key} 第 ${i} 点是骨架点，score 应为 1`)
      else assert.deepEqual(p, [0, 0, 0], `${key} 第 ${i} 点未使用，必须 [0,0,0]（否则会凭空长出手指）`)
    })
  }
})

test('buildPoseJson：坐标是 [0,canvas] 内的整数', () => {
  for (const [key, s] of Object.entries(POSTURE_SKELETONS)) {
    const out = buildPoseJson(s)
    out.points.forEach((p, i) => {
      for (const v of p) assert.ok(Number.isInteger(v), `${key}#${i} 坐标必须是整数，实际 ${v}`)
      if (p[2] === 1) {
        assert.ok(p[0] >= 0 && p[0] <= SKELETON_CANVAS, `${key}#${i}.x 越界：${p[0]}`)
        assert.ok(p[1] >= 0 && p[1] <= SKELETON_CANVAS, `${key}#${i}.y 越界：${p[1]}`)
      }
    })
  }
})

test('buildPoseJson 容错：缺 points / 非法索引 / 越界坐标都不抛错', () => {
  assert.equal(buildPoseJson(undefined).points.length, 133)
  assert.equal(buildPoseJson({}).points.length, 133)
  const out = buildPoseJson({ points: { 999: [0.5, 0.5], bad: [0.1, 0.1], 5: [9, -3], 6: [0.5, 0.5] } })
  assert.deepEqual(out.points[5], [SKELETON_CANVAS, 0, 1], '越界坐标应被 clamp 到画布内')
  assert.equal(out.points.filter(p => p[2] === 1).length, 2, '只应保留索引 5、6 两个点（999/bad 被跳过）')
  assert.deepEqual(out.points[100], [0, 0, 0], '越界索引 999 不应写进结果')
})

test('skeletonOf：未知/空 key 回落到 other，不抛错', () => {
  assert.equal(skeletonOf('riding'), POSTURE_SKELETONS.riding)
  assert.equal(skeletonOf('no-such-group'), POSTURE_SKELETONS.other)
  assert.equal(skeletonOf(undefined), POSTURE_SKELETONS.other)
  assert.equal(skeletonOf(''), POSTURE_SKELETONS.other)
})

test('listSkeletons：条数与大类数一致，每条都报出关节数', () => {
  const list = listSkeletons()
  assert.equal(list.length, POSTURE_GROUPS.length)
  for (const s of list) {
    assert.ok(POSTURE_SKELETONS[s.key], `listSkeletons 出现未知 key ${s.key}`)
    assert.ok(s.joints > 0, `${s.key} 关节数为 0`)
    assert.equal(typeof s.label, 'string')
  }
})

test('★ 无空洞：词库里每一条体位都能拿到骨架，且大类属于已有大类', () => {
  const groupKeys = POSTURE_GROUPS.map(g => g.key)
  assert.ok(POSITIONS.length > 0, '词库不该为空')
  const empty = []
  for (const p of POSITIONS) {
    const r = poseJsonForPositionObject(p)
    if (!r || !r.json) { empty.push(p.key); continue }
    assert.ok(groupKeys.includes(r.group), `${p.key} 落到了非法大类 ${r.group}`)
    const parsed = JSON.parse(r.json)
    assert.equal(parsed.canvas, SKELETON_CANVAS)
    assert.equal(parsed.points.length, 133)
    assert.ok(parsed.points.some(pt => pt[2] === 1), `${p.key} 的骨架全是未使用点`)
  }
  assert.deepEqual(empty, [], `以下体位拿不到骨架：${empty.join(', ')}`)
})

test('postureOf 的分组结果全部落在 POSTURE_GROUPS 内', () => {
  const groupKeys = new Set(POSTURE_GROUPS.map(g => g.key))
  for (const p of POSITIONS) {
    assert.ok(groupKeys.has(postureOf(p)), `${p.key} 的 postureOf=${postureOf(p)} 不在 11 类里`)
  }
})

test('poseJsonForPositionKey：词库 key 可用（含图库补的 gP 前缀）', () => {
  const samples = ['pr24.gP001.vaginal', POSITIONS[0].key, POSITIONS[POSITIONS.length - 1].key]
  for (const key of samples) {
    assert.ok(getPosition(key), `样本 key 不存在于词库：${key}`)
    const r = poseJsonForPositionKey(key)
    assert.ok(r && r.json, `${key} 应能拿到骨架`)
    assert.ok(r.group && r.groupLabel && r.view && r.note, `${key} 返回对象缺字段`)
    assert.equal(JSON.parse(r.json).canvas, SKELETON_CANVAS)
  }
})

test('poseJsonForPositionKey：按编号/中文名也能归一到骨架', () => {
  const first = POSITIONS[0]
  const byNo = poseJsonForPositionKey(first.no)
  assert.ok(byNo && byNo.json, `编号 ${first.no} 应能解析出骨架`)
  assert.equal(byNo.group, postureOf(first))
  if (first.name) {
    const byName = poseJsonForPositionKey(first.name)
    assert.ok(byName && byName.json, `中文名 ${first.name} 应能解析出骨架`)
  }
})

test('poseJsonForPositionKey：空值/不存在的 key 返回 null，不抛错', () => {
  for (const bad of ['', '   ', null, undefined, 'not-a-real-position.zzz', 'pr24.999.vaginal']) {
    assert.equal(poseJsonForPositionKey(bad), null, `${String(bad)} 应返回 null`)
  }
})

test('poseJsonForPositionObject：非对象返回 null，不抛错', () => {
  for (const bad of [null, undefined, 0, '', 'missionary']) {
    assert.equal(poseJsonForPositionObject(bad), null, `${String(bad)} 应返回 null`)
  }
})

test('★ 残缺体位对象不注入骨架（{} / [] / 只有无关字段）', () => {
  // 2026-11-03 修：空对象原来会按 other 画一具四足支撑，
  // 上层以为"注入成功"，实际画的是与剧情无关的姿势 —— 宁可不注入。
  assert.equal(poseJsonForPositionObject({}), null)
  assert.equal(poseJsonForPositionObject([]), null)
  assert.equal(poseJsonForPositionObject({ key: 'x' }), null)
  assert.ok(poseJsonForPositionObject({ core: ['doggystyle'] })?.json, '有身体标签时才给骨架')
  assert.ok(poseJsonForPositionObject({ name: '后入位' })?.json, '只有中文名也算有内容')
})

test('★ 精选 17 条英文打包 key 也能拿到骨架（按文本判大类兜底）', async () => {
  // 精选表（PREFERRED_POSITION_KEYS）用的是 'missionary' / 'doggystyle' 这类英文打包串，
  // 与词库的 'pr24.xxx.yyy' 是两套命名空间。2026-11-03 修：词库查不到时按文本判大类，
  // 老数据（用精选 key 存下来的场景）不会因此没有骨架。
  const { PREFERRED_POSITION_KEYS } = await import('../src/services/intimateActionService.js')
  assert.equal(PREFERRED_POSITION_KEYS.length, 17)
  const groupKeys = POSTURE_GROUPS.map(g => g.key)
  for (const key of PREFERRED_POSITION_KEYS) {
    const r = poseJsonForPositionKey(key)
    assert.ok(r && r.json, `${key} 必须能拿到骨架`)
    assert.ok(groupKeys.includes(r.group), `${key} 的大类 ${r.group} 不在大类表里`)
  }
})

test('结果 JSON 能被 AnimaPoseControl 直接吃：canvas + 133 点三元组', () => {
  const r = poseJsonForPositionKey(POSITIONS[0].key)
  const parsed = JSON.parse(r.json)
  assert.deepEqual(Object.keys(parsed).sort(), ['canvas', 'points'])
  assert.equal(parsed.canvas, 1024)
  assert.equal(parsed.points.length, 133)
  for (const p of parsed.points) {
    assert.equal(p.length, 3)
    assert.ok(p.every(Number.isInteger))
    assert.ok([0, 1].includes(p[2]), 'score 只应是 0 或 1')
  }
})
