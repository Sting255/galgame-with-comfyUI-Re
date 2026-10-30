<template>
  <div class="deepseek-setup">
    <Transition name="setup-content" mode="out-in">
      <div v-if="!editing" key="connected" class="setup-summary">
        <div class="setup-heading">
          <h4>DeepSeek · {{ connected ? '已连接' : '已配置' }}</h4>
          <span class="setup-status">{{ connected ? '连接成功，可以开始聊天了' : 'API Key 已保存' }}</span>
        </div>
        <p class="setup-copy">{{ preview || '已保存密钥' }} · deepseek-flash</p>
        <div class="setup-actions">
          <linshe-button variant="primary" @click="$emit('start-chat')">开始聊天</linshe-button>
          <linshe-button variant="link" size="sm" @click="editing = true">更换 Key</linshe-button>
          <linshe-button variant="link" size="sm" @click="$emit('configure')">模型设置</linshe-button>
        </div>
      </div>
      <form v-else key="form" class="setup-form" @submit.prevent="connect">
        <div class="setup-heading">
          <h4>{{ hasApiKey ? '更换 DeepSeek Key' : '连接 DeepSeek' }}</h4>
          <p class="setup-copy">{{ hasApiKey ? '粘贴新的 Key，连接成功后替换原来的密钥。' : '还差一步：填入 API Key，就可以开始和角色聊天了。' }}</p>
        </div>
        <div class="setup-step">
          <span class="setup-number" aria-hidden="true">1</span>
          <div class="setup-step-body">
            <h5>获取 API Key</h5>
            <p class="setup-copy">前往 DeepSeek 创建 API Key，复制后回到这里。</p>
            <a class="setup-link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">获取 DeepSeek API Key ↗</a>
          </div>
        </div>
        <div class="setup-step">
          <span class="setup-number" aria-hidden="true">2</span>
          <div class="setup-step-body">
            <label for="deepseek-setup-key">粘贴 API Key</label>
            <linshe-input id="deepseek-setup-key" v-model="key" type="password" autocomplete="new-password" name="deepseek-setup-key" placeholder="在这里粘贴你的 DeepSeek API Key" :disabled="busy" :invalid="Boolean(error)" aria-describedby="deepseek-setup-hint" @input="error = ''" />
            <p id="deepseek-setup-hint" class="setup-copy setup-hint">地址和模型已选好，只需填写 Key。</p>
          </div>
        </div>
        <p v-if="error" class="setup-error" role="alert">{{ error }}</p>
        <div class="setup-actions">
          <linshe-button type="submit" variant="primary" :loading="busy" :disabled="busy || !key.trim()">{{ busy ? stage === 'saving' ? '正在保存…' : '正在测试连接…' : '保存并测试连接' }}</linshe-button>
          <linshe-button v-if="hasApiKey" variant="link" size="sm" :disabled="busy" @click="cancelEdit">取消更换</linshe-button>
          <span class="setup-copy setup-hint" aria-live="polite">{{ busy ? '请稍候，正在确认 Key 是否可用' : '连接成功后保存' }}</span>
        </div>
      </form>
    </Transition>
    <div class="setup-alternatives">
      <p class="setup-copy">已有其他服务商的 Key？</p>
      <linshe-button variant="secondary" size="sm" :disabled="busy" @click="$emit('configure')">跳过 DeepSeek，使用其他接口 →</linshe-button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import { testLlmConnection, updateLlmConfig } from '../api/index.js'
import { connectAndSaveDeepseek, describeDeepseekSetupError } from '../utils/llmSetup.js'

const props = defineProps({ hasApiKey: Boolean, preview: { type: String, default: '' } })
const emit = defineEmits(['connected', 'configure', 'start-chat'])
const key = ref('')
const editing = ref(!props.hasApiKey)
const connected = ref(false)
const busy = ref(false)
const stage = ref('')
const error = ref('')

function cancelEdit() {
  key.value = ''
  error.value = ''
  editing.value = false
}

async function connect() {
  if (busy.value || !key.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const result = await connectAndSaveDeepseek(key.value, {
      testConnection: testLlmConnection,
      saveConfig: updateLlmConfig,
      onStage: value => { stage.value = value },
    })
    key.value = ''
    connected.value = true
    emit('connected', result)
    editing.value = false
  } catch (err) {
    error.value = err.stage === 'saving' ? err.message : describeDeepseekSetupError(err)
  } finally {
    busy.value = false
    stage.value = ''
  }
}
</script>

<style scoped>
.deepseek-setup { min-width: 0; }
.setup-form, .setup-summary { display: grid; gap: 18px; }
.setup-heading { display: grid; gap: 6px; }
.setup-heading h4 { margin: 0; font-size: var(--fs-lg); color: var(--text-primary); }
.setup-copy { margin: 0; font-size: var(--fs-sm); line-height: 1.6; color: var(--text-secondary); }
.setup-step { display: flex; align-items: flex-start; gap: 10px; }
.setup-number { display: grid; place-items: center; flex-shrink: 0; width: 24px; height: 24px; border-radius: var(--radius-full); background: var(--bg-sunken); color: var(--accent); font-size: var(--fs-sm); font-weight: 600; }
.setup-step-body { display: grid; gap: 6px; flex: 1; min-width: 0; }
.setup-step-body h5, .setup-step-body label { margin: 0; font-size: var(--fs-md); line-height: 1.6; font-weight: 600; color: var(--text-primary); }
.setup-link { width: fit-content; color: var(--accent); font-size: var(--fs-sm); text-underline-offset: 3px; }
.setup-hint { font-size: var(--fs-xs); }
.setup-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.setup-status { color: var(--success); font-size: var(--fs-sm); line-height: 1.6; }
.setup-error { margin: 0; color: var(--danger); font-size: var(--fs-sm); line-height: 1.6; }
.setup-alternatives { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; border-top: 1px solid var(--glass-border); margin-top: 20px; padding-top: 14px; }
.setup-alternatives > .setup-copy { flex-basis: 100%; }
.setup-content-enter-active, .setup-content-leave-active { transition: opacity 0.3s var(--ease-standard); }
.setup-content-enter-from, .setup-content-leave-to { opacity: 0; }
@container (max-width: 480px) {
  .setup-alternatives { align-items: flex-start; flex-direction: column; }
}
</style>
