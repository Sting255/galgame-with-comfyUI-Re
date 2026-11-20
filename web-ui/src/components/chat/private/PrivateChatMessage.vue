<template>
<div v-if="item.type === 'divider'" class="time-divider">{{ item.label }}</div>

            <!-- Event share card (奇遇分享卡片) -->
            <div v-else-if="item.msg.type === 'event_card'" class="message assistant" :class="{ 'msg-same-role': item.sameRole }">
              <div class="msg-avatar clickable" title="角色设置" @click="openSettings()">
                <img v-if="chat.activeChar?.avatar_path" :src="chat.activeChar.avatar_path" class="avatar-img" alt="" />
                <span v-else class="avatar-fallback">{{ chat.activeChar?.display_name?.charAt(0) }}</span>
                <span v-if="isCharSleeping" class="sleep-zzz" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path class="zzz-1" d="M4 9h4l-4 4h4" /><path class="zzz-2" d="M11 6h5l-5 5h5" /><path class="zzz-3" d="M17 3h5l-5 5h5" /></svg>
                </span>
              </div>
              <EventShareCard
                :msg="item.msg"
                @open-detail="onOpenEventDetail"
              />
            </div>

            <!-- 深度思考块（可折叠） -->

            <!-- Text bubble (user or assistant) -->
            <div v-else-if="item.msg.type !== 'image_gen'" class="message" :class="[item.msg.role, { 'msg-same-role': item.sameRole }]">
              <div class="msg-avatar" :class="{ 'clickable': item.msg.role === 'assistant' }" :title="item.msg.role === 'assistant' ? '角色设置' : ''" @click="item.msg.role === 'assistant' && openSettings()">
                <img v-if="msgAvatarSrc(item.msg.role)" :src="msgAvatarSrc(item.msg.role)" class="avatar-img" loading="lazy" decoding="async" alt="" />
                <span v-else class="avatar-fallback">{{ item.msg.role === 'user' ? '我' : chat.activeChar?.display_name?.charAt(0) }}</span>
                <span v-if="isCharSleeping && item.msg.role === 'assistant'" class="sleep-zzz" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path class="zzz-1" d="M4 9h4l-4 4h4" /><path class="zzz-2" d="M11 6h5l-5 5h5" /><path class="zzz-3" d="M17 3h5l-5 5h5" /></svg>
                </span>
              </div>
              <!-- 等待态：Agent消息内容为空时显示打字动画，不套气泡 -->
              <svg
