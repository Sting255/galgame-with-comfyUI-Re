<template>
  <linshe-modal :model-value="modelValue" :title="title" wide :transition-ms="300" @update:model-value="close">
    <div class="bg-crop-editor">
      <linshe-tabs v-model="ratio" size="sm" :disabled="saving" :options="ratios" aria-label="背景裁剪比例" />
      <p class="bg-crop-tip">拖动图片调整取景，滚轮或双指缩放。框内就是保存后的画面。</p>
      <div class="bg-crop-stage">
        <div ref="frame" class="bg-crop-frame" :class="{ 'is-saving': saving }" :style="{ aspectRatio: aspect, width: `min(100%, ${aspect * 420}px, ${aspect * 48}dvh)` }" tabindex="0" role="group" aria-label="背景取景，方向键移动，加减键缩放" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd" @pointercancel="pointerEnd" @lostpointercapture="pointerEnd" @wheel.prevent="wheel" @keydown="keyMove">
          <img ref="image" :src="src" :style="imageStyle" alt="待裁剪的背景" draggable="false" @load="loaded" @error="error = '图片读取失败，请重新选择'" />
          <div v-if="ready" class="bg-crop-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
          <span v-else class="bg-crop-loading">{{ error || '读取图片中…' }}</span>
        </div>
      </div>
      <div class="bg-crop-tools">
        <linshe-button size="sm" variant="secondary" :disabled="!ready || saving || zoom <= 1" aria-label="缩小" @click="setZoom(zoom / 1.15)">−</linshe-button>
        <span>{{ Math.round(zoom * 100) }}%</span>
        <linshe-button size="sm" variant="secondary" :disabled="!ready || saving || zoom >= 5" aria-label="放大" @click="setZoom(zoom * 1.15)">＋</linshe-button>
        <linshe-button size="sm" variant="ghost" :disabled="saving" @click="reset">重置取景</linshe-button>
      </div>
      <p class="bg-crop-tip">默认匹配当前聊天窗口；其他屏幕比例可能会裁去部分边缘。</p>
      <p v-if="error && ready" class="bg-crop-error" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <linshe-button variant="ghost" :disabled="saving" @click="close">取消</linshe-button>
      <linshe-button variant="primary" :disabled="!ready || saving" :loading="saving" @click="confirm">保存取景</linshe-button>
    </template>
  </linshe-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import LinsheModal from './ui/LinsheModal.vue'
import LinsheTabs from './ui/LinsheTabs.vue'
import LinsheButton from './ui/LinsheButton.vue'
import { backgroundCrop } from '../utils/backgroundCrop.js'

