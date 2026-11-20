<template>
<Transition name="editor-fade">
      <div v-if="showImpression" class="editor-overlay" @click.self="showImpression = false">
      <div class="editor-panel impression-panel">
        <div class="editor-header">
          <span>{{ chat.activeChar?.display_name }} 对你的印象</span>
          <linshe-button variant="icon" class="editor-close" @click="showImpression = false">&times;</linshe-button>
        </div>

        <div class="impression-body">
          <!-- 加载中 -->
          <div v-if="impressionLoading" class="impression-status">
            <div class="impression-loading-spinner"></div>
            <span>正在读取对你的印象...</span>
          </div>
          <!-- 错误 -->
          <div v-else-if="impressionError" class="impression-status impression-error-state">
            <span class="impression-error-icon">⚠️</span>
            <span>加载失败: {{ impressionError }}</span>
          </div>
          <!-- 画像列表 + 情绪状态（双栏） -->
          <div v-else class="impression-content">
            <div class="impression-left">
            <div v-for="key in groupKeys" :key="key">
              <div class="impression-group">
                <div class="impression-group-header">
                  <span class="impression-group-badge" :style="{ background: typeColor[key] }">
                    {{ typeIcon[key] }}
                  </span>
                  <span class="impression-group-title">{{ typeLabel[key] }}</span>
                  <span class="impression-group-count">{{ impressionGrouped[key]?.length || 0 }}</span>
                  <div class="impression-add-btn" role="button" tabindex="0" :style="{ color: typeColor[key] }" title="添加" @keydown.enter.prevent="startAdd(key)" @keydown.space.prevent="startAdd(key)" @click="startAdd(key)">+</div>
                </div>

                <!-- 添加模式（该组为空或用户点击 + 后） -->
                <div v-if="addingKey === key" class="impression-card-list">
                  <div class="impression-card impression-card-editing" :style="{ '--tint': typeColor[key] }">
                    <textarea
                      v-model="addingContent"
                      class="impression-edit-textarea"
                      :style="{ borderColor: typeColor[key] }"
                      rows="2"
                      placeholder="输入新的特征描述..."
                      @keydown.esc="cancelAdd"
                      @keydown.enter.ctrl="saveAdd(key)"
                    ></textarea>
                    <div class="impression-edit-actions">
                      <div role="button" tabindex="0" class="impression-btn impression-btn-cancel" :class="{ 'is-disabled': savingAdd }" :aria-disabled="savingAdd" @keydown.enter.prevent="cancelAdd" @keydown.space.prevent="cancelAdd" @click="cancelAdd">取消</div>
                      <div role="button" tabindex="0" class="impression-btn impression-btn-save" :class="{ 'is-disabled': savingAdd || addingContent.trim().length < 2 }" :aria-disabled="savingAdd || addingContent.trim().length < 2" :style="{ background: typeColor[key] }" @keydown.enter.prevent="saveAdd(key)" @keydown.space.prevent="saveAdd(key)" @click="saveAdd(key)">
                        {{ savingAdd ? '添加中...' : '添加' }}
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 已有特征列表 -->
                <div v-if="impressionGrouped[key]?.length" class="impression-card-list">
                  <div
                    v-for="trait in impressionGrouped[key]"
                    :key="trait.id"
                    class="impression-card"
                    :class="{ 'impression-card-editing': editingId === trait.id }"
                    :style="{ '--tint': typeColor[key] }"
                  >
                    <!-- 编辑模式 -->
                    <template v-if="editingId === trait.id">
                      <textarea
                        v-model="editingContent"
                        class="impression-edit-textarea"
                        :style="{ borderColor: typeColor[key] }"
                        rows="2"
                        @keydown.esc="cancelEdit"
                        @keydown.enter.ctrl="saveEdit(trait)"
                      ></textarea>
                      <div class="impression-edit-actions">
                        <div role="button" tabindex="0" class="impression-btn impression-btn-cancel" :class="{ 'is-disabled': savingEdit }" :aria-disabled="savingEdit" @keydown.enter.prevent="cancelEdit" @keydown.space.prevent="cancelEdit" @click="cancelEdit">取消</div>
                        <div role="button" tabindex="0" class="impression-btn impression-btn-save" :class="{ 'is-disabled': savingEdit || editingContent.trim().length < 2 }" :aria-disabled="savingEdit || editingContent.trim().length < 2" :style="{ background: typeColor[key] }" @keydown.enter.prevent="saveEdit(trait)" @keydown.space.prevent="saveEdit(trait)" @click="saveEdit(trait)">
                          {{ savingEdit ? '保存中...' : '保存' }}
                        </div>
                      </div>
                    </template>
                    <!-- 查看模式 -->
                    <template v-else>
                      <div class="impression-card-main">
                        <span class="impression-card-text">{{ trait.content }}</span>
                        <div class="impression-card-meta">
                          <span class="impression-card-confidence" :title="'置信度: ' + Math.round((trait.confidence || 0.5) * 100) + '%'">
                            <span class="dot" :class="'dot-' + confidenceLevel(trait.confidence)"></span>
                            <span class="dot" :class="'dot-' + confidenceLevel(trait.confidence, 1)"></span>
                            <span class="dot" :class="'dot-' + confidenceLevel(trait.confidence, 2)"></span>
                          </span>
                          <span class="impression-card-time">{{ formatTime(trait.created_at) }}</span>
                        </div>
                      </div>
                      <div class="impression-card-actions">
                        <div class="impression-action-btn" role="button" tabindex="0" title="编辑" @keydown.enter.prevent="startEdit(trait)" @keydown.space.prevent="startEdit(trait)" @click="startEdit(trait)">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                        </div>
                        <div class="impression-action-btn impression-action-btn-danger" role="button" tabindex="0" title="删除" @keydown.enter.prevent="removeTrait(trait)" @keydown.space.prevent="removeTrait(trait)" @click="removeTrait(trait)">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                        </div>
                      </div>
                    </template>
                  </div>
                </div>

                <!-- 空组占位 -->
                <div v-else-if="addingKey !== key" class="impression-empty-row">
                  <span class="impression-empty-row-text">暂无记录</span>
                  <div class="impression-add-link" role="button" tabindex="0" :style="{ color: typeColor[key] }" @keydown.enter.prevent="startAdd(key)" @keydown.space.prevent="startAdd(key)" @click="startAdd(key)">+ 添加特征</div>
                </div>
              </div>
            </div>
            </div>  <!-- impression-left -->

            <!-- 右栏：VAD 情绪 + 好感度 -->
            <div class="impression-right">
              <div class="vad-section">
                <div class="vad-section-title">情绪与好感度</div>

                <!-- 无数据 -->
                <div v-if="!impressionVad" class="vad-empty">
                  <span>暂无情绪数据</span>
                  <span class="vad-empty-hint">开始对话后自动生成</span>
                </div>

                <template v-else>
                  <!-- VAD 三维 -->
                  <div v-for="(conf, key) in VAD_LABELS" :key="key" class="vad-bar-group">
                    <div class="vad-bar-label">{{ conf.name }}</div>
                    <div class="vad-bar-row">
                      <span class="vad-bar-end vad-bar-end-left">{{ conf.left }}</span>
                      <div class="vad-bar-track">
                        <div
                          class="vad-bar-fill"
                          :style="{ width: vadPercent(key, impressionVad.instant[key]) + '%' }"
                        ></div>
                        <div
                          class="vad-bar-dot"
                          :style="{ left: vadPercent(key, impressionVad.instant[key]) + '%' }"
                        ></div>
                      </div>
                      <span class="vad-bar-end vad-bar-end-right">{{ conf.right }}</span>
                    </div>
                  </div>

                  <!-- 情绪特征（VAD → 最近四字词） -->
                  <div class="vad-dominant">
                    <span class="vad-dominant-label">情绪特征</span>
                    <span class="vad-emotion-tag">{{ topEmotions(impressionVad.instant, 1)[0]?.label || '—' }}</span>
                  </div>

                  <!-- 好感度 -->
                  <div class="affinity-section">
                    <div class="affinity-header">
                      <span class="affinity-label">好感度</span>
                      <span class="affinity-value">{{ Math.round(impressionAffinity) }}</span>
                      <span class="affinity-tag">{{ affinityLabel(impressionAffinity) }}</span>
                    </div>
                    <div class="affinity-hearts">
                      <div
                        v-for="i in 5"
                        :key="i"
                        class="affinity-heart"
                        :class="{ filled: impressionAffinity >= i * 20, half: impressionAffinity > (i - 1) * 20 && impressionAffinity < i * 20 }"
                      >
                        <svg viewBox="0 0 24 22" class="heart-svg">
                          <defs>
                            <clipPath :id="'heart-clip-' + i">
                              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                            </clipPath>
                          </defs>
                          <!-- 底色（空心） -->
                          <path
