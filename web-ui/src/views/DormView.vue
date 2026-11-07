<template>
  <div class="dorm-view">
    <div class="dorm-head">
      <div>
        <h2 class="dorm-title">宿舍</h2>
        <p class="dorm-sub">{{ rooms.length }} 间房 · {{ memberTotal }} 位住户</p>
      </div>
      <linshe-button variant="primary" size="sm" @click="managerOpen = true">管理房间与入住</linshe-button>
    </div>

    <p v-if="loading" class="dorm-hint" role="status">正在加载宿舍…</p>
    <div v-else-if="error" class="dorm-hint is-error" role="alert">
      <span>{{ error }}</span>
      <linshe-button variant="secondary" size="sm" @click="load">重试</linshe-button>
    </div>
    <div v-else-if="!rooms.length" class="dorm-empty">
      <p>还没有安排房间。角色现在各住各的，日程里的住址是自由生成的。</p>
      <linshe-button variant="secondary" size="sm" @click="managerOpen = true">去安排</linshe-button>
    </div>

    <div v-else class="dorm-grid">
      <section v-for="room in rooms" :key="room.id" class="dorm-room">
        <header class="dorm-room-head">
          <span class="dorm-room-name">{{ room.name }}</span>
          <span class="dorm-room-count">{{ room.members.length }} 人</span>
        </header>
        <ul v-if="room.members.length" class="dorm-members">
          <li v-for="member in room.members" :key="member.id" class="dorm-member">
            <img v-if="member.avatar_path" :src="member.avatar_path" alt="" class="dorm-avatar" />
            <span v-else class="dorm-avatar is-blank" aria-hidden="true">{{ (member.display_name || '?').slice(0, 1) }}</span>
            <span class="dorm-member-name">{{ member.display_name }}</span>
          </li>
        </ul>
        <p v-else class="dorm-room-empty">空房</p>
      </section>
    </div>

    <CohabitationModal v-model="managerOpen" @update:model-value="onManagerToggle" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import LinsheButton from '../components/ui/LinsheButton.vue'
import CohabitationModal from '../components/CohabitationModal.vue'
import * as api from '../api/index.js'

const rooms = ref([])
const characters = ref([])
const loading = ref(false)
const error = ref('')
const managerOpen = ref(false)

const memberTotal = computed(() => rooms.value.reduce((n, room) => n + room.members.length, 0))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.getCohabitation()
    characters.value = data?.characters || []
    const byId = new Map(characters.value.map(c => [c.id, c]))
    rooms.value = (data?.rooms || []).map(room => ({
      ...room,
      members: (room.memberIds || []).map(id => byId.get(id)).filter(Boolean),
    }))
  } catch (err) {
    error.value = err?.message || '读取宿舍失败'
  } finally {
    loading.value = false
  }
}

// 弹窗关闭时重新拉一次：里面可能改了房间名或住户，页面上的卡片要跟着变
function onManagerToggle(open) {
  managerOpen.value = open
  if (!open) load()
}

onMounted(load)
</script>

<style scoped>
.dorm-view { padding: 18px 20px 32px; min-height: 100%; }
.dorm-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.dorm-title { margin: 0; font-size: 18px; font-weight: 600; color: var(--text-bright); }
.dorm-sub { margin: 4px 0 0; font-size: 12px; color: var(--text-secondary); }
.dorm-hint { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 13px; color: var(--text-secondary); }
.dorm-hint.is-error { color: var(--danger, #c0392b); }
.dorm-empty { padding: 28px 20px; border-radius: 14px; background: var(--surface-2, rgba(217, 164, 65, 0.06)); text-align: center; }
.dorm-empty p { margin: 0 0 12px; font-size: 13px; line-height: 1.7; color: var(--text-secondary); }
.dorm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.dorm-room { padding: 14px; border-radius: 14px; background: var(--surface, #fff); border: 1px solid var(--border-soft, rgba(180, 150, 110, 0.22)); }
.dorm-room-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.dorm-room-name { font-size: 14px; font-weight: 600; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dorm-room-count { flex-shrink: 0; font-size: 11px; color: var(--text-secondary); }
.dorm-members { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.dorm-member { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dorm-avatar { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: var(--surface-2, #f3ece1); }
.dorm-avatar.is-blank { display: inline-flex; align-items: center; justify-content: center; font-size: 12px; color: var(--text-secondary); }
.dorm-member-name { font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dorm-room-empty { margin: 0; font-size: 12px; color: var(--text-secondary); opacity: 0.7; }
</style>
