<template>
<div class="card">
        <h3>功能开关</h3>

        <div class="toggle-row theme-mode-row">
          <div>
            <div class="tl">界面主题</div>
            <div class="td">暖色、暗夜，或按时间自动切换</div>
          </div>
          <div class="theme-mode-options" role="group" aria-label="界面主题">
            <linshe-button
              v-for="t in themeModes"
              :key="t.id"
              size="sm"
              variant="chip"
              :active="settingsStore.themeMode === t.id"
              @click="settingsStore.setThemeMode(t.id)"
            >
{{ t.name }}
</linshe-button>
          </div>
        </div>

        <div class="toggle-row">
          <div>
            <div class="tl">默认助手</div>
            <div class="td">那个生图助手人格。关掉后它不进角色列表，也不会被「对所有人」的批量覆盖/命令带上</div>
          </div>
          <linshe-switch v-model="defaultAssistantEnabled" @change="saveDefaultAssistant" />
        </div>

        <div class="toggle-row">
          <div>
            <div class="tl">好感度系统</div>
            <div class="td">每轮对话后评估 AI 情绪变化，影响回复语气</div>
          </div>
          <linshe-switch v-model="features.emotion" :disabled="featureSaving.has('emotion')" @change="saveFeature('emotion', features.emotion)" />
        </div>

        <div class="toggle-row">
          <div>
            <div class="tl">聊天候选词</div>
            <div class="td">LLM回复后预测用户接下来可能说的话，在输入框上方显示快捷候选</div>
          </div>
          <linshe-switch v-model="features.replyGuesses" :disabled="featureSaving.has('replyGuesses')" @change="saveFeature('replyGuesses', features.replyGuesses)" />
        </div>

        <div class="toggle-row">
          <div>
            <div class="tl">实时显示好感度</div>
            <div class="td">在聊天顶部实时显示当前好感度数值和最近变化原因</div>
          </div>
          <linshe-switch v-model="features.realtimeAffinityDisplay" :disabled="featureSaving.has('realtimeAffinityDisplay') || settingsStore.isSaving('realtimeAffinityDisplay')" @change="saveFeature('realtimeAffinityDisplay', features.realtimeAffinityDisplay)" />
        </div>


        <div class="toggle-row freq-row">
          <div>
            <div class="tl">主动聊天频率</div>
            <div class="td">0 关闭，越大越频繁。</div>
          </div>
          <div class="freq-control">
            <input
type="range" min="0" max="1" step="0.1"
              v-model.number="freqSlider"
              @change="onFreqChange"
            />
            <span class="freq-val">{{ freqSlider.toFixed(1) }}</span>
          </div>
        </div>

        <div class="toggle-row freq-row">
          <div>
            <div class="tl">奇遇触发频率</div>
            <div class="td">0 关闭自动触发，1 为默认频率（约 30 分钟一次）。</div>
          </div>
          <div class="freq-control">
            <input
type="range" min="0" max="1" step="0.1"
              v-model.number="eventFreqSlider"
              @change="onEventFreqChange"
            />
            <span class="freq-val">{{ eventFreqSlider.toFixed(1) }}</span>
          </div>
        </div>

        <!-- 防打扰模式 -->
        <div class="toggle-row">
          <div style="flex:1">
            <div class="tl">防打扰模式</div>
            <div class="td">在指定时间段内自动禁用勾选角色的朋友圈、主动聊天和奇遇</div>
          </div>
          <div
            v-if="disturbMode"
            class="disturb-setup-btn"
            title="防打扰设置"
            @click="openDisturbDialog"
          >
<gear-icon :size="17" />
</div>
          <linshe-switch v-model="disturbMode" @change="onDisturbModeToggle" />
        </div>

        <!-- 实时天气 -->
        <div class="toggle-row">
          <div style="flex:1">
            <div class="tl">实时天气</div>
            <div class="td">你将和角色共享天气</div>
          </div>
          <div
            v-if="features.weather"
            class="disturb-setup-btn"
            title="设置城市"
            @click="openWeatherCityDialog"
          >
