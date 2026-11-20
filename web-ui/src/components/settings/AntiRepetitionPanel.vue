<template>
<div class="card anti-rep-card">
        <h3>反重复与话题推进</h3>
        <p class="fd">角色连续几轮围绕同一话题打转时，动态提示她换角度、引入新信息或推进事件；同一情绪持续多轮时提示她像真人一样打断自己。全部是提示词层的增强，不额外调用模型。</p>

        <div class="toggle-row">
          <div>
            <div class="tl">反车轱辘话</div>
            <div class="td">最近几轮话题重叠超过阈值时，提示她换一种说法或推进话题（另附一条近端自身输出标注）</div>
          </div>
          <linshe-switch
            v-model="features.antiRepetition"
            aria-label="反车轱辘话"
            title="反车轱辘话"
            @change="saveAntiRepFeature('antiRepetition', features.antiRepetition)"
          />
        </div>

        <div class="toggle-row">
          <div>
            <div class="tl">反钻牛角尖</div>
            <div class="td">同一情绪极值连续多轮且话题没换时，提示她自我打断、分心或做个小决定，让对话往前走</div>
          </div>
          <linshe-switch
            v-model="features.antiRepetitionLock"
            aria-label="反钻牛角尖"
            title="反钻牛角尖"
            @change="saveAntiRepFeature('antiRepetitionLock', features.antiRepetitionLock)"
          />
        </div>

        <!-- B1 阶段二：升级档（默认开）。关掉只留温和提示；重写兜底 antiRepetitionReroll 本轮不接线，故无入口。 -->
        <div class="toggle-row">
          <div>
            <div class="tl">重复时自动加强约束</div>
            <div class="td">她连续 3 轮在复述同一件事时，把约束从温和升到更强；一旦不再重复立刻回落。关掉则只保留温和提示</div>
          </div>
          <linshe-switch
            v-model="features.antiRepetitionEscalation"
            aria-label="重复时自动加强约束"
            title="重复时自动加强约束"
            @change="saveAntiRepFeature('antiRepetitionEscalation', features.antiRepetitionEscalation)"
          />
        </div>

        <!-- D2 重写兜底（默认关）：用户点名「做个开关放到设置里说明」，说明里必须写清代价 -->
        <div class="toggle-row">
          <div>
            <div class="tl">重写这一轮</div>
            <div class="td">她还在复读时，把这一轮的话重写一次（会多消耗一次模型调用，默认关闭）—— 重写后原先那段会被整段换掉，不会重复出现</div>
          </div>
          <linshe-switch
            v-model="features.antiRepetitionReroll"
            aria-label="重写这一轮"
            title="重写这一轮"
            @change="saveAntiRepFeature('antiRepetitionReroll', features.antiRepetitionReroll)"
          />
        </div>

        <!-- 玩具系统总开关（用户拍板：一次性解锁，同 touchGroupAdult 先例；默认关） -->
        <div class="toggle-row">
          <div>
            <div class="tl">解锁成人玩具</div>
            <div class="td">打开后，触摸面板里多一块「玩具控制」：可以给她戴上跳蛋 / 振动棒 / 肛塞 / 乳夹 / 项圈，调强度、随时摘下，她会当场有反应（默认关）</div>
          </div>
          <linshe-switch
            v-model="features.toys"
            aria-label="解锁成人玩具"
            title="解锁成人玩具"
            @change="saveFeatureWithToast('toys', features.toys, '成人玩具')"
          />
        </div>

        <!-- 采样层（专题 L3）：默认留空 = 请求体里完全不发送这两个字段，行为与历史完全一致。
             规划 C5 要求先拿真网关探针确认参数被接受再上 UI；未探明前请保持留空。 -->
        <div class="anti-rep-penalty">
          <div class="anti-rep-penalty-copy">
            <div class="tl">重复惩罚参数（高级）</div>
            <div class="td">透传 presence_penalty / frequency_penalty 给模型接口，范围 -2 ~ 2。留空表示不发送；部分第三方中转站不接受该参数，若保存后回复出错请清空重试。</div>
          </div>
          <div class="anti-rep-penalty-inputs">
            <label class="anti-rep-field">
              <span class="anti-rep-field-label">presence</span>
              <linshe-input v-model="antiRepPenaltyPresence" class="fi anti-rep-input" placeholder="留空" :invalid="!antiRepPenaltyPresenceValid" @keyup.enter="onAntiRepPenaltySave" />
            </label>
            <label class="anti-rep-field">
              <span class="anti-rep-field-label">frequency</span>
              <linshe-input v-model="antiRepPenaltyFrequency" class="fi anti-rep-input" placeholder="留空" :invalid="!antiRepPenaltyFrequencyValid" @keyup.enter="onAntiRepPenaltySave" />
            </label>
            <linshe-button variant="secondary" size="sm" :loading="antiRepPenaltySaving" :disabled="!antiRepPenaltyValid" @click="onAntiRepPenaltySave">保存</linshe-button>
            <span v-if="antiRepPenaltySaved" class="smsg">已保存</span>
          </div>
        </div>
        <p v-if="antiRepPenaltyError" class="gen-error" role="alert">{{ antiRepPenaltyError }}</p>
      </div>
</template>

<script setup>
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import { useSettingsPageContext } from '../../composables/settings/settingsContext.js'
const { features, saveAntiRepFeature, saveFeatureWithToast, antiRepPenaltyPresence, antiRepPenaltyPresenceValid, onAntiRepPenaltySave, antiRepPenaltyFrequency, antiRepPenaltyFrequencyValid, antiRepPenaltySaving, antiRepPenaltyValid, antiRepPenaltySaved, antiRepPenaltyError } = useSettingsPageContext()
</script>

<style scoped>
.card {
  padding: 24px;
  display: flex;
  flex-direction: column;
}
.card h3 { font-size: 15px; color: var(--text-bright); margin-bottom: 12px; font-weight: 600; }
.fd { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.fi { margin-bottom: 14px; }
.comfy-params-card .fd { margin-bottom: 14px; line-height: 1.55; }

.gen-error { margin-top: 6px; font-size: 12px; color: var(--danger, #ff4d4f); }
.smsg { color: var(--success); font-size: 13px; }

.toggle-row { display: flex; gap: 14px; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--glass-border); }
.toggle-row:last-child { border-bottom: none; }
.tl { font-size: 14px; font-weight: 500; color: var(--text-bright); }
.td { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.anti-rep-card .anti-rep-penalty {
  display: flex; flex-wrap: wrap; gap: 14px; justify-content: space-between; align-items: flex-start;
  padding: 14px 0 0; margin-top: 2px; border-top: 1px solid var(--glass-border);
}
.anti-rep-card .anti-rep-penalty-copy { flex: 1 1 260px; min-width: 220px; }
.anti-rep-card .anti-rep-penalty-inputs { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.anti-rep-field { display: flex; flex-direction: column; gap: 4px; }
.anti-rep-field-label { font-size: 11px; color: var(--text-secondary); }
.anti-rep-card .anti-rep-input { width: 92px; }
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
@keyframes spin { to { transform: rotate(360deg); } }
</style>
