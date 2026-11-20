<template>
<div class="chat-view" @pointerdown.capture="onSpeechPointerDown" @pointermove.capture="onSpeechPointerMove" @pointercancel="clearSpeechBubble">
    <div v-if="!chat.activeCharId" class="empty-state">
    </div>

    <template v-else>
<div v-show="!immersive || galgameEntering" class="chat-standard" :inert="immersive || undefined">
<div v-if="chatBgUrl" class="chat-bg" :style="{ backgroundImage: `url(${chatBgUrl})` }"></div>
      <div v-if="chatBgUrl" class="chat-bg-veil"></div>
      <PrivateChatHeader />

      <PrivateChatMessageList />

      <PrivateChatStatus />

      <PrivateChatActionPanels />

      <PrivateChatComposer />
</div>
    </template>

    <Transition name="chat-mode" @after-enter="galgameEntering = false" @enter-cancelled="galgameEntering = false">
      <GalgameDialogue v-if="galgameVisited && chat.activeChar" v-show="immersive" :active="immersive" :character="chat.activeChar" v-model:draft="inputText" :image-mode="imageGenMode" :sleeping="isCharSleeping" :wake-busy="wakeBusy" @wake="onWakeChar" @exit="chatMode = 'chat'" @open-standing="openStandingDisplayPage" />
    </Transition>

    <ImageLightbox
      :visible="!!previewImage"
      :imgs="previewImage"
      @hide="previewImage = null"
      @regenerated="onChatImageRegenerated"
      @upscaled="onChatImageRegenerated"
      @deleted="onChatImageDeleted"
    />

    <PrivateChatCharacterOverlays />

    <PrivateChatImpression />

    <Teleport to="body">
      <AvatarCropper
        v-if="showAvatarPicker"
        :title="'选择' + (avatarCharacter?.display_name || chat.activeChar?.display_name || '') + '的头像'"
        :show-recent-tab="true"
        :show-generate-tab="true"
        :character-id="avatarCharacter?.id"
        :recent-images="recentImages"
        :recent-loading="recentLoading"
        @close="closeAvatarPicker"
        :save-handler="onAgentAvatarSave"
        @switch-to-recent="switchToRecent"
      />
    </Teleport>

    <EventCard
      v-if="detailEvent"
      :key="detailEventKey"
      :event="detailEvent"
      :initial-open="true"
      @updated="onDetailEventUpdated"
    />
  </div>
</template>

<script setup>
import { useSpeechBubbleControls } from '../composables/useSpeechBubbleControls.js'
import { loadSpeech, stopSpeech } from '../stores/speech.js'
import { useSpeechAutoPlay } from '../composables/useSpeechAutoPlay.js'
import { ref, computed, watch, nextTick, onMounted, onUnmounted, inject } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '../stores/chat.js'
import { useProgramClock } from '../composables/useProgramClock.js'
import { userAvatar, loadUserAvatar } from '../userConfig.js'
import * as api from '../api/index.js'
import { openStandingDisplay, standingDisplayUrl, selectStandingCharacter } from '../utils/standingDisplay.js'
import { getCharacterPortrait } from '../api/index.js'
import { useSettingsStore } from '../stores/settings.js'
import { useEventsStore } from '../stores/events.js'
import { useChatSchedule } from '../composables/useChatSchedule.js'
import EventCard from '../components/EventCard.vue'
import AvatarCropper from '../components/AvatarCropper.vue'
import ImageLightbox from '../components/ImageLightbox.vue'
import GalgameDialogue from '../components/chat/GalgameDialogue.vue'
import { provide } from 'vue'
import '../styles/speechBubble.css'
import { PRIVATE_CHAT_CONTEXT } from '../composables/chat/privateChatContext.js'
import { usePrivateChatTouch } from '../composables/chat/usePrivateChatTouch.js'
import { useChatImpression } from '../composables/chat/useChatImpression.js'
import { usePrivateChatScroll } from '../composables/chat/usePrivateChatScroll.js'
import PrivateChatHeader from '../components/chat/private/PrivateChatHeader.vue'
import PrivateChatMessageList from '../components/chat/private/PrivateChatMessageList.vue'
import PrivateChatStatus from '../components/chat/private/PrivateChatStatus.vue'
import PrivateChatActionPanels from '../components/chat/private/PrivateChatActionPanels.vue'
import PrivateChatComposer from '../components/chat/private/PrivateChatComposer.vue'
import PrivateChatCharacterOverlays from '../components/chat/private/PrivateChatCharacterOverlays.vue'
import PrivateChatImpression from '../components/chat/private/PrivateChatImpression.vue'

async function openStandingDisplayPage() {
  closeSettings()
  if (isMobile?.value) {
    await router.push('/standing-display')
    return
  }
  if (!(await openStandingDisplay())) window.location.assign(standingDisplayUrl())
}

const route = useRoute()

const router = useRouter()

