<template>
      <!-- 数据备份：一键导出全部数据 / 一键导入（导入是覆盖式操作，导入前自动备份） -->
      <div class="card card-full memory-settings-card data-backup-card">
        <div class="memory-settings-header">
          <div>
            <h3>数据备份</h3>
            <p>把角色、聊天记录、群聊、记忆、图片与音频打包成一个 .tar.gz；换电脑或重装后用同一个归档一键恢复</p>
          </div>
        </div>

        <p v-if="accessLoading" role="status">正在检查设备权限…</p>
        <p v-else-if="accessError" role="alert">{{ accessError }} <linshe-button variant="link" size="sm" @click="loadAccess">重试</linshe-button></p>
        <p v-else-if="!access?.local" class="data-backup-tip">数据备份与恢复请在运行邻舍的电脑本机操作。</p>
        <template v-if="access?.local">
        <div class="data-backup-info" role="status" aria-live="polite">
          <span class="data-backup-info-label">当前数据</span>
          <span class="data-backup-info-text">{{ exportInfoLoading ? '读取中…' : (exportInfoError || exportInfoText) }}</span>
        </div>

        <linshe-button v-if="exportInfoError" variant="link" size="sm" :disabled="controlsDisabled" @click="refreshExportInfo">重试读取</linshe-button>
        <div class="toggle-row">
          <div>
            <div class="tl">包含模型配置（含 API Key）</div>
            <div class="td">归档里会带上 config\.env；里面有你的密钥，这份备份不要发给别人</div>
          </div>
          <linshe-switch
            v-model="exportIncludeConfig"
            :disabled="controlsDisabled"
            aria-label="导出时包含模型配置（含 API Key）"
          />
        </div>

        <div class="data-backup-actions">
          <linshe-button
            variant="secondary"
            size="sm"
            :loading="exportBusy"
            :disabled="controlsDisabled"
            @click="onExportData"
          >
            {{ exportBusy ? '导出中…' : '一键导出全部数据' }}
          </linshe-button>
          <linshe-button
            variant="secondary"
            size="sm"
            :disabled="controlsDisabled"
            @click="pickImportFile"
          >
            一键导入
          </linshe-button>
          <span class="data-backup-tip">导入会覆盖当前数据库与资产文件；导入前会自动备份到 data\backups\</span>
        </div>

        <Transition name="backup-notice-fade">
          <p v-if="importNotice" class="data-backup-notice" :class="`is-${importNotice.type}`" role="status">
            {{ importNotice.text }}
          </p>
        </Transition>

        <!-- 唯一允许的裸 input：隐藏的文件选择器（AGENTS.md 特殊交互元素白名单），
             真正可点的控件是上面的 LinsheButton，因此这里不进 tab 序列也不读给读屏 -->
        <input
          ref="importFileEl"
          class="data-backup-file"
          type="file"
          accept=".gz,.tar.gz,.tgz,application/gzip"
          tabindex="-1"
          aria-hidden="true"
          @change="onImportFilePicked"
        />
        </template>
      </div>
    <!-- 导入二次确认：覆盖式破坏操作，必须让用户看清后果再上传 -->
    <linshe-modal v-model="importDialog.show" title="确认导入备份？" panel-class="data-backup-modal">
      <p class="data-backup-modal-line">
        导入会<strong>覆盖当前数据库与资产文件</strong>；导入前会自动备份到
        <code>data\backups\</code>，万一不满意可以用那份备份回滚。
      </p>
      <p class="data-backup-modal-line">
        选中的文件：<strong>{{ importDialog.fileName }}</strong>
        <span v-if="importDialog.fileSize" class="data-backup-modal-size">（{{ importDialog.fileSize }}）</span>
      </p>
      <p class="data-backup-modal-line">确认后开始上传，中途请不要关闭页面或退出程序。</p>
      <template #footer>
        <linshe-button variant="secondary" :disabled="importBusy" @click="importDialog.show = false">取消</linshe-button>
        <linshe-button variant="danger" :loading="importBusy" :disabled="importBusy" @click="confirmImport">
          {{ importBusy ? '导入中…' : '确认导入' }}
        </linshe-button>
      </template>
    </linshe-modal>
