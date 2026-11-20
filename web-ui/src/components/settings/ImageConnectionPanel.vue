<template>
<linshe-modal v-model="showNovelaiRelayModal" title="NovelAI 推荐中转站" wide>
        <p class="relay-modal-tip">以下为 NovelAI 图像生成兼容中转服务，API Key 请在其官网获取。</p>
        <div class="relay-station">
          <div class="relay-station-head">
            <span class="relay-station-name">NAI.Rinko</span>
            <linshe-button class="relay-quick-btn" variant="secondary" :loading="novelaiRelayConfigBusy" @click="applyNovelaiRelayConfig">
              <svg class="relay-quick-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
              <span>{{ novelaiRelayConfigBusy ? '配置中…' : '快速配置' }}</span>
            </linshe-button>
          </div>
          <p class="relay-station-desc">点击快速配置会保存接口地址 https://nai.rinko.ai；API Key 需在官网获取后自行填写。</p>
          <p class="relay-station-line"><a href="https://nai.rinko.ai/sign-up?aff=gOkj" target="_blank" rel="noopener" class="ext-link relay-station-link">跳转官网→</a></p>
        </div>
      </linshe-modal>

<div class="card image-connection-card">
        <h3>图片生成服务</h3>
        <linshe-tabs
          v-model="imageProvider"
          :options="imageProviderOptions"
          size="sm"
          class="image-provider-tabs"
          @update:model-value="onImageProviderChange"
        />
        <Transition name="expand" mode="out-in">
          <div v-if="imageProvider === 'comfyui'" key="comfyui" class="image-connection-fields">
            <p class="fd">ComfyUI 服务地址，默认 http://localhost:8188</p>
            <linshe-input v-model="comfyUrl" class="fi" placeholder="http://localhost:8188" @input="markConnDirty" />
            <div class="conn-switch-row">
              <span>跳过 TLS 证书验证（仅在连接云端 HTTPS ComfyUI 失败时开启）</span>
              <linshe-switch v-model="comfySkipTls" @change="markConnDirty" />
            </div>
          </div>
          <div v-else key="novelai" class="image-connection-fields">
            <div class="llm-profile-toolbar" role="group" aria-label="已保存的 NovelAI 配置">
              <div v-for="profile in novelaiProfiles" :key="profile.id" class="llm-profile-item">
                <linshe-button
                  variant="chip"
                  size="sm"
                  :active="profile.id === activeNovelaiProfileId"
                  :aria-pressed="profile.id === activeNovelaiProfileId"
                  :title="`${profile.name} · ${profile.model || '未选择模型'}`"
                  @click="switchNovelaiProfile(profile.id)"
                >
                  <span class="llm-profile-label">{{ profile.name }}</span>
                  <span v-if="profile.id === activeNovelaiProfileId" aria-hidden="true">●</span>
                </linshe-button>
                <linshe-button v-if="novelaiProfiles.length > 1 && profile.id !== activeNovelaiProfileId" variant="link" tone="danger" size="sm" :aria-label="`删除配置 ${profile.name}`" :title="`删除配置 ${profile.name}`" @click="removeNovelaiProfile(profile.id)">×</linshe-button>
              </div>
              <linshe-button size="sm" variant="chip" @click="showAddNovelaiProfile = true">+ 新增配置</linshe-button>
            </div>
            <p class="novelai-model-hint">切换配置会整组替换下面的接口、模型、参数与提示词；新增配置以当前这套为底复制一份。</p>
            <p class="fd">NovelAI 生图固定单张，使用这里设置的分辨率和参数，不跟随系统分辨率。免费标准档适用尺寸：512×512、832×1216、1216×832、1024×1024，步数上限为 28。</p>
            <div class="novelai-api-mode-row">
              <!-- 三协议（上游 v3.10.0）：官方直连 / native 原生 / relay OpenAI 兼容中转 -->
              <linshe-select
                id="novelai-protocol"
                v-model="novelaiApiFormat"
                class="novelai-api-format-select"
                :options="novelaiApiFormatOptions"
                aria-label="NovelAI 连接方式"
                @update:model-value="changeNovelaiFormat(); markConnDirty()"
              />
              <linshe-input
                id="novelai-url"
                v-model="novelaiUrl"
                class="novelai-api-url"
                :disabled="novelaiApiFormat === 'official'"
                placeholder="接口地址"
                aria-label="NovelAI 接口地址"
                @input="markConnDirty"
              />
            </div>
            <label class="novelai-setting-label" for="novelai-proxy">代理地址（可选）</label>
            <linshe-input
              id="novelai-proxy"
              v-model="novelaiProxyUrl"
              class="novelai-api-url"
              placeholder="例如 http://127.0.0.1:7890（留空走环境变量代理）"
              aria-label="NovelAI 代理地址"
              @input="markConnDirty"
            />
            <p class="novelai-model-hint">{{ novelaiApiFormat === 'official' ? '官方 API 直连 NovelAI。' : novelaiApiFormat === 'native' ? '原生协议：直连自建/中转的 NovelAI 兼容服务。' : '中转站模式使用上方地址。' }}保存后生效。</p>
            <div class="novelai-model-row">
              <linshe-select v-model="novelaiModel" class="novelai-model-select" :options="novelaiModels" searchable allow-free-input placeholder="请先自动获取模型" @update:model-value="markConnDirty" />
              <linshe-button variant="secondary" size="md" :loading="novelaiModelsLoading" @click="fetchNovelaiModels">自动获取</linshe-button>
            </div>
            <p v-if="novelaiModels.length === 0" class="novelai-model-hint">填写 API Key 后点击“自动获取”，读取{{ novelaiApiFormat === 'relay' ? '当前中转站' : '官方 API' }}提供的模型。</p>
            <label class="novelai-setting-label" for="novelai-quality-prompt">质量提示词</label>
            <linshe-input
              id="novelai-quality-prompt"
              v-model="novelaiQualityPrompt"
              class="novelai-quality-prompt"
              placeholder="masterpiece, best quality, score_9, score_8, highres, absurdres, year 2025"
              @input="markConnDirty"
            />
            <label class="novelai-setting-label" for="novelai-artist">画师串</label>
            <linshe-input
              id="novelai-artist"
              v-model="novelaiArtist"
              placeholder="例如：@ebora"
              @input="markConnDirty"
            />
            <label class="novelai-setting-label" for="novelai-negative-prompt">反向提示词</label>
            <linshe-input
              id="novelai-negative-prompt"
              v-model="novelaiNegativePrompt"
              placeholder="输入希望避免出现的内容，留空表示不额外限制"
              @input="markConnDirty"
            />
            <div class="novelai-resolution-field">
              <div class="fpresets-head">
                <span class="resolution-title">分辨率</span>
                <span class="resolution-hint">输入宽高，或选用预设</span>
              </div>
              <div class="fr novelai-dimensions-row">
                <div class="fh"><label class="fl" for="novelai-width">宽度</label><linshe-input id="novelai-width" v-model.number="novelaiWidth" type="number" min="64" max="4096" step="64" @input="onNovelaiDimensionInput('width', $event)" /></div>
                <div class="fh"><label class="fl" for="novelai-height">高度</label><linshe-input id="novelai-height" v-model.number="novelaiHeight" type="number" min="64" max="4096" step="64" @input="onNovelaiDimensionInput('height', $event)" /></div>
              </div>
              <div class="fpresets novelai-resolution-presets">
                <span class="pl">预设：</span>
                <linshe-button v-for="preset in novelaiResolutionPresets" :key="preset.label" class="pbtn" variant="chip" :active="novelaiWidth === preset.width && novelaiHeight === preset.height" @click="applyNovelaiResolutionPreset(preset)">{{ preset.label }}</linshe-button>
              </div>
            </div>
            <div class="novelai-param-row">
              <div class="novelai-param-field">
                <label class="fl" for="novelai-sampler">采样器</label>
                <linshe-select id="novelai-sampler" v-model="novelaiSampler" :options="novelaiSamplerOptions" @update:model-value="markConnDirty" />
              </div>
              <div class="novelai-param-field">
                <label class="fl" for="novelai-noise-schedule">噪声调度</label>
                <linshe-select id="novelai-noise-schedule" v-model="novelaiNoiseSchedule" :options="novelaiNoiseScheduleOptions" @update:model-value="markConnDirty" />
              </div>
            </div>
            <div class="novelai-steps-field">
              <div class="novelai-slider-heading">
                <label class="fl" for="novelai-steps">步数（1–50）</label>
                <span>{{ novelaiSteps }}</span>
              </div>
              <linshe-slider id="novelai-steps" v-model="novelaiSteps" :min="1" :max="50" :step="1" aria-label="NovelAI 步数" @update:model-value="markConnDirty" />
            </div>
            <div class="novelai-steps-field">
              <div class="novelai-slider-heading">
                <label class="fl" for="novelai-guidance">引导强度</label>
                <span>{{ Number(novelaiGuidance).toFixed(1) }}</span>
              </div>
              <linshe-slider id="novelai-guidance" v-model="novelaiGuidance" :min="0" :max="10" :step="0.1" aria-label="NovelAI 引导强度" @update:model-value="markConnDirty" />
            </div>
            <label class="novelai-setting-label" for="novelai-api-key">NovelAI API Key（按当前接口格式发送）</label>
            <linshe-input
              id="novelai-api-key"
              v-model="novelaiApiKey"
              class="fi"
              type="password"
              autocomplete="new-password"
              :placeholder="novelaiApiKeySaved ? '已保存，留空保持不变' : '输入 NovelAI API Key'"
              @input="onNovelaiKeyInput"
            />
            <div class="conn-key-hint">
              <span v-if="novelaiApiKeySaved && !novelaiApiKeyCleared">API Key 已保存；留空会继续使用已保存的密钥。</span>
              <span v-else>填写对应接口使用的 API Key，保存后可测试连接。</span>
              <linshe-button
                v-if="novelaiApiKeySaved && !novelaiApiKey && !novelaiApiKeyCleared"
                variant="link"
                size="sm"
                @click="clearNovelaiKey"
              >