// ── galgame 沉浸模式（上游 v3.9.0 合并）──
// 模式由 URL query 驱动（?mode=galgame），普通侧与舞台各自 v-show，互不销毁、消息一份不丢。
// 上游 v4.0.0 合并：语音气泡控制（长按/点击揭示并播放本条语音）
const { touchedSpeechBubble, clearSpeechBubble, onSpeechPointerDown, onSpeechPointerMove, revealSpeechBubble } = useSpeechBubbleControls(() => route.params.id)

const immersive = computed(() => route.query.mode === 'galgame')

const galgameVisited = ref(immersive.value)

// 进场动画中（普通侧还要多留一拍，等舞台铺开再撤）
const galgameEntering = ref(false)

// 预加载中（背景图解码）：按钮显示 loading，避免切过去先看到空舞台（上游 v3.10.0）
const preparingGalgame = ref(false)

const chatMode = computed({
  get: () => immersive.value ? 'galgame' : 'chat',
  set: value => {
    const query = { ...route.query }
    if (value === 'galgame') query.mode = 'galgame'
    else delete query.mode
    router.push({ path: route.path, query })
  },
})

const chat = useChatStore()

// 程序时间：进页面拉一次偏移，消息时间统一按它显示（见 composables/useProgramClock.js）
const clock = useProgramClock()

clock.ensureLoaded()

// 上游 v4.0.0 合并：进入会话后自动播放本会话新到的语音
useSpeechAutoPlay(() => `chat:${route.params.id || chat.activeCharId}`)

// 进场前的背景预载：角色/背景一换就重新解码，并用 modeRequest 作废上一轮（快速连点时只认最后一次）
let galgameBackgroundImage = null

let galgameBackgroundReady = Promise.resolve()

let modeRequest = 0

watch(() => [chat.activeChar?.id, chat.activeChar?.galgame_bg_path || chat.activeChar?.chat_bg_path || ''], ([, url]) => {
  modeRequest++
  preparingGalgame.value = false
  galgameBackgroundImage = url ? new Image() : null
  if (galgameBackgroundImage) {
    galgameBackgroundImage.src = url
    // Keep the decoded image alive until the stage can paint it, including cold-cache entry.
    // 老 WebView 可能没有 HTMLImageElement.decode（Android 壳），退化成"直接切"而不是抛错
    galgameBackgroundReady = typeof galgameBackgroundImage.decode === 'function'
      ? galgameBackgroundImage.decode().catch(() => {})
      : Promise.resolve()
  } else galgameBackgroundReady = Promise.resolve()
}, { immediate: true })

/** 进入 galgame：先等背景解码（冷缓存时最明显），再切 query，切完撤 loading */
async function enterGalgame() {
  if (preparingGalgame.value || immersive.value) return
  const request = ++modeRequest
  const path = route.path
  preparingGalgame.value = true
  try {
    await galgameBackgroundReady
    if (request === modeRequest && route.path === path) chatMode.value = 'galgame'
  } finally {
    if (request === modeRequest) preparingGalgame.value = false
  }
}

onUnmounted(() => { modeRequest++ })

// 进/出沉浸的收尾动作：进场关掉普通侧浮层；退场把焦点还给普通输入框（桌面端）。
// 回调只在用户切换模式后触发，届时 setup 已全部执行完，closeSettings/inputEl/isMobile 均已就位。
watch(immersive, async value => {
  if (value) { galgameEntering.value = true; galgameVisited.value = true; closeSettings() }
  else {
    galgameEntering.value = false
    await nextTick()
    if (!isMobile?.value) inputEl.value?.focus({ preventScroll: true })
  }
})

const eventsStore = useEventsStore()

const confirmFn = inject('confirm')

const toastFn = inject('toast')

const isMobile = inject('isMobile')

const toggleMobileSidebar = inject('toggleMobileSidebar')

const showSettings = ref(false)

const { msgList, userScrolledUp, scrollTimer, cancelImageScroll, scrollToBottom, setupMobileKeyboard, teardownMobileKeyboard, setupResizeObserver, teardownResizeObserver, pendingCharSwitch, onScroll, interruptImageScroll, onScrollKeydown, flatItems, msgListInner, onChatImageLoaded } = usePrivateChatScroll({ chat, clock, isMobile })

const { impressionAffinity, openImpression, showImpression, impressionLoading, impressionError, groupKeys, typeColor, typeIcon, typeLabel, impressionGrouped, startAdd, addingKey, addingContent, cancelAdd, saveAdd, savingAdd, editingId, editingContent, cancelEdit, saveEdit, savingEdit, confidenceLevel, formatTime, startEdit, removeTrait, impressionVad, VAD_LABELS, vadPercent, topEmotions, affinityLabel, impressionLastDelta, impressionLastReason } = useChatImpression({ chat, clock, confirmFn, toastFn, showSettings })

const inputText = ref('')

const showGiftPanel = ref(false)

const inputFocused = ref(false)

const wakeShaking = ref(false)

// ── 奇遇分享卡片 → 详情覆盖层 ──
const detailEvent = ref(null)

const detailEventKey = ref(0)

// 递增以强制 EventCard 重新挂载（重新触发 initialOpen）

