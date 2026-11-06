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
import { getDeviceAccess, pairDevice } from '../api/access.js'
const authorized = ref(false)
const loading = ref(true)
const busy = ref(false)
const code = ref('')
const error = ref('')
async function check() {
  loading.value = true
  try { authorized.value = (await getDeviceAccess()).authorized; error.value = '' }
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