const props = defineProps({ modelValue: Boolean, src: { type: String, default: '' }, title: { type: String, default: '背景取景' }, aspectRatio: { type: Number, default: 16 / 9 }, saving: Boolean })
const emit = defineEmits(['update:modelValue', 'save'])
const image = ref(null), frame = ref(null)
const width = ref(0), height = ref(0), zoom = ref(1), centerX = ref(.5), centerY = ref(.5), ratio = ref('window'), error = ref('')
const pointers = new Map()
const ratios = [{ label: '当前窗口', value: 'window' }, { label: '横屏', value: 'wide' }, { label: '竖屏', value: 'tall' }, { label: '原图比例', value: 'original' }]
const ready = computed(() => width.value > 0 && height.value > 0)
const aspect = computed(() => ratio.value === 'wide' ? 16 / 9 : ratio.value === 'tall' ? 9 / 16 : ratio.value === 'original' && ready.value ? width.value / height.value : props.aspectRatio)
const crop = computed(() => backgroundCrop(width.value, height.value, aspect.value, zoom.value, centerX.value, centerY.value))
const imageStyle = computed(() => !ready.value ? { opacity: 0 } : { width: `${width.value / crop.value.w * 100}%`, height: `${height.value / crop.value.h * 100}%`, left: `${-crop.value.x / crop.value.w * 100}%`, top: `${-crop.value.y / crop.value.h * 100}%` })
function reset() { zoom.value = 1; centerX.value = .5; centerY.value = .5; pointers.clear() }
watch(() => props.src, () => { width.value = 0; height.value = 0; error.value = ''; ratio.value = 'window'; reset() })
watch(ratio, reset)
function loaded() { width.value = image.value.naturalWidth; height.value = image.value.naturalHeight; error.value = ''; reset() }
function close() { if (!props.saving) { pointers.clear(); emit('update:modelValue', false) } }
function keepCenter() { centerX.value = (crop.value.x + crop.value.w / 2) / width.value; centerY.value = (crop.value.y + crop.value.h / 2) / height.value }
function setZoom(value) { if (!ready.value || props.saving) return; keepCenter(); zoom.value = Math.max(1, Math.min(5, value)); keepCenter() }
function move(dx, dy) {
  if (!ready.value || props.saving) return
  const rect = frame.value.getBoundingClientRect(), current = crop.value
  centerX.value = (current.x + current.w / 2 - dx * current.w / rect.width) / width.value
  centerY.value = (current.y + current.h / 2 - dy * current.h / rect.height) / height.value
  keepCenter()
}
function pointerDown(e) { if (!ready.value || props.saving || (e.pointerType === 'mouse' && e.button !== 0)) return; e.preventDefault(); frame.value.focus({ preventScroll: true }); frame.value.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }) }
function pointerMove(e) {
  if (!pointers.has(e.pointerId)) return
  const before = [...pointers.values()], old = pointers.get(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2) {
    const after = [...pointers.values()], distance = p => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
    if (distance(before) > 0) setZoom(zoom.value * distance(after) / distance(before))
  } else if (pointers.size === 1) move(e.clientX - old.x, e.clientY - old.y)
}
function pointerEnd(e) { pointers.delete(e.pointerId) }
function wheel(e) { setZoom(zoom.value * Math.exp(-e.deltaY * .0015)) }
function keyMove(e) {
  const offsets = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] }
  if (offsets[e.key]) { e.preventDefault(); move(...offsets[e.key]) }
  else if (['+', '=', '-'].includes(e.key)) { e.preventDefault(); setZoom(zoom.value * (e.key === '-' ? 1 / 1.15 : 1.15)) }
}
function confirm() {
  if (!ready.value || props.saving) return
  try {
    const { x, y, w, h } = crop.value, scale = Math.min(1, 1600 / Math.max(w, h)), canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image.value, x, y, w, h, 0, 0, canvas.width, canvas.height)
    emit('save', canvas.toDataURL('image/jpeg', .9))
  } catch { error.value = '无法裁剪这张图片，请下载后重新上传' }
}
</script>

<style scoped>
.bg-crop-editor { display: flex; flex-direction: column; gap: 14px; }
.bg-crop-tip { color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.bg-crop-stage { display: flex; justify-content: center; padding: 10px; background: var(--bg-sunken); border-radius: var(--radius-md); }
.bg-crop-frame { position: relative; overflow: hidden; flex-shrink: 0; touch-action: none; cursor: grab; outline: 1px solid var(--border-strong); background: var(--bg-tertiary); }
.bg-crop-frame:active { cursor: grabbing; }
.bg-crop-frame:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.bg-crop-frame.is-saving { cursor: wait; }
.bg-crop-frame img { position: absolute; max-width: none; user-select: none; pointer-events: none; }
.bg-crop-grid { position: absolute; inset: 0; border: 1px solid var(--on-accent); opacity: .45; pointer-events: none; }
.bg-crop-grid i { position: absolute; background: var(--on-accent); }
.bg-crop-grid i:nth-child(1), .bg-crop-grid i:nth-child(2) { width: 1px; height: 100%; left: 33.333%; }
.bg-crop-grid i:nth-child(2) { left: 66.667%; }
.bg-crop-grid i:nth-child(3), .bg-crop-grid i:nth-child(4) { height: 1px; width: 100%; top: 33.333%; }
.bg-crop-grid i:nth-child(4) { top: 66.667%; }
.bg-crop-loading { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12px; color: var(--text-secondary); }
.bg-crop-tools { display: flex; align-items: center; justify-content: center; gap: 12px; font-size: 12px; color: var(--text-secondary); }
.bg-crop-error { color: var(--danger); font-size: 12px; }
</style>
