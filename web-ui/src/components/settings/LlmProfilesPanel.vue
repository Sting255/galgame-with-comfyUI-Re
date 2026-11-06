<template>
  <div class="llm-profiles-bar" :aria-busy="busy">
    <div v-for="profile in profiles" :key="profile.id" class="profile-item-row">
      <linshe-button
variant="chip" size="sm" :active="profile.id === activeId" :disabled="busy"
        :title="(profile.preview || '未设置 Key') + ' · ' + (profile.model || '?')"
        @click="select(profile.id)"
>
<span class="profile-name">{{ profile.name }}</span>
</linshe-button>
      <linshe-button
v-if="profiles.length > 1 && profile.id !== activeId" variant="icon" size="sm"
        :disabled="busy" :aria-label="`删除配置 ${profile.name}`" @click="remove(profile.id)"
>
×
</linshe-button>
    </div>
    <linshe-button variant="chip" size="sm" :disabled="busy" @click="openAdd">+ 新增配置</linshe-button>
  </div>
  <linshe-modal :model-value="showAdd" title="新增配置" @update:model-value="closeAdd">
    <p class="profile-description">复制当前已保存的模型设置，不包含 API Key。未保存的修改请先保存。</p>
    <linshe-input
ref="nameInput" v-model="name" :disabled="busy" aria-label="配置名称"
      placeholder="输入配置名称，如：我的 OpenAI、本地 LLM" @keyup.enter="submit"
/>
    <template #footer>
      <linshe-button variant="secondary" :disabled="busy" @click="closeAdd(false)">取消</linshe-button>
      <linshe-button variant="primary" :disabled="busy || !name.trim()" :loading="busy" @click="submit">确定</linshe-button>
    </template>
  </linshe-modal>
</template>

<script setup>
import { ref, nextTick } from 'vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheModal from '../ui/LinsheModal.vue'

const props = defineProps({
  profiles: { type: Array, default: () => [] }, activeId: { type: String, default: '' },
  busy: Boolean, select: { type: Function, required: true },
  remove: { type: Function, required: true }, create: { type: Function, required: true },
})
const showAdd = ref(false)
const name = ref('')
const nameInput = ref(null)
let submitting = false
async function openAdd() {
  if (props.busy) return
  showAdd.value = true
  await nextTick()
  nameInput.value?.focus()
}
function closeAdd(value) { if (!props.busy && !submitting) showAdd.value = value }
async function submit() {
  if (props.busy || submitting || !name.value.trim()) return
  submitting = true
  try {
    if (await props.create(name.value)) { showAdd.value = false; name.value = '' }
  } finally { submitting = false }
}
</script>

<style scoped>
.llm-profiles-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center; }
.profile-item-row { display: flex; align-items: center; gap: 4px; max-width: 100%; }
.profile-name { display: block; max-width: min(220px, 45vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.profile-description { color: var(--text-secondary); font-size: 13px; line-height: 1.6; margin: 0 0 12px; }
</style>