清除密钥
</linshe-button>
            </div>
          </div>
        </Transition>
        <div class="sr">
          <span :class="['sd', health?.connected ? 'on' : 'off']"></span>
          <span>{{ health?.connected ? '已连接' : '未连接' }}</span>
          <span v-if="health?.provider === 'novelai' && health?.modelAvailable === false" class="conn-health-hint">当前模型未在服务端模型列表中</span>
          <span v-else-if="health?.error" class="conn-health-hint">{{ health.error }}</span>
        </div>
        <div class="sa" style="margin-top:12px">
          <linshe-button variant="primary" :disabled="!connDirty" @click="saveComfyUrl">保存</linshe-button>
          <span v-if="connSaved" class="smsg">已保存</span>
          <linshe-button variant="secondary" @click="checkHealth">测试连接</linshe-button>
        </div>
        <div v-if="imageProvider === 'novelai'" class="sa novelai-relay-entry-row">
          <div
            role="button"
            tabindex="0"
            class="relay-intro-btn relay-intro-footer"
            @click="showNovelaiRelayModal = true"
            @keydown.enter.prevent="showNovelaiRelayModal = true"
            @keydown.space.prevent="showNovelaiRelayModal = true"
          >
推荐中转站
</div>
        </div>

        <linshe-modal v-model="showAddNovelaiProfile" title="新增 NovelAI 配置">
          <p class="llm-help-copy">会以当前生效的这套配置为底复制一份（含接口、模型、参数、提示词与 API Key），之后可分别修改，保存后互不影响。</p>
          <linshe-input
            v-model="newNovelaiProfileName"
            placeholder="输入配置名称，如：官方直连、中转 A"
            aria-label="NovelAI 配置名称"
            @keyup.enter="addNovelaiProfileDraft"
            ref="newNovelaiProfileInput"
          />
          <template #footer>
            <linshe-button variant="secondary" @click="showAddNovelaiProfile = false">取消</linshe-button>
            <linshe-button variant="primary" :disabled="!newNovelaiProfileName.trim() || novelaiProfileBusy" :loading="novelaiProfileBusy" @click="addNovelaiProfileDraft">确定</linshe-button>
          </template>
        </linshe-modal>
      </div>
