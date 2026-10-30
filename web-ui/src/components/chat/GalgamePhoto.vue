<template>
  <div class="gal-photo-surface" :class="{ 'is-ready': ready, 'is-failed': failed }">
    <img ref="image" :src="src" :alt="alt" draggable="false" @load="reveal" @error="failed = true">
    <span class="photo-flash" aria-hidden="true"></span>
    <span class="photo-curtain photo-curtain-top" aria-hidden="true"></span>
    <span class="photo-curtain photo-curtain-bottom" aria-hidden="true"></span>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'

const props = defineProps({ src: { type: String, required: true }, alt: { type: String, default: '' } })
const image = ref(null), ready = ref(false), failed = ref(false)
function reveal() { ready.value = true; failed.value = false }
watch(() => props.src, () => { ready.value = false; failed.value = false })
onMounted(() => { if (image.value?.complete && image.value.naturalWidth) reveal() })
</script>

<style scoped>
.gal-photo-surface { position: relative; overflow: hidden; }
.gal-photo-surface img { display: block; width: 100%; max-height: var(--gal-photo-max-height); object-fit: contain; border-radius: 0; }
.photo-flash, .photo-curtain { position: absolute; pointer-events: none; }
.photo-flash { inset: 0; z-index: 2; opacity: 0; background: var(--dialogue-photo-paper); }
.photo-curtain { left: 0; right: 0; height: 51%; z-index: 1; background: var(--dialogue-photo-shutter); }
.photo-curtain-top { top: 0; transform-origin: center top; }
.photo-curtain-bottom { bottom: 0; transform-origin: center bottom; }
/* Match the schedule peek's flash + twin shutter, confined to the photo. */
.is-ready .photo-flash { animation: photo-flash var(--dur-slow) var(--ease-standard) both; }
.is-ready .photo-curtain { animation: photo-open var(--dur-slow) 40ms var(--ease-out) both; }
.is-failed .photo-flash, .is-failed .photo-curtain { display: none; }
@keyframes photo-flash { 0% { opacity: .65; } 45% { opacity: .35; } 100% { opacity: 0; } }
@keyframes photo-open { from { transform: scaleY(1); } to { transform: scaleY(0); } }
@media (prefers-reduced-motion: reduce) {
  .photo-flash, .photo-curtain { display: none; }
}
</style>
