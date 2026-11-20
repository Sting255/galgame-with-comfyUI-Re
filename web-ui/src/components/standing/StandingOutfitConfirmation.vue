<template>
  <linshe-modal :model-value="state.open" title="所选服装尚未齐全" :transition-ms="300" @close="$emit('choose', null)">
    <div class="outfit-confirmation">
      <p>本次选择「{{ state.sceneLabel }}」，以下 {{ state.missingCharacters.length }} 位角色尚未配置这套外观：</p>
      <ul aria-label="缺少所选服装的角色">
        <li v-for="character in state.missingCharacters" :key="character.id">{{ character.name }}</li>
      </ul>
      <p><strong>自动补全：</strong>为这些角色生成并保存缺失的「{{ state.sceneLabel }}」服装描述，再继续生成{{ assetLabel }}；已有服装保持不变。补全会增加等待时间，失败的角色会显示错误。</p>
      <p><strong>跳过补全：</strong>这些角色仍会生成{{ assetLabel }}，但使用默认外观；其他角色继续使用「{{ state.sceneLabel }}」。</p>
      <p class="outfit-confirmation-hint">两种方式都会优先遵循你填写的生成方向。</p>
    </div>
    <template #footer>
      <div class="outfit-confirmation-actions">
        <linshe-button variant="ghost" @click="$emit('choose', null)">取消</linshe-button>
        <linshe-button @click="$emit('choose', 'fallback')">跳过补全，使用默认外观</linshe-button>
        <linshe-button variant="primary" @click="$emit('choose', 'generate')">自动补全后生成</linshe-button>
      </div>
    </template>
  </linshe-modal>
</template>

<script setup>
import LinsheModal from '../ui/LinsheModal.vue'
import LinsheButton from '../ui/LinsheButton.vue'
defineProps({ state: { type: Object, required: true }, assetLabel: { type: String, default: '立绘' } })
defineEmits(['choose'])
</script>

<style scoped>
.outfit-confirmation { display: grid; gap: 12px; color: var(--text-primary); font-size: var(--fs-sm); line-height: 1.7; }
.outfit-confirmation p { margin: 0; }
.outfit-confirmation ul { margin: 0; padding-left: 22px; max-height: 160px; overflow-y: auto; }
.outfit-confirmation-hint { color: var(--text-secondary); }
.outfit-confirmation-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; width: 100%; }
@media (max-width: 600px) { .outfit-confirmation-actions { flex-direction: column-reverse; } }
</style>
