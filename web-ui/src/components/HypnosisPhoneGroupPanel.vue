<template>
  <!-- 群聊里的催眠手机：先选人，再动手。
       · 选 1 人 → 单独使用模式（直接复用私聊的完整面板：含遗忘与遗忘记录）
       · 选多人 → 批量模式（一次对所有人下同一条指令，逐个反馈成功/失败）
       每人一份独立状态，可反复使用（再点一次催眠＝重新开始一次）。 -->
  <div class="hpg">
    <!-- ── ① 选人 ── -->
    <section class="hpg-sec">
      <header class="hpg-sec-head">
        <h4 class="hpg-sec-title">对谁用</h4>
        <span class="hpg-sec-hint">可选单人也可以选多人</span>
      </header>
      <div class="hpg-members">
        <linshe-button
          v-for="m in members"
          :key="m.id"
          variant="chip"
          size="sm"
          :active="isSelected(m.id)"
          @click="toggle(m.id)"
        >
          {{ memberName(m) }}
          <span class="hpg-member-state">{{ stateText(m.id) }}</span>
        </linshe-button>
      </div>
      <div class="hpg-bulk">
        <linshe-button variant="link" size="sm" @click="selectAll">全选</linshe-button>
        <linshe-button variant="link" size="sm" :disabled="selectedIds.length === 0" @click="clearAll">清空</linshe-button>
        <span class="hpg-note">已选 {{ selectedIds.length }} 人</span>
      </div>
    </section>

    <!-- ── ② 单独使用模式：完整单人面板 ── -->
    <template v-if="selectedIds.length === 1">
      <p class="hpg-tip">单独使用模式：下面是「{{ singleCharacter?.display_name || singleCharacter?.name }}」的完整面板（含遗忘与遗忘记录）。</p>
      <HypnosisPhonePanel :character="singleCharacter" />
    </template>

    <!-- ── ③ 批量模式 ── -->
    <template v-else-if="selectedIds.length > 1">
      <section class="hpg-sec">
        <header class="hpg-sec-head">
          <h4 class="hpg-sec-title">按时长催眠</h4>
          <span class="hpg-sec-hint">对上面选中的 {{ selectedIds.length }} 人同时生效</span>
        </header>
        <div class="hpg-duration">
          <linshe-input
            v-model="minutes"
            type="number"
            size="sm"
            :min="MIN_MINUTES"
            :max="MAX_MINUTES"
            class="hpg-duration-input"
            aria-label="催眠时长（分钟）"
          />
          <span class="hpg-duration-unit">分钟</span>
          <span class="hpg-duration-range">可填 {{ MIN_MINUTES }} ~ {{ MAX_MINUTES }}</span>
        </div>
      </section>

      <section class="hpg-sec">
        <header class="hpg-sec-head">
          <h4 class="hpg-sec-title">批量操作</h4>
          <span class="hpg-sec-hint">重复点没有副作用（催眠＝重开一次）</span>
        </header>
        <div class="hpg-actions">
          <linshe-button
            v-for="action in GROUP_BATCH_ACTIONS"
            :key="action.key"
            :variant="action.variant"
            size="sm"
            :disabled="batchBusy"
            :loading="busyKey === action.key"
            @click="runBatch(action.key)"
          >
            {{ action.label }}
          </linshe-button>
        </div>
        <Transition name="hpg-fade">
          <p v-if="resultText" class="hpg-result">{{ resultText }}</p>
        </Transition>
        <p class="hpg-note">「遗忘被控制这段时间」按钮只在单独使用模式里提供；但遗忘的效果已覆盖群聊：被遗忘那段时间里她在群里说过的话，同样不再进入她的上下文，对应的群聊长期记忆也会一起归档 —— 在单独使用模式 / 私聊面板的「遗忘记录」里可以让她恢复。</p>
      </section>

      <!-- ── ③b 命令她们用玩具（force_toy 的群聊入口）──
           私聊面板 §⑤ 一直有这颗按钮，群聊批量区此前只有四个按钮 ⇒ 用户点不到。
           语义与私聊完全一致（同一后端指令），只是"同一件玩具 + 同一强度"发给选中的每个人，
           所以下指令前先确认**每个人都真的能用这件玩具**（否则会出现半成功的怪状态）。 -->
      <section v-if="toySection.visible" class="hpg-sec hpg-sec-toys">
        <header class="hpg-sec-head">
          <h4 class="hpg-sec-title">命令她用玩具</h4>
          <span class="hpg-sec-hint">戴上之后她自己取不下来</span>
        </header>
        <div class="hpg-actions hpg-toy-row">
          <linshe-select
            v-model="toyKey"
            size="sm"
            :options="toySection.options"
            class="hpg-toy-select"
            aria-label="选择要命令她们戴上的玩具"
          />
          <linshe-select
            v-model="toyIntensity"
            size="sm"
            :options="toySection.intensityOptions"
            class="hpg-toy-intensity"
            aria-label="选择强度"
          />
          <linshe-select
            v-model="toyMode"
            size="sm"
            :options="toyModeOptions"
            class="hpg-toy-mode"
            aria-label="选择振动模式"
          />
          <linshe-select
            v-model="toyCurve"
            size="sm"
            :options="toyCurveOptions"
            class="hpg-toy-curve"
            aria-label="选择强度曲线"
          />
          <linshe-button
            variant="secondary"
            size="sm"
            :disabled="batchBusy || !toySection.canSend"
            :loading="busyKey === GROUP_FORCE_TOY_ACTION.key"
            :title="toySection.blockReason || '戴上之后她自己取不下来'"
            @click="runForceToyBatch"
          >
            命令她们戴上
          </linshe-button>
        </div>
        <p class="hpg-note">{{ toySection.note }}</p>
      </section>

      <!-- ── ④ 睡眠控制（独立一区：这是"她们睡没睡"，不是催眠指令）──
           刻意不和上面的催眠按钮混在一排 —— 用户要的是"单独一个选项控制睡眠"。 -->
      <section class="hpg-sec hpg-sec-sleep">
        <header class="hpg-sec-head">
          <h4 class="hpg-sec-title">睡眠控制</h4>
          <span class="hpg-sec-hint">对上面选中的 {{ selectedIds.length }} 人同时生效，与催眠指令无关</span>
        </header>
        <div class="hpg-actions">
          <linshe-button
            v-for="action in SLEEP_ACTIONS"
            :key="action.key"
            :variant="action.variant"
            size="sm"
            :disabled="batchBusy"
            :loading="busyKey === action.key"
            @click="runSleepBatch(action.key)"
          >
            {{ action.label }}
          </linshe-button>
        </div>
        <p class="hpg-note">{{ SLEEP_SECTION_NOTE }}</p>
      </section>
    </template>

    <p v-else class="hpg-empty">先选人：选 1 人是单独使用模式，选多人则批量下指令。</p>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { inject } from 'vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSelect from './ui/LinsheSelect.vue'