d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
                            class="heart-bg"
/>
                          <!-- 填充（clip 到对应百分比） -->
                          <rect
                            v-if="impressionAffinity > (i - 1) * 20"
                            x="0" y="0" width="24" height="22"
                            class="heart-fg"
                            :clip-path="'url(#heart-clip-' + i + ')'"
                            :style="{ width: Math.min(100, Math.max(0, (impressionAffinity - (i - 1) * 20) / 20 * 100)) + '%' }"
                          />
                        </svg>
                      </div>
                    </div>

                    <!-- 最近一次好感度变化 -->
                    <div v-if="impressionLastDelta != null" class="affinity-change">
                      <div class="affinity-change-row">
                        <span class="affinity-change-label">最近变化</span>
                        <span class="affinity-change-delta" :class="impressionLastDelta >= 0 ? 'delta-up' : 'delta-down'">
                          {{ impressionLastDelta >= 0 ? '+' : '' }}{{ impressionLastDelta.toFixed(1) }}
                        </span>
                      </div>
                      <div v-if="impressionLastReason" class="affinity-change-reason">
                        💬 {{ impressionLastReason }}
                      </div>
                    </div>
                    <!-- 实时显示开关 -->
                    <div class="affinity-realtime-toggle">
                      <span class="affinity-realtime-label">实时显示</span>
                      <linshe-switch
                        :model-value="realtimeAffinityEnabled"
                        :disabled="settings.isSaving('realtimeAffinityDisplay')"
                        size="sm"
                        aria-label="实时显示好感度"
                        @change="onRealtimeAffinityChange"
                      />
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>  <!-- impression-content -->
</div>
      </div>
      </div>
    </Transition>
