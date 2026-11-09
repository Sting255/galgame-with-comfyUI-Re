<template>
  <linshe-modal
    v-model="visible"
    :title="current.title"
    panel-class="confirm-modal"
    body-class="confirm-modal-body"
    @close="onCancel"
    @after-leave="onAfterLeave"
  >
    <!-- 图标区：danger 用三角警告，普通用圆点信息 -->
    <div class="confirm-icon" :class="{ 'is-danger': current.danger }">
      <svg v-if="current.danger" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L2 22h20L12 2z" stroke-linejoin="round"
              stroke="var(--danger)" stroke-width="1.6" stroke-linecap="round"/>
        <line x1="12" y1="10" x2="12" y2="15" stroke="var(--danger)" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="12" cy="18.5" r="1" fill="var(--danger)" stroke="none"/>
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="1.6"/>
        <line x1="12" y1="7" x2="12" y2="12" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="12" cy="16.5" r="0.9" fill="var(--accent)" stroke="none"/>
      </svg>
    </div>
    <div class="confirm-body">
      <div class="confirm-message">{{ current.message }}</div>
    </div>

    <template #footer>
      <linshe-button @click="onCancel">{{ current.cancelText }}</linshe-button>
      <linshe-button :variant="current.danger ? 'danger' : 'primary'" @click="onOk">{{ current.okText }}</linshe-button>
    </template>
  </linshe-modal>
</template>

<script setup>
// 统一确认框。对外仍是 show(opts): Promise<boolean>，调用方一行都不用改。
//
// 2026-11-09 重做（W01）：原来只有一个 resolvePromise 变量，两个 confirm 前后脚
// 触发时后一个把前一个的回调覆盖掉，前一个 await 永远不返回 —— 用户以为卡死，
// 反复点，操作做了两遍。现在改成请求队列：每条请求带着自己的 resolver 入队，
// 当前这条结算完、退场动画结束，下一条才展示。
//
// 另外原来是自己写 Teleport + 遮罩 + 独立 z-index 20000 + 0.18s 退出，没进弹窗栈，
// 和 LinsheModal 是两套。现在改走 LinsheModal，层级由 modalStack 统一管。
import { ref, computed, onBeforeUnmount } from 'vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheModal from './ui/LinsheModal.vue'

const DEFAULT_OPTS = {
  title: '确认操作',
  message: '确定要执行此操作吗？',
  okText: '确定',
  cancelText: '取消',
  // 沿用原口径：只有显式传 danger: false 才不是危险样式
  danger: true,
}

const visible = ref(false)
// 队列：{ opts, resolve, settled }
const queue = ref([])
const current = computed(() => queue.value[0]?.opts || DEFAULT_OPTS)
let disposed = false

/** 把一条请求结算掉（每次请求只会走到一次） */
function settle(entry, value) {
  if (!entry || entry.settled) return
  entry.settled = true
  entry.resolve(value)
}

/** 当前这条结算后退出，等离场动画结束再放行下一条 */
function finish(value) {
  const entry = queue.value[0]
  if (!entry) return
  settle(entry, value)
  visible.value = false
}

function show(opts = {}) {
  // 组件已销毁：明确返回 false，不制造永久 pending
  if (disposed) return Promise.resolve(false)
  return new Promise(resolve => {
    queue.value.push({
      opts: { ...DEFAULT_OPTS, ...opts },
      resolve,
      settled: false,
    })
    // 队列本来是空的，这条立刻展示；否则等前一条退场结束（见 onAfterLeave）
    if (queue.value.length === 1) visible.value = true
  })
}

function onOk() { finish(true) }
// Escape / 点遮罩 / 关闭键都按取消处理
function onCancel() { finish(false) }

/**
 * 离场动画真正结束后：把已结算的这条移出队列，放行下一条。
 * 用 after-leave 而不是 setTimeout —— 队列要的是"上一条真的走了"，
 * 猜时长会让两条确认框叠在一起。
 */
function onAfterLeave() {
  if (visible.value) return          // 又被重新打开了，队列不用动
  if (queue.value[0]?.settled) queue.value.shift()
  if (disposed) return
  if (queue.value.length) {
    // 下一条已经在队列里等着：重新打开，current 自动切到它
    visible.value = true
  }
}

onBeforeUnmount(() => {
  disposed = true
  // 未处理项明确返回 false，调用方的 await 不会永远挂着
  for (const entry of queue.value) settle(entry, false)
  queue.value = []
})

defineExpose({ show })
</script>

<style scoped>
/* panel-class / body-class 落在 LinsheModal 内部的元素上，scoped 选择器命中不到，
   必须走 :global（GiftPanel 的 .gift-modal 是同一口径）。皮肤仍由 LinsheModal 维护，
   这里只收宽度与内容排布。 */
:global(.linshe-modal.confirm-modal) {
  width: min(360px, 94vw);
}
:global(.linshe-modal .modal-body.confirm-modal-body) {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 22px 4px 6px;
}

/* ── 图标：柔光底色圆衬 + 动态颜色 ── */
.confirm-icon {
  width: 48px; height: 48px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(var(--accent-rgb), 0.08);
  flex-shrink: 0;
}
.confirm-icon.is-danger {
  background: rgba(255, 77, 79, 0.07);
}
.confirm-icon svg {
  width: 26px; height: 26px;
}

.confirm-body {
  text-align: center;
}
.confirm-message {
  font-size: 13px; color: var(--text-secondary);
  line-height: 1.65; white-space: pre-line;
  max-width: 280px;
}

/* prefers-reduced-motion：动效交给全局 .modal-fade-*，这里不再单独定义 */
</style>