async function onOpenEventDetail(eventId) {
  if (eventId == null) {
    console.warn('[ChatView] onOpenEventDetail called with null/undefined eventId')
    return
  }
  // 优先从 store 获取（活跃事件、实时数据）
  const evt = eventsStore.activeEvents.find(e => e.id === eventId) || null
  if (evt) {
    detailEvent.value = evt
    detailEventKey.value++
    console.log('[ChatView] Event detail opened from store:', eventId, evt.title)
    return
  }
  // 回退到 API（历史事件或 store 未同步）
  console.log('[ChatView] Event not in store, fetching from API:', eventId)
  const data = await api.getEventById(eventId)
  if (data) {
    // 确保历史事件有正确的过期标记
    if (data.ended_at && !data.expires_at) {
      data.expires_at = data.ended_at
    }
    detailEvent.value = data
    detailEventKey.value++
  } else {
    console.warn('[ChatView] Event not found via API either:', eventId)
  }
}

function onDetailEventUpdated(update) {
  // EventCard emit 的事件更新（分支选择完成/事件结束等）
  if (update?.concluded || update?.expired) {
    detailEvent.value = null
  } else if (update?.event) {
    detailEvent.value = update.event
  }
}

const settings = useSettingsStore()

const scheduleStore = useChatSchedule(() => chat.activeCharId, () => chat.streaming, () => chat.messages.length)

// 当前角色的日程活动文本
const currentScheduleText = computed(() => {
  if (!chat.activeCharId) return ''
  const sc = scheduleStore.characters.find(c => String(c.id) === String(chat.activeCharId))
  if (!sc || !sc.current_activity || sc.current_activity === '未设置日程') return ''
  return sc.current_activity
})

// 从 schedule store 获取当前角色睡眠状态（实时更新）
const charSleepState = computed(() => {
  if (!chat.activeCharId) return null
  return scheduleStore.characters.find(c => String(c.id) === String(chat.activeCharId)) || null
})

const isCharSleeping = computed(() => {
  const s = charSleepState.value
  return s ? (s.is_sleeping && !s.is_temp_woken) : false
})

const { scheduleTouchStateRefresh, showIntimatePanel, showTouchPanel, touchServerGroups, touchGateState, touchBusyActions, touchHypnosisBadge, touchPendingCount, touchPendingByMode, touchStates, onTouchAction, onTouchPanelOpen, showToyPanel, wornToys, toyOptions, onToyEquip, onToyIntensity, onToyRemove, toysEnabled, touchPendingHint, togglePanel } = usePrivateChatTouch({ chat, toastFn, isCharSleeping, impressionAffinity })

const imageGenMode = computed(() => settings.imageGenMode)

const imageGenModeLabel = computed(() => {
  if (imageGenMode.value === 'off') return '关闭配图'
  if (imageGenMode.value === 'force') return '导演模式'
  return '灵性配图'
})

const imageGenModeIcon = computed(() => {
  if (imageGenMode.value === 'off') return '🚫'
  if (imageGenMode.value === 'force') return '🎬'
  return '🎨'
})

const realtimeAffinityEnabled = computed(() => settings.realtimeAffinityDisplay)

const IMAGE_GEN_MODE_CYCLE = ['smart', 'force', 'off']

async function cycleImageGenMode() {
  if (settings.isSaving('imageGenMode')) return
  const idx = IMAGE_GEN_MODE_CYCLE.indexOf(imageGenMode.value)
  const next = IMAGE_GEN_MODE_CYCLE[(idx + 1) % IMAGE_GEN_MODE_CYCLE.length]
  try {
    await settings.setImageGenMode(next)
    showForceTip()
  } catch (err) {
    toastFn?.(`配图模式保存失败：${err?.message || '未知错误'}`, 'error')
  }
}

async function onRealtimeAffinityChange(next) {
  if (settings.isSaving('realtimeAffinityDisplay')) return
  try {
    await settings.setRealtimeAffinityDisplay(next)
  } catch (err) {
    toastFn?.(`好感度显示保存失败：${err?.message || '未知错误'}`, 'error')
  }
}