</template>

<script setup>
import LinsheButton from '../../ui/LinsheButton.vue'
import LinsheSwitch from '../../ui/LinsheSwitch.vue'
import { usePrivateChatContext } from '../../../composables/chat/privateChatContext.js'
const { showImpression, chat, impressionLoading, impressionError, groupKeys, typeColor, typeIcon, typeLabel, impressionGrouped, startAdd, addingKey, addingContent, cancelAdd, saveAdd, savingAdd, editingId, editingContent, cancelEdit, saveEdit, savingEdit, confidenceLevel, formatTime, startEdit, removeTrait, impressionVad, VAD_LABELS, vadPercent, topEmotions, impressionAffinity, affinityLabel, impressionLastDelta, impressionLastReason, realtimeAffinityEnabled, settings, onRealtimeAffinityChange } = usePrivateChatContext()
</script>

<style scoped>
.typing-dots .dot {
  fill: #fff; animation: dotBlink 1.2s ease-in-out infinite;
}

@keyframes dotBlink {
  0%, 20%, 100% { fill: #fff; }
  40%, 60% { fill: #aaa; }
}
.force-img-toggle.is-disabled { opacity: 0.35; cursor: wait; }
.send-btn:not(.is-disabled):hover {
  box-shadow:
    0 4px 18px rgba(var(--accent-rgb), 0.35),
    0 0 32px rgba(var(--accent-rgb), 0.10);
  transform: scale(1.06);
}
.send-btn:not(.is-disabled):hover .send-icon { transform: translateX(1.5px); }
.send-btn:not(.is-disabled):hover::after {
  opacity: 1;
  inset: -8px;
}
.send-btn:not(.is-disabled):active {
  transform: scale(0.94);
  box-shadow: 0 1px 4px rgba(var(--accent-rgb), 0.2);
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}
.send-btn.is-disabled {
  opacity: 0.35;
  box-shadow: none;
}
.sp-btn.is-disabled { opacity:0.4; cursor:not-allowed; }
.sp-btn-danger:hover:not(.is-disabled) { background:rgba(255, 77, 79, 0.06); }
.editor-header { padding:16px 20px; border-bottom:1px solid var(--glass-border); display:flex; align-items:center; justify-content:space-between; }
.editor-header span { font-size:15px; font-weight:600; color:var(--text-bright); }
.editor-close { width:32px; height:32px; font-size:20px; }
@media (max-width: 767px) {
  .editor-header { padding-top: calc(16px + env(safe-area-inset-top, 0px)); }
}
.impression-body {
  overflow-y: auto;
  flex: 1;
  padding: 0;
}
.impression-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
  color: var(--text-secondary);
  font-size: 14px;
  gap: 12px;
}
.impression-loading-spinner {
  width: 28px; height: 28px;
  border: 3px solid var(--tint-subtle);
  border-top-color: var(--accent, var(--accent));
  border-radius: 50%;
  animation: impression-spin 0.7s linear infinite;
}
@keyframes impression-spin { to { transform: rotate(360deg); } }
.impression-error-state { color: #e55; }
.impression-error-icon { font-size: 24px; }
.impression-group { margin-bottom: 16px; }
.impression-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 0 2px;
}
.impression-group-badge {
  width: 26px; height: 26px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
}
.impression-group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.impression-group-count {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--tint-subtle);
  border-radius: 10px;
  padding: 0 7px;
  line-height: 18px;
  margin-left: auto;
}
.impression-add-btn {
  width: 24px; height: 24px;
  padding: 0;
  border-radius: 7px;
  border: 1px dashed currentColor;
  background: transparent;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
  transition: opacity 0.15s;
  margin-left: 4px;
  user-select: none;
}
.impression-add-btn:hover { opacity: 1; }
.impression-empty-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  border: 1.5px dashed var(--border);
  border-radius: 10px;
  background: var(--tint-faint);
}
.impression-empty-row-text {
  font-size: 13px;
  color: var(--text-secondary);
}
.impression-add-link {
  font-size: 13px;
  font-weight: 500;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 5px;
  transition: background 0.15s;
  text-decoration: none;
  user-select: none;
}
.impression-add-link:hover {
  background: var(--tint-subtle);
}
.impression-card-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.impression-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: 10px;
  border-left: 3px solid var(--tint, #ccc);
  transition: all 0.2s ease;
  position: relative;
}
.impression-card:hover {
  background: var(--bg-hover);
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
}
.impression-card-editing {
  flex-direction: column;
  background: var(--bg-tertiary);
  box-shadow: 0 2px 12px rgba(0,0,0,0.06);
}

