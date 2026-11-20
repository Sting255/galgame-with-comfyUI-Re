<template>
<div class="card comfy-params-card">
        <h3>画师串 & 分辨率</h3>
        <p class="fd">直接描述画面风格 或者 选择0~2个画风，英文逗号分隔，参考来源：<a href="https://anima.mooshieblob.com/" target="_blank" rel="noopener" class="ext-link">https://anima.mooshieblob.com/</a> · 分辨率越高出图越精细，代价是变慢。参考：5070ti 768×512 base约 7s/图|turbo 约2.5s/图</p>

        <linshe-tabs
          :model-value="comfyTab"
          :options="comfyTabs"
          class="comfy-tabs"
          @update:model-value="switchComfyTab"
        />

        <div class="comfy-form-stage">
          <Transition :name="'tab-slide-' + tabSlideDir" mode="out-in">
            <div :key="comfyTab" class="comfy-form-inner">
              <div class="fav-input-row">
                <linshe-input
                  v-model="form[activeFields.artist]"
                  class="fi fav-input"
                  placeholder="画师串"
                  @input="markDirty"
                />                <div
                  role="button"
                  tabindex="0"
                  class="fav-star-btn"
                  :class="{ 'is-disabled': !form[activeFields.artist].trim() }"
                  :aria-disabled="!form[activeFields.artist].trim()"
                  title="收藏当前画师串"
                  @click="addToFavorites(comfyTab)"
                  @keydown.enter.prevent="addToFavorites(comfyTab)"
                  @keydown.space.prevent="addToFavorites(comfyTab)"
                >
