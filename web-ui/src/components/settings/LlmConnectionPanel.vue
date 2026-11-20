<template>
<div class="card llm-card" :class="{ 'llm-card-first': llmCardFirst }">
        <div class="llm-card-header">
          <h3>LLM API 设置</h3>
          <!-- 每日免费鸡蛋：点击开启/关闭，免 Key 走 opencode zen 免费端点 -->
          <div
            v-if="llmSetupMode === 'full' || freeEgg"
            ref="freeEggBtn"
            role="button"
            tabindex="0"
            :class="['free-egg-btn', { active: freeEgg, 'is-disabled': llmBusy }]"
            :aria-disabled="llmBusy"
            :title="freeEgg ? '点击关闭，恢复自有 LLM 配置' : '点击开启：免 Key 使用 opencode 免费模型（按 IP 限流，上游限速会调整）'"
            @click="onFreeEggClick"
            @keydown.enter.prevent="onFreeEggClick"
            @keydown.space.prevent="onFreeEggClick"
          >
            <span class="free-egg-label">{{ freeEgg ? '🥚 免费鸡蛋享用中' : '🥚 每日免费鸡蛋' }}</span>
            <span v-if="eggSplash" :key="eggSplash.id" class="egg-splash" aria-hidden="true">
              <i v-for="drop in eggSplash.drops" :key="drop.id" class="egg-drop" :style="drop.style"></i>
              <i v-for="shard in eggSplash.shards" :key="shard.id" class="egg-shard" :style="shard.style"></i>
            </span>
          </div>
        </div>

        <Transition name="egg-page" mode="out-in">
        <!-- 首次/未配置：DeepSeek 简易设置（上游 v3.10.0 D 组） -->
        <p v-if="llmSetupMode === 'loading'" key="llm-loading" class="fd" role="status">正在读取接口设置…</p>
        <p v-else-if="llmSetupMode === 'error'" key="llm-error" class="gen-error" role="alert">暂时无法读取接口设置，请刷新页面重试。</p>
        <DeepseekSetup
          v-else-if="!freeEgg && llmSetupMode === 'guided'"
          key="llm-guided"
          :has-api-key="llmPreview.hasApiKey"
          :preview="llmPreview.preview"
          @connected="onGuidedLlmConnected"
          @configure="openFullLlmSetup"
          @start-chat="router.push('/chat')"
        />
        <div v-else-if="!freeEgg" key="llm-custom" class="llm-api-switch-body" :inert="llmBusy" :aria-busy="llmBusy">
        <div class="llm-setup-intro-row">
          <p class="fd" style="margin:0">配置 AI 对话和角色生成所使用的 LLM 接口</p>
          <div class="llm-setup-intro-actions">
            <linshe-button variant="link" size="sm" @click="showLlmHelp = true">接入说明</linshe-button>
            <linshe-button v-if="canReturnToGuidedSetup" variant="link" size="sm" @click="returnToGuidedSetup">返回 DeepSeek 简易设置</linshe-button>
          </div>
        </div>
        <p class="fd">deepseek的key获取地址：<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener" class="ext-link">https://platform.deepseek.com/api_keys</a> ，充多少用多少</p>

        <!-- 接入方式（上游 v3.10.0）：OpenAI 兼容接口 / Google Vertex AI -->
        <label class="fl llm-label" for="llm-connection-type">接入方式</label>
        <linshe-select
          id="llm-connection-type"
          v-model="llmConnectionType"
          :options="llmConnectionOptions"
          style="margin-bottom:6px"
          aria-label="接入方式"
          @update:model-value="onLlmConnectionChange"
        />
        <template v-if="llmConnectionType === 'vertexai'">
          <label class="fl llm-label" for="vertex-account">服务账号 JSON</label>
          <linshe-input
            id="vertex-account"
            v-model="vertexServiceAccount"
            type="textarea"
            :rows="4"
            placeholder="粘贴完整 service_account JSON（包括最外层大括号）；留空则沿用已保存的账号"
            @input="onVertexAccountInput"
          />
          <div class="vertex-status-row">
            <linshe-button
              variant="secondary"
              size="sm"
              :loading="vertexValidating"
              :disabled="vertexValidating || (!vertexServiceAccount.trim() && !hasVertexServiceAccount)"
              @click="validateVertexAccount"
            >
