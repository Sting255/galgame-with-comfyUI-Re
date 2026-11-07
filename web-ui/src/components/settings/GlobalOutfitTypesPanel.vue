<script setup>
import { ref, computed, inject, onMounted, onBeforeUnmount } from 'vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import * as api from '../../api'

/**
 * 全角色统一服装（2026-11-07）
 *
 * 和角色卡里的「添加服装类型」不同：这里的类型对所有角色生效，
 * 并且可以一键把所有人的这套描述与立绘跑完（后台任务，关掉页面也会继续）。
 */
const toastFn = inject('toast')
const confirmFn = inject('confirm', null)

const types = ref([])
const tasks = ref({})
const newName = ref('')
const loading = ref(false)
const creating = ref(false)
const busyId = ref(0)
// 默认跳过已写好的：批量不该悄悄覆盖手写内容
const skipExisting = ref(true)
let timer = null

async function confirmRemoval(title, message, okText = '确定') {
  return confirmFn
    ? await confirmFn({ title, message, okText, danger: true })
    : window.confirm(message)
}

async function load() {
  loading.value = true
  try {
    const res = await api.listGlobalOutfitTypes()
    types.value = res.types || []
  } catch (err) {
    toastFn?.(`读取统一服装失败：${err?.message || ''}`, 'error')
  } finally {
    loading.value = false
  }
}

async function create() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    const res = await api.createGlobalOutfitType(name)
    newName.value = ''
    await load()
    toastFn?.(`已添加「${name}」，已应用到 ${res.applied ?? 0} 个角色`, 'success')
  } catch (err) {
    toastFn?.(`添加失败：${err?.message || ''}`, 'error')
  } finally {
    creating.value = false
  }
}

function taskFor(id) {
  return tasks.value[id] || null
}

function busy(id) {
  return !!taskFor(id)?.running || busyId.value === id
}

async function pollOnce(id) {
  try {
    const res = await api.getGlobalOutfitTask(id)
    const task = res.task || null
    if (task) tasks.value = { ...tasks.value, [id]: task }
    else if (tasks.value[id]) {
      const { [id]: _drop, ...rest } = tasks.value
      tasks.value = rest
    }
    if (!task?.running) return false
    return true
  } catch {
    return false
  }
}

function ensurePolling() {
  if (timer) return
  timer = setInterval(async () => {
    const running = types.value.filter(t => taskFor(t.id)?.running)
    if (!running.length) {
      clearInterval(timer)
      timer = null
      await load()
      return
    }
    for (const t of running) await pollOnce(t.id)
    // 有任务刚结束 → 刷新统计
    if (!types.value.some(t => taskFor(t.id)?.running)) {
      clearInterval(timer)
      timer = null
      await load()
    }
  }, 2500)
}

async function generate(type, withStanding) {
  if (busy(type.id)) return
  busyId.value = type.id
  try {
    const res = await api.generateGlobalOutfitType(type.id, withStanding, skipExisting.value)
    tasks.value = { ...tasks.value, [type.id]: res.task }
    toastFn?.(
      withStanding
        ? `已开始为 ${res.task.total} 个角色生成描述与立绘，可以离开这个页面`
        : `已开始为 ${res.task.total} 个角色生成描述`,
      'success'
    )
    ensurePolling()
  } catch (err) {
    toastFn?.(`启动失败：${err?.message || ''}`, 'error')
  } finally {
    busyId.value = 0
  }
}

async function apply(type) {
  busyId.value = type.id
  try {
    const res = await api.applyGlobalOutfitType(type.id)
    await load()
    toastFn?.(res.applied ? `已补到 ${res.applied} 个角色` : '所有角色都已经有这套了', 'success')
  } catch (err) {
    toastFn?.(`补齐失败：${err?.message || ''}`, 'error')
  } finally {
    busyId.value = 0
  }
}

async function remove(type) {
  const ok = await confirmRemoval(
    `删除「${type.name}」？`,
    `所有角色这 ${type.appliedCount} 套的描述与立绘都会一并删除，且不可恢复。\n角色自己另外添加的服装类型不受影响。`,
    '删除'
  )
  if (!ok) return
  busyId.value = type.id
  try {
    await api.deleteGlobalOutfitType(type.id)
    await load()
    toastFn?.(`已删除「${type.name}」`, 'success')
  } catch (err) {
    toastFn?.(`删除失败：${err?.message || ''}`, 'error')
  } finally {
    busyId.value = 0
  }
}