.impression-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.impression-card-text {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-word;
}
.impression-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.impression-card-confidence {
  display: inline-flex;
  gap: 3px;
  align-items: center;
}
.impression-card-confidence .dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  transition: background 0.2s;
}
.impression-card-confidence .dot.on {
  background: var(--tint, #ccc);
  opacity: 0.8;
}
.impression-card-confidence .dot.off {
  background: var(--tint-subtle);
}

.impression-card-time {
  font-size: 11px;
  color: var(--text-secondary);
  margin-left: auto;
}
.impression-card-actions {
  display: flex;
  gap: 2px;
  opacity: 0.55;
  transition: opacity 0.18s ease;
  flex-shrink: 0;
  padding-top: 2px;
}
.impression-card:hover .impression-card-actions {
  opacity: 1;
}
@media (max-width: 767px) {
  .impression-card-actions { opacity: 1; }
}
.impression-action-btn {
  width: 28px; height: 28px;
  padding: 0;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  user-select: none;
}
.impression-action-btn:hover {
  background: var(--tint-subtle);
  color: var(--text-bright);
}
.impression-action-btn-danger:hover {
  background: rgba(255,77,79,0.1);
  color: var(--danger, #e55);
}
.impression-edit-textarea {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.5;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-bright);
  outline: none;
  resize: vertical;
  font-family: inherit;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.impression-edit-textarea:focus {
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb),0.12);
}
.impression-edit-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.impression-btn {
  padding: 6px 14px;
  border-radius: 7px;
  border: 1px solid transparent;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
  user-select: none;
}
.impression-btn.is-disabled { opacity: 0.5; cursor: not-allowed; }
.impression-btn-cancel {
  border-color: var(--border);
  background: transparent;
  color: var(--text-secondary);
}
.impression-btn-cancel:hover { background: var(--tint-subtle); }
.impression-btn-save {
  color: white;
  border: none;
}
.impression-btn-save:hover { filter: brightness(1.08); }