☆
</div>
              </div>
              <template v-if="artistFavorites.length">
                <div class="fav-section-title">收藏的画师 / 风格</div>
                <div class="fav-chips">
                <linshe-button v-for="fav in artistFavorites" :key="fav.id" class="fav-chip" variant="chip" :active="fav.artist === form[activeFields.artist]" @click="applyFavorite(fav, comfyTab)" :title="fav.artist">
                  {{ fav.label }}
                  <span class="fav-chip-x" @click.stop="removeFavorite(fav.id)">×</span>
                </linshe-button>
                </div>
              </template>
              <div class="fr">
                <div class="fh"><label class="fl">宽度</label><linshe-input v-model.number="form[activeFields.width]" type="number" min="256" max="4096" @input="markDirty" /></div>
                <div class="fh"><label class="fl">高度</label><linshe-input v-model.number="form[activeFields.height]" type="number" min="256" max="4096" @input="markDirty" /></div>
              </div>
              <div class="fpresets-head">
                <span class="resolution-title">分辨率</span>
                <span class="resolution-hint">不建议超过 1536×1536 个像素，人体崩坏概率会上升</span>
              </div>
              <div class="fpresets">
                <span class="pl">预设：</span>
                <linshe-button v-for="p in presets" :key="p.label" class="pbtn" variant="chip" :active="isPresetActive(p)" @click="applyPreset(p, comfyTab)">{{ p.label }}</linshe-button>
              </div>
            </div>
          </Transition>
        </div>

        <!-- 体位骨架（2026-11-15）：参考图那条路已按用户要求整块移除 —— 上传的参考图
             既不绑定又碍眼，留着只会让人以为它在起作用。现在只剩一种姿势控制：
             亲密场景按推进面板的当前体位现算骨架。 -->
        <div v-if="imageProvider !== 'novelai'" class="pose-ref-section">
          <div class="pose-ref-header">
            <span class="pose-ref-title">体位骨架</span>
          </div>
          <div class="pose-ref-row pose-ref-row--body">
            <div class="pose-ref-copy">
              <div class="pose-ref-desc">亲密场景出图时，按推进面板当前的体位摆姿势（骑乘就跨坐、后入就趴跪）。</div>
              <div class="pose-ref-hint">按体位现算骨架，不需要参考图。普通聊天、立绘、朋友圈配图不受影响。</div>
            </div>
            <linshe-switch
              v-model="poseFromPosition"
              size="sm"
              on-text="已启用"
              off-text="已关闭"
              aria-label="体位骨架"
              :disabled="poseSaving"
              @change="onPoseFromPositionToggle"
            />
          </div>
          <!-- 竖构图（2026-11-04）：体位骨架是铺满整张画布的，横图会被画成近景特写、竖图才有完整双人构图 -->
          <div class="pose-ref-row pose-ref-row--body">
            <div class="pose-ref-copy">
              <div class="pose-ref-desc">体位场景用竖构图出图</div>
              <div class="pose-ref-hint">骨架铺满整块画布：横图容易被画成贴脸特写，竖图（768×1024）才是完整双人构图。只影响带体位骨架的那张图，其它场景尺寸不变。</div>
            </div>
            <linshe-switch
              v-model="poseFromPositionPortrait"
              size="sm"
              on-text="竖构图"
              off-text="跟随设置"
              aria-label="体位场景用竖构图"
              :disabled="poseSaving"
              @change="onPosePortraitToggle"
            />
          </div>
        </div>

        <div v-if="imageProvider !== 'novelai'" class="hiresfix-section">
          <div class="hiresfix-header">
            <span class="hiresfix-title">HiresFix 细化</span>
          </div>
          <div class="hiresfix-row">
            <div class="hiresfix-copy">
              <div class="hiresfix-desc">图片进一步高清细化设置</div>
            </div>
            <span class="hiresfix-summary">{{ hiresSummary }}</span>
            <linshe-button class="hiresfix-link" variant="link" @click="openHiresFixSettings">设置 →</linshe-button>
          </div>
          <div class="hiresfix-row hiresfix-turbo-row">
            <div class="hiresfix-copy">
              <div class="hiresfix-turbo-title">细化用 turbo 参数（更快）</div>
              <div class="hiresfix-desc">打开：CFG {{ HIRES_TURBO_CFG.toFixed(1) }} / {{ HIRES_TURBO_STEPS }} 步，速度约快一倍、更贴合 turbo 模型；关闭：沿用「设置 →」里的步数与 CFG</div>
              <div class="hiresfix-desc">{{ hiresTurbo ? '当前「设置 →」里的步数与 CFG 不生效（仍可照常修改，关掉本开关后即按它们细化）' : '当前按「设置 →」里的步数与 CFG 细化' }}</div>
            </div>
            <linshe-switch
              v-model="hiresTurbo"
              on-text="已启用"
              off-text="已关闭"
              aria-label="细化用 turbo 参数"
              title="细化用 turbo 参数（CFG 1.0 / 12 步）"
              @change="onHiresTurboToggle"
            />
          </div>
          <div class="hiresfix-row">
            <div class="hiresfix-copy">
              <div class="hiresfix-turbo-title">细化精度</div>
              <div class="hiresfix-desc">她出图后那道细化重绘的步数。越低越快、细节略软；越高越保真、更慢。（高 12 步 / 中 10 步 / 低 8 步，默认低）</div>
            </div>
            <linshe-tabs
              :model-value="normalizeHiresQuality(features.hiresQuality)"
              :options="HIRES_QUALITY_MODES"
              size="sm"
              class="hiresfix-quality-tabs"
              @update:model-value="saveHiresQuality"
            />
          </div>
        </div>
        <div class="quality-section">
          <div class="quality-row">
            <div class="quality-copy">
              <div class="quality-subtitle">质量提示词</div>
              <div class="quality-desc">生图时注入的画质增强词，留空使用系统默认</div>
            </div>
            <span class="quality-summary" :class="{ 'is-default': !qualityPrompt }" :title="qualityPrompt || '使用工作流内置的质量提示词'">{{ qualityPrompt ? qualityPrompt : '系统默认' }}</span>
            <linshe-button class="quality-link" variant="link" @click="openQualityDialog">更改 →</linshe-button>
          </div>
          <div class="quality-row">
            <div class="quality-copy">
              <div class="quality-subtitle">负面提示词</div>
              <div class="quality-desc">生图时排除的负面词条，留空使用工作流内置默认</div>
            </div>
            <span class="quality-summary" :class="{ 'is-default': !negativePrompt }" :title="negativePrompt || '使用工作流内置的负面提示词'">{{ negativePrompt ? negativePrompt : '工作流默认' }}</span>
            <linshe-button class="quality-link" variant="link" @click="openNegativeDialog">更改 →</linshe-button>
          </div>
        </div>
        <div class="sa">
          <linshe-button variant="primary" :disabled="!dirty || comfySaving" :loading="comfySaving" @click="saveComfy">保存</linshe-button>
          <span v-if="saved" class="smsg">已保存</span>
          <div class="sa-spacer"></div>
          <linshe-button class="wf-action-btn wf-lora-btn" variant="secondary" @click="openGlobalLora">
            全局LoRA
            <span v-if="globalLoraCount > 0" class="float-badge active">已生效 {{ globalLoraCount }}</span>
          </linshe-button>
          <linshe-button class="wf-action-btn wf-mode-btn" variant="secondary" :disabled="wfResetting" @click="doWorkflowReset2">{{ wfResetting ? '重置中...' : '重置工作流' }}</linshe-button>
          <linshe-button class="wf-action-btn wf-mode-btn" variant="secondary" @click="openWfModeDialog">切换工作流模式</linshe-button>
        </div>
      </div>