验证 JSON
</linshe-button>
            <span class="vertex-status" aria-live="polite">{{ vertexValidation || (vertexServiceAccount.trim() ? '新 JSON 尚未验证 / 保存' : hasVertexServiceAccount ? '服务账号已配置' : '缺少服务账号') }}</span>
          </div>
          <label class="fl llm-label" for="vertex-region">地区</label>
          <linshe-select
            id="vertex-region"
            v-model="vertexRegion"
            :options="vertexRegionOptions"
            searchable
            allow-free-input
            aria-label="地区"
            @update:model-value="onLlmEndpointInput"
          />
          <p class="fd">默认 global，模型可用性取决于项目权限和地区。</p>
        </template>

        <LlmProfilesPanel
          :profiles="llmProfiles" :active-id="activeLlmProfileId"
          :busy="llmBusy" :select="switchProfile" :remove="removeProfile" :create="addProfile"
        />
        <!-- API Key / API 地址：仅 OpenAI 兼容接口需要（Vertex 走服务账号） -->
        <template v-if="llmConnectionType === 'openai'">
        <!-- API Key -->
        <label class="fl llm-label">API Key</label>
        <div class="apikey-row">
          <linshe-input
            v-model="llmApiKey"
            :type="showApiKey ? 'text' : 'password'"
            class="fi"
            name="linshe-llm-key"
            autocomplete="new-password"
            style="margin-bottom:0"
            :placeholder="llmPreview.hasApiKey ? '已保存密钥，输入新密钥可替换' : '请输入 API Key'"
            @input="onLlmKeyInput"
          />
          <linshe-button class="sp-btn-small" size="sm" style="flex-shrink:0" title="复制完整 API Key" @click="copyLlmApiKey">复制</linshe-button>
          <linshe-button class="sp-btn-small" variant="ghost" size="sm" style="flex-shrink:0" @click="showApiKey = !showApiKey">
            {{ showApiKey ? '隐藏' : '显示' }}
          </linshe-button>
        </div>
        <div v-if="llmPreview.hasApiKey" class="key-status">
          <span class="key-ok">🔑 当前:</span>
          <code class="key-preview" role="button" tabindex="0" title="点击复制完整 API Key" @click="copyLlmApiKey" @keydown.enter="copyLlmApiKey">{{ llmPreview.preview }}</code>
        </div>
        <div v-else class="key-status key-missing">⚠️ 未设置，AI 对话功能不可用</div>

        <!-- API 地址 -->
        <label class="fl llm-label" style="margin-top:14px">API 地址</label>
        <linshe-select v-model="llmBaseURLSelectVal" :options="llmBaseURLOptions" placeholder="请选择API地址" style="margin-bottom:6px" />
        <linshe-input v-if="isCustomBaseURL" v-model="llmBaseURL" class="fi" placeholder="https://your-api-endpoint/v1" @input="onLlmEndpointInput" />
        </template>

        <section class="llm-section" aria-labelledby="llm-model-heading">
          <div class="llm-section-heading"><h4 id="llm-model-heading">模型参数</h4></div>
          <div class="llm-field">
            <label class="llm-label">模型</label>
            <div class="llm-model-row">
              <linshe-select
                ref="llmModelSelect"
                v-model="llmModelSelectVal"
                class="llm-model-select"
                :options="llmModelOptions"
                searchable
                allow-free-input
                :placeholder="llmConnectionType === 'vertexai' ? '如 gemini-2.5-pro' : '选择或输入模型 ID'"
                aria-label="模型"
              />
              <linshe-button variant="secondary" :loading="llmModelsLoading" :disabled="llmModelsLoading || (llmConnectionType === 'openai' && !llmBaseURL.trim())" @click="loadAvailableModels">获取模型</linshe-button>
            </div>
            <p v-if="llmModelsError" class="model-fetch-error" role="alert">{{ llmModelsError }}</p>
          </div>
          <div class="llm-parameter-grid">
            <div class="llm-field">
              <label class="llm-label" for="llm-max-tokens">最大输出 tokens</label>
              <linshe-input id="llm-max-tokens" v-model.number="llmMaxTokens" type="number" min="1" step="1" :invalid="!llmMaxTokensValid" aria-describedby="llm-max-tokens-hint" @input="onLlmMaxTokensInput" />
              <p id="llm-max-tokens-hint" class="llm-token-hint" :class="{ 'is-invalid': !llmMaxTokensValid, 'is-oversized': llmMaxTokensValid && llmMaxTokensOversized }" aria-live="polite">{{ llmMaxTokensHint }}</p>
            </div>
          </div>
        </section>

        <section class="llm-section llm-routes-section" aria-labelledby="llm-routes-heading">
          <div class="llm-section-heading">
            <h4 id="llm-routes-heading">按用途分配模型</h4>
            <span v-if="modelRoutesSaved" class="smsg">已保存</span>
          </div>
          <p class="llm-routes-hint">留空即跟随上面的默认模型。神说和日程对模型的要求常常相反，分开配比反复调一个通吃更省事。</p>
          <p v-if="modelRoutesFreeEgg" class="llm-routes-hint">当前开着免费鸡蛋，模型由免费池决定，这套分配暂不生效。</p>
          <div class="llm-routes-grid">
            <div v-for="route in modelRoutes" :key="route.key" class="llm-routes-item">
              <label class="llm-label">{{ route.label }}</label>
              <linshe-select
                v-model="route.model"
                :options="llmModelOptions"
                searchable
                allow-free-input
                size="sm"
                :placeholder="modelRoutesDefault ? `默认 ${modelRoutesDefault}` : '选择或输入模型 ID'"
                :aria-label="route.label"
                @update:model-value="markModelRoutesDirty"
              />
            </div>
          </div>
          <p v-if="modelRoutesError" class="model-fetch-error" role="alert">{{ modelRoutesError }}</p>
          <div class="llm-routes-actions">
            <linshe-button variant="secondary" size="sm" :loading="modelRoutesSaving" :disabled="modelRoutesSaving || !modelRoutesDirty" @click="saveModelRouteChanges">保存分配</linshe-button>
          </div>
        </section>

        <div v-if="isCustomBaseURL" class="toggle-row thinking-setting">
          <div>
            <div class="tl llm-label">思考模式</div>
            <div class="td">默认「关」：请求里明确禁用思考，回复更快也更省 token。开启后模型先思考再作答，适合需要推演复杂设定的场景，但更慢、更耗额度。</div>
          </div>
          <!-- 分段选择统一用 LinsheTabs：原先自绘的滑块选中色取的是 --accent（暖色主题下是珊瑚红），
               看着像警告色，与页面其它分段控件也不一致（2026-10-30 用户反馈「反色」）。 -->
          <linshe-tabs
            :model-value="llmThinkingMode === 'enabled' ? 'enabled' : 'disabled'"
            :options="thinkingModeOptions"
            size="sm"
            aria-label="思考模式"
            @update:model-value="onThinkingModePick"
          />
        </div>

        <template v-if="isCustomBaseURL">
          <div
            role="button"
            tabindex="0"
            class="llm-advanced-toggle"
            :aria-expanded="llmAdvancedOpen"
            @click="toggleLlmAdvanced"
            @keydown.enter.prevent="toggleLlmAdvanced"
            @keydown.space.prevent="toggleLlmAdvanced"
          >
            <span class="llm-advanced-label llm-label">高级设置</span>
            <svg class="llm-advanced-chevron" :class="{ open: llmAdvancedOpen }" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
          </div>
          <CollapseTransition :show="llmAdvancedOpen">
            <div class="llm-advanced-body">
              <!-- 自定义请求头（仅自定义API时显示，部分中转站如 OpenRouter 需要） -->
          <div class="toggle-row llm-custom-toggle">
            <div>
              <div class="tl">自定义请求头</div>
              <div class="td">为 OpenRouter 等中转服务附加 HTTP 请求头</div>
            </div>
            <linshe-switch v-model="llmHeadersEnabled" title="启用自定义请求头" aria-label="启用自定义请求头" @change="markLlmDirty" />
          </div>
          <div v-if="llmHeadersEnabled" class="llm-custom-editor">
            <label class="fl" for="llm-custom-headers">请求头 JSON</label>
            <linshe-input
              id="llm-custom-headers"
              v-model="llmHeadersText"
              class="fi llm-json-textarea"
              type="textarea"
              :invalid="!llmHeadersValid"
              placeholder="{&quot;HTTP-Referer&quot;:&quot;https://example.com&quot;,&quot;X-Title&quot;:&quot;MyApp&quot;}"
              @input="markLlmDirty"
            />
            <p v-if="!llmHeadersValid" class="gen-error" role="alert">JSON 格式无效</p>
          </div>

          <!-- 自定义请求体参数（仅自定义API时显示，用于注入 body 级参数如 thinking / agent 等） -->
          <div class="toggle-row llm-custom-toggle">
            <div>
              <div class="tl">自定义请求体</div>
              <div class="td">注入 agent 等额外 body 参数；同名字段会覆盖内置参数</div>
            </div>
            <linshe-switch v-model="llmExtraBodyEnabled" title="启用自定义请求体" aria-label="启用自定义请求体" @change="markLlmDirty" />
          </div>
          <div v-if="llmExtraBodyEnabled" class="llm-custom-editor">
            <label class="fl" for="llm-custom-body">请求体 JSON</label>
            <linshe-input
              id="llm-custom-body"
              v-model="llmExtraBodyText"
              class="fi llm-json-textarea"
              type="textarea"
              :invalid="!llmExtraBodyValid"
              placeholder="{&quot;agent&quot;:&quot;my-agent&quot;,&quot;agentName&quot;:&quot;Nova&quot;}"
              @input="markLlmDirty"
            />
            <p v-if="!llmExtraBodyValid" class="gen-error" role="alert">JSON 格式无效</p>
          </div>

          <!-- 后台 LLM 任务队列（仅自定义 API 时显示） -->
          <div class="toggle-row llm-option-row" style="padding-top:14px">
            <div>
              <div class="tl">后台 LLM 任务队列</div>
              <div class="td">限制LLM并发数量，避免本地 LLM 过载导致雪崩</div>
            </div>
            <linshe-switch v-model="features.serializeBackgroundLLM" @change="markLlmDirty()" />
          </div>
          <div v-if="features.serializeBackgroundLLM" class="toggle-row freq-row llm-option-row" style="margin-top:8px">
            <div>
              <div class="tl">最大并发后台请求数</div>
              <div class="td">同时运行的后台 LLM 任务数上限</div>
            </div>
            <div class="freq-control">
              <input