<gear-icon :size="17" />
</div>
          <linshe-switch v-model="features.weather" :disabled="featureSaving.has('weather')" @change="saveFeature('weather', features.weather)" />
        </div>

        <!-- 亲密度看板（总开关：关闭后不再自动记账，看板写入与回填接口返回 409） -->
        <div class="toggle-row">
          <div>
            <div class="tl">亲密度看板</div>
            <div class="td">记录角色的身体档案与相处统计，并允许角色在对话中知晓；关闭后停止自动记账与历史回填</div>
          </div>
          <linshe-switch v-model="features.intimate" aria-label="亲密度看板" title="亲密度看板" @change="saveIntimateFeature('intimate', features.intimate)" />
        </div>

        <!-- 历史对话回填（默认开：把以往会话中能识别的记录补进看板流水） -->
        <div class="toggle-row">
          <div>
            <div class="tl">历史对话回填</div>
            <div class="td">把以往的对话记录补进看板流水，仅在亲密度看板开启时生效</div>
          </div>
          <linshe-switch v-model="features.intimateBackfill" aria-label="历史对话回填" title="历史对话回填" @change="saveIntimateFeature('intimateBackfill', features.intimateBackfill)" />
        </div>

        <!-- 全部角色知晓身体档案（一键批量开关：不用逐个角色打开看板顶部的知晓开关。
             空档案在注入时被判为空内容、零注入，所以对没填档案的角色打开它不产生 token 成本） -->
        <div class="toggle-row">
          <div>
            <div class="tl">全部角色知晓身体档案</div>
            <div class="td">{{ injectAllHint }}。档案为空时不会注入任何内容，也不消耗 token</div>
          </div>
          <linshe-switch
            v-model="injectAllOn"
            :disabled="injectAll.saving"
            aria-label="全部角色知晓身体档案"
            title="全部角色知晓身体档案"
            @change="saveInjectAll"
          />
        </div>
      </div>