</template>
<script setup>
import { ref, reactive, computed, inject, onMounted } from 'vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import LinsheModal from '../ui/LinsheModal.vue'
import { getDeviceAccess } from '../../api/access.js'
import { downloadDataArchive, getDataExportInfo, importDataArchive } from '../../api/index.js'
import {
  formatBytes,
  formatExportSummary,
  importFailureText,
  importSuccessText,
  restoredText,
  validateImportFile,
} from '../../utils/dataBackup.js'
const toastFn = inject('toast', null)
// ── 数据备份：一键导出 / 一键导入 ──
//
// 导出：GET /api/data/export 拿二进制 tar.gz，前端直接触发下载（不经过 JSON 层）。
// 导入：POST /api/data/import 发原始字节，属于覆盖式破坏操作，必须先过二次确认弹窗。
const access = ref(null)
const accessLoading = ref(true)
const accessError = ref('')
const restartRequired = ref(false)
const controlsDisabled = computed(() => !access.value?.local || exportBusy.value || importBusy.value || restartRequired.value)
const exportInfoError = ref('')
onMounted(loadAccess)
async function loadAccess() {
  accessLoading.value = true
  accessError.value = ''
  try {
    access.value = await getDeviceAccess()
    if (access.value.local) await refreshExportInfo()
  } catch (err) {
    accessError.value = `权限检查失败：${err?.message || '请重试'}`
  } finally {
    accessLoading.value = false
  }
}
const exportIncludeConfig = ref(false)
const exportBusy = ref(false)
const importBusy = ref(false)
const exportInfoLoading = ref(false)
const exportInfo = ref(null)
/** 导入/导出的结果提示：留在页面上（失败时带上可回滚的备份路径，toast 装不下） */
const importNotice = ref(null)
const importFileEl = ref(null)
/** 选中的文件本体不放 reactive：File 不需要响应式，也避免被代理后传给 fetch */
let pendingImportFile = null
const importDialog = reactive({ show: false, fileName: '', fileSize: '' })

/** 一行摘要：角色/消息/群聊/记忆条数 + 预计大小（后端 dbBytes 只是估算上界） */
const exportInfoText = computed(() => formatExportSummary(exportInfo.value))

async function refreshExportInfo() {
  if (restartRequired.value) return
  exportInfoLoading.value = true
  exportInfoError.value = ''
  try {
    exportInfo.value = await getDataExportInfo()
  } catch (err) {
    exportInfoError.value = `读取失败：${err?.message || '请重试'}`
    exportInfo.value = null
    console.warn('[数据备份] 读取导出摘要失败:', err?.message || err)
  } finally {
    exportInfoLoading.value = false
  }
}

async function onExportData() {
  if (controlsDisabled.value) return
  exportBusy.value = true
  importNotice.value = null
  try {
    const { fileName, bytes } = await downloadDataArchive(exportIncludeConfig.value)
    toastFn?.(`已导出 ${fileName}（${formatBytes(bytes)}）`, 'success')
    await refreshExportInfo()
  } catch (err) {
    toastFn?.(`导出失败：${err?.message || '未知错误'}`, 'error')
  } finally {
    exportBusy.value = false
  }
}

/** 触发隐藏 file input 的系统文件选择框（真正的可访问控件是那个 LinsheButton） */
function pickImportFile() {
  if (controlsDisabled.value) return
  importFileEl.value?.click()
}

function onImportFilePicked(event) {
  if (controlsDisabled.value) return
  const input = event?.target
  const file = input?.files?.[0] || null
  // 清空 value，否则连续选同一个文件不会再触发 change
  if (input) input.value = ''

  // 本地预检：后缀 / 空文件 / 超过 2GB 直接拒绝，不上传
  const check = validateImportFile(file)
  if (!check.ok) {
    importNotice.value = { type: 'error', text: check.reason }
    toastFn?.(check.reason, 'error')
    return
  }

  pendingImportFile = file
  importDialog.fileName = file.name
  importDialog.fileSize = formatBytes(file.size)
  importDialog.show = true
}