<GlobalLoraModal v-model="globalLoraModalVisible" :initial-loras="globalLoras" @saved="onGlobalLoraSaved" />

<HiresFixModal v-if="imageProvider !== 'novelai'" v-model="hiresFixModalVisible" :initial-sampling-mode="hiresSamplingMode" :initial-global-lora-scale="hiresGlobalLoraScale" :initial-source-blend="hiresSourceBlend" :initial-upscale-model="hiresUpscaleModel" :initial-workflow-mode="hiresWorkflowMode" :initial-loras="hiresLoras" :initial-steps="hiresSteps" :initial-cfg="hiresCfg" :initial-denoise="hiresDenoise" :initial-max-size="hiresMaxSize" :initial-artist-mode="hiresArtistMode" :initial-artist="hiresArtist" :initial-turbo="hiresTurbo" @saved="onHiresFixSaved" />

<linshe-modal v-model="favDialog.show" title="收藏画师串">
      <p class="form-dialog-desc">为当前画师串起个名字，方便以后快速识别：</p>
      <linshe-input
        ref="favDialogInput"
        v-model="favDialog.label"
        placeholder="输入收藏名称"
        maxlength="30"
        @keyup.enter="confirmAddFavorite"
      />
      <template #footer>
        <linshe-button variant="secondary" @click="cancelAddFavorite">取消</linshe-button>
        <linshe-button variant="primary" :disabled="!favDialog.label.trim()" @click="confirmAddFavorite">确认收藏</linshe-button>
      </template>
    </linshe-modal>

<linshe-modal v-model="qualityDialog.show" title="质量提示词" wide :transition-ms="300">
      <p class="form-dialog-desc">填写英文质量提示词覆盖工作流默认值，留空则使用系统默认</p>
      <linshe-input
        v-model="qualityDialog.text"
        type="textarea"
        rows="8"
        placeholder="masterpiece, best quality, score_9, score_8，highres, absurdres, year 2025"
      />
      <template #footer>
        <linshe-button variant="secondary" @click="qualityDialog.show = false">取消</linshe-button>
        <linshe-button variant="primary" :disabled="qualitySaving" @click="saveQualityPrompt">{{ qualitySaving ? '保存中…' : '保存' }}</linshe-button>
      </template>
    </linshe-modal>

<linshe-modal v-model="negativeDialog.show" title="负面提示词" wide :transition-ms="300">
      <p class="form-dialog-desc">填写英文负面提示词覆盖工作流默认值，留空则使用工作流内置默认</p>
      <linshe-input
        v-model="negativeDialog.text"
        type="textarea"
        rows="8"
        placeholder="score_1, score_2, score_3, bad anatomy, bad proportions, deformed anatomy, deformed face, deformed eyes, multiple fingers, text, watermark, artist name, censor, mosaic, signature, logo, twitter username, patreon username, username, shadows, highlights, strong lighting, dramatic lighting, rim light, backlighting, high contrast, volumetric lighting"
      />
      <template #footer>
        <linshe-button variant="secondary" @click="negativeDialog.show = false">取消</linshe-button>
        <linshe-button variant="primary" :disabled="negativeSaving" @click="saveNegativePrompt">{{ negativeSaving ? '保存中…' : '保存' }}</linshe-button>
      </template>
    </linshe-modal>