type="range" min="1" max="10" step="1"
                v-model.number="backgroundConcurrency" @change="markLlmDirty()"
/>
              <span class="freq-val">{{ backgroundConcurrency }}</span>
            </div>
          </div>

          <div class="toggle-row llm-option-row" style="padding-bottom:4px">
            <div>
              <div class="tl">合并消息兼容更多llm模板</div>
              <div class="td">合并连续Assistant或User消息，解决 LM Studio本地模型或其他llm的模板冲突</div>
            </div>
            <linshe-switch v-model="features.mergeMessages" @change="markLlmDirty()" />
          </div>
            </div>
          </CollapseTransition>
        </template>

        <div class="sa" style="margin-top:12px">
          <linshe-button variant="primary" :disabled="!llmDirty || !llmHeadersValid || !llmExtraBodyValid || !llmContextWindowValid || !llmMaxTokensValid || llmSaving" :loading="llmSaving" @click="saveLlmConfig">保存</linshe-button>
          <span v-if="llmSaved" class="smsg">已保存</span>
          <linshe-button class="llm-test-btn" variant="secondary" :disabled="llmTesting || !llmHeadersValid || !llmExtraBodyValid" @click="runLlmConnectionTest">
            {{ llmTesting ? '测试中…' : '测试连接' }}
          </linshe-button>
          <div
            role="button"
            tabindex="0"
            class="relay-intro-btn relay-intro-footer"
            @click="showRelayModal = true"
            @keydown.enter.prevent="showRelayModal = true"
            @keydown.space.prevent="showRelayModal = true"
          >
