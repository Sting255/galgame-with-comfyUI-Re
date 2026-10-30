/** Draw in CSS pixels so portrait layouts keep the paper's corners and inset uniform. */
export function galgameFrame(width, height) {
  const w = Math.max(1, width), h = Math.max(1, height)
  const cut = Math.min(46, w * .06, h * .24)
  function path(inset) {
    const x = Math.min(inset, w / 4), y = Math.min(inset, h / 4)
    const c = Math.max(0, cut - inset * .4)
    const points = [[x + c, y], [w - x - c, y], [w - x, y + c],
      [w - x, h - y - c], [w - x - c, h - y], [x + c, h - y],
      [x, h - y - c], [x, y + c]]
    const radius = Math.min(5, c / 3)
    const rounded = points.map((point, i) => {
      const towards = other => {
        const dx = other[0] - point[0], dy = other[1] - point[1]
        const fraction = Math.min(.5, radius / (Math.hypot(dx, dy) || 1))
        return [point[0] + dx * fraction, point[1] + dy * fraction]
      }
      return { point, before: towards(points[(i + 7) % 8]), after: towards(points[(i + 1) % 8]) }
    })
    return `M${rounded[0].before} ` + rounded.map(({ point, before, after }, i) =>
      `${i ? `L${before} ` : ''}Q${point} ${after}`).join(' ') + ' Z'
  }
  return { viewBox: `0 0 ${w} ${h}`, paper: path(3), inner: path(9) }
}