<linshe-modal v-model="showWfModeDialog" title="工作流模式" wide>
      <div class="wf-mode-options">
        <div
v-for="m in workflowModeOptions" :key="m.value"
          role="button"
          tabindex="0"
          :class="['wf-mode-option', { active: wfModeDraft === m.value }]"
          @click="wfModeDraft = m.value"
          @keydown.enter.prevent="wfModeDraft = m.value"
          @keydown.space.prevent="wfModeDraft = m.value"
>
          <span class="wf-mo-title">{{ m.label }}</span>
          <span class="wf-mo-desc" v-html="m.desc"></span>
        </div>
      </div>
      <Transition name="expand">
        <div v-if="wfModeDraft === 'custom'" class="wf-mode-custom">
          <p class="wf-mode-hint">从 workflow 目录中选择工作流，所有生图场景统一使用</p>
          <linshe-select
v-model="wfCustomDraft" :options="customWorkflowOptions"
            :disabled="customWorkflowLoading" placeholder="请选择自定义工作流"
/>
          <p v-if="!customWorkflowLoading && customWorkflowOptions.length === 0" class="wf-mode-custom-empty">
            未找到可选工作流，请把 .json 文件放入 workflow 目录
          </p>
          <div class="wf-inject-note">
            <div class="wf-inject-title">生图时会自动往这些节点注入内容</div>
            <ul class="wf-inject-list">
              <li v-for="row in workflowInjectRows" :key="row.node" class="wf-inject-row">
                <span class="wf-inject-node">{{ row.node }}</span>
                <span class="wf-inject-type">{{ row.type }}</span>
                <span class="wf-inject-desc">{{ row.desc }}</span>
              </li>
            </ul>
            <p class="wf-inject-tip">按节点标题匹配：工作流里节点标题与上表一致才会写入，其余节点保持原样。全局 LoRA 与角色 LoRA 不受标题限制，会自动串入 LoraLoaderModelOnly 节点链；KSampler 的 seed 为 randomize 时会自动随机。</p>
          </div>
        </div>
      </Transition>
      <div v-if="wfModeDraft !== 'custom'" class="wf-mode-downloads">
        <p class="wf-mode-dl-hint">整合包内一般只有一个模型（检查路径ComfyUI-aki-v3\ComfyUI\models\diffusion_models），如需额外下载：</p>
        <div class="wf-dl-item">
          <span class="wf-dl-label">Anima-turbo：</span>
          <a href="https://civitai.com/api/download/models/3108589?fileId=2988553" target="_blank" rel="noopener">Civitai 下载</a>
          <span class="wf-dl-sep">|</span>
          <a href="https://pan.quark.cn/s/8ee40c22ccc6?pwd=SWwE" target="_blank" rel="noopener">网盘下载</a>
        </div>
        <div class="wf-dl-item">
          <span class="wf-dl-label">Anima-base：</span>
          <a href="https://civitai.com/api/download/models/2945208?fileId=2824391" target="_blank" rel="noopener">Civitai 下载</a>
          <span class="wf-dl-sep">|</span>
          <a href="https://pan.quark.cn/s/8ee40c22ccc6?pwd=SWwE" target="_blank" rel="noopener">网盘下载</a>
        </div>
      </div>
      <Transition name="expand">
        <div v-if="wfModeDraft === 'hybrid'" class="wf-mode-scenes">
          <p class="wf-mode-hint">hybrid 模式下可为不同场景分配不同工作流，默认生图用 turbo</p>
          <div v-for="s in sceneOptions" :key="s.key" class="wf-scene-row-h">
            <span class="wf-scene-name">{{ s.label }}</span>
            <div class="wf-scene-toggle">
              <linshe-button
class="wf-toggle-btn" variant="chip" size="sm"
                :active="wfSceneDraft[s.key] === 'turbo'"
                @click="wfSceneDraft[s.key] = 'turbo'"