function onGiftSent(result) {
  showGiftPanel.value = false

  // 刷新顶部好感度显示
  chat.realtimeAffinity = {
    affinity: result.affinity,
    affinityDelta: result.affinityDelta,
    lastReason: '哇，收到礼物了',
  }
  chat.affinityKey++

  chat.patchCharacterLocal(chat.activeCharId, {
    ...(result.affinity != null ? { affinity: result.affinity } : {}),
    ...(result.is_oath ? { is_oath: 1 } : {}),
  })

  // 1. 自定义送出台词（选填）
  if (result.giftLine) {
    chat.messages.push({
      id: result.userMsgId || Date.now(),
      role: 'user',
      content: result.giftLine,
      created_at: new Date().toISOString(),
    })
  }

  // 2. 角色文字气泡
  chat.messages.push({
    id: result.msgId,
    role: 'assistant',
    content: result.reaction,
    created_at: new Date().toISOString(),
  })

  // 3. 生图气泡（pending → 遮罩 + 进度条，和普通生图完全一致）
  const genId = `gift_${result.msgId}`
  const genMsg = {
    id: Date.now(),
    role: 'assistant',
    type: 'image_gen',
    genId,
    genStatus: 'pending',
    genStartTime: Date.now(),
    created_at: new Date().toISOString(),
  }
  chat.messages.push(genMsg)
  nextTick(() => scrollToBottom(true))

  // 4. 轮询图片就绪，更新 image_gen 气泡
  let polls = 0
  const timer = setInterval(async () => {
    polls++
    try {
      const res = await fetch(`/api/messages/${result.msgId}`)
      if (!res.ok) { clearInterval(timer); return }
      const data = await res.json()
      if (data.images) {
        try {
          const urls = JSON.parse(data.images)
          if (Array.isArray(urls) && urls.length > 0) {
            const idx = chat.messages.findIndex(m => m.genId === genId)
            if (idx >= 0) {
              chat.messages[idx].images = urls.map(url => ({ url, base64: null }))
              chat.messages[idx].genStatus = 'done'
            }
          }
        } catch {}
        clearInterval(timer)
      }
    } catch { /* ignore */ }
    if (polls >= 20) {
      const idx = chat.messages.findIndex(m => m.genId === genId)
      if (idx >= 0) chat.messages[idx].genStatus = 'error'
      clearInterval(timer)
    }
  }, 4000)
}

const forceTipVisible = ref(false)

let forceTipTimer = null

function showForceTip() {
  forceTipVisible.value = true
  clearTimeout(forceTipTimer)
  forceTipTimer = setTimeout(() => { forceTipVisible.value = false }, 2000)
}

// ── 聊天流叫醒按钮（三段式：电话→上门→摇醒） ──
const wakeBusy = ref(false)

async function onWakeChar() {
  if (!chat.activeCharId) return
  const id = chat.activeCharId
  if (wakeBusy.value) return
  wakeBusy.value = true
  wakeShaking.value = true

  const name = chat.activeChar?.display_name || ''
  const s = charSleepState.value

  try {
    // 已上门/摇醒过 → 再次摇醒
    if (s?.was_door_woken) {
      toastFn(`${name}！${name}！`, 'info')
      const res = await api.wakeUpByDoor(id)
      if (!res?.success) toastFn(res?.message || '摇醒失败', 'info')
      return
    }

    // 电话叫醒已满 3 次 → 上门
    if ((s?.wake_attempts || 0) >= 3) {
      toastFn(`${name}！${name}！`, 'info')
      setTimeout(() => { toastFn(`${name}亦未寝。`, 'info') }, 2000)
      const res = await api.wakeUpByDoor(id)
      if (!res?.success) toastFn(res?.message || '摇醒失败', 'info')
      return
    }

    // 默认 → 电话叫醒
    const res = await api.wakeUpByPhone(id)
    if (res?.success) {
      // 成功：主动刷新确保按钮切回礼物
    } else {
      toastFn(`没叫醒${name}...`, 'info')
      if (res?.door_wake_available) {
        setTimeout(() => { toastFn(`电话打不通，试试上门找${name}吧`, 'info') }, 1200)
      }
    }
  } catch (err) {
    toastFn('叫醒失败: ' + (err.message || '未知错误'), 'error')
  } finally {
    // 每次 API 调用后刷新数据，使 wake_attempts 反映最新值
    try { await scheduleStore.fetchOverview(true) } catch {}
    try { await chat.loadCharacters() } catch {}
    wakeShaking.value = false
    wakeBusy.value = false
  }
}

// ── 实时好感度：拉取当前角色最新值 ──
async function fetchRealtimeAffinity() {
  if (!realtimeAffinityEnabled.value || !chat.activeCharId) return
  try {
    const data = await getCharacterPortrait(chat.activeCharId)
    chat.realtimeAffinity = {
      affinity: data.affinity ?? 50,
      affinityDelta: data.lastAffinityDelta ?? 0,
      lastReason: data.lastReason || ''
    }
  } catch {}
}

// 开关从关→开时拉取
watch(realtimeAffinityEnabled, async (on) => { if (on) fetchRealtimeAffinity() })

// 切换角色时拉取
watch(() => chat.activeCharId, async (newId) => { if (newId) fetchRealtimeAffinity() })

const inputEl = ref(null)

const previewImage = ref(null)

// 聊天图片预览（上游 v3.10.0 合并时被「本地优先」丢掉的那一项，2026-10-19 补回）
function onChatImagePreview(url) {
  previewImage.value = url
}

function onChatImageDeleted(deletedUrl) {
  const base = deletedUrl.replace(/\?.*$/, '')
  chat.messages = chat.messages.filter(msg => {
    if (msg.type === 'image_gen' && msg.images) {
      return !msg.images.some(img => {
        const imgUrl = typeof img === 'string' ? img : img.url
        return imgUrl && imgUrl.replace(/\?.*$/, '') === base
      })
    }
    return true
  })
  previewImage.value = null
}

