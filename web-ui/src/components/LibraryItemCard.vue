<template>
  <div class="item-card" :class="{ editing: item._editing }">
    <!-- 编辑态 -->
    <!-- 编辑态 / 展示态 -->
    <CardHeightTransition :editing="item._editing">
      <div v-if="item._editing" class="edit-form">
        <label class="edit-field">
          <span class="edit-label">名称</span>
          <linshe-input v-model.trim="item.name" class="edit-input" size="sm" placeholder="名称" />
        </label>
        <label v-if="isEvents" class="edit-field">
          <span class="edit-label">标签（逗号分隔）</span>
          <linshe-input v-model="funFromText" class="edit-input" size="sm" placeholder="如 小确幸, 日常感" />
        </label>
        <label class="edit-field">
          <span class="edit-label">描述</span>
          <linshe-input v-model.trim="item.desc" class="edit-input edit-textarea" type="textarea" rows="6" />
        </label>
        <label v-if="!isEvents" class="edit-field edit-field-inline">
          <span class="edit-label">参与自动抽取</span>
          <linshe-switch v-model="item.checked" size="sm" />
        </label>
      </div>

      <div v-else class="card-main">
        <div class="card-title-row">
          <span class="card-name">{{ item.name }}</span>
          <!-- 话题库独有：是否参与「自动抽取」。手动点题不受它限制，所以叫「参与自动抽取」而不是「启用」 -->
          <linshe-switch
            v-if="!isEvents"
            v-model="item.checked"
            size="sm"
            class="card-checked"
            :title="item.checked ? '参与自动抽取（点掉后不再被自动抽中，手动点题仍可用）' : '不参与自动抽取（手动点题仍可用）'"
            @change="emit('toggle-checked', item)"
          />
        </div>
        <div class="card-desc">{{ item.desc }}</div>
        <div v-if="isEvents && item.funFrom && item.funFrom.length" class="card-tags">
          <span v-for="(t, ti) in item.funFrom" :key="ti" class="tag">{{ t }}</span>
        </div>
      </div>
    </CardHeightTransition>

    <div class="card-actions">
      <!-- 「立即发送」：把这条话题/事件库条目直接发给某个角色生成一条（上游 v3.9.0 点题入口） -->
      <linshe-button v-if="!item._editing && item.id" size="sm" :disabled="publishing" @click="emit('publish', item)">立即发送</linshe-button>
      <linshe-button size="sm" @click="onToggleEdit">{{ item._editing ? '取消' : '编辑' }}</linshe-button>
      <linshe-button v-if="item._editing" variant="primary" size="sm" @click="emit('save', item)">保存</linshe-button>
      <linshe-button v-else variant="danger" size="sm" @click="emit('remove', item)">删除</linshe-button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import CardHeightTransition from './CardHeightTransition.vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSwitch from './ui/LinsheSwitch.vue'

const props = defineProps({
  item: { type: Object, required: true },
  isEvents: { type: Boolean, default: false },
  publishing: { type: Boolean, default: false },
})
const emit = defineEmits(['edit', 'cancel', 'save', 'remove', 'toggle-checked', 'publish'])

// 标签以逗号分隔字符串编辑，实时同步回数组
const funFromText = ref('')
watch(
  () => props.item._editing,
  (v) => {
    if (v) funFromText.value = (props.item.funFrom || []).join(', ')
  }
)
watch(funFromText, (v) => {
  props.item.funFrom = v.split(/[,，]/).map(s => s.trim()).filter(Boolean)
})

function onToggleEdit() {
  if (props.item._editing) emit('cancel', props.item)
  else emit('edit', props.item)
}
</script>

<style scoped>
.item-card {
  display: flex; flex-direction: column; justify-content: space-between;
  border: 1px solid var(--glass-border, rgba(0,0,0,0.1));
  border-radius: 12px; padding: 12px;
  background: var(--glass-bg);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.item-card:hover { border-color: rgba(var(--accent-rgb),0.35); box-shadow: 0 3px 16px rgba(var(--accent-rgb),0.06); }
.item-card.editing { border-color: var(--accent, var(--accent)); box-shadow: 0 0 0 2px rgba(var(--accent-rgb),0.15); }
.card-main { min-width: 0; }
.card-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-checked { flex-shrink: 0; }
.card-name { font-size: 14px; font-weight: 700; color: var(--text-bright, #2b2b2b); }
.card-desc {
  font-size: 12px; color: var(--text-primary, #555);
  line-height: 1.6; margin-top: 6px;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.card-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.tag {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: rgba(var(--accent-rgb),0.1); color: var(--accent-text);
}
.card-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }
.edit-form { display: flex; flex-direction: column; gap: 8px; }
.edit-field { display: flex; flex-direction: column; gap: 4px; }
.edit-field-inline { flex-direction: row; align-items: center; justify-content: space-between; }
.edit-label { font-size: 11px; color: var(--text-secondary, #888); }
.edit-input {
  padding: 6px 8px;
  font-size: 12px; box-sizing: border-box;
}
</style>
