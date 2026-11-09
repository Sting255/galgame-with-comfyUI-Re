<template>
  <GodAngelDetailModal v-if="character?.system_role === 'angel'" ref="angelRef" :visible="visible" :character="character" v-bind="$attrs" />
  <ResidentCharacterDetailModal v-else ref="residentRef" :visible="visible" :character="character" v-bind="$attrs" />
</template>

<script setup>
import { ref, computed } from 'vue'
import GodAngelDetailModal from './godSays/GodAngelDetailModal.vue'
import ResidentCharacterDetailModal from './ResidentCharacterDetailModal.vue'

defineOptions({ inheritAttrs: false })
defineProps({ visible: Boolean, character: { type: Object, default: null } })

// 外层是壳：把父组件用到的实例方法透给内层卡（ChatView 会调 refreshRelationships）
const residentRef = ref(null)
const angelRef = ref(null)

// 2026-11-09（W01/C02）：isDirty 原来没有透传，父层想在切角色 / 关窗前判断
// 「这个卡里还有没存的草稿」拿不到答案，只能一律放行 —— 草稿就丢了。
// 现在两条分支都透出去，父层可直接用 ref.value?.isDirty。
const isDirty = computed(() => !!(
  residentRef.value?.isDirty || angelRef.value?.isDirty
))

defineExpose({
  refreshRelationships: () => residentRef.value?.refreshRelationships?.(),
  isDirty,
})
// 天使适配器也渲染同一个 ResidentCharacterDetailModal，仅替换数据接口并隐藏居民专属功能。
</script>