function onChatImageRegenerated(newUrl) {
  const base = newUrl.replace(/\?.*$/, '')
  for (const msg of chat.messages) {
    if (msg.type !== 'image_gen' || !Array.isArray(msg.images)) continue
    for (const img of msg.images) {
      const imgUrl = typeof img === 'string' ? img : img?.url
      if (imgUrl && imgUrl.replace(/\?.*$/, '') === base) {
        if (typeof img === 'string') msg.images[msg.images.indexOf(img)] = newUrl
        else img.url = newUrl
      }
    }
  }
}

/** 亲密看板（聊天页直达）：与角色详情卡里那个是同在 IntimatePanel 上的同一个看板 */
const showIntimate = ref(false)

const showHypnosis = ref(false)

const showEditor = ref(false)

const editorCharacter = ref(null)

const editorLoading = ref(false)

let editorClearTimer = null

let editorRequestSeq = 0

const showRelationGraph = ref(false)

const detailModalRef = ref(null)

const clearing = ref(false)

const deleting = ref(false)

// 关闭关系图后刷新详情中的关系数据
watch(showRelationGraph, (val) => {
  if (!val) {
    detailModalRef.value?.refreshRelationships()
  }
})

// 消息行头像地址：用户用本人头像，其余用当前角色头像（无则回落首字母）
function msgAvatarSrc(role) {
  return role === 'user' ? (userAvatar.value || '') : (chat.activeChar?.avatar_path || '')
}

function openSettings() { showSettings.value = true }

function closeSettings() { showSettings.value = false }

/**
 * 从聊天页设置面板一步打开亲密信息看板。
 * 先关设置面板再开看板：两者都是遮罩层，叠着会出现两层遮罩与焦点错乱。
 */
function openIntimatePanel() {
  showSettings.value = false
  showIntimate.value = true
}

/** 从聊天页设置面板一步打开催眠手机（与亲密信息同款交互：先关设置面板，避免双层遮罩） */
function openHypnosisPanel() {
  showSettings.value = false
  showHypnosis.value = true
}

// ══════════════════════════════════════════════════
// 角色详情编辑弹窗（酒馆同款）
// ══════════════════════════════════════════════════

async function openCharEditor() {
  const characterId = chat.activeCharId
  if (!characterId || editorLoading.value) return
  clearTimeout(editorClearTimer)
  const requestId = ++editorRequestSeq
  editorLoading.value = true
  try {
    const detail = await chat.loadCharacterDetail(characterId, { force: true })
    if (!detail) throw new Error('角色详情已更新，请重试')
    if (requestId !== editorRequestSeq || String(chat.activeCharId) !== String(characterId)) return
    editorCharacter.value = detail
    showSettings.value = false
    showEditor.value = true
  } catch (err) {
    toastFn?.(`角色资料读取失败：${err?.message || '请稍后重试'}`, 'error')
  } finally {
    editorLoading.value = false
  }
}

function closeCharEditor() {
  editorRequestSeq += 1
  showEditor.value = false
  clearTimeout(editorClearTimer)
  editorClearTimer = setTimeout(() => {
    if (!showEditor.value) editorCharacter.value = null
  }, 320)
}

async function onCharSaved(c) {
  const characterId = c?.id ?? chat.activeCharId
  if (!characterId) return
  const requestId = ++editorRequestSeq
  chat.invalidateCharacterDetail(characterId)
  await chat.loadCharacters()
  if (requestId !== editorRequestSeq
    || String(chat.activeCharId) !== String(characterId)
    || String(editorCharacter.value?.id) !== String(characterId)
    || !showEditor.value) return
  try {
    const detail = await chat.loadCharacterDetail(characterId, { force: true })
    if (requestId !== editorRequestSeq
      || String(chat.activeCharId) !== String(characterId)
      || String(editorCharacter.value?.id) !== String(characterId)
      || !showEditor.value) return
    if (!detail) throw new Error('角色详情已更新，请重试')
    editorCharacter.value = detail
  } catch (err) {
    if (requestId === editorRequestSeq) {
      toastFn?.(`角色已保存，但详情刷新失败：${err?.message || '请重新打开'}`, 'error')
    }
  }
}

async function onCharDeleted(c) {
  editorRequestSeq += 1
  if (c?.id) chat.invalidateCharacterDetail(c.id)
  showEditor.value = false
  clearTimeout(editorClearTimer)
  editorClearTimer = setTimeout(() => {
    if (!showEditor.value) editorCharacter.value = null
  }, 320)
  await chat.loadCharacters()
  router.push('/tavern')
}

function onOpenAvatarEditor(c) {
  openAvatarPicker()
}

function onOpenRelationGraph(c) {
  showRelationGraph.value = true
}

// 设置面板中的撤回一轮（div 无 disabled 属性，点击前自行守卫）
function onUndoRound() {
  if (!chat.messages.length || chat.streaming) return
  closeSettings()
  undoLastRound()
}

async function clearChatHistory() {
showSettings.value = false
if (clearing.value) return
const ok = await confirmFn({ title:'清空记忆', message:`确定要清空${chat.activeChar?.display_name}的所有记忆吗？\n此操作不可恢复。`, okText:'清空' })
if (!ok) return
clearing.value = true
try { await chat.clearActiveMessages() } catch {} finally { clearing.value = false }
}