@media (max-width: 767px) {
  .impression-card { padding: 8px 10px; }
  .impression-content { flex-direction: column; }
  .impression-right { width: 100% !important; border-left: none; border-top: 1px solid var(--border); padding: 14px 0 0; min-width: 0; }
}
.impression-content {
  display: flex;
  gap: 0;
  flex: 1;
  min-height: 0;
}
.impression-left {
  flex: 1;
  min-width: 0;
  padding: 8px 20px 16px;
  overflow-y: auto;
}
.impression-right {
  width: 240px;
  min-width: 240px;
  border-left: 1px solid var(--border);
  padding: 8px 18px 16px;
  overflow-y: auto;
  background: var(--tint-faint);
}
.vad-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.vad-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 0;
  font-size: 13px;
  color: var(--text-secondary);
}
.vad-empty-hint {
  font-size: 11px;
  color: var(--text-secondary);
}
.vad-bar-group {
  margin-bottom: 10px;
}
.vad-bar-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 3px;
}
.vad-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.vad-bar-end {
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
  min-width: 28px;
  line-height: 1;
}
.vad-bar-end-left { text-align: right; }
.vad-bar-end-right { text-align: left; }
.vad-bar-track {
  flex: 1;
  height: 6px;
  background: var(--tint-subtle);
  border-radius: 3px;
  position: relative;
  overflow: visible;
}
.vad-bar-fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  background: linear-gradient(90deg, #6366f1, #a78bfa, var(--accent));
  border-radius: 3px;
  transition: width 0.4s ease;
}
.vad-bar-dot {
  position: absolute;
  top: 50%; transform: translate(-50%, -50%);
  width: 10px; height: 10px;
  background: white;
  border: 2px solid #6366f1;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(99,102,241,0.15);
}
.vad-dominant {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 10px;
  padding: 8px 10px;
  background: rgba(99,102,241,0.06);
  border-radius: 8px;
}
.vad-dominant-label {
  font-size: 11px;
  color: var(--text-secondary);
}
.vad-emotion-tag {
  font-size: 12px;
  font-weight: 600;
  color: #6366f1;
  background: rgba(99,102,241,0.08);
  padding: 2px 10px;
  border-radius: 10px;
  white-space: nowrap;
}
.affinity-section {
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.affinity-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.affinity-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.affinity-value {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
}
.affinity-tag {
  font-size: 11px;
  color: var(--accent);
  background: rgba(var(--accent-rgb),0.08);
  padding: 1px 8px;
  border-radius: 10px;
  margin-left: auto;
}
.affinity-hearts {
  display: flex;
  gap: 4px;
  justify-content: center;
}
.affinity-heart {
  width: 36px;
  height: 34px;
  position: relative;
  transition: transform 0.2s ease;
}
.affinity-heart.filled {
  transform: scale(1.06);
}
.affinity-heart .heart-svg {
  width: 100%;
  height: 100%;
}
.affinity-heart .heart-bg {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 1.2;
}
.affinity-heart .heart-fg {
  fill: #e05a7a;
}
.affinity-heart.filled .heart-fg {
  fill: #e0245e;
}
.affinity-heart.half .heart-fg {
  fill: #f0889e;
}
.affinity-change {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.affinity-change-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.affinity-change-label {
  font-size: 11px;
  color: var(--text-secondary);
}
.affinity-change-delta {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.affinity-change-delta.delta-up { color: #e05a7a; }
.affinity-change-delta.delta-down { color: #6366f1; }
.affinity-change-reason {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.5;
  font-style: italic;
}
.affinity-realtime-toggle {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 0 4px; margin-top: 4px;
  border-top: 1px solid var(--border);
}
.affinity-realtime-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
.header-affinity-delta.delta-up { color: #c2184a; }
.header-affinity-delta.delta-down { color: #4a90d9; }
</style>