import HypnosisPhonePanel from './HypnosisPhonePanel.vue'
import { getHypnosisState, hypnotizeCharacter, wakeCharacter, commandCharacter, sleepCharacter, wakeFromSleepCharacter } from '../api/hypnosis.js'
import { fetchToys } from '../api/index.js'
import { VIBRATION_MODES, INTENSITY_CURVES, maxIntensityOf, toyLabelOf } from './toyLogic.js'
import {
  DEFAULT_MINUTES,
  GROUP_BATCH_ACTIONS,
  GROUP_FORCE_TOY_ACTION,
  MIN_MINUTES,
  MAX_MINUTES,
  SLEEP_ACTIONS,
  SLEEP_SECTION_NOTE,
  buildForceToyCommand,
  canBatchForceToy,
  clampMinutes,
  intensityOptionsFor,
  memberStateText,
  selectedMembers,
  summarizeBatch,
  toyOptionsFromResponse,
} from './hypnosisLogic.js'

const props = defineProps({
  /** 群成员列表（来自群聊的 members；至少要有 id 与 display_name/name） */
  members: { type: Array, default: () => [] },
})

const toastFn = inject('toast', null)
const POLL_MS = 10000

const selectedIds = ref([])
const states = ref({})
const minutes = ref(DEFAULT_MINUTES)
const busyKey = ref('')
const resultText = ref('')

const batchBusy = computed(() => !!busyKey.value)
const singleCharacter = computed(() => selectedMembers(props.members, selectedIds.value)[0] || null)

const memberName = m => m?.display_name || m?.name || `角色${m?.id}`
const isSelected = id => selectedIds.value.includes(Number(id))
const stateText = id => memberStateText(states.value[Number(id)], Date.now())

function notify(message, type = 'info') {
  if (typeof toastFn === 'function') toastFn(message, type)
  else console.warn('[催眠手机·群聊]', message)
}

function toggle(id) {
  const n = Number(id)
  selectedIds.value = selectedIds.value.includes(n)
    ? selectedIds.value.filter(x => x !== n)
    : [...selectedIds.value, n]
  resultText.value = ''
}

function selectAll() {
  selectedIds.value = props.members.map(m => Number(m.id)).filter(Number.isInteger)
  resultText.value = ''
}