// 设置面板中的删除角色（保留兼容）
async function deleteChar() {
if (deleting.value) return
showSettings.value = false
const ok = await confirmFn({
title: '删除' + chat.activeChar?.display_name,
message: `确定要删除角色「${chat.activeChar?.display_name}」吗？\n此操作不可恢复。`,
okText: '删除', danger: true,
})
if (!ok) return
deleting.value = true
try { await chat.deleteActiveCharacter() } catch {} finally { deleting.value = false }
}

async function removeAvatar() {
  const characterId = chat.activeCharId
  if (!characterId) return
  const displayName = chat.activeChar?.display_name || '当前角色'
  showSettings.value = false
  const ok = await confirmFn({ title:'移除头像', message:`确定要移除${displayName}的头像吗？`, okText:'移除' })
  if (!ok) return
  await chat.uploadAvatar(null, characterId)
}

// ══════════════════════════════════════════════════
// 角色聊天背景
// ══════════════════════════════════════════════════

const chatBgUrl = computed(() => chat.activeChar?.chat_bg_path || '')

function onChatBgUpdated({ characterId, path }) {
  chat.patchCharacterLocal(characterId, { chat_bg_path: path })
}

// ══════════════════════════════════════════════════
// 头像选择器（使用 AvatarCropper 组件）
// ══════════════════════════════════════════════════

const showAvatarPicker = ref(false)

const recentImages = ref([])

const recentLoading = ref(false)

const avatarCharacter = ref(null)

let avatarClearTimer = null

let recentRequestSeq = 0

function openAvatarPicker() {
  const characterId = chat.activeCharId
  if (!characterId) return
  recentRequestSeq += 1
  clearTimeout(avatarClearTimer)
  showSettings.value = false
  recentImages.value = []
  avatarCharacter.value = {
    id: characterId,
    display_name: chat.activeChar?.display_name || '',
  }
  showAvatarPicker.value = true
}

function closeAvatarPicker() {
  recentRequestSeq += 1
  showAvatarPicker.value = false
  clearTimeout(avatarClearTimer)
  avatarClearTimer = setTimeout(() => {
    if (!showAvatarPicker.value) avatarCharacter.value = null
  }, 320)
}

async function switchToRecent() {
  if (recentImages.value.length > 0) return
  const characterId = avatarCharacter.value?.id
  if (!characterId) return
  const requestId = ++recentRequestSeq
  recentLoading.value = true
  try {
    const d = await chat.getRecentChatImages(characterId)
    if (requestId !== recentRequestSeq || String(avatarCharacter.value?.id) !== String(characterId)) return
    recentImages.value = d.images || []
  } catch {
  } finally {
    if (requestId === recentRequestSeq) recentLoading.value = false
  }
}

async function onAgentAvatarSave(base64) {
  const characterId = avatarCharacter.value?.id
  if (!characterId) throw new Error('头像归属角色已失效')
  await chat.uploadAvatar(base64, characterId)
}

onMounted(async () => {
  await Promise.all([chat.loadCharacters(), loadUserAvatar(), settings.loadComfyConfig()])
  if (chat.activeCharId) loadSpeech(chat.activeCharId).catch(() => {})
  const targetId = route.params.id ? parseInt(route.params.id) : (chat.characters.length > 0 ? chat.characters[0].id : null)
  if (targetId && targetId !== chat.activeCharId) {
    if (route.params.id) selectStandingCharacter(targetId)
    await chat.selectChar(targetId)
  }
  await nextTick()
  scrollToBottom(true)  // 首次加载强制滚底
  setupResizeObserver()  // 之后由 ResizeObserver 追底（图片加载等异步布局变化）
  if (!isMobile) inputEl.value?.focus()
  setupMobileKeyboard()
  // selectChar 之后拉取实时好感度（避免被 selectChar 清空）
  fetchRealtimeAffinity()
  // 点击页面其他地方关闭撤回气泡
  window.addEventListener('click', dismissUndoBubble)
})

onUnmounted(() => {
  editorRequestSeq += 1
  recentRequestSeq += 1
  cancelImageScroll()
  clearTimeout(editorClearTimer)
  clearTimeout(avatarClearTimer)
  clearTimeout(scrollTimer.value)
  teardownMobileKeyboard()
  teardownResizeObserver()
  window.removeEventListener('click', dismissUndoBubble)
})

// 浏览器前进/后退 → 同步 store
watch(() => route.params.id, (newId) => {
  const id = parseInt(newId)
  if (id && id !== chat.activeCharId) {
    selectStandingCharacter(id)
    chat.selectChar(id)
  }
})

// 切角色：停 Observer + 隐藏容器，等消息加载完成后滚底
watch(() => chat.activeCharId, (id, oldId) => {
  stopSpeech()
  if (id) loadSpeech(id).catch(() => {})
  if (id && id !== oldId) {
    cancelImageScroll()
    const routeId = parseInt(route.params.id)
    if (id !== routeId) router.replace('/chat/' + id)
    pendingCharSwitch.value = true
    userScrolledUp.value = false
    if (msgList.value) msgList.value.style.visibility = 'hidden'
  }
})