推荐中转站
</div>
        </div>
        </div>

        <!-- 免费鸡蛋模式：隐藏全部 LLM 配置项，仅显示说明 -->
        <div v-else key="llm-free" class="free-egg-notice">
          <span class="free-egg-icon" aria-hidden="true">🥚</span>
          <div class="free-egg-copy">
            <div class="free-egg-title">正在使用 opencode go 免费模型</div>
            <div class="free-egg-desc">每5小时每个IP限额200次请求</div>
            <div class="free-egg-hint">免费模型失败会自动切换；本轮全部失败会自动关闭鸡蛋，改用自有配置重试</div>
          </div>
        </div>
        </Transition>
      </div>

<linshe-modal v-model="showRelayModal" title="推荐中转站" wide>
        <p class="relay-modal-tip">以下为第三方 LLM 中转站，API Key 请在其官网获取</p>
        <div v-for="station in relayStations" :key="station.name" class="relay-station">
          <div class="relay-station-head">
            <span class="relay-station-name">{{ station.name }}</span>
            <linshe-button class="relay-quick-btn" variant="secondary" :disabled="relayConfigBusy" @click="applyRelayConfig(station)">
              <svg class="relay-quick-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
              <span>{{ relayConfigBusy ? '新增中…' : '快速配置' }}</span>
            </linshe-button>
          </div>
          <p class="relay-station-desc">{{ station.desc }}</p>
          <p class="relay-station-line"><a :href="station.keysUrl" target="_blank" rel="noopener" class="ext-link relay-station-link">跳转官网→</a></p>
        </div>
        <p class="relay-sponsor-note">可以注意到以上中转均未支付赞助费，看到请及时支付 <strong>**广告位招租**</strong></p>
      </linshe-modal>

