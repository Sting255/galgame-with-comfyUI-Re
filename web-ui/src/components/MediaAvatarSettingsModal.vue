<template>
  <linshe-modal :visible="modelValue" title="头像设置" wide :transition-ms="300" @close="close">
    <div class="avatar-settings">
      <div class="avatar-intro">
        <div><h2>给路人一个独特的标记</h2><p>路人会随机选用库内头像，同一媒体里的同名路人保持一致。已有角色使用自己的头像。</p></div>
        <span class="avatar-count">{{ readyCount }} 张可用</span>
      </div>
      <section class="avatar-create" aria-labelledby="avatar-direction-label">
        <label id="avatar-direction-label" for="avatar-direction">生成方向 <span>· 可选</span></label>
        <linshe-input id="avatar-direction" v-model="direction" type="textarea" :rows="3" maxlength="2000" placeholder="留空让灵感自由发挥；也可以写：复古像素、可爱小动物、风景、抽象图案……" :disabled="submitting || library.busy" />
        <label for="avatar-artist">画师串</label>
        <linshe-input id="avatar-artist" v-model="artist" maxlength="2000" placeholder="例如：@ebora；留空则不使用画师串" :disabled="submitting || library.busy" />
        <p class="avatar-hint">用于本批头像，生成后记住此设置；每套画面仍会探索不同的艺术风格。</p>
        <label for="avatar-count">本次生成 <span>{{ count }} 张</span></label>
        <linshe-slider id="avatar-count" v-model="count" :min="10" :max="50" :step="10" :disabled="submitting || library.busy" :aria-valuetext="`${count} 张`" />
        <div class="avatar-count-range"><span>10 张</span><span>50 张</span></div>
        <div class="avatar-create-actions">
          <linshe-button variant="primary" :loading="submitting || library.busy" :disabled="!loaded || !!loadError" @click="generate">
            {{ library.busy ? '正在生成头像…' : '生成一批头像' }}
          </linshe-button>
          <span>共 {{ count }} 张，每套画面生成 1 张。关闭窗口后继续生成。</span>
        </div>
      </section>
      <p v-if="actionError" class="avatar-error" role="alert">{{ actionError }}</p>
      <div v-if="loadError" class="avatar-error" role="alert">{{ loadError }} <linshe-button size="sm" @click="refresh">重新加载</linshe-button></div>
      <p v-if="!loaded && !loadError" class="avatar-hint" role="status">正在读取头像库…</p>
      <Transition name="avatar-progress">
        <section v-if="library.progress" class="avatar-progress" aria-label="当前生成进度">
          <span role="status">{{ progressLabel }}</span>
          <progress :value="library.progress.completed + library.progress.failed" :max="library.progress.total" aria-label="头像生成进度" />
          <span v-if="library.progress.error" class="avatar-error" role="alert">{{ library.progress.error }}</span>
        </section>
      </Transition>
      <div class="avatar-library-heading"><h3>默认头像库</h3><span>点开查看大图</span></div>
      <p v-if="loaded && !library.avatars.length" class="avatar-empty">还没有头像。生成第一批，让人物、风景、物件或抽象图案成为路人的标记。</p>
      <div class="avatar-grid">
        <article v-for="avatar in library.avatars" :key="avatar.id" class="avatar-tile">
          <div role="button" tabindex="0" class="avatar-preview" aria-label="放大头像" @click="zoomId = avatar.id" @keydown.enter.prevent="zoomId = avatar.id" @keydown.space.prevent="zoomId = avatar.id">
            <img :src="avatar.image" alt="路人头像" loading="lazy" />
          </div>
          <div class="avatar-remove" :class="{ 'is-removing': removingId === avatar.id }">
            <linshe-button variant="icon" size="sm" title="移出头像库" aria-label="移出头像库" :loading="removingId === avatar.id" :disabled="submitting || removingId !== null" @click.stop="remove(avatar)">✕</linshe-button>
          </div>
        </article>
      </div>
      <p class="avatar-hint">多个路人可以共用同一头像。移出头像后，会清空所有使用它的路人头像绑定，待路人下次出现时重新随机分配。</p>
    </div>
    <template #footer><linshe-button @click="close">完成</linshe-button></template>
  </linshe-modal>
  <Teleport to="body">
    <div style="--vel-z-index: 14000">
      <ImageLightbox :visible="!!zoomSrc" :imgs="zoomSrc ? [zoomSrc] : []" :index="0" :regenerate-handler="regenerate" :regenerate-busy="submitting || library.busy" :show-upscale="false" :show-delete="false" @hide="zoomId = null" />
    </div>
  </Teleport>
</template>

<script setup>
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import LinsheModal from './ui/LinsheModal.vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSlider from './ui/LinsheSlider.vue'
import ImageLightbox from './ImageLightbox.vue'
import * as api from '../api/index.js'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue', 'changed'])
const toast = inject('toast', null)
const library = ref({ busy: false, avatars: [], progress: null })
const loaded = ref(false)
const loadError = ref('')
const actionError = ref('')
const direction = ref('')
const artist = ref('@ebora')
const count = ref(10)
const submitting = ref(false)
const removingId = ref(null)
const zoomId = ref(null)
const zoomSrc = computed(() => library.value.avatars.find(avatar => avatar.id === zoomId.value)?.image || '')
const readyCount = computed(() => library.value.avatars.length)
let timer
let revision = 0
let disposed = false