>
turbo
</linshe-button>
              <linshe-button
class="wf-toggle-btn" variant="chip" size="sm"
                :active="wfSceneDraft[s.key] === 'base'"
                @click="wfSceneDraft[s.key] = 'base'"
>
base
</linshe-button>
            </div>
          </div>
        </div>
      </Transition>
      <template #footer>
        <linshe-button variant="secondary" @click="showWfModeDialog = false">取消</linshe-button>
        <linshe-button variant="primary" :disabled="wfSaving" @click="saveWfModeDialog">{{ wfSaving ? '保存中...' : '保存' }}</linshe-button>
      </template>
    </linshe-modal>
</template>

<script setup>
import LinsheModal from '../ui/LinsheModal.vue'
import LinsheSelect from '../ui/LinsheSelect.vue'
import LinsheTabs from '../ui/LinsheTabs.vue'
import GlobalLoraModal from '../GlobalLoraModal.vue'
import HiresFixModal from '../HiresFixModal.vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import { useSettingsPageContext } from '../../composables/settings/settingsContext.js'
const { comfyTab, comfyTabs, switchComfyTab, tabSlideDir, form, activeFields, markDirty, addToFavorites, artistFavorites, applyFavorite, removeFavorite, presets, isPresetActive, applyPreset, imageProvider, poseFromPosition, poseSaving, onPoseFromPositionToggle, poseFromPositionPortrait, onPosePortraitToggle, hiresSummary, openHiresFixSettings, HIRES_TURBO_CFG, HIRES_TURBO_STEPS, hiresTurbo, onHiresTurboToggle, normalizeHiresQuality, features, HIRES_QUALITY_MODES, saveHiresQuality, qualityPrompt, openQualityDialog, negativePrompt, openNegativeDialog, dirty, comfySaving, saveComfy, saved, openGlobalLora, globalLoraCount, wfResetting, doWorkflowReset2, openWfModeDialog, globalLoraModalVisible, globalLoras, onGlobalLoraSaved, hiresFixModalVisible, hiresSamplingMode, hiresGlobalLoraScale, hiresSourceBlend, hiresUpscaleModel, hiresWorkflowMode, hiresLoras, hiresSteps, hiresCfg, hiresDenoise, hiresMaxSize, hiresArtistMode, hiresArtist, onHiresFixSaved, favDialog, cancelAddFavorite, confirmAddFavorite, qualityDialog, qualitySaving, saveQualityPrompt, negativeDialog, negativeSaving, saveNegativePrompt, showWfModeDialog, wfSaving, saveWfModeDialog, workflowModeOptions, wfModeDraft, wfCustomDraft, customWorkflowOptions, customWorkflowLoading, workflowInjectRows, sceneOptions, wfSceneDraft, favDialogInput } = useSettingsPageContext()
</script>

<style scoped>
.comfy-params-card .sa { gap: 10px; }
.wf-action-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 14px; font-size: 12px; font-weight: 500;
  white-space: nowrap;
}
.float-badge {
  font-size: 10px; padding: 2px 8px; border-radius: 10px;
  background: rgba(var(--accent-rgb), 0.10); color: var(--accent); margin-left: 4px;
  white-space: nowrap;
}
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
.comfy-params-card { padding: 22px; }
.comfy-params-card h3 { margin-bottom: 18px; }
.comfy-params-card .fd { margin-bottom: 14px; line-height: 1.55; }
.comfy-params-card .fr { margin-bottom: 18px; }
.comfy-params-card .fpresets { margin: 0 0 24px; }

.comfy-form-stage {
  overflow: hidden;
  position: relative;
}
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
.pose-ref-row--body {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}
.pose-ref-section {
  margin: 8px 0 0; padding: 14px 0;
  border-top: 1px solid var(--border);
}
.pose-ref-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.pose-ref-title { font-size: var(--fs-md); font-weight: 600; color: var(--text-primary); }
.pose-ref-row { display: flex; align-items: flex-start; gap: 12px; }
.pose-ref-copy { flex: 1; min-width: 0; }
.pose-ref-desc { font-size: var(--fs-sm); color: var(--text-secondary); margin: 0 0 4px; }
.pose-ref-hint { font-size: var(--fs-xs); color: var(--text-secondary); opacity: .8; }