<linshe-modal v-model="showLlmHelp" title="LLM 接入说明">
      <div class="llm-help-section">
        <h4>Google Vertex AI / Agent Platform</h4>
        <p class="fd">使用完整版 Service Account：粘贴下载的完整 JSON，点击「验证 JSON」。项目 ID 会自动读取，无需 API Key 或 API 地址；地区默认 global。保存后隐藏 JSON，仅显示配置状态。</p>
        <p class="fd">可获取模型目录或手动填写模型 ID（如 gemini-2.5-pro）。目录不代表项目已获授权，请用「测试连接」验证。Gemini Pro 选择关闭思考时，会使用模型允许的最低档位或自动预算。</p>
      </div>
      <template #footer><linshe-button variant="secondary" @click="showLlmHelp = false">知道了</linshe-button></template>
    </linshe-modal>
</template>

<script setup>
import DeepseekSetup from '../DeepseekSetup.vue'
import LlmProfilesPanel from './LlmProfilesPanel.vue'
import LinsheModal from '../ui/LinsheModal.vue'
import LinsheSelect from '../ui/LinsheSelect.vue'
import LinsheTabs from '../ui/LinsheTabs.vue'
import CollapseTransition from '../CollapseTransition.vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import { useSettingsPageContext } from '../../composables/settings/settingsContext.js'
const { llmCardFirst, llmSetupMode, freeEgg, llmBusy, onFreeEggClick, eggSplash, llmPreview, onGuidedLlmConnected, openFullLlmSetup, router, showLlmHelp, canReturnToGuidedSetup, returnToGuidedSetup, llmConnectionType, onLlmConnectionChange, llmConnectionOptions, vertexServiceAccount, onVertexAccountInput, vertexValidating, hasVertexServiceAccount, validateVertexAccount, vertexValidation, vertexRegion, onLlmEndpointInput, vertexRegionOptions, llmProfiles, activeLlmProfileId, switchProfile, removeProfile, addProfile, llmApiKey, showApiKey, onLlmKeyInput, copyLlmApiKey, llmBaseURLSelectVal, llmBaseURLOptions, isCustomBaseURL, llmBaseURL, llmModelSelectVal, llmModelOptions, llmModelsLoading, loadAvailableModels, llmModelsError, llmMaxTokens, llmMaxTokensValid, onLlmMaxTokensInput, llmMaxTokensOversized, llmMaxTokensHint, modelRoutesSaved, modelRoutesFreeEgg, modelRoutes, markModelRoutesDirty, modelRoutesDefault, modelRoutesError, modelRoutesSaving, modelRoutesDirty, saveModelRouteChanges, llmThinkingMode, thinkingModeOptions, onThinkingModePick, llmAdvancedOpen, toggleLlmAdvanced, llmHeadersEnabled, markLlmDirty, llmHeadersText, llmHeadersValid, llmExtraBodyEnabled, llmExtraBodyText, llmExtraBodyValid, features, backgroundConcurrency, llmDirty, llmContextWindowValid, llmSaving, saveLlmConfig, llmSaved, llmTesting, runLlmConnectionTest, showRelayModal, relayStations, relayConfigBusy, applyRelayConfig, freeEggBtn, llmModelSelect } = useSettingsPageContext()
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