v-if="item.piece.kind === 'text' && item.msg.role === 'assistant' && !item.msg.content && chat.streaming && chat.showTypingDots"
                class="typing-dots" viewBox="0 0 72 10" width="72" height="10"
                style="align-self:center"
              >
                <circle cx="4" cy="5" r="3" class="dot dot-0" />
                <circle cx="16" cy="5" r="3" class="dot dot-1" />
                <circle cx="28" cy="5" r="3" class="dot dot-2" />
                <circle cx="40" cy="5" r="3" class="dot dot-3" />
                <circle cx="52" cy="5" r="3" class="dot dot-4" />
                <circle cx="64" cy="5" r="3" class="dot dot-5" />
              </svg>
              <!-- 表情包：独立 100×100 气泡，不再并入文本气泡 -->
              <div v-else-if="item.piece.kind === 'sticker'" class="msg-bubble msg-sticker-bubble">
                <img
                  :src="item.msg.sticker_images[item.piece.index]?.url || item.msg.sticker_images[item.piece.index]"
                  class="msg-sticker-img"
                  loading="lazy"
                />
              </div>
              <!-- 等待期占位（专题 §九 建议 1）：淡色 + 复用现成 .typing-dots 跳动圆点（typing 字段终于有人消费）。
                   必须排在下面 content 分支**之前** —— 占位是有 content 的，否则会被普通气泡吞掉。 -->
              <div
                v-else-if="item.msg.placeholder === 'touch'"
                class="msg-bubble msg-placeholder-bubble"
              >
                <span class="msg-placeholder-text">{{ item.msg.content }}</span>
                <svg class="typing-dots msg-placeholder-dots" viewBox="0 0 72 10" width="36" height="5" aria-hidden="true">
                  <circle cx="4" cy="5" r="3" class="dot dot-0" />
                  <circle cx="16" cy="5" r="3" class="dot dot-1" />
                  <circle cx="28" cy="5" r="3" class="dot dot-2" />
                  <circle cx="40" cy="5" r="3" class="dot dot-3" />
                  <circle cx="52" cy="5" r="3" class="dot dot-4" />
                  <circle cx="64" cy="5" r="3" class="dot dot-5" />
                </svg>
              </div>
              <div
                v-else-if="item.msg.content" class="msg-bubble"
                :class="{ 'has-speech': speechEnabled && item.msg.role === 'assistant' && item.msg.speech_message_id, 'speech-revealed': touchedSpeechBubble === item.id }"
                @pointerup="revealSpeechBubble($event, item.id)"
              >
                <div class="msg-text" v-html="renderContent(item.msg.content)"></div>
                <SpeechButton
                  v-if="item.msg.role === 'assistant' && item.msg.speech_message_id"
                  :auto-token="item.msg.speech_auto_token"
                  :notify-errors="immersive"
                  :key="`${chat.activeCharId}-${item.msg.speech_message_id}`" :character-id="chat.activeCharId" :character-name="chat.activeChar?.display_name" :message-id="item.msg.speech_message_id" :touch-target="isMobile"
                />
              </div>
            </div>

            <!-- Image generation bubble -->
            <div v-else class="message assistant" :class="{ 'msg-same-role': item.sameRole }">
              <div class="msg-avatar clickable" title="角色设置" @click="openSettings()">
                <img v-if="chat.activeChar?.avatar_path" :src="chat.activeChar.avatar_path" class="avatar-img" alt="" />
                <span v-else class="avatar-fallback">{{ chat.activeChar?.display_name?.charAt(0) }}</span>
                <span v-if="isCharSleeping" class="sleep-zzz" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path class="zzz-1" d="M4 9h4l-4 4h4" /><path class="zzz-2" d="M11 6h5l-5 5h5" /><path class="zzz-3" d="M17 3h5l-5 5h5" /></svg>
                </span>
              </div>
              <ImageGenBubble
                :msg="item.msg"
                :emit-loaded-when-initially-done="!!item.msg.liveImage"
                @preview="onChatImagePreview($event)"
                @loaded="onChatImageLoaded(item.msg)"
              />
            </div>
</template>

<script setup>
import { speechEnabled } from '../../../stores/speech.js'
import SpeechButton from '../../SpeechButton.vue'
import ImageGenBubble from '../../ImageGenBubble.vue'
import EventShareCard from '../../EventShareCard.vue'
import { usePrivateChatContext } from '../../../composables/chat/privateChatContext.js'
defineProps({ item: { type: Object, required: true } })
const { openSettings, chat, isCharSleeping, onOpenEventDetail, msgAvatarSrc, touchedSpeechBubble, revealSpeechBubble, renderContent, immersive, isMobile, onChatImagePreview, onChatImageLoaded } = usePrivateChatContext()
</script>

<style scoped>
.time-divider { text-align:center; padding:16px 0 8px; font-size:12px; color:var(--text-secondary); user-select:none; }
.message { display:flex; margin:3px 0; align-items:flex-start; gap:8px; }
.message.user { flex-direction:row-reverse; }
.message.assistant { flex-direction:row; }

