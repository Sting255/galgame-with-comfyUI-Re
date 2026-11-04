/**
 * 随包自带的姿势控制资产 → 自动装进目标 ComfyUI
 *
 * 2026-11-03 用户口径：「别的机器没有指定的文件或者的节点 你就直接包含在里面
 * 用的时候调用就行了 这样多方便 还不用单独再写一份文件」
 *
 * 钉死三件事：
 *   1. 路径齐全时把「自定义节点 + 姿态 LoRA + 检测模型」都装过去；
 *   2. **幂等**：已经装过就不再复制（不能覆盖用户自己装的版本）；
 *   3. 找不到 ComfyUI / 没有随包资产时**安静返回**，绝不抛错影响启动。
 *
 * ⚠️ 本测试覆盖过一个真事故：`fs.cpSync` 在 Windows + 中文路径 + Node 22 上会
 * 静默终止整个进程（连 try/catch 都拦不住）。所以实现改成了手写递归复制，
 * 这里也顺带保证「走的是 copyFileSync 那条路」——用真实临时目录跑一遍即可。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = ':memory:'
const mod = await import('../src/services/poseControlInstall.js')

const temporaryDirs = []
function tmpdir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pose-install-${tag}-`))
  temporaryDirs.push(dir)
  return dir
}
after(() => { for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true }) })

test('找不到 ComfyUI 路径：安静返回，不抛错', () => {
  const r = mod.ensurePoseControlAssets({ comfyRoot: null, bundledDir: 'D:/definitely-not-here' })
  assert.equal(r.ok, false)
  assert.ok(r.skipped.some(s => s.includes('ComfyUI')))
})

test('没有随包资产：安静返回，不抛错', () => {
  const root = tmpdir('nobundle')
  const r = mod.ensurePoseControlAssets({ comfyRoot: root, bundledDir: path.join(root, 'nope') })
  assert.equal(r.ok, false)
  assert.ok(r.skipped.some(s => s.includes('assets/pose-control')))
})

test('★ 齐全时四类资产都装过去，且第二次是幂等的', () => {
  // 造一份迷你"随包资产"：节点目录 + 一个假 LoRA + 一个假 onnx
  const bundle = tmpdir('bundle')
  const nodeDir = path.join(bundle, 'custom_nodes', 'ComfyUI-anima-pose-control')
  fs.mkdirSync(nodeDir, { recursive: true })
  fs.writeFileSync(path.join(nodeDir, 'node.py'), '# fake node\n')
  fs.writeFileSync(path.join(nodeDir, '__init__.py'), '# fake init\n')
  const loraDir = path.join(bundle, 'models', 'loras')
  fs.mkdirSync(loraDir, { recursive: true })
  fs.writeFileSync(path.join(loraDir, mod.POSE_LORA_FILE || 'anima_pose_preview2.safetensors'), 'fake-lora')
  const detDir = path.join(bundle, 'detectors')
  fs.mkdirSync(detDir, { recursive: true })
  fs.writeFileSync(path.join(detDir, 'yolox_test.onnx'), 'fake-onnx')

  const comfyRoot = tmpdir('comfy')
  const rtmlib = tmpdir('rtmlib')
  const r = mod.ensurePoseControlAssets({ comfyRoot, bundledDir: bundle, rtmlibDir: rtmlib })

  assert.equal(r.ok, true, JSON.stringify(r.failed))
  assert.ok(fs.existsSync(path.join(comfyRoot, 'custom_nodes', 'ComfyUI-anima-pose-control', 'node.py')), '节点必须装过去')
  assert.ok(fs.existsSync(path.join(comfyRoot, 'models', 'loras', 'anima_pose_preview2.safetensors')), 'LoRA 必须装过去')
  assert.ok(fs.existsSync(path.join(rtmlib, 'yolox_test.onnx')), '检测模型必须装过去')

  // 第二次：一个字节都不该重新复制
  const again = mod.ensurePoseControlAssets({ comfyRoot, bundledDir: bundle, rtmlibDir: rtmlib })
  assert.deepEqual(again.copied, [], '幂等：已装好就不该再复制')
  assert.deepEqual(again.failed, [])
})

test('dryRun 只探测不写盘', () => {
  const bundle = tmpdir('bundle2')
  fs.mkdirSync(path.join(bundle, 'custom_nodes'), { recursive: true })
  const comfyRoot = tmpdir('comfy2')
  const r = mod.ensurePoseControlAssets({ comfyRoot, bundledDir: bundle, dryRun: true })
  assert.deepEqual(r.copied, [])
  assert.equal(fs.readdirSync(comfyRoot).length, 0, 'dryRun 不能写任何东西')
})

test('用户已有不同大小的模型与部分节点文件均保留，只补缺少的文件', () => {
  const root = tmpdir('preserve')
  const bundle = path.join(root, 'bundle'), comfy = path.join(root, 'comfy'), cache = path.join(root, 'cache')
  const node = 'custom_nodes/ComfyUI-anima-pose-control'
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  write(path.join(bundle, node, 'node.py'), '# bundled node')
  write(path.join(bundle, node, '__init__.py'), '# bundled init')
  write(path.join(comfy, node, '__init__.py'), '# user modified init must survive')
  const lora = 'models/loras/anima_pose_preview2.safetensors'
  write(path.join(bundle, lora), 'old')
  write(path.join(comfy, lora), 'user upgraded model')
  write(path.join(bundle, 'detectors', 'detector.onnx'), 'old detector')
  write(path.join(cache, 'detector.onnx'), 'user detector with different bytes')
  const result = mod.ensurePoseControlAssets({ comfyRoot: comfy, bundledDir: bundle, rtmlibDir: cache })
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(comfy, lora), 'utf8'), 'user upgraded model')
  assert.equal(fs.readFileSync(path.join(cache, 'detector.onnx'), 'utf8'), 'user detector with different bytes')
  assert.equal(fs.readFileSync(path.join(comfy, node, '__init__.py'), 'utf8'), '# user modified init must survive')
  assert.equal(fs.readFileSync(path.join(comfy, node, 'node.py'), 'utf8'), '# bundled node')
})

test('缺失必须的随包资产不报告安装成功', () => {
  const bundle = tmpdir('incomplete'), comfy = tmpdir('target')
  const result = mod.ensurePoseControlAssets({ comfyRoot: comfy, bundledDir: bundle, rtmlibDir: path.join(comfy, 'cache') })
  assert.equal(result.ok, false)
  assert.ok(result.skipped.some(item => item.includes('自定义节点')))
})
