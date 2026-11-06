/** 保留 TAP 失败块，并把子进程异常纳入判定，避免摘要看似全绿。 */
export function testProcessDiagnostics(result) {
  const output = (result.stdout || '') + (result.stderr || '')
  const lines = output.split(/\r?\n/)
  const blocks = []
  for (let i = 0; i < lines.length && blocks.length < 10; i++) {
    if (!/^\s*not ok \d+/.test(lines[i])) continue
    const block = [lines[i]]
    for (let j = i + 1; j < lines.length && block.length < 50; j++) {
      if (/^\s*(?:not ok|ok) \d+|^# Subtest:/.test(lines[j])) break
      block.push(lines[j])
      if (/^\s*\.\.\.\s*$/.test(lines[j])) break
    }
    blocks.push(block.join('\n'))
  }
  const problems = []
  if (result.error) problems.push(`测试进程错误：${result.error.message}`)
  if (result.signal) problems.push(`测试进程信号：${result.signal}`)
  if (result.status !== 0) problems.push(`测试进程退出码：${result.status ?? '无'}`)
  // 启动失败可能没有 TAP；只保留末尾少量输出。
  const diagnostics = blocks.length ? blocks.join('\n\n') : problems.length ? lines.slice(-30).join('\n') : ''
  return { problems, diagnostics: diagnostics.slice(0, 16000) }
}