const progressLabel = computed(() => {
  const p = library.value.progress
  if (!p) return ''
  const state = { designing: '正在构思头像', generating: '正在绘制', done: '生成完成', failed: '生成结束' }[p.stage] || ''
  return `${state} · 已生成 ${p.completed} / ${p.total} 张${p.failed ? ` · ${p.failed} 张失败` : ''}`
})
async function refresh() {
  if (!props.modelValue || disposed) return
  clearTimeout(timer)
  const current = ++revision
  try {
    const data = await api.listMediaAvatars()
    if (current !== revision || disposed) return
    const wasRegenerating = library.value.busy && library.value.progress?.avatarId
    library.value = data
    if (wasRegenerating && !data.busy && data.progress?.avatarId === wasRegenerating) {
      toast?.(data.progress.stage === 'done' ? '头像已更新' : `重新生成失败：${data.progress.error || '请重试'}`, data.progress.stage === 'done' ? 'success' : 'error')
      emit('changed')
    }
    if (data.busy && data.progress && !data.progress.avatarId) count.value = data.progress.total
    if (!loaded.value) artist.value = data.artist ?? '@ebora'
    loaded.value = true
    loadError.value = ''
  } catch (error) {
    if (current === revision && !disposed) loadError.value = error.message || '头像库读取失败'
  } finally {
    if (current === revision && props.modelValue && !disposed) timer = setTimeout(refresh, 3000)
  }
}
async function submit(action) {
  if (submitting.value || library.value.busy) return
  submitting.value = true
  actionError.value = ''
  try {
    await action()
    library.value.busy = true
  } catch (error) {
    actionError.value = error.message || '生成请求失败'
  } finally {
    await refresh()
    submitting.value = false
  }
}
function generate() { return submit(() => api.generateMediaAvatars(direction.value.trim(), artist.value.trim(), count.value)) }
async function regenerate() {
  if (submitting.value || library.value.busy || !zoomId.value) return
  const id = zoomId.value
  submitting.value = true
  try {
    await api.regenerateMediaAvatar(id, direction.value.trim(), artist.value.trim())
    library.value.busy = true
    library.value.progress = { stage: 'designing', total: 1, completed: 0, failed: 0, error: null, avatarId: id }
    await refresh()
  } finally { submitting.value = false }
}
async function remove(avatar) {
  if (removingId.value !== null) return
  removingId.value = avatar.id
  actionError.value = ''
  try {
    await api.removeMediaAvatar(avatar.id)
    await refresh()
  } catch (error) { actionError.value = error.message || '移出失败' }
  finally { removingId.value = null }
}
function close() {
  zoomId.value = null
  emit('update:modelValue', false)
  emit('changed')
}
watch(() => props.modelValue, visible => {
  clearTimeout(timer)
  ++revision
  if (visible) {
    loaded.value = false
    actionError.value = ''
    refresh()
  } else zoomId.value = null
}, { immediate: true })
onUnmounted(() => { disposed = true; ++revision; clearTimeout(timer) })
</script>

<style scoped>
.avatar-settings { display: grid; gap: 20px; color: var(--text-primary); }
.avatar-intro, .avatar-create-actions, .avatar-library-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.avatar-intro h2 { margin: 0 0 8px; font-size: var(--fs-lg); }
.avatar-intro p, .avatar-hint, .avatar-create-actions > span, .avatar-library-heading > span { margin: 0; color: var(--text-secondary); font-size: var(--fs-sm); line-height: 1.7; }
.avatar-count { flex-shrink: 0; color: var(--accent); font-size: var(--fs-sm); font-weight: 700; }
.avatar-create { display: grid; gap: 12px; }
.avatar-create label { font-weight: 700; font-size: var(--fs-sm); }
.avatar-create label span { color: var(--text-secondary); font-weight: 400; }
.avatar-count-range { display: flex; justify-content: space-between; color: var(--text-secondary); font-size: var(--fs-xs); }
.avatar-create-actions { justify-content: flex-start; flex-wrap: wrap; }
.avatar-progress { display: grid; gap: 8px; border-block: 1px solid var(--border); padding: 14px 0; font-size: var(--fs-sm); color: var(--text-secondary); }
.avatar-progress progress { width: 100%; height: 6px; accent-color: var(--accent); }
.avatar-progress-enter-active, .avatar-progress-leave-active { transition: opacity 0.3s var(--ease-standard); }
.avatar-progress-enter-from, .avatar-progress-leave-to { opacity: 0; }
.avatar-error { margin: 0; color: var(--danger); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.avatar-library-heading h3 { margin: 0; font-size: var(--fs-md); }
.avatar-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 20px; }
.avatar-tile { position: relative; min-width: 0; width: 100%; max-width: 140px; justify-self: center; text-align: center; animation: avatar-appear 0.3s var(--ease-standard); }
.avatar-preview { width: 100%; aspect-ratio: 1; border-radius: var(--radius-full); overflow: hidden; border: 2px solid var(--border); background: var(--bg-sunken); }
.avatar-remove { position: absolute; top: 0; right: 0; opacity: 0; pointer-events: none; transform: scale(0.85); transition: opacity 0.3s var(--ease-standard), transform 0.3s var(--ease-standard); }
.avatar-tile:hover .avatar-remove, .avatar-tile:focus-within .avatar-remove, .avatar-remove.is-removing { opacity: 1; pointer-events: auto; transform: scale(1); }
.avatar-preview { cursor: zoom-in; text-align: center; }
.avatar-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.avatar-empty { text-align: center; padding: 28px 16px; background: var(--bg-sunken); border-radius: var(--radius-md); font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.8; }
@keyframes avatar-appear { from { opacity: 0; } to { opacity: 1; } }
@media (max-width: 600px) {
  .avatar-intro { align-items: flex-start; flex-wrap: wrap; }
  .avatar-grid { grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 16px; }
}
@media (hover: none) { .avatar-remove { opacity: 1; pointer-events: auto; transform: none; } }
</style>
