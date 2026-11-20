<template>
<div class="card touch-action-card">
        <h3>动作系统（触摸互动）</h3>
        <p class="fd">聊天页输入框上方会出现一条动作胶囊条（摸头 / 抱抱 / 亲脸颊…）。点下去她会当场有反应，连续点同一个动作会逐渐不耐烦。即时反应是"立刻单独回一条"，关掉后改成并进下一轮回复。</p>

        <div class="toggle-row">
          <div>
            <div class="tl">动作系统</div>
            <div class="td">关闭后聊天页不再显示动作条，后端也会拒绝动作请求（已记录的动作反应不受影响）</div>
          </div>
          <linshe-switch
            v-model="features.touch"
            aria-label="动作系统"
            title="动作系统"
            @change="saveTouchFeature('touch', features.touch)"
          />
        </div>

        <div class="toggle-row">
          <div>
            <div class="tl">即时反应</div>
            <div class="td">点动作后立刻单独发一条反应（含表情与心情变化）；每日 100 次，额度用完自动并回下一轮</div>
          </div>
          <linshe-switch
            v-model="features.touchInstant"
            aria-label="即时反应"
            title="即时反应"
            @change="saveTouchFeature('touchInstant', features.touchInstant)"
          />
        </div>

        <div class="toggle-row">
          <div>
            <div class="tl">群聊里的敏感动作</div>
            <div class="td">允许在群聊里对角色做 Lv3 敏感动作（摸胸 / 摸臀等）。默认关闭：这种事留到只有你们俩的时候；打开后群成员可能围观</div>
          </div>
          <linshe-switch
            v-model="features.touchGroupAdult"
            aria-label="群聊里的敏感动作"
            title="群聊里的敏感动作"
            @change="saveTouchFeature('touchGroupAdult', features.touchGroupAdult)"
          />
        </div>

        <!-- 动作出图档位（阶段三）：三档用 LinsheTabs，键与后端 features.touchImageMode 同口径 -->
        <div class="toggle-row touch-image-mode-row">
          <div>
            <div class="tl">动作出图</div>
            <div class="td">她做完动作后要不要顺手配一张图。「智能」只在合适的时候配（默认）；「总是」每次都配；「从不」只要文字。</div>
          </div>
          <linshe-tabs
            :model-value="normalizeTouchImageMode(features.touchImageMode)"
            :options="TOUCH_IMAGE_MODES"
            size="sm"
            class="touch-image-mode-tabs"
            @update:model-value="saveTouchImageMode"
          />
        </div>

        <!-- 即时反应风格（task-30）：后端 features.touchReactionMode 一直是完整的，前端此前零引用 -->
        <div class="toggle-row touch-image-mode-row">
          <div>
            <div class="tl">动作反应风格</div>
            <div class="td">她回应你动作时的写法。「对话式」把人格、心情、关系、日程和最近几句对话都喂给她，回得更像真人、还能顺着话题接话（默认）；「快速」只给最近两句、回得短，更快但更像应付。</div>
          </div>
          <linshe-tabs
            :model-value="normalizeTouchReactionMode(features.touchReactionMode)"
            :options="TOUCH_REACTION_MODES"
            size="sm"
            class="touch-image-mode-tabs"
            @update:model-value="saveTouchReactionMode"
          />
        </div>

        <!-- 群聊围观插话概率（task-22）：开关 + 概率滑块；关掉＝这轮其他成员都不发言 -->
        <div class="toggle-row">
          <div>
            <div class="tl">群聊里的围观插话</div>
            <div class="td">在群里对某人做动作时，其他成员凑过来插一句的概率。关掉＝这一轮谁都不插话（与加功能前完全一致）</div>
          </div>
          <linshe-switch
            v-model="bystanderEnabled"
            aria-label="群聊里的围观插话"
            title="群聊里的围观插话"
            @change="saveBystanderEnabled"
          />
        </div>

        <div v-if="bystanderEnabled" class="bystander-row">
          <div class="bystander-slider">
            <linshe-slider
              id="touch-bystander-chance"
              v-model="bystanderPercent"
              :min="0"
              :max="100"
              :step="5"
              aria-label="围观插话概率"
              @change="saveBystanderChance"
            />
          </div>
          <span class="bystander-value">{{ bystanderPercent }}%</span>
        </div>

        <!-- 群聊记忆轮次（2026-10-31 用户要求可开到 30 轮）：
             一轮＝全体成员各说一遍；轮次越大记得越久，但每次请求的 prompt 也越大。 -->
        <div class="toggle-row">
          <div>
            <div class="tl">群聊记忆轮次</div>
            <div class="td">一轮＝全体成员各说一遍。调大后记得更久；30 轮时每次请求约 3~5 万 tokens，更慢也更贵</div>
          </div>
          <span class="bystander-value">{{ groupMemRounds }} 轮</span>
        </div>
        <div class="bystander-row">
          <div class="bystander-slider">
            <linshe-slider
              id="group-mem-rounds"
              v-model="groupMemRounds"
              :min="2"
              :max="30"
              :step="1"
              aria-label="群聊记忆轮次"
              @change="saveGroupMemRounds"
            />
          </div>
          <span class="bystander-value">{{ groupMemRounds }} 轮</span>
        </div>
      </div>
</template>

<script setup>
import { normalizeTouchImageMode, TOUCH_IMAGE_MODES, normalizeTouchReactionMode, TOUCH_REACTION_MODES } from '../touchActionLogic.js'
import LinsheTabs from '../ui/LinsheTabs.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import LinsheSlider from '../ui/LinsheSlider.vue'
import { useSettingsPageContext } from '../../composables/settings/settingsContext.js'
const { features, saveTouchFeature, saveTouchImageMode, saveTouchReactionMode, bystanderEnabled, saveBystanderEnabled, bystanderPercent, saveBystanderChance, groupMemRounds, saveGroupMemRounds } = useSettingsPageContext()
</script>

<style scoped>
.card {
  padding: 24px;
  display: flex;
  flex-direction: column;
}
.card h3 { font-size: 15px; color: var(--text-bright); margin-bottom: 12px; font-weight: 600; }
.fd { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.comfy-params-card .fd { margin-bottom: 14px; line-height: 1.55; }

.toggle-row { display: flex; gap: 14px; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--glass-border); }
.toggle-row:last-child { border-bottom: none; }
.touch-image-mode-row { flex-wrap: wrap; }
.touch-image-mode-tabs { flex-shrink: 0; }
.bystander-row { display: flex; align-items: center; gap: 12px; padding: 0 0 14px; }
.bystander-slider { flex: 1; min-width: 0; }
.bystander-value { width: 44px; flex-shrink: 0; text-align: right; font-size: 12px; color: var(--text-secondary); }
.tl { font-size: 14px; font-weight: 500; color: var(--text-bright); }
.td { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.image-connection-fields .fd { margin-bottom: 8px; line-height: 1.5; }
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
@keyframes spin { to { transform: rotate(360deg); } }
</style>