onMounted(async () => {
  await load()
  // 进入设置页时把还在跑的任务接上（页面刷新过也能看到进度）
  for (const type of types.value) {
    const running = await pollOnce(type.id)
    if (running) ensurePolling()
  }
})
onBeforeUnmount(() => { if (timer) { clearInterval(timer); timer = null } })

const runningTask = computed(() => Object.values(tasks.value).find(t => t?.running) || null)
</script>

<template>
  <section class="got">
    <div class="got-head">
      <h3>全角色统一服装</h3>
      <span class="got-count">{{ types.length }} 个类型</span>
    </div>
    <p class="got-hint">
      这里添加的服装类型对<b>所有角色</b>生效：每个角色都会多出这套（描述与立绘各自生成）。
      一键生成在后台跑，离开本页也会继续。
    </p>

    <div class="got-create">
      <linshe-input
        v-model="newName"
        maxlength="20"
        placeholder="例如：婚纱 / 泳装 / 制服"
        aria-label="新服装类型名称"
        :disabled="creating"
        @keyup.enter="create"
      />
      <linshe-button size="sm" :loading="creating" :disabled="!newName.trim()" @click="create">
        添加类型
      </linshe-button>
    </div>

    <div class="got-option">
      <linshe-switch v-model="skipExisting" size="sm" on-text="跳过已写好的" />
      <span class="got-hint">开启时只处理还没有描述的角色，你手写或改过的那几套不会被覆盖。</span>
    </div>

    <p v-if="loading" class="got-empty">正在读取…</p>
    <p v-else-if="!types.length" class="got-empty">还没有统一服装类型。</p>

    <div v-for="type in types" :key="type.id" class="got-row">
      <div class="got-info">
        <div class="got-name">{{ type.name }}</div>
        <div class="got-stat">
          已应用 {{ type.appliedCount }}/{{ type.characterCount }} 个角色 ·
          已写描述 {{ type.describedCount }} · 已出立绘 {{ type.standingCount }}
        </div>
        <div v-if="taskFor(type.id)?.running" class="got-progress" role="status">
          生成中 {{ taskFor(type.id).done }}/{{ taskFor(type.id).total }}
          <template v-if="taskFor(type.id).skipped"> · 跳过 {{ taskFor(type.id).skipped }}</template>
          <template v-if="taskFor(type.id).current"> · {{ taskFor(type.id).current }}</template>
        </div>
        <div v-else-if="taskFor(type.id)?.failed?.length" class="got-failed">
          上次失败 {{ taskFor(type.id).failed.length }} 个：{{ taskFor(type.id).failed.map(f => f.name).slice(0, 4).join('、') }}
        </div>
      </div>
      <div class="got-actions">
        <linshe-button size="sm" variant="secondary" :disabled="busy(type.id)" @click="generate(type, false)">
          只生成描述
        </linshe-button>
        <linshe-button size="sm" variant="primary" :disabled="busy(type.id)" @click="generate(type, true)">
          生成描述 + 立绘
        </linshe-button>
        <linshe-button size="sm" variant="ghost" :disabled="busy(type.id)" @click="apply(type)">
          补齐角色
        </linshe-button>
        <linshe-button size="sm" variant="danger" :disabled="busy(type.id)" @click="remove(type)">
          删除
        </linshe-button>
      </div>
    </div>

    <p v-if="runningTask" class="got-hint got-hint-run">
      正在为「{{ runningTask.done }}/{{ runningTask.total }}」生成，约 {{ runningTask.withStanding ? '每角色 30~50 秒' : '每角色 5~10 秒' }}。
    </p>
  </section>
</template>

<style scoped>
.got {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.got-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.got-head h3 {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-bright);
}
.got-count {
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.got-hint {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-dim);
}
.got-hint-run {
  color: var(--color-primary, inherit);
}
.got-create {
  display: flex;
  gap: 8px;
  align-items: center;
}
.got-create > :first-child {
  flex: 1;
  min-width: 0;
}
.got-option {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.got-empty {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.got-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--surface-sunken, rgba(0, 0, 0, 0.03));
}
.got-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 180px;
  flex: 1;
}
.got-name {
  font-size: var(--fs-sm);
  color: var(--text-bright);
  font-weight: 600;
}
.got-stat,
.got-progress,
.got-failed {
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.got-progress {
  color: var(--color-primary, inherit);
}
.got-failed {
  color: var(--color-danger, #c0392b);
}
.got-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