.hiresfix-section {
  margin: 8px 0 0; padding: 16px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.hiresfix-header {
  display: flex; align-items: baseline;
  justify-content: space-between; margin-bottom: 10px;
}
.hiresfix-title {
  font-size: 14px; font-weight: 600; color: var(--text-bright);
}
.hiresfix-row {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.hiresfix-copy { flex: 1; min-width: 200px; }
.hiresfix-desc {
  font-size: 12px; color: var(--text-secondary); margin-top: 2px;
}
.hiresfix-quality-tabs { flex-shrink: 0; }
.hiresfix-turbo-row {
  margin-top: 14px; padding-top: 14px;
  border-top: 1px dashed var(--border);
  align-items: flex-start;
}
.hiresfix-turbo-title { font-size: 13px; font-weight: 600; color: var(--text-bright); }
.hiresfix-summary { font-size: 12px; color: var(--text-secondary); }
.hiresfix-link, .quality-link {
  font-size: 13px;
}
.quality-section {
  margin: 0 0 20px; padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.quality-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.quality-row + .quality-row { margin-top: 14px; }
.quality-copy { flex: 1; min-width: 180px; }
.quality-subtitle { font-size: 13px; font-weight: 700; color: var(--text-bright); }
.quality-desc { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.quality-summary {
  font-size: 12px; color: var(--text-secondary);
  max-width: 200px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.quality-summary.is-default { color: var(--text-secondary); }
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
.fav-input-row {
  display: flex; align-items: center; gap: 2px;
  padding: 0 4px 0 12px; margin-bottom: 8px;
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 12px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.fav-input-row:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.10);
}
.fav-input {
  flex: 1; min-width: 0; height: 38px; padding: 0; margin: 0;
  font-size: 13px; background: transparent; border: none; box-shadow: none;
}
.fav-input:focus { box-shadow: none; }
.fav-star-btn {
  width: 34px; height: 34px; flex-shrink: 0; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--text-secondary);
  font-size: 16px; line-height: 1; cursor: pointer;
  transition: color 0.15s ease;
  user-select: none;
}
.fav-star-btn:hover:not(.is-disabled) { color: #E2A83E; }
.fav-star-btn.is-disabled { opacity: 0.35; cursor: not-allowed; }
.fav-section-title {
  font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;
}
.fav-chips {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px;
}
.fav-chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; font-size: 14px;
}
.fav-chip-x {
  font-size: 12px; line-height: 1; color: var(--text-secondary);
}
.fav-chip-x:hover { color: var(--accent); }

.sa { display: flex; align-items: center; gap: 12px; margin-top: auto; }
.sa-spacer { flex: 1; }
.smsg { color: var(--success); font-size: 13px; }
.form-dialog-desc { font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; }
.image-connection-fields .fd { margin-bottom: 8px; line-height: 1.5; }
.apikey-row .fi { flex: 1; min-width: 0; }
.free-egg-btn:hover:not(.is-disabled) { border-color: #facc15; background: rgba(250, 204, 21, 0.08); color: #facc15; }
.free-egg-btn.active { border-color: #facc15; background: rgba(250, 204, 21, 0.16); color: #facc15; }
.free-egg-btn.is-disabled { opacity: 0.6; cursor: wait; }
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
  .fr { flex-direction: column; gap: 10px; }
  .sa { flex-wrap: wrap; gap: 8px; }
  .sa .sa-spacer { flex-basis: 100%; height: 0; margin: 0; }
  .sa .wf-action-btn { flex: 1 1 0; justify-content: center; padding: 8px 6px; }
  .quality-summary { max-width: 100%; flex-basis: 100%; order: 2; }
  .quality-row .quality-link { order: 3; margin-left: auto; }
}
.wf-mode-options {
  display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px;
}
.wf-mode-option {
  flex: 1 1 140px;
  min-width: 0;
  background: var(--bg-secondary);
  border: 2px solid var(--border);
  border-radius: 12px;
  padding: 14px 12px;
  cursor: pointer;
  user-select: none;
  transition: all 0.2s;
  display: flex; flex-direction: column; gap: 6px;
  text-align: center;
}
.wf-mode-option:hover { border-color: var(--accent); }
.wf-mode-option.active {
  border-color: var(--accent);
  background: rgba(var(--accent-rgb), 0.08);
}
.wf-mo-title {
  font-size: 14px; font-weight: 600; color: var(--text-bright);
}
.wf-mo-desc {
  font-size: 12px; color: var(--text-secondary); line-height: 1.4;
}
.wf-mo-desc:deep(.wf-mo-highlight) {
  color: var(--accent); font-weight: 700;
}
@media (max-width: 640px) {
  .wf-mode-option { flex: 1 1 calc(50% - 6px); }
}
.wf-mode-downloads {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 14px; margin-bottom: 4px;
}
.wf-mode-dl-hint {
  font-size: 12px; color: var(--text-secondary); margin: 0 0 6px;
}
.wf-dl-item {
  font-size: 12px; color: var(--text-secondary); line-height: 1.8;
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
}
.wf-dl-label { font-weight: 500; color: var(--text-bright); min-width: 40px; }
.wf-dl-item a { color: var(--accent); text-decoration: underline; }
.wf-dl-item a:hover { color: var(--accent-hover, var(--accent)); }
.wf-dl-sep { opacity: 0.4; margin: 0 2px; }
.wf-mode-hint {
  font-size: 12px; color: var(--text-secondary);
  margin-bottom: 10px; text-align: center;
}
.wf-mode-custom {
  background: rgba(var(--accent-rgb), 0.04);
  border: 1px solid rgba(var(--accent-rgb), 0.12);
  border-radius: 8px; padding: 12px 16px;
  margin-bottom: 12px;
}
.wf-mode-custom-empty {
  font-size: 12px; color: var(--text-secondary);
  margin: 8px 0 0; text-align: center;
}
.wf-inject-note {
  margin-top: 12px; padding-top: 12px;
  border-top: 1px dashed rgba(var(--accent-rgb), 0.2);
}
.wf-inject-title {
  font-size: 12px; font-weight: 600; color: var(--text-bright);
  margin-bottom: 8px;
}
.wf-inject-list {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 6px;
}
.wf-inject-row {
  display: grid;
  grid-template-columns: 84px 112px 1fr;
  align-items: baseline;
  column-gap: 8px;
  font-size: 12px; line-height: 1.5;
}
.wf-inject-node {
  justify-self: start;
  padding: 1px 8px;
  border-radius: 6px;
  background: rgba(var(--accent-rgb), 0.1);
  border: 1px solid rgba(var(--accent-rgb), 0.22);
  color: var(--accent); font-weight: 600; white-space: nowrap;
}
.wf-inject-type {
  justify-self: start;
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(var(--accent-rgb), 0.06);
  border: 1px solid rgba(var(--accent-rgb), 0.14);
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px; line-height: 16px; white-space: nowrap;
}
.wf-inject-desc {
  min-width: 0;
  color: var(--text-secondary);
}
@media (max-width: 640px) {
  .wf-inject-row { grid-template-columns: auto auto; }
  .wf-inject-desc { grid-column: 1 / -1; }
}
.wf-inject-tip {
  margin: 10px 0 0; font-size: 11px; line-height: 1.5;
  color: var(--text-secondary); opacity: 0.85;
}
.wf-mode-scenes {
  background: rgba(var(--accent-rgb), 0.04);
  border: 1px solid rgba(var(--accent-rgb), 0.12);
  border-radius: 8px; padding: 12px 16px;
}
.wf-scene-row-h {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 0;
}
.wf-scene-row-h + .wf-scene-row-h { border-top: 1px solid var(--border); }
.wf-scene-name {
  font-size: 13px; color: var(--text-primary);
}
.wf-scene-toggle {
  display: flex; gap: 4px;
}
.wf-toggle-btn {
  padding: 3px 14px; font-size: 12px;
}
</style>