function clearAll() {
  selectedIds.value = []
  resultText.value = ''
}

async function refreshStates({ silent = false } = {}) {
  const list = props.members || []
  const next = { ...states.value }
  await Promise.all(list.map(async m => {
    try {
      next[Number(m.id)] = await getHypnosisState(m.id)
    } catch (err) {
      if (!silent) console.warn('[催眠手机·群聊] 读取状态失败', m?.id, err?.message)
    }
  }))
  states.value = next
}

// ── 命令她们用玩具（force_toy 群聊入口）──
// 玩具清单按**选中的人**分别取（每人解锁情况不同）⇒ 取交集判断"这件玩具是不是每个人都能用"。
const toyState = ref({ loading: false, perMember: {}, options: [] })
const toyKey = ref('')
const toyIntensity = ref(0)
const toyMode = ref('')
const toyCurve = ref('')

const toyModeOptions = computed(() => [
  { label: '保持当前模式', value: '' },
  ...VIBRATION_MODES.map(m => ({ label: m.label || m.key, value: m.key })),
])
const toyCurveOptions = computed(() => [
  { label: '保持当前曲线', value: '' },
  ...INTENSITY_CURVES.map(c => ({ label: c.label || c.key, value: c.key })),
])

const selectedList = computed(() => selectedMembers(props.members, selectedIds.value))

const toySection = computed(() => {
  const options = toyState.value.options
  const visible = options.length > 0 && selectedIds.value.length > 1
  const max = maxIntensityOf(toyKey.value)
  const check = canBatchForceToy(
    selectedList.value.map(m => (toyState.value.perMember[Number(m.id)] || [])),
    toyKey.value
  )
  return {
    visible,
    options,
    intensityOptions: intensityOptionsFor(max),
    canSend: check.ok,
    blockReason: check.ok ? '' : check.reason,
    note: visible
      ? '点下去她们**当场**被戴上（不是"将要"），这一轮就会演出来；戴上之后她们自己取不下来。'
      : '',
  }
})

/** 换玩具后强度要回落到该件玩具的上限（不同玩具上限不同） */
watch(toyKey, () => {
  toyIntensity.value = Math.min(Number(toyIntensity.value) || 0, maxIntensityOf(toyKey.value))
})

async function loadGroupToys() {
  const targets = selectedList.value
  if (targets.length === 0) {
    toyState.value = { loading: false, perMember: {}, options: [] }
    return
  }
  toyState.value = { ...toyState.value, loading: true }
  const perMember = {}
  await Promise.all(targets.map(async m => {
    try {
      const res = await fetchToys(m.id)
      const opts = toyOptionsFromResponse(res, { labelOf: toyLabelOf })
      perMember[Number(m.id)] = opts.map(o => o.value)
      // 合并成一份可选清单（以第一份的标签为准，去重）
      for (const o of opts) {
        if (!toyState.value.options.some(x => x.value === o.value)) {
          toyState.value.options = [...toyState.value.options, o]
        }
      }
    } catch {
      perMember[Number(m.id)] = []
    }
  }))
  toyState.value = { loading: false, perMember, options: toyState.value.options }
  if (!toyKey.value && toyState.value.options.length) toyKey.value = toyState.value.options[0].value
  toyIntensity.value = Math.min(Number(toyIntensity.value) || 0, maxIntensityOf(toyKey.value))
}

/** 批量下 force_toy：同玩具同强度发给选中的每个人，逐个收集结果 */
async function runForceToyBatch() {
  if (batchBusy.value) return
  const targets = selectedList.value
  if (targets.length === 0) return
  const cmd = buildForceToyCommand({
    toyKey: toyKey.value,
    intensity: toyIntensity.value,
    mode: toyMode.value,
    curve: toyCurve.value,
  })
  if (!cmd) return notify('先选一件玩具', 'error')
  const check = canBatchForceToy(targets.map(m => (toyState.value.perMember[Number(m.id)] || [])), cmd.toyKey)
  if (!check.ok) return notify(check.reason, 'error')

  busyKey.value = GROUP_FORCE_TOY_ACTION.key
  try {
    const results = await Promise.all(targets.map(async m => {
      try {
        await commandCharacter(m.id, 'force_toy', cmd)
        return { id: m.id, name: memberName(m), ok: true }
      } catch (err) {
        return { id: m.id, name: memberName(m), ok: false, error: err?.message || '操作失败' }
      }
    }))
    const summary = summarizeBatch(results)
    resultText.value = summary.text
    notify(summary.text, summary.failedCount > 0 ? 'error' : 'success')
    await refreshStates({ silent: true })
  } finally {
    busyKey.value = ''
  }
}