</template>

<script setup>
import LinsheModal from '../ui/LinsheModal.vue'
import LinsheSelect from '../ui/LinsheSelect.vue'
import LinsheTabs from '../ui/LinsheTabs.vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import LinsheSlider from '../ui/LinsheSlider.vue'
import { useSettingsPageContext } from '../../composables/settings/settingsContext.js'
const { showNovelaiRelayModal, novelaiRelayConfigBusy, applyNovelaiRelayConfig, imageProvider, onImageProviderChange, imageProviderOptions, comfyUrl, markConnDirty, comfySkipTls, novelaiProfiles, activeNovelaiProfileId, switchNovelaiProfile, removeNovelaiProfile, showAddNovelaiProfile, novelaiApiFormat, changeNovelaiFormat, novelaiApiFormatOptions, novelaiUrl, novelaiProxyUrl, novelaiModel, novelaiModels, novelaiModelsLoading, fetchNovelaiModels, novelaiQualityPrompt, novelaiArtist, novelaiNegativePrompt, novelaiWidth, onNovelaiDimensionInput, novelaiHeight, novelaiResolutionPresets, applyNovelaiResolutionPreset, novelaiSampler, novelaiSamplerOptions, novelaiNoiseSchedule, novelaiNoiseScheduleOptions, novelaiSteps, novelaiGuidance, novelaiApiKey, novelaiApiKeySaved, onNovelaiKeyInput, novelaiApiKeyCleared, clearNovelaiKey, health, connDirty, saveComfyUrl, connSaved, checkHealth, newNovelaiProfileName, novelaiProfileBusy, addNovelaiProfileDraft, newNovelaiProfileInput } = useSettingsPageContext()
</script>

