/**
 * 自定义工作流（上游 v3.10.0）：选择 → 解析 → 真正被生图链用上。
 *
 * 这一条以前是**死的**：设置页能选「自定义」、也写进了 config.workflow.customTemplate，
 * 但 imageSkill.resolveWorkflowPath 只认 turbo/base/hybrid ⇒ 选了自定义仍然走内置工作流。
 * 这里钉住三件事：
 *   1. resolveCustomWorkflowPath 只接受裸 .json 文件名（防目录穿越），不存在返回 null；
 *   2. custom 模式下生图链解析到的就是那个文件（captureImageGenerationConfig 会记进任务）；
 *   3. 自定义模板缺失时回退内置 turbo，生图不中断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'

const { config } = await import('../src/config.js')
const { resolveCustomWorkflowPath } = await import('../src/services/workflowTemplates.js')
const { captureImageGenerationConfig } = await import('../src/services/imageSkill.js')
const workflowsRouter = (await import('../src/routes/workflows.js')).default

const original = { mode: config.workflow?.mode, customTemplate: config.workflow?.customTemplate }

test.after(() => {
  if (!config.workflow) return
  config.workflow.mode = original.mode
  config.workflow.customTemplate = original.customTemplate
})

test('GET /api/workflows 含内置生图工作流（builtin: true），否则「自定义」开箱不可用', async () => {
  const app = express()
  app.use('/api/workflows', workflowsRouter)
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/workflows`)
    assert.equal(res.status, 200)
    const { workflows } = await res.json()
    const byName = Object.fromEntries(workflows.map(w => [w.filename, w]))
    assert.equal(byName['制图工作流.json']?.builtin, true, 'turbo 内置工作流必须可选')
    assert.equal(byName['制图工作流-pro.json']?.builtin, true, 'base 内置工作流必须可选')
    // 内置的排最前，面板首屏就能选中
    assert.equal(workflows[0].builtin, true)
  } finally {
    server.close()
  }
})

test('resolveCustomWorkflowPath 只认裸 .json 文件名', () => {
  assert.equal(resolveCustomWorkflowPath(''), null)
  assert.equal(resolveCustomWorkflowPath(null), null)
  assert.equal(resolveCustomWorkflowPath('a/b.json'), null)
  assert.equal(resolveCustomWorkflowPath('..\\x.json'), null)
  assert.equal(resolveCustomWorkflowPath('notes.txt'), null)
  assert.equal(resolveCustomWorkflowPath('不存在的模板.json'), null)
  // 仓库里真实存在的内置工作流：允许被当自定义模板选中（用户也可能选它）
  assert.match(resolveCustomWorkflowPath('制图工作流-pro.json') || '', /制图工作流-pro\.json$/)
})

test('custom 模式：生图链解析到所选模板；模板缺失则回退 turbo', () => {
  config.workflow.mode = 'custom'
  config.workflow.customTemplate = '制图工作流-pro.json'
  assert.equal(captureImageGenerationConfig('chat').customWorkflow, '制图工作流-pro.json')

  config.workflow.customTemplate = '被删掉的模板.json'
  assert.equal(captureImageGenerationConfig('chat').customWorkflow, '制图工作流.json', '缺失时必须回退内置 turbo')

  config.workflow.mode = 'turbo'
  assert.equal(captureImageGenerationConfig('chat').customWorkflow, '制图工作流.json')
})
