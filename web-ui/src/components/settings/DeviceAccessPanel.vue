<template>
  <section class="card device-access">
    <div class="da-head">
      <h3>设备连接</h3>
      <span v-if="access?.local" class="da-hint">配对码 30 天有效，只给自己的设备用</span>
    </div>
    <template v-if="access?.local">
      <div class="da-row">
        <linshe-input class="da-code" :model-value="revealed ? access.pairingCode : '••••••••'" readonly aria-label="设备配对码" />
        <linshe-button variant="ghost" size="sm" @click="revealed = !revealed">{{ revealed ? '隐藏' : '显示' }}</linshe-button>
        <linshe-button variant="secondary" size="sm" @click="copy">{{ copied ? '已复制' : '复制' }}</linshe-button>
      </div>
    </template>
    <p v-else class="da-note">此设备已连接。数据备份与恢复请在电脑本机操作。</p>
    <p v-if="error" role="alert" class="da-note">{{ error }}</p>
  </section>
</template>
<script setup>
import { ref, onMounted } from 'vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheButton from '../ui/LinsheButton.vue'
import { getDeviceAccess } from '../../api/access.js'
const access = ref(null)
const revealed = ref(false)
const copied = ref(false)
const error = ref('')
onMounted(async () => {
  try { access.value = await getDeviceAccess() } catch (e) { error.value = e.message }
})
async function copy() {
  try { await navigator.clipboard.writeText(access.value.pairingCode); copied.value = true }
  catch { revealed.value = true; error.value = '浏览器未允许复制，请选中配对码手动复制' }
}
</script>

<style scoped>
/* 2026-11-06 用户反馈：这块占的高度太多。改成「标题 + 一行配对码」两行，说明并进标题右侧。 */
.device-access {
  padding: 16px 18px;
  gap: 0;
}
.da-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  min-width: 0;
}
.da-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-bright);
  white-space: nowrap;
}
.da-hint {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.da-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.da-code { flex: 1 1 auto; min-width: 0; }
.da-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
@media (max-width: 767px) {
  .da-head { flex-direction: column; align-items: flex-start; gap: 2px; }
  .da-hint { white-space: normal; }
}
</style>