// 新消息到达 → 自动滚底（监听 messages.length，窗口展开不影响）
let previousImageIds = new Set(chat.messages.filter(msg => msg.type === 'image_gen').map(msg => msg.id))

watch(() => chat.messages.length, (newLen) => {
  const imageIds = new Set(chat.messages.filter(msg => msg.type === 'image_gen').map(msg => msg.id))
  const hasNewImage = [...imageIds].some(id => !previousImageIds.has(id))
  previousImageIds = imageIds
  if (newLen === 0) return
  // task-29 问题 3：新消息往往就是「她回应了」⇒ 把「还有 N 个动作」刷掉。
  // 走合并器：同一轮会连插好几条，只刷一次，别把请求打爆。
  scheduleTouchStateRefresh()
  if (pendingCharSwitch.value) {
    // 切角色后消息加载完成：滚底 + 恢复可见
    setTimeout(() => {
      const el = msgList.value
      if (!el) return
      el.scrollTop = el.scrollHeight
      el.style.visibility = ''
      setTimeout(() => {
        const el2 = msgList.value
        if (!el2) return
        el2.scrollTop = el2.scrollHeight
        pendingCharSwitch.value = false
      }, 150)
    }, 50)
  } else {
    // 图片的第一次入场发生在占位气泡插入时，不能只在 loaded 后延长滚动。
    scrollToBottom(false, hasNewImage ? 600 : 0)
  }
})

// 表情包是追加到当前分句气泡上的，不改变 messages.length；单独监听贴图数量触发滚底
watch(
  () => {
    const last = chat.messages[chat.messages.length - 1]
    return `${last?.sticker_images?.length || 0}:${last?.content ? 1 : 0}`
  },
  () => {
    if (pendingCharSwitch.value) return
    scrollToBottom()
  }
)

// 候选词出现时平滑滚底（此时 streaming 已结束，scrollTo 不与气泡插入竞争）
watch(() => chat.guesses, (val) => {
  if (val) { nextTick(() => scrollToBottom()) }
})

function pickGuess(text) {
  if (!text) return
  inputText.value = text
  chat.guesses = null
  inputEl.value?.focus()
}

// ── 长按发送按钮 → 撤回气泡 ──
const showUndoBubble = ref(false)

let pressTimer = null

let longPressFired = false

const sendDisabled = computed(() => !inputText.value.trim() || chat.streaming)

function onSendPressStart() {
  // 流式中不允许长按（正在发送消息），仅输入为空时可以
  if (chat.streaming) return
  if (!chat.messages.length) return
  longPressFired = false
  pressTimer = setTimeout(() => {
    longPressFired = true
    showUndoBubble.value = true
  }, 600)
}

function onSendPressEnd() {
  clearTimeout(pressTimer)
  pressTimer = null
}

function onSendClick() {
  if (sendDisabled.value) return
  if (longPressFired) {
    // 长按刚触发，忽略本次 click（由 mouseup/touchend 之后的浏览器 click 事件产生）
    longPressFired = false
    return
  }
  if (showUndoBubble.value) {
    // 气泡已显示，点击发送按钮 = 关闭气泡
    showUndoBubble.value = false
    return
  }
  send()
}

function dismissUndoBubble(e) {
  // 忽略来自发送按钮区域的点击（由 onSendClick 统一处理）
  if (e && e.target.closest('.send-btn')) return
  showUndoBubble.value = false
}

async function undoLastRound() {
  showUndoBubble.value = false
  const ok = await confirmFn({
    title: '撤回对话',
    message: '确定撤回上一轮对话吗？\n你最后一条消息和角色的回复都会被删除。\n\n💡 提示：长按发送键可快速撤回。',
    okText: '撤回',
  })
  if (!ok) return
  try {
    await chat.undoLastRound()
    await scrollToBottom(true)
  } catch (err) {
    console.error('[chat] undo last round failed:', err)
  }
}

async function send() {
  if (sendDisabled.value) return
  const text = inputText.value.trim()
  inputText.value = ''
  userScrolledUp.value = false  // 用户主动发送 → 强制跟随
  await chat.sendMessage(text, imageGenMode.value)
  await scrollToBottom(true)
}