<linshe-modal v-model="disturbDialog.show" title="防打扰设置" wide>
      <div class="disturb-dialog-section">
        <span class="disturb-dialog-label">⏰ 静默时段</span>
        <p class="disturb-dialog-hint">在此时段内自动禁用所选角色的朋友圈、主动聊天和奇遇。支持跨午夜（如 22:00 ~ 08:00）。</p>
        <div class="disturb-time-row">
          <linshe-input type="time" v-model="disturbDialog.startTime" class="disturb-time-input" />
          <span class="disturb-time-sep">—</span>
          <linshe-input type="time" v-model="disturbDialog.endTime" class="disturb-time-input" />
        </div>
      </div>
      <div class="disturb-dialog-section">
        <span class="disturb-dialog-label">👤 适用角色</span>
        <p class="disturb-dialog-hint">勾选需要在静默时段内暂停互动通知的角色</p>
        <div v-if="allCharacters.length === 0" class="disturb-no-chars">暂无角色，请先创建角色</div>
        <div v-else class="disturb-char-grid">
          <label
            v-for="ch in allCharacters"
            :key="ch.id"
            class="disturb-char-chip"
            :class="{ selected: disturbDialog.characterIds.includes(ch.id) }"
            @click="toggleDisturbDialogChar(ch.id)"
          >
            <div
              class="disturb-char-avatar"
              :style="ch.avatar_path
                ? { backgroundImage: `url(${ch.avatar_path})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                : { background: 'var(--accent)' }"
            >{{ ch.avatar_path ? '' : ch.display_name.charAt(0) }}</div>
            <span class="disturb-char-name">{{ ch.display_name }}</span>
          </label>
        </div>
      </div>
      <div class="disturb-dialog-section disturb-dialog-toggles">
        <label class="disturb-option-row">
          <span class="disturb-option-label">隐藏世界观</span>
          <span class="disturb-option-hint">时段内暂时不向角色注入世界背景设定</span>
          <linshe-switch v-model="disturbDialog.hideWorld" aria-label="隐藏世界观" />
        </label>
        <label class="disturb-option-row">
          <span class="disturb-option-label">跳过周末</span>
          <span class="disturb-option-hint">周六周日不执行防打扰，恢复全部互动</span>
          <linshe-switch v-model="disturbDialog.skipWeekends" aria-label="跳过周末" />
        </label>
      </div>
      <template #footer>
        <linshe-button variant="secondary" @click="cancelDisturbDialog">取消</linshe-button>
        <linshe-button variant="primary" @click="confirmDisturbDialog">保存设置</linshe-button>
      </template>
    </linshe-modal>

<linshe-modal v-model="weatherCityDialog.show" title="天气城市设置">
      <p class="disturb-dialog-hint">输入城市名（中文），留空则自动根据 IP 定位</p>
      <linshe-input type="text" v-model="weatherCityDialog.city" class="fi" :disabled="settingsStore.isSaving('weatherCity')" placeholder="如：北京、上海、杭州" @keyup.enter="confirmWeatherCity" />
      <template #footer>
        <linshe-button variant="primary" :loading="settingsStore.isSaving('weatherCity')" :disabled="settingsStore.isSaving('weatherCity')" @click="confirmWeatherCity">保存</linshe-button>
      </template>
    </linshe-modal>
</template>

<script setup>
import LinsheModal from '../ui/LinsheModal.vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import GearIcon from '../GearIcon.vue'
import { useSettingsPageContext } from '../../composables/settings/settingsContext.js'
const { themeModes, settingsStore, defaultAssistantEnabled, saveDefaultAssistant, features, featureSaving, saveFeature, freqSlider, onFreqChange, eventFreqSlider, onEventFreqChange, disturbMode, openDisturbDialog, onDisturbModeToggle, openWeatherCityDialog, saveIntimateFeature, injectAllHint, injectAllOn, injectAll, saveInjectAll, disturbDialog, cancelDisturbDialog, confirmDisturbDialog, allCharacters, toggleDisturbDialogChar, weatherCityDialog, confirmWeatherCity } = useSettingsPageContext()
</script>

<style scoped>
.float-badge.active { background: rgba(var(--accent-rgb), 0.14); color: var(--accent); }
.card {
  padding: 24px;
  display: flex;
  flex-direction: column;
}
.card h3 { font-size: 15px; color: var(--text-bright); margin-bottom: 12px; font-weight: 600; }
.fi { margin-bottom: 14px; }

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
.disturb-setup-btn {
  width: 30px; height: 30px; border-radius: 50%;
  background: transparent; color: var(--text-secondary);
  border: 1px solid transparent;
  cursor: pointer; transition: all 0.2s ease;
  display: flex; align-items: center; justify-content: center;
  margin-right: 6px; flex-shrink: 0;
  font-size: 17px; line-height: 1;
}
.disturb-setup-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  transform: rotate(60deg);
}
.disturb-dialog-section { margin-bottom: 18px; flex-shrink: 0; }
.disturb-dialog-section.disturb-char-scroll {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  margin-bottom: 0;
}
.disturb-dialog-label {
  font-size: 14px; font-weight: 600; color: var(--text-bright);
}
.disturb-dialog-hint {
  font-size: 12px; color: var(--text-secondary); margin: 4px 0 10px;
}
.disturb-time-row {
  display: flex; align-items: center; gap: 10px;
}
.disturb-time-input {
  font-size: 14px;
  width: 130px;
}
.disturb-time-sep { color: var(--text-secondary); }
.disturb-no-chars {
  font-size: 13px; color: var(--text-secondary); margin: 8px 0;
}
.disturb-char-grid {
  display: flex; flex-wrap: wrap; gap: 10px;
  overflow-y: auto; flex: 1; min-height: 0;
  align-content: flex-start;
}
.disturb-char-chip {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 10px 12px; border-radius: 12px;
  border: 2px solid transparent;
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
  min-width: 70px;
}
.disturb-char-chip:hover {
  border-color: var(--border);
  background: var(--bg-hover);
}
.disturb-char-chip.selected {
  border-color: var(--accent);
  background: rgba(var(--accent-rgb), 0.08);
}
.disturb-char-avatar {
  width: 42px; height: 42px; border-radius: 50%;
  background-size: cover; background-position: center;
  border: 2px solid transparent;
  transition: border-color 0.15s;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 13px; font-weight: 700;
  user-select: none;
}
.disturb-char-chip.selected .disturb-char-avatar {
  border-color: var(--accent);
}
.disturb-char-name {
  font-size: 12px; color: var(--text-secondary); text-align: center;
  max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.disturb-char-chip.selected .disturb-char-name {
  color: var(--accent); font-weight: 500;
}
.disturb-dialog-toggles {
  padding-top: 10px; border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.disturb-option-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 0;
  cursor: pointer; user-select: none;
  flex-wrap: wrap;
}
.disturb-option-label {
  font-size: 13px; font-weight: 500; color: var(--text-bright);
}
.disturb-option-hint {
  flex: 1; min-width: 140px; font-size: 12px; color: var(--text-secondary);
}
.apikey-row .fi { flex: 1; min-width: 0; }
.free-egg-btn.active { border-color: #facc15; background: rgba(250, 204, 21, 0.16); color: #facc15; }
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
.wf-mode-option.active {
  border-color: var(--accent);
  background: rgba(var(--accent-rgb), 0.08);
}
.theme-mode-row { align-items: flex-start; }
.theme-mode-options { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; padding-top: 2px; }
@media (max-width: 767px) {
  .theme-mode-row { flex-direction: column; align-items: stretch; gap: 10px; }
  .theme-mode-options { justify-content: flex-start; }
}
</style>
