<template>
  <div class="gallery" ref="scrollContainer" @scroll="onScroll">
    <!-- 空状态 -->

    <!-- 角色筛选条（横向滚动头像，与文件夹筛选叠加） -->
    <div v-if="!loading && chat.characters.length > 0" class="char-bar">
      <div ref="charScrollRef" class="char-scroll" @wheel="onCharWheel">
        <div
          class="char-avatar char-all"
          :class="{ active: activeCharId === null }"
          @click="onCharChange(null)"
        >全部</div>
        <div
          v-for="ch in chat.characters"
          :key="ch.id"
          class="char-avatar"
          :class="{ active: activeCharId === ch.id }"
          :title="ch.display_name"
          @click="onCharChange(ch.id)"
        >
          <img v-if="ch.avatar_path" :src="ch.avatar_path" class="char-avatar-img" alt="" />
          <span v-else>{{ ch.display_name?.charAt(0) || '?' }}</span>
        </div>
      </div>
    </div>

    <!-- 文件夹筛选按钮（常驻） -->
    <div v-if="!loading && folderButtons.length > 1" class="folder-bar">
      <linshe-button
        v-for="f in folderButtons"
        :key="f.key"
        variant="chip"
        :active="activeFolder === f.key"
        @click="onFolderChange(f.key)"
      >
        <span class="folder-label">{{ f.label }}</span>
        <span class="folder-count">{{ f.count }}</span>
      </linshe-button>
    </div>

    <!-- 多选删除工具条（2026-10-20）：平时不占位，点「选择」才展开 -->
    <div v-if="!loading && images.length > 0" class="selection-bar">
      <linshe-button variant="secondary" size="sm" @click="toggleSelectMode">{{ selectMode ? '完成' : '选择' }}</linshe-button>
      <template v-if="selectMode">
        <linshe-button variant="secondary" size="sm" @click="toggleSelectAll">{{ allSelected ? '取消全选' : '全选已加载' }}</linshe-button>
        <linshe-button
          variant="danger"
          size="sm"
          :disabled="!selectedCount || deleting"
          :loading="deleting"
          @click="deleteSelected"
        >删除选中（{{ selectedCount }}）</linshe-button>
        <span class="selection-hint">只删图片文件，聊天里的文字不受影响</span>
      </template>
    </div>

    <!-- 按时间分组的图片网格 -->
    <template v-if="images.length > 0">
      <div v-for="group in visibleDayGroups" :key="group.label" class="gallery-group">
        <div class="group-header">
          <span class="group-label">{{ group.label }}</span>
          <span class="group-count">{{ group.images.length }} 张</span>
        </div>
        <div class="gallery-grid stagger">
          <div
            v-for="img in group.images"
            :key="img.name"
            class="gallery-item sheen"
            :class="{ 'is-selectable': selectMode, 'is-selected': selected.has(img.name) }"
            @click="selectMode ? toggleSelect(img) : onPreview(img.flatIndex)"
          >
            <span v-if="selectMode" class="select-check" :class="{ on: selected.has(img.name) }" aria-hidden="true">✓</span>
            <!-- 用 img + loading=lazy 取代 background-image：浏览器可延迟加载视口外缩略图 -->
            <img
              class="img-wrapper"
              :src="bustUrlIfOverwritten(img.url)"
              loading="lazy"
              decoding="async"
              alt=""
            >
          </div>
        </div>
      </div>
    </template>

    <!-- 空状态提示 -->
    <div v-else-if="loadError" class="load-more">
      — 加载失败：{{ loadError }} —
      <linshe-button variant="link" size="sm" @click="loadPage(0)">重试</linshe-button>
    </div>
    <div v-else-if="!loading" class="load-more">— {{ activeCharId !== null ? 'ta还没有留下图片' : '相册还是空的' }} —</div>

    <!-- 加载更多 -->
    <div v-if="!loading && hasMore && images.length > 0" class="load-more">
      <span v-if="loadingMore">加载中...</span>
      <span v-else>上滑加载更多</span>
    </div>
    <div v-else-if="!hasMore && images.length > 0" class="load-more">— 共 {{ total }} 张 —</div>

    <!-- 图片预览 Lightbox -->
    <ImageLightbox
      :visible="lightboxVisible"
      :imgs="lightboxImgs"
      :index="lightboxIndex"
      @hide="lightboxVisible = false"
      @regenerated="onRegenerated"
      @upscaled="onRegenerated"
      @deleted="onDeleted"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, inject } from 'vue'
