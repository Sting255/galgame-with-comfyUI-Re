/**
 * 姿势控制注入：在 ComfyUI API prompt 上插节点、改采样器主模型
 *
 * 为什么钉这些：注入是「开关打开后每张图都走」的路径，插错一个节点或漏改 KSampler.model，
 * 表现是「出图正常但姿势完全没跟」——不报错，最难发现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
const { applyPoseControl, maybeApplyPoseControl, POSE_LORA_FILE } = await import('../src/services/poseControl.js')
const { config } = await import('../src/config.js')

function basePrompt(unetName = 'anima_turboV10.safetensors') {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: unetName, weight_dtype: 'default' } },
    2: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    3: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
    4: { class_type: 'KSampler', inputs: { model: ['1', 0], steps: 12, cfg: 1 } },
  }
}

test('注入后采样器改吃「带姿态控制」的主模型，且节点链完整', () => {
  const p = basePrompt()
  const r = applyPoseControl(p, { imageName: 'ref.png' })
  assert.equal(r.applied, true)

  // 采样器主模型必须换成 apply 节点
  assert.deepEqual(p['4'].inputs.model, ['pose_ctl_apply', 0])

  assert.equal(p.pose_ctl_load.class_type, 'LoadImage')
  assert.equal(p.pose_ctl_load.inputs.image, 'ref.png')
  assert.equal(p.pose_ctl_detect.class_type, 'AnimaPoseControl')
  assert.equal(p.pose_ctl_detect.inputs.style, 'R0_thin', '用官方唯一训练过的细线骨架')
  assert.equal(p.pose_ctl_scale.class_type, 'ImageScale')
  // 骨架直接铺满目标尺寸（补黑边会让骨架缩小、模型不跟随，实测过）
  assert.deepEqual([p.pose_ctl_scale.inputs.width, p.pose_ctl_scale.inputs.height], [768, 1024])
  assert.equal(p.pose_ctl_vae.class_type, 'VAEEncode')
  assert.deepEqual(p.pose_ctl_vae.inputs.vae, ['2', 0], 'VAE 复用工作流里那个')
  assert.equal(p.pose_ctl_lora.inputs.lora_name, POSE_LORA_FILE)
  assert.deepEqual(p.pose_ctl_lora.inputs.model, ['1', 0], '适配器接在 UNET 之后')
  assert.equal(p.pose_ctl_apply.inputs.control_embedder_path, POSE_LORA_FILE)
  assert.deepEqual(p.pose_ctl_apply.inputs.control_latent, ['pose_ctl_vae', 0])
})

test('骨架分辨率固定 1024（768 档实测几乎不跟随）', () => {
  for (const [w, h] of [[512, 512], [768, 512], [832, 1216]]) {
    const p = basePrompt()
    p['3'].inputs.width = w
    p['3'].inputs.height = h
    assert.equal(applyPoseControl(p, { imageName: 'r.png' }).resolution, 1024, `${w}x${h} 也走 1024`)
  }
})

test('重复注入是幂等的，不会堆出一串同名节点', () => {
  const p = basePrompt()
  applyPoseControl(p, { imageName: 'a.png' })
  applyPoseControl(p, { imageName: 'b.png' })
  const injected = Object.keys(p).filter(k => k.startsWith('pose_ctl_'))
  assert.equal(injected.length, 6, 'load/detect/scale/vae/lora/apply 共 6 个')
  assert.equal(p.pose_ctl_load.inputs.image, 'b.png', '第二次要覆盖成新图')
})

test('非 anima 模型：明确拒绝注入，不静默出一张没受控的图', () => {
  const p = basePrompt('krea2_turbo_fp8_scaled.safetensors')
  const r = applyPoseControl(p, { imageName: 'r.png' })
  assert.equal(r.applied, false)
  assert.match(r.reason, /只支持 Anima/)
  assert.deepEqual(p['4'].inputs.model, ['1', 0], '拒绝时不能改动原工作流')
})

test('工作流缺关键节点时抛错而不是装作成功', () => {
  const p = { 4: { class_type: 'KSampler', inputs: { model: ['1', 0] } } }
  assert.throws(() => applyPoseControl(p, { imageName: 'r.png' }), /UNETLoader/)
})

test('开关关着时完全不碰工作流', () => {
  config.comfyui.poseControlEnabled = false
  config.comfyui.poseControlImage = 'r.png'
  const p = basePrompt()
  const before = JSON.stringify(p)
  const r = maybeApplyPoseControl(p)
  assert.equal(r.applied, false)
  assert.equal(JSON.stringify(p), before, '关掉开关必须逐字节不变')
})

test('开关开着但没有参考图：不动工作流', () => {
  config.comfyui.poseControlEnabled = true
  config.comfyui.poseControlImage = ''
  const p = basePrompt()
  const r = maybeApplyPoseControl(p)
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'no-image')
  config.comfyui.poseControlEnabled = false
})

test('★ 宽高是 PrimitiveInt 连线注入时，也要解析出真实数值', () => {
  const p = basePrompt()
  p['10'] = { class_type: 'PrimitiveInt', inputs: { value: 768 } }
  p['11'] = { class_type: 'PrimitiveInt', inputs: { value: 512 } }
  p['3'].inputs.width = ['10', 0]
  p['3'].inputs.height = ['11', 0]
  const r = applyPoseControl(p, { imageName: 'r.png' })
  assert.deepEqual([p.pose_ctl_scale.inputs.width, p.pose_ctl_scale.inputs.height], [768, 512], '骨架铺满真实生成尺寸')
  assert.equal(r.resolution, 1024)
})