/** 批量：对选中的每个人跑同一个动作，逐个收集结果 */
async function runBatch(key) {
  if (batchBusy.value) return
  const targets = selectedMembers(props.members, selectedIds.value)
  if (targets.length === 0) return
  busyKey.value = key
  try {
    const results = await Promise.all(targets.map(async m => {
      try {
        if (key === 'hypnotize') await hypnotizeCharacter(m.id, clampMinutes(minutes.value))
        else if (key === 'wake') await wakeCharacter(m.id, 'full')
        else if (key === 'wakeMind') await wakeCharacter(m.id, 'mind')
        else if (key === 'forcedClimax') await commandCharacter(m.id, 'forced_climax')
        return { id: m.id, name: memberName(m), ok: true }
      } catch (err) {
        return { id: m.id, name: memberName(m), ok: false, error: err?.message || '操作失败' }
      }
    }))
    const summary = summarizeBatch(results)
    resultText.value = summary.text
    notify(summary.text, summary.failedCount > 0 ? 'error' : 'success')
    await refreshStates({ silent: true })
  } finally {
    busyKey.value = ''
  }
}

/** 睡眠批量：与上面那排催眠按钮分开的一区（sleep / wake 各自调独立接口，不带 mode、不带 minutes） */
async function runSleepBatch(key) {
  if (batchBusy.value) return
  const targets = selectedMembers(props.members, selectedIds.value)
  if (targets.length === 0) return
  busyKey.value = key
  try {
    const results = await Promise.all(targets.map(async m => {
      try {
        if (key === 'sleep') await sleepCharacter(m.id)
        else await wakeFromSleepCharacter(m.id)
        return { id: m.id, name: memberName(m), ok: true }
      } catch (err) {
        return { id: m.id, name: memberName(m), ok: false, error: err?.message || '操作失败' }
      }
    }))
    const summary = summarizeBatch(results)
    resultText.value = summary.text
    notify(summary.text, summary.failedCount > 0 ? 'error' : 'success')
    await refreshStates({ silent: true })
  } finally {
    busyKey.value = ''
  }
}

let pollTimer = null
onMounted(() => {
  refreshStates()
  pollTimer = setInterval(() => refreshStates({ silent: true }), POLL_MS)
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })

// 选人变化时重新取玩具清单（每人解锁情况不同，清单必须跟着选中的人走）
watch(() => selectedIds.value.join(','), () => {
  toyState.value = { loading: false, perMember: {}, options: [] }
  toyKey.value = ''
  if (selectedIds.value.length > 1) loadGroupToys()
})
</script>

<style scoped>
.hpg { display: flex; flex-direction: column; gap: 14px; }

.hpg-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
}
.hpg-sec-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.hpg-sec-title { margin: 0; font-size: var(--fs-md); font-weight: 700; letter-spacing: 0.3px; }
.hpg-sec-hint { font-size: var(--fs-xs); color: var(--text-secondary); }

.hpg-members { display: flex; flex-wrap: wrap; gap: 8px; }
.hpg-member-state { margin-left: 6px; font-size: var(--fs-xs); opacity: 0.75; }

.hpg-bulk { display: flex; align-items: center; gap: 10px; }
.hpg-note { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); }
.hpg-tip { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); }
.hpg-empty {
  margin: 0;
  padding: 14px 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  text-align: center;
}

.hpg-duration { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hpg-duration-input { width: 96px; }
.hpg-duration-unit { font-size: var(--fs-sm); color: var(--text-secondary); }
.hpg-duration-range { font-size: var(--fs-xs); color: var(--text-secondary); }

.hpg-actions { display: flex; flex-wrap: wrap; gap: 8px; }

/* 命令她用玩具：四个下拉 + 一颗按钮，窄屏自动换行 */
.hpg-toy-row { align-items: center; }
.hpg-toy-select { min-width: 120px; }
.hpg-toy-intensity { min-width: 92px; }
.hpg-toy-mode { min-width: 110px; }
.hpg-toy-curve { min-width: 110px; }
/* 睡眠区与催眠区同皮肤，用虚线边框把"这是另一套东西"写进视觉 */
.hpg-sec-sleep { border-style: dashed; }
.hpg-result {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: var(--fs-sm);
}

.hpg-fade-enter-active, .hpg-fade-leave-active { transition: opacity 0.3s var(--ease-standard); }
.hpg-fade-enter-from, .hpg-fade-leave-to { opacity: 0; }
</style>