import { listGalleryImages, deleteImagesBatch } from '../api/index.js'
import ImageLightbox from './ImageLightbox.vue'
import LinsheButton from './ui/LinsheButton.vue'
import { bustUrlIfOverwritten } from '../utils/imageUrlRefresh.js'
import { useChatStore } from '../stores/chat.js'

const PAGE_SIZE = 60

const emit = defineEmits(['loaded'])

const images = ref([])
const total = ref(0)
const hasMore = ref(false)
const loading = ref(true)
const loadingMore = ref(false)
// 加载失败要和「相册还是空的」区分开（2026-10-22）：以前失败只打日志，
// 界面照常显示"相册还是空的"，用户会以为图没了。
const loadError = ref(null)
const lightboxVisible = ref(false)
const lightboxIndex = ref(0)
const scrollContainer = ref(null)

const folders = ref([])
const activeFolder = ref(null)
const activeCharId = ref(null)
const charScrollRef = ref(null)

const chat = useChatStore()

const folderButtons = computed(() => {
  const all = { key: null, label: '全部', count: total.value }
  if (!activeFolder.value) all.count = total.value
  else {
    // when filtered, compute "全部" count from folders
    let sum = 0
    for (const f of folders.value) sum += f.count
    all.count = sum
  }
  return [all, ...folders.value.map(f => ({ key: f.key, label: f.label, count: f.count }))]
})

const allDayGroups = computed(() => {
  if (images.value.length === 0) return []

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  const thisYear = now.getFullYear()

  const map = new Map()

  for (const img of images.value) {
    const d = new Date(img.mtime)
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

    let label
    if (dayStart >= todayStart) {
      label = '今天'
    } else if (dayStart >= yesterdayStart) {
      label = '昨天'
    } else {
      const m = d.getMonth() + 1
      const day = d.getDate()
      if (d.getFullYear() === thisYear) {
        label = `${m}月${day}日`
      } else {
        label = `${d.getFullYear()}年${m}月${day}日`
      }
    }

    if (!map.has(dayStart)) {
      map.set(dayStart, { label, dayStart, images: [] })
    }
    map.get(dayStart).images.push(img)
  }

  return [...map.values()].sort((a, b) => b.dayStart - a.dayStart)
})

const allFlatImages = computed(() => {
  let idx = 0
  const result = []
  for (const group of allDayGroups.value) {
    for (const img of group.images) {
      img.flatIndex = idx++
    }
    result.push(group)
  }
  return result
})

const visibleDayGroups = computed(() => allFlatImages.value)

const lightboxImgs = computed(() => {
  const urls = []
  for (const group of visibleDayGroups.value) {
    for (const img of group.images) {
      urls.push(bustUrlIfOverwritten(img.url))
    }
  }
  return urls
})

function onPreview(flatIndex) {
  lightboxIndex.value = flatIndex
  lightboxVisible.value = true
}

function onRegenerated(newUrl) {
  const base = newUrl.replace(/\?.*$/, '')
  for (const img of images.value) {
    if (img.url.replace(/\?.*$/, '') === base) {
      img.url = newUrl
    }
  }
}

function onDeleted(deletedUrl) {
  const base = deletedUrl.replace(/\?.*$/, '')
  images.value = images.value.filter(img => img.url.replace(/\?.*$/, '') !== base)
  total.value = Math.max(0, total.value - 1)
}

