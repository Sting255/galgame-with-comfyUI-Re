/**
 * 体位骨架 JSON → 姿势控制注入
 *
 * 为什么钉这些：`AnimaPoseControl.detect()` 写死只认一个人，双人参考图检出来是残缺骨架、
 * 出图完全不跟随（实测）。所以体位推进改成跳过检测、直接喂 133 点坐标 ——
 * 这条路上最容易错的是：还留着 LoadImage、`redetect` 忘了关、`pose_json` 串没传进去。
 * 三种都不报错，只是「出图正常但姿势没跟」，最难发现。
 *
 * 另外：骨架 JSON 坏了绝不能让生图整体失败，只能退化成「无姿势出图」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { applyPoseControlFromJson, maybeApplyPoseControl, POSITION_POSE_PORTRAIT_WIDTH, POSITION_POSE_PORTRAIT_HEIGHT } = await import('../src/services/poseControl.js')
const { config, setPoseFromPosition } = await import('../src/config.js')
const { getSetting, initSettingsHandle } = await import('../src/db/settings.js')
const { getDb } = await import('../src/db/index.js')
initSettingsHandle(getDb())

function basePrompt(unetName = 'anima_turboV10.safetensors') {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: unetName, weight_dtype: 'default' } },
    2: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    3: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
    4: { class_type: 'KSampler', inputs: { model: ['1', 0], steps: 12, cfg: 1 } },
  }
}

const POSE_JSON = JSON.stringify({
  canvas: 1024,
  points: [[512, 300, 1], [480, 360, 1], [544, 360, 1]],
})

test('不传 poseJson 且固定参考图关闭：工作流逐字节不变', () => {
  config.comfyui.poseControlEnabled = false
  config.comfyui.poseControlImage = 'ref.png'
  const p = basePrompt()
  const before = JSON.stringify(p)
  const r = maybeApplyPoseControl(p)
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(JSON.stringify(p), before, '没有姿势来源时必须一个字节都不改')
})

test('传 poseJson：跳过检测、直接喂坐标，采样器改吃带姿态控制的主模型', () => {
  config.comfyui.poseControlEnabled = false   // 体位骨架是独立开关，不受固定参考图开关影响
  const p = basePrompt()
  const r = maybeApplyPoseControl(p, { poseJson: POSE_JSON })
  assert.equal(r.applied, true)

  assert.equal(p.pose_ctl_detect.class_type, 'AnimaPoseControl')
  assert.equal(p.pose_ctl_detect.inputs.pose_json, POSE_JSON, 'pose_json 必须原样透传')
  assert.equal(p.pose_ctl_detect.inputs.redetect, false, '喂坐标必须关掉检测')
  assert.equal(p.pose_ctl_detect.inputs.resolution, 1024, '分辨率取 JSON 里的 canvas')

  const loadNodes = Object.values(p).filter(n => n?.class_type === 'LoadImage')
  assert.equal(loadNodes.length, 0, '骨架 JSON 路径不建 LoadImage')

  // 采样器主模型指向注入的 AnimaControlApply（这一条错就整条姿势控制失效）
  assert.deepEqual(p['4'].inputs.model, ['pose_ctl_apply', 0])
  assert.equal(p.pose_ctl_apply.class_type, 'AnimaControlApply')
  assert.deepEqual(p.pose_ctl_apply.inputs.control_latent, ['pose_ctl_vae', 0])

  // 骨架铺满真实生成尺寸（宽高是数字时直接读）
  assert.deepEqual([p.pose_ctl_scale.inputs.width, p.pose_ctl_scale.inputs.height], [768, 1024])
})

test('骨架 JSON 非法：只降级成无姿势，不能弄坏工作流', () => {
  const p = basePrompt()
  const before = JSON.stringify(p)

  assert.throws(() => applyPoseControlFromJson(p, { poseJson: '{不是 JSON' }), /解析失败/)
  assert.equal(JSON.stringify(p), before, '解析失败时不能留下半截注入')

  const r = maybeApplyPoseControl(p, { poseJson: '{不是 JSON' })
  assert.equal(r.applied, false)
  assert.equal(JSON.stringify(p), before, 'maybeApply 也只 warn，不改工作流')

  // 结构不对（缺 points）同样只降级
  const r2 = maybeApplyPoseControl(p, { poseJson: '{"canvas":1024}' })
  assert.equal(r2.applied, false)
  assert.equal(JSON.stringify(p), before)
})

test('重复注入两次不堆节点（幂等）', () => {
  const p = basePrompt()
  maybeApplyPoseControl(p, { poseJson: POSE_JSON })
  maybeApplyPoseControl(p, { poseJson: POSE_JSON })
  const injected = Object.keys(p).filter(k => k.startsWith('pose_ctl_'))
  // detect/scale/vae/lora/apply 共 5 个（JSON 路径没有 load）
  assert.equal(injected.length, 5)
  assert.equal(Object.values(p).filter(n => n?.class_type === 'AnimaPoseControl').length, 1)
  assert.deepEqual(p['4'].inputs.model, ['pose_ctl_apply', 0], '第二次注入后采样器仍指向最终 apply 节点')
})

test('comfyui.poseFromPosition 默认 true，setter 能改并持久化', () => {
  assert.equal(config.comfyui.poseFromPosition, true)

  assert.equal(setPoseFromPosition(false), false)
  assert.equal(config.comfyui.poseFromPosition, false)
  assert.equal(getSetting('comfy_pose_from_position'), '0')

  // 关掉后即使传了 poseJson 也不注入
  const p = basePrompt()
  const before = JSON.stringify(p)
  const r = maybeApplyPoseControl(p, { poseJson: POSE_JSON })
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'pose-from-position-disabled')
  assert.equal(JSON.stringify(p), before)

  assert.equal(setPoseFromPosition(true), true)
  assert.equal(getSetting('comfy_pose_from_position'), '1')
})

test('★ 竖构图：横图工作流会被改成 768x1024，且骨架 scale 与 latent 同步', () => {
  // 实测依据（2026-11-03）：骨架铺满画布，横图会把趴跪/侧卧画成近景特写；竖图才有完整双人构图。
  const p = basePrompt()
  p[3].inputs.width = 768
  p[3].inputs.height = 512
  const r = applyPoseControlFromJson(p, { poseJson: POSE_JSON, portrait: true })
  assert.equal(r.applied, true)
  assert.equal(p[3].inputs.width, POSITION_POSE_PORTRAIT_WIDTH)
  assert.equal(p[3].inputs.height, POSITION_POSE_PORTRAIT_HEIGHT)
  const scale = Object.values(p).find(n => n.class_type === 'ImageScale')
  assert.equal(scale.inputs.width, POSITION_POSE_PORTRAIT_WIDTH, '骨架缩放尺寸必须跟 latent 一致，否则骨架被拉伸变形')
  assert.equal(scale.inputs.height, POSITION_POSE_PORTRAIT_HEIGHT)
})

test('竖构图开关关闭时沿用工作流原尺寸；本来就是竖图时不动', () => {
  const wide = basePrompt()
  wide[3].inputs.width = 768
  wide[3].inputs.height = 512
  applyPoseControlFromJson(wide, { poseJson: POSE_JSON, portrait: false })
  assert.equal(wide[3].inputs.width, 768, '关掉竖构图就保持原尺寸')
  assert.equal(wide[3].inputs.height, 512)

  const tall = basePrompt()   // 夹具本来就是 768x1024
  applyPoseControlFromJson(tall, { poseJson: POSE_JSON, portrait: true })
  assert.equal(tall[3].inputs.width, 768)
  assert.equal(tall[3].inputs.height, 1024)
})
