import { test } from 'node:test'
import assert from 'node:assert/strict'
import { testProcessDiagnostics } from '../../scripts/lib/testResults.mjs'

test('即使 TAP 摘要全绿，进程退出异常仍使门禁失败', () => {
  const result = testProcessDiagnostics({ status: 1, stdout: '# tests 1\n# pass 1\n# fail 0' })
  assert.match(result.problems.join(' '), /退出码：1/)
  assert.match(result.diagnostics, /# fail 0/)
  assert.deepEqual(testProcessDiagnostics({ status: 0, stdout: '# fail 0' }).problems, [])
})

test('保留嵌套 TAP 失败原因和堆栈；启动异常不依赖 TAP', () => {
  const result = testProcessDiagnostics({ status: 1, stdout: '    not ok 1 - connection\n      ---\n      error: EADDRINUSE\n      stack: server.listen\n      ...\n    ok 2 - next' })
  assert.match(result.diagnostics, /EADDRINUSE/)
  assert.match(result.diagnostics, /server.listen/)
  assert.doesNotMatch(result.diagnostics, /ok 2/)
  const failed = testProcessDiagnostics({ status: null, signal: 'SIGTERM', error: new Error('ENOENT'), stderr: 'spawn failed' })
  assert.equal(failed.problems.length, 3)
  assert.match(failed.diagnostics, /spawn failed/)
})