// ── 多选删除（2026-10-20）：复用后端 delete-batch（幂等 + .avif 孪生）──
const toastFn = inject('toast', null)
const confirmFn = inject('confirm', null)
const selectMode = ref(false)
const selected = ref(new Set())
const deleting = ref(false)
const selectedCount = computed(() => selected.value.size)
const allSelected = computed(() => images.value.length > 0 && images.value.every(img => selected.value.has(img.name)))

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  selected.value = new Set()
}
function toggleSelect(img) {
  const next = new Set(selected.value)
  if (next.has(img.name)) next.delete(img.name)
  else next.add(img.name)
  selected.value = next
}
function toggleSelectAll() {
  selected.value = allSelected.value ? new Set() : new Set(images.value.map(img => img.name))
}
const stripQuery = u => String(u || '').replace(/\?.*$/, '')
async function deleteSelected() {
  const items = images.value.filter(img => selected.value.has(img.name))
  if (!items.length || deleting.value) return
  const ok = confirmFn
    ? await confirmFn({
        title: '删除图片',
        message: `确定删除选中的 ${items.length} 张图片吗？\n只删图片文件，聊天里的文字不受影响。`,
        okText: '删除',
      })
    : true
  if (!ok) return
  deleting.value = true
  try {
    const res = await deleteImagesBatch(items.map(img => img.url))
    // 失败项按 URL 保留（后端会把非法/不存在的 URL 列进 failedItems）
    const failed = new Set((res?.failedItems || []).map(f => stripQuery(f.url)))
    const removedNames = new Set(items
      .filter(img => !failed.has(stripQuery(img.url)))
      .map(img => img.name))
    images.value = images.value.filter(img => !removedNames.has(img.name))
    total.value = Math.max(0, total.value - (res?.deleted ?? removedNames.size))
    selected.value = new Set()
    selectMode.value = false
    const failedCount = res?.failed || 0
    toastFn?.(`已删除 ${res?.deleted ?? removedNames.size} 张${failedCount ? `，${failedCount} 张失败` : ''}`, failedCount ? 'warning' : 'success')
  } catch (err) {
    toastFn?.('删除失败: ' + (err?.message || err), 'error')
  } finally {
    deleting.value = false
  }
}

function onFolderChange(key) {
  if (activeFolder.value === key) return
  activeFolder.value = key
  loadPage(0)
  scrollContainer.value?.scrollTo({ top: 0 })
}

function onCharChange(id) {
  if (activeCharId.value === id) return
  activeCharId.value = id
  loadPage(0)
  scrollContainer.value?.scrollTo({ top: 0 })
}

function onCharWheel(e) {
  const el = charScrollRef.value
  if (!el) return
  const atLeftEdge = el.scrollLeft <= 0 && e.deltaY < 0
  const atRightEdge = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 && e.deltaY > 0
  if (atLeftEdge || atRightEdge) return
  e.preventDefault()
  el.scrollBy({ left: e.deltaY, behavior: 'smooth' })
}

// 请求序号：筛选切换不复位旧数据（避免计数闪 0、网格闪空），靠序号丢弃过期响应
let loadSeq = 0
let pendingFirstPage = false

async function loadPage(offset) {
  const seq = ++loadSeq
  if (offset === 0) pendingFirstPage = true
  try {
    const data = await listGalleryImages(PAGE_SIZE, offset, activeFolder.value || '', activeCharId.value)
    if (seq !== loadSeq) return
    pendingFirstPage = false
    if (offset === 0) {
      images.value = data.images || []
      if (data.folders) folders.value = data.folders
    } else {
      images.value.push(...(data.images || []))
    }
    total.value = data.total || images.value.length
    hasMore.value = data.hasMore ?? false
    emit('loaded', total.value)
    loadError.value = null
  } catch (err) {
    if (seq === loadSeq) pendingFirstPage = false
    console.error('[gallery] load images error:', err)
    // 只在首屏失败时算"加载失败"；上滑加载更多失败不该把整页变成错误态
    if (seq === loadSeq && offset === 0) loadError.value = err?.message || '加载失败'
  }
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value || pendingFirstPage) return
  loadingMore.value = true
  await loadPage(images.value.length)
  loadingMore.value = false
}