<style scoped>
.comfy-params-card .sa { gap: 10px; }
.float-badge.active { background: rgba(var(--accent-rgb), 0.14); color: var(--accent); }
.card {
  padding: 24px;
  display: flex;
  flex-direction: column;
}
.card h3 { font-size: 15px; color: var(--text-bright); margin-bottom: 12px; font-weight: 600; }
.fl { font-size: 13px; font-weight: 600; color: var(--text-bright); display: block; margin-bottom: 2px; }
.fd { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.fi { margin-bottom: 14px; }
.comfy-params-card .fd { margin-bottom: 14px; line-height: 1.55; }
.comfy-params-card .fr { margin-bottom: 18px; }
.comfy-params-card .fpresets { margin: 0 0 24px; }
.fr { display: flex; gap: 12px; }
.fh { flex: 1; min-width: 0; }
.fr .fl {
  display: block; margin-bottom: 6px;
  font-size: 14px; font-weight: 600; color: var(--text-bright);
}
.fpresets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.fpresets-head {
  display: flex; align-items: baseline; flex-wrap: wrap;
  gap: 2px 10px; margin-bottom: 6px;
}
.resolution-title {
  font-size: 14px; font-weight: 600; color: var(--text-bright);
}
.resolution-hint {
  font-size: 12px; color: var(--text-secondary);
}
.pl { font-size: 12px; color: var(--text-secondary); margin-right: 2px; }
.pbtn {
  display: inline-flex; align-items: center; height: 30px; padding: 0 12px;
  font-size: 12px;
}
.ext-link {
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;
  font-weight: 500;
  transition: color 0.15s;
}
.ext-link:hover { color: var(--accent-text); }

.sa { display: flex; align-items: center; gap: 12px; margin-top: auto; }
.smsg { color: var(--success); font-size: 13px; }
.sr { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 13px; }
.image-connection-card { gap: 8px; }
.novelai-relay-entry-row { justify-content: flex-end; }
.image-provider-tabs { margin-bottom: 4px; }
.image-connection-fields { min-width: 0; }
.image-connection-fields .fd { margin-bottom: 8px; line-height: 1.5; }
.novelai-model-row { display: flex; align-items: center; gap: 8px; min-width: 0; margin-bottom: 14px; }
.novelai-model-select { flex: 1; min-width: 0; }
.novelai-api-mode-row { display: flex; align-items: center; gap: 12px; min-width: 0; margin: 8px 0; }
.novelai-api-url { flex: 1; min-width: 0; }
.novelai-model-hint { margin: -4px 0 6px; color: var(--text-secondary); font-size: 11px; line-height: 1.45; }
.novelai-resolution-field { min-width: 0; margin: 10px 0; }
.novelai-steps-field { min-width: 0; margin: 10px 0; }
.novelai-param-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 12px 0; }
.novelai-param-field { min-width: 0; }
.novelai-slider-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.novelai-slider-heading > span { min-width: 32px; color: var(--text-secondary); font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; }
.novelai-setting-label { display: block; margin: 0 0 6px; color: var(--text-secondary); font-size: 12px; }
.novelai-dimensions-row { margin-bottom: 8px; }
.novelai-resolution-presets { margin-bottom: 8px; }
.conn-switch-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin: 8px 0; color: var(--text-secondary); font-size: 12px; line-height: 1.45;
}
.conn-key-hint {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: -2px 0 4px; color: var(--text-secondary); font-size: 11px; line-height: 1.45;
}
.conn-health-hint { color: var(--text-secondary); font-size: 11px; }
.sd { width: 9px; height: 9px; border-radius: 50%; }
.sd.on { background: var(--success); }
.sd.off { background: var(--danger); }
.apikey-row .fi { flex: 1; min-width: 0; }
.free-egg-btn.active { border-color: #facc15; background: rgba(250, 204, 21, 0.16); color: #facc15; }
.relay-intro-btn {
  padding: 0; border: none; background: none;
  font-size: 12px; font-weight: 500; color: var(--accent-text);
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: color 0.15s;
}
.relay-intro-btn:hover { color: var(--accent-text); }
.relay-intro-footer { margin-left: auto; }
.relay-modal-tip { font-size: 12px; color: var(--text-secondary); margin: 0 0 12px; }
.relay-station {
  border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 12px;
  background: var(--bg-secondary);
}
.relay-station-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px;
}
.relay-station-name { font-size: 14px; font-weight: 600; color: var(--text-bright); }
.relay-quick-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 12px;
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
.relay-quick-icon { flex-shrink: 0; }
.relay-station-desc {
  font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin: 0 0 10px;
}
.relay-station-line {
  font-size: 12px; color: var(--text-secondary); margin: 4px 0; line-height: 1.6;
  overflow-wrap: anywhere;
}
.relay-station-link { overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .relay-station-head { align-items: flex-start; }
}
@keyframes egg-drop-fly {
  0% { transform: translate(0, 0) rotate(var(--rot)) scale(0.15, 0.15); opacity: 0; }
  8% { opacity: 1; }
  32% { transform: translate(var(--mx), var(--my)) rotate(var(--rot)) scale(0.85, 1.45); }
  68% { transform: translate(var(--x), var(--y)) rotate(var(--rot)) scale(0.6, 0.9); opacity: 0.95; }
  100% { transform: translate(var(--x), calc(var(--y) + var(--fall))) rotate(var(--rot)) scale(1.3, 0.08); opacity: 0; }
}
@keyframes egg-shard-fly {
  0% { transform: translate(0, 0) rotate(0deg) scale(0.2); opacity: 0; }
  12% { opacity: 1; }
  55% { transform: translate(var(--mx), var(--my)) rotate(calc(var(--rot) + 150deg)) scale(1.05); }
  100% { transform: translate(var(--x), var(--y)) rotate(calc(var(--rot) + 290deg)) scale(0.5); opacity: 0; }
}
.profile-tag.active {
  background: var(--btn-primary-bg);
  border-color: var(--btn-primary-bg);
  color: var(--btn-primary-fg);
  font-weight: 600;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 767px) {
  .novelai-param-row { grid-template-columns: 1fr; gap: 8px; }
  .fr { flex-direction: column; gap: 10px; }
  .sa { flex-wrap: wrap; gap: 8px; }
  .sa .sa-spacer { flex-basis: 100%; height: 0; margin: 0; }
  .sa .wf-action-btn { flex: 1 1 0; justify-content: center; padding: 8px 6px; }
}
.wf-mode-option.active {
  border-color: var(--accent);
  background: rgba(var(--accent-rgb), 0.08);
}
</style>