/**
 * 等自动重启完成：旧进程退出 → 新进程重新 listen。
 * 不刷新页面就继续操作的话，所有请求都会打到「备份已恢复」的维护锁上。
 */
async function waitForRestart() {
  await new Promise(resolve => setTimeout(resolve, 3500))
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      if (res.ok) {
        window.location.reload()
        return
      }
    } catch { /* 进程还没起来，继续等 */ }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  importNotice.value = { type: 'error', text: '自动重启超时，请手动关闭启动器后重新启动邻舍' }
}

async function confirmImport() {
  const file = pendingImportFile
  if (!file || controlsDisabled.value) return
  importBusy.value = true
  importNotice.value = null
  try {
    const result = await importDataArchive(file)
    restartRequired.value = Boolean(result?.restartRequired)
    const restored = restoredText(result?.restored)
    const text = restored ? `${importSuccessText(result)}（${restored}）` : importSuccessText(result)
    importNotice.value = { type: 'success', text }
    toastFn?.(text, 'success')
    importDialog.show = false
    // 后端会在 2.5 秒后自重启（换库 / .env 生效只有新进程才做得到）：
    // 这里先提示，再轮询 /api/health，服务回来后自动刷新页面。
    if (result?.autoRestart || result?.restartRequired) {
      importNotice.value = { type: 'success', text: '数据已恢复，正在自动重启…本页稍后会自动刷新' }
      importBusy.value = false
      await waitForRestart()
      return
    }
    if (!result?.restartRequired && !result?.restartRecommended) await refreshExportInfo()
  } catch (err) {
    // 500 时后端会带回导入前的自动备份路径：一并写进页面，用户可按它回滚
    const text = importFailureText(err)
    importNotice.value = { type: 'error', text }
    toastFn?.(text, 'error')
    importDialog.show = false
  } finally {
    pendingImportFile = null
    importBusy.value = false
  }
}

</script>
<style scoped>
/* ── 数据备份（一键导出 / 一键导入） ── */
.data-backup-card .toggle-row { border-bottom: none; }
.data-backup-info {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 2px;
}
.data-backup-info-label { font-size: 12px; color: var(--text-secondary); flex-shrink: 0; }
.data-backup-info-text {
  font-size: 13px;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
}
.data-backup-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 14px;
}
.data-backup-tip {
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.data-backup-notice {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
  word-break: break-all;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-sunken);
  color: var(--text-primary);
}
.data-backup-notice.is-success {
  border-color: color-mix(in srgb, var(--success) 35%, var(--border));
  color: var(--success);
}
.data-backup-notice.is-error {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
  color: var(--danger);
}
/* 导入结果提示的出现 / 消失：与全局口径一致的 0.3s 淡入淡出 */
.backup-notice-fade-enter-active,
.backup-notice-fade-leave-active {
  transition: opacity 0.3s var(--ease-standard);
}
.backup-notice-fade-enter-from,
.backup-notice-fade-leave-to { opacity: 0; }
/* 隐藏的文件选择器：不进布局、不进 tab 序列（可点入口是旁边的 LinsheButton） */
.data-backup-file {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.data-backup-modal-line {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.75;
  margin: 0 0 8px;
}
.data-backup-modal-line code {
  font-size: 12px;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--bg-sunken);
  color: var(--text-bright);
}
.data-backup-modal-size { color: var(--text-secondary); font-size: 12px; }
.card-full { grid-column: 1 / -1; margin-top: 16px; }
.memory-settings-header h3 { margin-bottom: 4px; }
.memory-settings-header p { max-width: 560px; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.toggle-row { display: flex; gap: 14px; justify-content: space-between; align-items: center; padding: 14px 0; }
.tl { font-size: 14px; font-weight: 500; color: var(--text-bright); }
.td { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
</style>
