import test from 'node:test'
import assert from 'node:assert/strict'
import { backgroundCrop } from '../src/utils/backgroundCrop.js'

test('portrait and landscape framing select source pixels without stretching', () => {
  assert.deepEqual(backgroundCrop(1600, 900, 1), { x: 350, y: 0, w: 900, h: 900 })
  assert.deepEqual(backgroundCrop(900, 1600, 1), { x: 0, y: 350, w: 900, h: 900 })
  assert.deepEqual(backgroundCrop(1600, 900, 16 / 9), { x: 0, y: 0, w: 1600, h: 900 })
})

test('zoom and extreme dragging never expose empty pixels outside the image', () => {
  for (const aspect of [9 / 16, 16 / 9, 1, .3, 3]) {
    for (const zoom of [1, 2, 5]) {
      for (const center of [-10, 0, .5, 1, 10]) {
        const { x, y, w, h } = backgroundCrop(2000, 1200, aspect, zoom, center, center)
        assert.ok(x >= 0 && y >= 0 && x + w <= 2000 + 1e-9 && y + h <= 1200 + 1e-9)
        assert.ok(Math.abs(w / h - aspect) < 1e-9)
      }
    }
  }
  assert.deepEqual(backgroundCrop(1600, 900, 16 / 9, 2, 1, 0), { x: 800, y: 0, w: 800, h: 450 })
})
