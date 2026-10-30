import test from 'node:test'
import assert from 'node:assert/strict'
import { galgameFrame } from '../src/utils/galgameFrame.js'

test('paper paths use the measured portrait and landscape sizes with a uniform pixel inset', () => {
  for (const [width, height] of [[300, 174], [349, 198], [756, 118], [1152, 252]]) {
    const frame = galgameFrame(width, height)
    assert.equal(frame.viewBox, `0 0 ${width} ${height}`)
    for (const [path, inset] of [[frame.paper, 3], [frame.inner, 9]]) {
      const numbers = path.match(/-?\d+(?:\.\d+)?/g).map(Number)
      const xs = numbers.filter((_, i) => i % 2 === 0)
      const ys = numbers.filter((_, i) => i % 2 === 1)
      assert.equal(Math.min(...xs), inset)
      assert.equal(Math.max(...xs), width - inset)
      assert.equal(Math.min(...ys), inset)
      assert.equal(Math.max(...ys), height - inset)
      assert.ok(path.endsWith('Z'))
    }
  }
})
