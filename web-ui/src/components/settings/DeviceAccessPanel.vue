<template>
  <section class="card">
    <h3>设备连接</h3>
    <p v-if="access?.local" class="fd">手机首次连接时输入此配对码，设备记住 30 天。请只分享给自己的设备。</p>
    <template v-if="access?.local">
      <linshe-input :model-value="revealed ? access.pairingCode : '••••••••'" readonly aria-label="设备配对码" />
      <linshe-button variant="secondary" size="sm" @click="revealed = !revealed">{{ revealed ? '隐藏配对码' : '显示配对码' }}</linshe-button>
      <linshe-button variant="secondary" size="sm" @click="copy">{{ copied ? '已复制' : '复制配对码' }}</linshe-button>
    </template>
    <p v-else class="fd">此设备已连接。数据备份与恢复请在电脑本机操作。</p>
    <p v-if="error" role="alert">{{ error }}</p>
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