.msg-avatar {
  position: relative;
  width:42px; height:42px; border-radius:50%; flex-shrink:0;
  display:flex; align-items:center; justify-content:center;
  transition: opacity 0.15s;
}
.avatar-img {
  width:100%; height:100%; object-fit:cover;
  border-radius:inherit; display:block;
}
.msg-avatar.clickable {
  cursor: pointer;
}
.msg-avatar.clickable:hover {
  opacity: 0.85;
  box-shadow: 0 0 0 2px rgba(255,255,255,0.4);
}
.msg-same-role .msg-avatar { opacity: 0; pointer-events: none; }
.msg-avatar > .avatar-fallback {
  width: 100%; height: 100%;
  border-radius: inherit;
  background: var(--accent);
  font-size: 14px;
}
.sleep-zzz {
  position: absolute; top: -11px; right: -12px;
  width: 27px; height: 27px;
  pointer-events: none;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
}
.sleep-zzz svg { display: block; overflow: visible; }
.sleep-zzz path {
  opacity: 0;
  transform-box: fill-box; transform-origin: center;
  animation: zzz-pop 2.4s ease-in-out infinite;
}
.sleep-zzz .zzz-1 { animation-delay: 0s; }
.sleep-zzz .zzz-2 { animation-delay: 0.8s; }
.sleep-zzz .zzz-3 { animation-delay: 1.6s; }
@keyframes zzz-pop {
  0% { opacity: 0; transform: translate(0, 2px) scale(0.5); }
  25% { opacity: 1; transform: translate(0, 0) scale(1); }
  55% { opacity: 1; transform: translate(0, -2px) scale(1); }
  100% { opacity: 0; transform: translate(0, -5px) scale(1); }
}

.msg-bubble {
  max-width:75%; padding:10px 14px; border-radius:8px;
  font-size:14px; line-height:1.6; word-break:break-word;
}
.msg-bubble.has-speech {
  max-width:min(75%, calc(100% - 102px));
  margin-right:52px;
}
.message.user .msg-bubble {
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  color:#fff; border:none;
  border-radius: 14px 4px 14px 14px;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.16), var(--shadow-glow);
}
.message.assistant .msg-bubble {
  background:var(--bg-secondary); color:var(--text-primary);
  border-radius: 4px 14px 14px 14px;
  box-shadow: var(--shadow-hard-sm);
}
.msg-placeholder-bubble {
  display: inline-flex; align-items: center; gap: 8px;
  animation: placeholder-breathe 1.6s ease-in-out infinite;
}
.msg-placeholder-text { color: var(--text-secondary); font-style: italic; }
.msg-placeholder-dots { opacity: 0.85; }
@keyframes placeholder-breathe { 0%, 100% { opacity: 0.55 } 50% { opacity: 0.85 } }

.typing-dots { overflow: visible; flex-shrink: 0; }
.typing-dots .dot {
  fill: #fff; animation: dotBlink 1.2s ease-in-out infinite;
}
.typing-dots .dot-0 { animation-delay: 0.00s; }
.typing-dots .dot-1 { animation-delay: 0.10s; }
.typing-dots .dot-2 { animation-delay: 0.20s; }
.typing-dots .dot-3 { animation-delay: 0.30s; }
.typing-dots .dot-4 { animation-delay: 0.40s; }
.typing-dots .dot-5 { animation-delay: 0.50s; }

@keyframes dotBlink {
  0%, 20%, 100% { fill: #fff; }
  40%, 60% { fill: #aaa; }
}

.msg-text { font-size:14px; line-height:1.6; }
.msg-sticker-bubble {
  height:140px; width:auto; padding:0; border-radius:8px; overflow:hidden; flex-shrink:0;
  background:var(--glass-bg); border:none; box-sizing:border-box;
}
.message.user .msg-sticker-bubble, .message.assistant .msg-sticker-bubble {
  background:var(--glass-bg); border:none;
}
.msg-sticker-bubble .msg-sticker-img { height:140px; width:auto; object-fit:contain; border-radius:8px; background:transparent; padding:0; display:block; }
.msg-text :deep(code) { background:rgba(0,0,0,0.2); padding:2px 6px; border-radius:4px; font-size:13px; }
.msg-text :deep(strong) { font-weight:600; }

.avatar-preview.clickable { cursor:pointer; transition: opacity 0.15s; }
.avatar-preview.clickable:hover { opacity:0.85; }
.detail-avatar.clickable { cursor: pointer; transition: opacity 0.15s; }
.detail-avatar.clickable:hover { opacity: 0.85; }
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
</style>