function renderContent(text) {
  if (!text) return ''
  // <br> 必须在 HTML 转义之前剥离——转义后 < 变成 &lt;，正则无法匹配
  return text.replace(/<br\s*\/?>/gi, '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\n/g,'<br>')
}

provide(PRIVATE_CHAT_CONTEXT, { isMobile, toggleMobileSidebar, chat, realtimeAffinityEnabled, currentScheduleText, charSleepState, scheduleStore, showIntimatePanel, openStandingDisplayPage, openSettings, immersive, preparingGalgame, enterGalgame, onScroll, clearSpeechBubble, interruptImageScroll, onScrollKeydown, flatItems, msgList, msgListInner, pickGuess, showTouchPanel, touchServerGroups, touchGateState, touchBusyActions, touchHypnosisBadge, touchPendingCount, touchPendingByMode, touchStates, onTouchAction, onTouchPanelOpen, showToyPanel, wornToys, toyOptions, onToyEquip, onToyIntensity, onToyRemove, imageGenMode, settings, imageGenModeLabel, cycleImageGenMode, imageGenModeIcon, forceTipVisible, inputText, send, inputFocused, isCharSleeping, wakeShaking, onWakeChar, showGiftPanel, toysEnabled, touchPendingHint, togglePanel, showUndoBubble, undoLastRound, sendDisabled, onSendClick, onSendPressStart, onSendPressEnd, onGiftSent, inputEl, showSettings, closeSettings, openAvatarPicker, removeAvatar, onChatBgUpdated, editorLoading, openCharEditor, openIntimatePanel, openHypnosisPanel, openImpression, clearing, clearChatHistory, onUndoRound, deleting, deleteChar, showEditor, editorCharacter, closeCharEditor, onCharSaved, onCharDeleted, onOpenAvatarEditor, onOpenRelationGraph, showRelationGraph, showIntimate, showHypnosis, detailModalRef, showImpression, impressionLoading, impressionError, groupKeys, typeColor, typeIcon, typeLabel, impressionGrouped, startAdd, addingKey, addingContent, cancelAdd, saveAdd, savingAdd, editingId, editingContent, cancelEdit, saveEdit, savingEdit, confidenceLevel, formatTime, startEdit, removeTrait, impressionVad, VAD_LABELS, vadPercent, topEmotions, impressionAffinity, affinityLabel, impressionLastDelta, impressionLastReason, onRealtimeAffinityChange, onOpenEventDetail, msgAvatarSrc, touchedSpeechBubble, revealSpeechBubble, renderContent, onChatImagePreview, onChatImageLoaded, onSpeechPointerDown, onSpeechPointerMove, chatBgUrl, galgameEntering, galgameVisited, wakeBusy, chatMode, previewImage, onChatImageRegenerated, onChatImageDeleted, showAvatarPicker, avatarCharacter, recentImages, recentLoading, closeAvatarPicker, onAgentAvatarSave, switchToRecent, detailEvent, detailEventKey, onDetailEventUpdated })
</script>

<style scoped>
.chat-standard { display: flex; flex-direction: column; flex: 1; min-height: 0; }

.chat-view { flex:1; display:flex; flex-direction:column; height:100vh; height:100dvh; overflow:hidden; background:transparent; position:relative; }
.chat-bg {
  position: absolute; inset: 0;
  background-size: cover; background-position: center;
  pointer-events: none;
}
.chat-bg-veil {
  position: absolute; inset: 0;
  background: color-mix(in srgb, var(--bg-primary) 52%, transparent);
  pointer-events: none;
}
.empty-state { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; }
.empty-state h2 { font-size:18px; color:var(--text-secondary); font-weight:400; }
@keyframes zzz-pop {
  0% { opacity: 0; transform: translate(0, 2px) scale(0.5); }
  25% { opacity: 1; transform: translate(0, 0) scale(1); }
  55% { opacity: 1; transform: translate(0, -2px) scale(1); }
  100% { opacity: 0; transform: translate(0, -5px) scale(1); }
}
@keyframes placeholder-breathe { 0%, 100% { opacity: 0.55 } 50% { opacity: 0.85 } }

@keyframes dotBlink {
  0%, 20%, 100% { fill: #fff; }
  40%, 60% { fill: #aaa; }
}
.force-img-toggle.active {
  opacity: 1;
  background: linear-gradient(135deg, rgba(var(--accent-rgb), 0.15) 0%, rgba(208, 110, 94, 0.15) 100%);
  border-color: var(--accent-light);
  box-shadow: var(--focus-ring), 0 0 16px rgba(var(--accent-rgb), 0.08);
}
.force-img-toggle.active .force-img-icon { transform: scale(1.1); }
@keyframes wake-shake {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-12deg); }
  50% { transform: rotate(12deg); }
  75% { transform: rotate(-8deg); }
}
@keyframes wake-nudge {
  0%, 19%, 100% { transform: rotate(0deg); }
  3% { transform: rotate(-14deg) scale(1.08); }
  6% { transform: rotate(12deg) scale(1.08); }
  9% { transform: rotate(-9deg) scale(1.08); }
  13% { transform: rotate(7deg) scale(1.05); }
  16% { transform: rotate(-3deg) scale(1.02); }
}
@keyframes dotPulse { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
.color-dot.active { border-color:var(--accent); transform:scale(1.15); }
@keyframes rel-spin {
  to { transform: rotate(360deg); }
}
@keyframes impression-spin { to { transform: rotate(360deg); } }
@keyframes roll-out { from { transform: translateY(0);    opacity: 1; } to { transform: translateY(-120%); opacity: 0; } }
@keyframes roll-in  { from { transform: translateY(120%); opacity: 0; } to { transform: translateY(0);     opacity: 1; } }
</style>
