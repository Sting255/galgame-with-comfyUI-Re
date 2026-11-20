<template>
  <Transition name="page" mode="out-in">
    <div v-if="authorized" key="app" class="device-app"><slot /></div>
    <main v-else key="connect" class="device-connect">
      <section class="card">
        <h2>{{ loading ? '正在连接邻舍…' : '连接你的邻舍' }}</h2>
        <template v-if="!loading">
          <p>在电脑上打开「设置 → 设备连接」，复制配对码到这里。</p>
          <form @submit.prevent="connect">
            <linshe-input v-model="code" aria-label="配对码" placeholder="配对码" autocomplete="off" :disabled="busy" />
            <p v-if="error" role="alert">{{ error }}</p>
            <linshe-button variant="primary" :loading="busy" :disabled="!code.trim()" type="submit">连接</linshe-button>
            <linshe-button variant="ghost" @click="check">重新检查</linshe-button>
          </form>
        </template>
      </section>
    </main>
  </Transition>
</template>
<script setup>
import { ref, onMounted } from 'vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheButton from './ui/LinsheButton.vue'
import { getDeviceAccess, pairDevice, requestDeviceToken } from '../api/access.js'
const authorized = ref(false)
const loading = ref(true)
const busy = ref(false)
const code = ref('')
const error = ref('')

/**
 * 把设备令牌交给原生层（P0-02）。
 *
 * 只有 Android 壳里有 AndroidBridge；网页端（含桌面浏览器）走的是 HttpOnly Cookie，
 * 不需要也不该拿到这个令牌。桥调用失败静默：网页功能不受影响，只是后台通知没授权。
 */
async function pushTokenToNative() {
  const bridge = window.AndroidBridge
  if (!bridge || typeof bridge.setDeviceToken !== 'function') return
  try {
    // 已经下发过就不重复申请，避免每次进页面都多一条令牌记录
    if (typeof bridge.hasDeviceToken === 'function' && bridge.hasDeviceToken() === true) return
    const issued = await requestDeviceToken('android-shell')
    if (issued?.token) bridge.setDeviceToken(issued.token)
  } catch (e) {
    console.warn('[access] 设备令牌下发失败（后台通知将不可用）:', e?.message || e)
  }
}

async function check() {
  loading.value = true
  try {
    authorized.value = (await getDeviceAccess()).authorized
    error.value = ''
    if (authorized.value) await pushTokenToNative()
  }
  catch (e) { error.value = e.message }
  finally { loading.value = false }
}
async function connect() {
  busy.value = true
  try { await pairDevice(code.value); code.value = ''; await check() }
  catch (e) { error.value = e.message }
  finally { busy.value = false }
}
onMounted(check)
</script>
<style scoped>
.device-app { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.device-connect { min-height: 100dvh; display: grid; place-items: center; padding: 20px; }
.device-connect .card { width: min(100%, 440px); padding: 24px; }
.device-connect p { color: var(--text-secondary); line-height: 1.6; }
.device-connect form { display: grid; gap: 12px; }
</style>
