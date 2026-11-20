/** Crop coordinates stay in source pixels so resizing the editor never shifts the selection. */
export function backgroundCrop(width, height, aspect, zoom = 1, centerX = .5, centerY = .5) {
  const w = Math.min(width, height * aspect) / Math.max(1, zoom)
  const h = w / aspect
  return { x: Math.max(0, Math.min(width - w, centerX * width - w / 2)), y: Math.max(0, Math.min(height - h, centerY * height - h / 2)), w, h }
}
