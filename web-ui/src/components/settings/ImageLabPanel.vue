<template>
<div class="card image-lab-card">
        <h3>图片实验室</h3>
        <p class="fd">可测试当前生图服务，使用对应画师串和分辨率发送生图请求，图片仅作预览不保存</p>
        <p class="fd">Anima文生图模型的数据库大约在2025年9月，过新的角色不识别，越久的角色特征越稳定</p>
        <p class="fd">切换模型之后首次生图需要加载模型所以会慢一点</p>

        <div class="free-scene-row">
          <div class="free-scene-input-wrap">
            <linshe-auto-textarea
              ref="sceneDescRef"
              v-model="freeSceneDesc"
              class="free-scene-textarea"
              collapsible
              placeholder="（置空使用默认）自由描述任意画面"
              @focus="onSceneDescFocus"
              @blur="onSceneDescBlur"
              @enter="submitOnEnter($event, runFreeSceneTest)"
            />
</div>
          <!-- 有输入内容时才出现，渐入渐出 -->
          <Transition name="gen-btn-fade">
            <linshe-button
              v-if="freeSceneDesc.trim() || styleTesting"
              class="free-scene-btn"
              variant="primary"
              :disabled="styleTesting || !freeSceneDesc.trim()"
              @click="runFreeSceneTest"
            >
              {{ styleTesting ? '生成中...' : generatedPrompt ? '重新生成提示词' : '生成提示词' }}
            </linshe-button>
          </Transition>
        </div>

        <div
          v-if="generatedPrompt && !promptEditing"
          class="generated-prompt-box editable"
          title="点击编辑提示词"
          @click="startPromptEdit"
        >
{{ generatedPrompt }}
</div>
        <linshe-auto-textarea
          v-else-if="generatedPrompt"
          ref="promptEditRef"
          v-model="generatedPrompt"
          class="generated-prompt-box generated-prompt-editor"
          placeholder=""
          @blur="promptEditing = false"
          @enter="submitOnEnter($event, runGeneratedPromptTest)"
          @escape="promptEditing = false"
        />
        <div v-if="styleError" class="style-error">{{ styleError }}</div>

        <div v-if="styleTesting" class="style-loading">
          <span class="style-spinner"></span>
          <span>{{ imageProvider === 'novelai' ? 'NovelAI 正在生成图片，请耐心等待...' : 'ComfyUI 正在生成图片，请耐心等待...' }}</span>
        </div>

        <div v-if="styleImages.length > 0" class="style-result">
          <div v-if="styleElapsed != null" class="style-elapsed">
            ⏱ 生成耗时 {{ formatElapsed(styleElapsed) }}
            <span v-if="styleTiming" class="style-timing-breakdown">
              · {{ imageProvider === 'novelai' ? 'NovelAI' : 'ComfyUI' }} {{ formatElapsed(styleTiming.comfyui_ms) }}
              · 下载 {{ formatElapsed(styleTiming.download_ms) }}
              <span v-if="styleTiming.ws_setup_ms != null" title="WebSocket 建连 + ComfyUI 预热">
                · 连接预热 {{ formatElapsed(styleTiming.ws_setup_ms) }}
              </span>
            </span>
          </div>
          <img
            v-for="(img, i) in styleImages"
            :key="i"
            :src="img.base64"
            class="style-preview-img"
            @click="openLightbox(i)"
            alt="测试画风结果"
          />
        </div>

        <div class="style-test-row">
          <linshe-button
            class="style-test-btn"
            variant="primary"
            :disabled="styleTesting"
            @click="runStyleTest"
          >
            {{ styleTesting ? '生成中...' : '🎨 生成画面' }}
          </linshe-button>
          <linshe-tabs
            v-model="testMode"
            :options="testModes"
            :disabled="styleTesting"
            size="sm"
            class="test-mode-segmented"
          />
          <linshe-button
            v-if="imageProvider !== 'novelai'"
            class="style-test-btn hires-test-btn"
            variant="primary"
            :disabled="hireTesting"
            @click="runHiresTest"
          >
            {{ hireTesting ? '细化中...' : '测试HiresFix细化' }}
          </linshe-button>
          <linshe-button class="test-prompt-btn" variant="link" @click="openPromptEditor">默认测试提示词</linshe-button>
        </div>

        <div v-if="imageProvider !== 'novelai' && hiresError" class="style-error">{{ hiresError }}</div>

        <div v-if="imageProvider !== 'novelai' && hireTesting" class="style-loading">
          <span class="style-spinner"></span>
          <span>正在按 HiresFix 参数细化最近一张图...</span>
        </div>

        <div v-if="imageProvider !== 'novelai' && hiresCompare" class="style-result">
          <div class="style-elapsed">细化耗时 {{ formatElapsed(hiresCompare.elapsed) }}</div>
          <BeforeAfterSlider :before="hiresCompare.original" :after="hiresCompare.refined" />
        </div>

        <!-- 全屏预览（纯预览，无删除/重生成/放大操作栏） -->
        <Teleport to="body">
          <ImageLightbox
            :visible="lightboxVisible"
            :imgs="lightboxImgs"
            :index="lightboxIndex"
            :show-delete="false"
            :show-regenerate="false"
            :show-upscale="false"
            @hide="lightboxVisible = false"
          />
        </Teleport>
      </div>