function onScroll() {
  const el = scrollContainer.value
  if (!el || loadingMore.value || !hasMore.value) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
    loadMore()
  }
}

onMounted(async () => {
  await loadPage(0)
  loading.value = false
})

async function refresh() {
  await loadPage(0)
}

defineExpose({ refresh })
</script>

<style scoped>
.gallery {
  height: 100%;
  overflow-y: auto;
  padding: 16px;
}

/* ── 角色筛选条（与朋友圈筛选条同款交互） ── */
.char-bar {
  padding: 0 0 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}

.char-scroll {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding: 6px 4px;
  margin: -6px -4px 0;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.char-scroll::-webkit-scrollbar { display: none; }

.char-avatar {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  box-sizing: border-box;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  opacity: 0.55;
  border: 2px solid var(--glass-border);
  font-size: 17px;
  font-weight: 700;
  color: #fff;
  user-select: none;
  background: var(--accent);
  transition: opacity 0.2s ease, border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}
.char-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
  border-radius: inherit;
  display: block;
}
.char-avatar.active {
  opacity: 1;
  border-color: var(--accent);
  transform: scale(1.08);
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.25);
}
.char-avatar:hover:not(.active) {
  opacity: 0.85;
  border-color: var(--text-secondary);
}
/* 「全部」按钮：只覆盖视觉属性，结构尺寸继承 .char-avatar */
.char-all {
  background: rgba(255,255,255,0.75);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  opacity: 0.7;
}
.char-all.active {
  /* 同主按钮口径：--accent + 白字 2.9:1 */
  background: var(--btn-primary-bg);
  color: var(--btn-primary-fg);
  border-color: var(--accent);
  opacity: 1;
}

/* ── 文件夹筛选栏 ── */
.folder-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}

.folder-label {
  font-weight: 500;
}

.folder-count {
  font-size: 11px;
  opacity: 0.7;
}

/* ── 空状态 ── */
/* 空状态已迁移至 EmptyState 组件 */

/* ── 分组 ── */
.gallery-group {
  margin-bottom: 20px;
}

.group-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 4px 12px;
}
.group-label {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-bright);
}
.group-count {
  font-size: 12px;
  color: var(--text-secondary);
}

/* ── 图片网格 ── */
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.gallery-item {
  border-radius: 12px;
  overflow: hidden;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--glass-border);
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.gallery-item:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

/* ── 多选删除 ── */
.selection-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 14px 8px;
}
.selection-hint { font-size: 12px; color: var(--text-secondary); }
.gallery-item { position: relative; }
.gallery-item.is-selectable { cursor: pointer; }
.gallery-item.is-selected {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  transform: none;
}
.select-check {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: transparent;
  background: rgba(0, 0, 0, 0.35);
  border: 2px solid rgba(255, 255, 255, 0.85);
  pointer-events: none;
}
.select-check.on {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}

.gallery-item .img-wrapper {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  background-color: var(--bg-tertiary);
  object-fit: cover;
  transition: transform 0.3s ease, background-color 0.2s ease;
}
.gallery-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.gallery-item:hover .img-wrapper {
  transform: scale(1.05);
}

/* ── 加载更多 ── */
.load-more {
  text-align: center;
  padding: 24px 16px;
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.7;
}

/* ── 移动端适配 ── */
@media (max-width: 767px) {
  .gallery {
    padding: 12px;
  }
  .gallery-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
  }
  .group-label {
    font-size: 14px;
  }
  .folder-bar {
    gap: 6px;
    padding: 2px 0 12px;
    margin-bottom: 12px;
  }
  .char-bar {
    padding-bottom: 10px;
    margin-bottom: 10px;
  }
  .char-scroll {
    gap: 8px;
  }
}
</style>
