<template>
  <GodAngelDetailModal v-if="character?.system_role === 'angel'" :visible="visible" :character="character" v-bind="$attrs" />
  <ResidentCharacterDetailModal v-else ref="residentRef" :visible="visible" :character="character" v-bind="$attrs" />
</template>

<script setup>
import { ref } from 'vue'
import GodAngelDetailModal from './godSays/GodAngelDetailModal.vue'
import ResidentCharacterDetailModal from './ResidentCharacterDetailModal.vue'

defineOptions({ inheritAttrs: false })
defineProps({ visible: Boolean, character: { type: Object, default: null } })

// 外层是壳：把父组件用到的实例方法透给居民卡（ChatView 会调 refreshRelationships）
const residentRef = ref(null)
defineExpose({
  refreshRelationships: () => residentRef.value?.refreshRelationships?.(),
})
// 天使适配器也渲染同一个 ResidentCharacterDetailModal，仅替换数据接口并隐藏居民专属功能。
</script>