<linshe-modal v-model="showPromptEditor" title="编辑测试提示词" wide>
        <div class="prompt-editor-field">
          <label class="fl">对话配图提示词</label>
          <linshe-input v-model="testPrompts.chat" class="fi prompt-textarea" type="textarea" rows="5" />
        </div>
        <div class="prompt-editor-field">
          <label class="fl">朋友圈配图提示词</label>
          <linshe-input v-model="testPrompts.moments" class="fi prompt-textarea" type="textarea" rows="5" />
        </div>
        <div class="prompt-editor-field">
          <label class="fl">奇遇配图提示词</label>
          <linshe-input v-model="testPrompts.event" class="fi prompt-textarea" type="textarea" rows="5" />
        </div>
        <template #footer>
          <linshe-button variant="secondary" @click="resetTestPrompts">恢复默认</linshe-button>
          <linshe-button variant="primary" @click="saveTestPrompts">保存</linshe-button>
        </template>
      </linshe-modal>
</template>

<script setup>
import ImageLightbox from '../ImageLightbox.vue'
import LinsheModal from '../ui/LinsheModal.vue'
import BeforeAfterSlider from '../BeforeAfterSlider.vue'
import LinsheTabs from '../ui/LinsheTabs.vue'
import LinsheAutoTextarea from '../ui/LinsheAutoTextarea.vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import { useSettingsPageContext } from '../../composables/settings/settingsContext.js'
const { freeSceneDesc, onSceneDescFocus, onSceneDescBlur, submitOnEnter, runFreeSceneTest, styleTesting, generatedPrompt, promptEditing, startPromptEdit, runGeneratedPromptTest, styleError, imageProvider, styleImages, styleElapsed, formatElapsed, styleTiming, openLightbox, runStyleTest, testMode, testModes, hireTesting, runHiresTest, openPromptEditor, hiresError, hiresCompare, lightboxVisible, lightboxImgs, lightboxIndex, showPromptEditor, resetTestPrompts, saveTestPrompts, testPrompts, sceneDescRef, promptEditRef } = useSettingsPageContext()
</script>

<style scoped>
.image-lab-card { align-self: start; }
.card {
  padding: 24px;
  display: flex;
  flex-direction: column;
}
.card h3 { font-size: 15px; color: var(--text-bright); margin-bottom: 12px; font-weight: 600; }
.fl { font-size: 13px; font-weight: 600; color: var(--text-bright); display: block; margin-bottom: 2px; }
.fd { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.fi { margin-bottom: 14px; }
.prompt-editor-field { margin-bottom: 16px; }
.prompt-textarea { min-height: 100px; margin-bottom: 0; }
.comfy-params-card .fd { margin-bottom: 14px; line-height: 1.55; }
.fr .fl {
  display: block; margin-bottom: 6px;
  font-size: 14px; font-weight: 600; color: var(--text-bright);
}
.image-connection-fields .fd { margin-bottom: 8px; line-height: 1.5; }
.apikey-row .fi { flex: 1; min-width: 0; }
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
.style-test-row { display: flex; align-items: center; gap: 10px; margin-top: auto; padding-top: 12px; flex-wrap: wrap; }
.free-scene-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
.free-scene-input-wrap { position: relative; flex: 1; min-width: 0; }
.free-scene-btn { margin: 0; flex-shrink: 0; }
.generated-prompt-box {
  padding: 10px 14px; margin-bottom: 12px; border-radius: 12px;
  background: var(--glass-bg-strong); border: 1px solid var(--glass-border);
  color: var(--text-secondary); font-size: 13px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.generated-prompt-box.editable { cursor: text; transition: border-color 0.15s; }
.generated-prompt-box.editable:hover { border-color: var(--accent); }
.generated-prompt-editor {
  resize: none; overflow: hidden; outline: none; font-family: inherit;
  color: var(--text-bright); margin-bottom: 12px;
}
.generated-prompt-editor:focus { border-color: var(--accent); }
.style-test-btn { margin: 0; }
.test-prompt-btn {
  margin-left: auto; padding: 0; font-size: 12px;
}
.style-error { padding: 8px 12px; border-radius: 8px; background: rgba(255, 77, 79, 0.06); color: var(--danger); font-size: 13px; margin-bottom: 12px; white-space: pre-wrap; line-height: 1.5; }
.style-loading { display: flex; align-items: center; gap: 10px; padding: 12px 0; color: var(--text-secondary); font-size: 13px; }
.style-spinner { width: 18px; height: 18px; border: 2px solid var(--glass-border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
.style-result { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; align-items: flex-start; flex-direction: column; }
.style-elapsed { font-size: 13px; color: var(--text-secondary); padding: 4px 10px; border-radius: 6px; background: var(--glass-bg-strong); border: 1px solid var(--glass-border); }
.style-timing-breakdown { font-size: 12px; color: var(--text-muted, #999); }
.style-timing-breakdown::before { content: ' '; }
.style-preview-img { max-width: 480px; max-height: 480px; border-radius: 12px; border: 1px solid var(--glass-border); cursor: pointer; object-fit: contain; background: var(--glass-bg-strong); transition: transform 0.2s ease; }
.style-preview-img:hover { transform: scale(1.03); }
@media (max-width: 767px) {
  .style-preview-img { max-width: 100%; }
  .free-scene-row { flex-direction: column; align-items: stretch; }
  .free-scene-input-wrap { width: 100%; }
  .free-scene-btn { width: 100%; }
  .style-test-row .style-test-btn { width: 100%; }
  .style-test-row .test-mode-segmented { flex: 1 1 0; }
  .test-prompt-btn { margin-left: 0; }
}
</style>