.gen-error { margin-top: 6px; font-size: 12px; color: var(--danger, #ff4d4f); }
.llm-token-hint { margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
.llm-token-hint.is-invalid { color: var(--danger, #ff4d4f); }
.llm-token-hint.is-oversized { color: var(--warning, #faad14); }
.fr .fl {
  display: block; margin-bottom: 6px;
  font-size: 14px; font-weight: 600; color: var(--text-bright);
}
.ext-link {
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;
  font-weight: 500;
  transition: color 0.15s;
}
.ext-link:hover { color: var(--accent-text); }
.fav-star-btn:hover:not(.is-disabled) { color: #E2A83E; }
.fav-star-btn.is-disabled { opacity: 0.35; cursor: not-allowed; }

.sa { display: flex; align-items: center; gap: 12px; margin-top: auto; }
.smsg { color: var(--success); font-size: 13px; }

.toggle-row { display: flex; gap: 14px; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--glass-border); }
.toggle-row:last-child { border-bottom: none; }
.tl { font-size: 14px; font-weight: 500; color: var(--text-bright); }
.td { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

.freq-control {
  display: flex; align-items: center; gap: 10px; flex-shrink: 0;
}
.freq-control input[type="range"] {
  border: none;
  width: 100px; accent-color: var(--accent);
  -webkit-appearance: none; appearance: none;
  background: transparent;
}
.freq-control input[type="range"]::-webkit-slider-runnable-track {
  height: 4px; border-radius: 2px; background: #ffffff;box-shadow: 0 0 2px 1px lightcoral;
}
.freq-control input[type="range"]::-moz-range-track {
  height: 4px; border-radius: 2px; background: #fff;
}
.freq-control input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--accent); margin-top: -6px; cursor: pointer;
}
.freq-control input[type="range"]::-moz-range-thumb {
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--accent); border: none; cursor: pointer;
}
.freq-val {
  font-size: 14px; font-weight: 600; color: var(--accent-text); min-width: 28px; text-align: right;
}
.image-connection-fields .fd { margin-bottom: 8px; line-height: 1.5; }

.sp-btn-small { padding:6px 14px; font-size:12px; margin-right:6px; }
.apikey-row { display: flex; gap: 8px; align-items: center; }
.apikey-row .fi { flex: 1; min-width: 0; }
.key-status { margin-top: 8px; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.key-ok { color: #24682a; }
.key-missing { color: var(--danger); padding: 6px 10px; border-radius: 6px; background: rgba(255, 77, 79, 0.06); }
.key-preview { font-size: 12px; padding: 2px 8px; border-radius: 4px; background: var(--glass-bg-strong); border: 1px solid var(--glass-border); color: var(--text-secondary); cursor: pointer; transition: border-color 0.15s; }
.key-preview:hover { border-color: var(--accent); }
.llm-card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.llm-card-first { border-color: var(--accent, #d9a441); }
.llm-setup-intro-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.llm-setup-intro-actions { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.llm-card-header h3 { margin-bottom: 0; }
.free-egg-btn {
  display: inline-flex;
  align-items: center;
  padding: 5px 13px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 999px;
  border: 2px solid rgba(250, 204, 21, 0.45);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
  flex-shrink: 0;
  white-space: nowrap;
  position: relative;
}
.free-egg-btn:hover:not(.is-disabled) { border-color: #facc15; background: rgba(250, 204, 21, 0.08); color: #facc15; }
.free-egg-btn.active { border-color: #facc15; background: rgba(250, 204, 21, 0.16); color: #facc15; }
.free-egg-btn.is-disabled { opacity: 0.6; cursor: wait; }
.free-egg-label { position: relative; z-index: 3; }
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
.relay-sponsor-note {
  margin: 4px 0 0; text-align: right; font-size: 11px;
  color: var(--text-muted, #b3aca4); opacity: 0.55;
}
.relay-sponsor-note strong { font-weight: 600; color: var(--text-muted, #b3aca4); }
@media (max-width: 640px) {
  .relay-station-head { align-items: flex-start; }
}
.egg-splash {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  z-index: 2;
  pointer-events: none;
}
.egg-drop {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--size);
  height: calc(var(--size) * 1.35);
  margin: calc(var(--size) * -0.675) 0 0 calc(var(--size) * -0.5);
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, rgba(255, 255, 255, 0.95) 0 10%, var(--color) 42%, rgba(190, 118, 10, 0.9) 100%);
  box-shadow: 0 0 6px rgba(255, 190, 40, 0.5);
  animation: egg-drop-fly var(--dur) cubic-bezier(0.14, 0.62, 0.36, 1) var(--delay) both;
}
@keyframes egg-drop-fly {
  0% { transform: translate(0, 0) rotate(var(--rot)) scale(0.15, 0.15); opacity: 0; }
  8% { opacity: 1; }
  32% { transform: translate(var(--mx), var(--my)) rotate(var(--rot)) scale(0.85, 1.45); }
  68% { transform: translate(var(--x), var(--y)) rotate(var(--rot)) scale(0.6, 0.9); opacity: 0.95; }
  100% { transform: translate(var(--x), calc(var(--y) + var(--fall))) rotate(var(--rot)) scale(1.3, 0.08); opacity: 0; }
}
.egg-shard {
  position: absolute;
  left: 0;
  top: 0;
  width: calc(var(--size) * 1.7);
  height: var(--size);
  margin: calc(var(--size) * -0.5) 0 0 calc(var(--size) * -0.85);
  background: linear-gradient(135deg, #fffdf5 0%, #ead9b0 55%, #cbb177 100%);
  clip-path: polygon(18% 0, 100% 28%, 84% 100%, 0 74%, 10% 22%);
  box-shadow: inset 0 0 2px rgba(255, 255, 255, 0.75);
  animation: egg-shard-fly var(--dur) cubic-bezier(0.18, 0.7, 0.28, 1) var(--delay) both;
}
@keyframes egg-shard-fly {
  0% { transform: translate(0, 0) rotate(0deg) scale(0.2); opacity: 0; }
  12% { opacity: 1; }
  55% { transform: translate(var(--mx), var(--my)) rotate(calc(var(--rot) + 150deg)) scale(1.05); }
  100% { transform: translate(var(--x), var(--y)) rotate(calc(var(--rot) + 290deg)) scale(0.5); opacity: 0; }
}
.free-egg-notice {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  margin-top: 0;
  border-radius: 10px;
  border: 1px solid rgba(250, 204, 21, 0.28);
  background: rgba(250, 204, 21, 0.07);
}
.free-egg-icon { font-size: 30px; line-height: 1; flex-shrink: 0; }
.free-egg-copy { min-width: 0; }
.free-egg-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.free-egg-desc { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
.free-egg-hint { font-size: 11px; color: var(--text-secondary); opacity: 0.75; margin-top: 2px; }
.llm-model-row { display: flex; align-items: stretch; gap: 8px; margin-bottom: 14px; }
.llm-model-row .ls-select-wrapper { flex: 1; min-width: 0; }
.model-fetch-error { margin-top: -8px; margin-bottom: 14px; color: var(--danger); font-size: 12px; line-height: 1.5; }
.thinking-setting { min-width: 0; }
.thinking-setting,
.llm-custom-toggle,
.llm-option-row { border-bottom: none; }
.llm-custom-editor { padding: 4px 0 2px; }
.llm-json-textarea { min-height: 72px; font-family: monospace; font-size: 12px; resize: vertical; }
.llm-label { font-size: 13px; font-weight: 600; color: var(--text-bright); }
.llm-routes-section { margin-top: 18px; }
.llm-routes-hint { margin: 0 0 12px; font-size: 12px; line-height: 1.6; color: var(--text-secondary); }
.llm-routes-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px 14px; }
.llm-routes-item { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.llm-routes-actions { display: flex; justify-content: flex-end; margin-top: 14px; }
.llm-advanced-toggle {
  display: flex; align-items: center; justify-content: flex-start; gap: 6px;
  width: 100%; margin-top: 4px; padding: 12px 0 10px;
  border: none; border-bottom: 1px solid var(--glass-border);
  background: none; color: var(--text-bright);
  font-size: 13px; font-weight: 600; cursor: pointer;
  user-select: none;
  transition: color 0.15s;
}
.llm-advanced-label { min-width: 0; }
.llm-advanced-chevron { flex-shrink: 0; color: var(--text-secondary); transition: color 0.15s, transform 0.25s ease; }
.llm-advanced-toggle:hover .llm-advanced-chevron { color: var(--accent); }
.llm-advanced-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.llm-advanced-chevron.open { transform: rotate(180deg); }
.llm-advanced-body { padding-top: 2px; }
.profile-tag.active {
  background: var(--btn-primary-bg);
  border-color: var(--btn-primary-bg);
  color: var(--btn-primary-fg);
  font-weight: 600;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 767px) {
  .sa { flex-wrap: wrap; gap: 8px; }
  .sa .sa-spacer { flex-basis: 100%; height: 0; margin: 0; }
  .sa .wf-action-btn { flex: 1 1 0; justify-content: center; padding: 8px 6px; }
}
.wf-mode-option.active {
  border-color: var(--accent);
  background: rgba(var(--accent-rgb), 0.08);
}
</style>
