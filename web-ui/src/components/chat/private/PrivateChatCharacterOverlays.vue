<template>
<Transition name="panel-slide">
      <div v-if="showSettings" class="settings-overlay" @click.self="closeSettings">
        <div class="settings-panel">
        <div class="sph">
          <span>关于{{ chat.activeChar?.display_name }}</span>
        </div>

        <!-- 头像设置 -->
        <div class="sp-section">
          <label class="sp-label">头像</label>
          <div class="avatar-row">
            <div
              class="avatar-preview clickable"
              :style="chat.activeChar?.avatar_path ? {} : { background: 'var(--accent)' }"
              @click="openAvatarPicker"
            >
              <img v-if="chat.activeChar?.avatar_path" :src="chat.activeChar.avatar_path" class="avatar-img" alt="" />
              <span v-else>{{ chat.activeChar?.display_name?.charAt(0) }}</span>
            </div>
            <div>
              <div role="button" tabindex="0" class="sp-btn-small" @click="openAvatarPicker" @keydown.enter.prevent="openAvatarPicker" @keydown.space.prevent="openAvatarPicker">更换头像</div>
              <div v-if="chat.activeChar?.avatar_path" role="button" tabindex="0" class="sp-btn-small sp-btn-subtle" @click="removeAvatar" @keydown.enter.prevent="removeAvatar" @keydown.space.prevent="removeAvatar">移除</div>
            </div>
          </div>
        </div>

        <!-- 聊天背景设置 -->
        <div class="sp-section">
          <label class="sp-label">聊天背景</label>
          <ChatBgPanel :character="chat.activeChar" @updated="onChatBgUpdated" />
        </div>

        <div class="sp-divider"></div>

        <div role="button" tabindex="0" class="sp-btn standing-entry-mobile" @click="openStandingDisplayPage" @keydown.enter.prevent="openStandingDisplayPage" @keydown.space.prevent="openStandingDisplayPage">
          <svg class="sp-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="15" rx="3" /><path d="M8 22h8M12 18v4" /><circle cx="12" cy="8" r="2" /><path d="M8 15a4 4 0 0 1 8 0" /></svg>
          同步形象展示
        </div>

        <!-- 编辑人格 → 二级弹窗 -->
        <div role="button" tabindex="0" class="sp-btn" :class="{ 'is-disabled': editorLoading }" :aria-disabled="editorLoading" @click="openCharEditor" @keydown.enter.prevent="openCharEditor" @keydown.space.prevent="openCharEditor">
          <svg class="sp-btn-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M892.691692 30.72l77.981539 77.981538a73.491692 73.491692 0 0 1 0 103.975385l-584.861539 584.861539-228.036923 46.08 46.08-228.036924L788.716308 30.72a73.491692 73.491692 0 0 1 103.975384 0z m25.993846 129.969231l-77.981538-77.981539-569.186462 569.186462-19.692307 97.673846 97.673846-19.692308 569.186461-569.186461z" fill="currentColor" /><path d="M652.366769 167.699692l180.854154 182.035693 55.689846-55.689847-180.854154-182.114461zM73.491692 953.344h888.595693v-78.769231H73.570462z" fill="currentColor" /></svg>
          {{ editorLoading ? '读取角色资料...' : '查看详细信息' }}
        </div>

        <!-- 亲密信息看板直达：原先要「查看详细信息」→ 详情卡里再点一次，这里一步打开同一个看板 -->
        <div role="button" tabindex="0" class="sp-btn" @click="openIntimatePanel" @keydown.enter.prevent="openIntimatePanel" @keydown.space.prevent="openIntimatePanel">
          <svg class="sp-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
          亲密信息
        </div>

        <!-- 催眠手机直达：不用专程去背包，聊天页一步打开同一个状态面板 -->
        <div role="button" tabindex="0" class="sp-btn" @click="openHypnosisPanel" @keydown.enter.prevent="openHypnosisPanel" @keydown.space.prevent="openHypnosisPanel">
          <svg class="sp-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="2.5" /><path d="M9.5 2.5v2h5v-2" /><path d="M10 18.5h4" /></svg>
          催眠手机
        </div>

        <!-- 查看角色对用户的印象 -->
        <div role="button" tabindex="0" class="sp-btn" @click="openImpression" @keydown.enter.prevent="openImpression" @keydown.space.prevent="openImpression">
          <svg class="sp-btn-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M607.839811 895.957102H214.69447A86.82497 86.82497 0 0 1 127.880338 809.070721V214.784781A86.839419 86.839419 0 0 1 214.69447 127.880338h594.28594a86.33729 86.33729 0 0 1 61.436749 25.456857c16.400473 16.400473 25.362934 38.208767 25.373771 61.411462L894.439878 607.821749v0.10476a32.031496 32.031496 0 0 0 64.059379 0.101149L959.825022 214.889542v-0.104761A150.775976 150.775976 0 0 0 808.98041 63.940169H214.69447A150.638703 150.638703 0 0 0 63.940169 214.784781v594.28594a150.638703 150.638703 0 0 0 150.757914 150.82655h393.141728a31.970084 31.970084 0 0 0 0-63.940169z" fill="currentColor" /><path d="M950.544667 905.331381l-122.071536-122.071536a192.217875 192.217875 0 1 0-45.213286 45.213286l122.071536 122.071536a31.970084 31.970084 0 0 1 45.213286-45.213286z m-278.547941-105.302594a128.028448 128.028448 0 1 1 90.531332-37.497116 127.193975 127.193975 0 0 1-90.527719 37.497116zM768.004516 352.212795c17.653989 0 31.966472-14.402794 31.970084-32.056783s-14.308871-32.074845-31.966472-32.078457L256.002709 287.911382a32.020659 32.020659 0 0 0-31.970084 32.024271c0 17.657601 14.308871 32.092907 31.966472 32.092908L768.004516 352.212795zM448.000226 544.033302a31.96286 31.96286 0 1 0 0-63.940169h-192.001129a31.937573 31.937573 0 1 0 0 63.878758l192.001129 0.061411zM256.017159 671.91364a31.959247 31.959247 0 1 0 0 63.922107l127.999549 0.018062a31.941185 31.941185 0 1 0 0-63.878757z" fill="currentColor" /></svg>
          对你的印象
        </div>

        <div class="sp-divider sp-divider-strong"></div>

        <!-- 清空聊天记录 -->
        <div role="button" tabindex="0" class="sp-btn sp-btn-danger" :class="{ 'is-disabled': clearing }" :aria-disabled="clearing" @click="!clearing && clearChatHistory()" @keydown.enter.prevent="!clearing && clearChatHistory()" @keydown.space.prevent="!clearing && clearChatHistory()">
          <svg class="sp-btn-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M687.6 96.4H336.4v91.2h351.1V96.4zM636.7 398v405.5h-73.9V398h73.9z m-175.5 0v405.5h-73.9V398h73.9z m332.1-119.2H230.7l27.9 648.8h506.7l28-648.8zM696.8 5.1c40.4 0 73.3 35.6 73.9 79.8v102.7h147.8c20.2 0 36.6 17.8 37 39.9v41.2c0 5.5-4 10-9 10.1h-70.1L848 941.6c-1.8 42.9-33.7 76.6-72.6 77.3H249.8c-39 0-71.3-33.4-73.7-76l-0.1-1.3-28.5-662.7H77.7c-5 0-9.1-4.4-9.2-9.8v-40.9c0-22.2 16.2-40.2 36.3-40.5h148.4V86.2c0-44.3 32.5-80.4 72.7-81.1h370.9z" fill="currentColor" /></svg>
          {{ clearing ? '清空中...' : '清空记忆' }}
        </div>

        <!-- 撤回一轮对话 -->
        <div role="button" tabindex="0" class="sp-btn sp-btn-danger" :class="{ 'is-disabled': !chat.messages.length || chat.streaming }" :aria-disabled="!chat.messages.length || chat.streaming" @click="onUndoRound" @keydown.enter.prevent="onUndoRound" @keydown.space.prevent="onUndoRound">
          <svg class="sp-btn-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M320 192h512v64H320zM320 448h512v64H320zM320 704h384v64H320zM160 256a32 32 0 1 0 0-64 32 32 0 0 0 0 64zM160 512a32 32 0 1 0 0-64 32 32 0 0 0 0 64zM160 768a32 32 0 1 0 0-64 32 32 0 0 0 0 64z" fill="currentColor" /></svg>
          撤回一轮对话
        </div>

        <div class="sp-divider"></div>

        <!-- 删除角色（2026-11-08：默认助手也允许删除，删掉后种子数据不会再把它建回来） -->
        <div
role="button" tabindex="0" class="sp-btn sp-btn-danger" :class="{ 'is-disabled': deleting }" :aria-disabled="deleting"
          :title="chat.activeChar?.name === 'default' ? '默认助手是个生图助手，没有用的话可以删掉' : ''" @click="deleteChar" @keydown.enter.prevent="deleteChar" @keydown.space.prevent="deleteChar"
>
          <svg class="sp-btn-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M512 179.2l390.4 627.2H128l384-627.2m0-64c-19.2 0-44.8 12.8-51.2 32l-390.4 627.2c-25.6 44.8 6.4 96 51.2 96H896c51.2 0 83.2-57.6 51.2-96l-384-627.2c-6.4-19.2-32-32-51.2-32z" fill="currentColor" /><path d="M512 640c-19.2 0-32-12.8-32-32v-192c0-19.2 12.8-32 32-32s32 12.8 32 32v192c0 19.2-12.8 32-32 32z" fill="currentColor" /><path d="M512 723.2m-32 0a32 32 0 1 0 64 0 32 32 0 1 0-64 0Z" fill="currentColor" /></svg>
          {{ deleting ? '删除中...' : '删除' + chat.activeChar?.display_name }}
        </div>
      </div>
    </div>
    </Transition>

<CharacterDetailModal
      ref="detailModalRef"
      :visible="showEditor"
      :character="editorCharacter"
      @close="closeCharEditor"
      @saved="onCharSaved"
      @deleted="onCharDeleted"
      @lora-saved="onCharSaved"
      @open-avatar-editor="onOpenAvatarEditor"
      @remove-avatar="removeAvatar"
      @open-relation-graph="onOpenRelationGraph"
    />

<RelationshipGraph
      v-if="chat.activeChar"
      :visible="showRelationGraph"
      :center-character="chat.activeChar"
      :all-characters="chat.characters"
      @close="showRelationGraph = false"
    />

<linshe-modal v-model="showIntimate" :title="`亲密信息 — ${chat.activeChar?.display_name || ''}`" full>
      <IntimatePanel v-if="chat.activeChar" :character="chat.activeChar" />
      <template #footer>
        <linshe-button variant="secondary" @click="showIntimate = false">关闭</linshe-button>
      </template>
    </linshe-modal>

<linshe-modal v-model="showHypnosis" :title="`催眠手机 — ${chat.activeChar?.display_name || ''}`" full>
      <HypnosisPhonePanel v-if="chat.activeChar && showHypnosis" :character="chat.activeChar" />
      <template #footer>
        <linshe-button variant="secondary" @click="showHypnosis = false">关闭</linshe-button>
      </template>
    </linshe-modal>
</template>

<script setup>
import LinsheModal from '../../ui/LinsheModal.vue'
import ChatBgPanel from '../../ChatBgPanel.vue'
import RelationshipGraph from '../../RelationshipGraph.vue'
import CharacterDetailModal from '../../CharacterDetailModal.vue'
import LinsheButton from '../../ui/LinsheButton.vue'
import IntimatePanel from '../../character/IntimatePanel.vue'
import HypnosisPhonePanel from '../../HypnosisPhonePanel.vue'
import { usePrivateChatContext } from '../../../composables/chat/privateChatContext.js'
const { showSettings, closeSettings, chat, openAvatarPicker, removeAvatar, onChatBgUpdated, openStandingDisplayPage, editorLoading, openCharEditor, openIntimatePanel, openHypnosisPanel, openImpression, clearing, clearChatHistory, onUndoRound, deleting, deleteChar, showEditor, editorCharacter, closeCharEditor, onCharSaved, onCharDeleted, onOpenAvatarEditor, onOpenRelationGraph, showRelationGraph, showIntimate, showHypnosis, detailModalRef } = usePrivateChatContext()
</script>

<style scoped>
.sp-btn.standing-entry-mobile { display:none; }
@media (max-width:767px) {
  .sp-btn.standing-entry-mobile { display:flex; }
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
.settings-overlay { position:fixed; inset:0; background:transparent; display:flex; align-items:flex-start; justify-content:flex-end; z-index:1000; padding:60px 24px 0 0; }
.settings-panel {
  width:280px;
  background: var(--bg-secondary);
  border-radius:16px;
  border:1px solid var(--glass-border);
  box-shadow: 0 8px 32px rgba(0,0,0,0.14);
  overflow:hidden;
}
.sph { padding:14px 16px; border-bottom:1px solid var(--glass-border); display:flex; align-items:center; justify-content:space-between; }
.sph span { font-size:14px; font-weight:600; color:var(--text-bright); }

.sp-section { padding:14px 16px; }
.sp-label { font-size:12px; color:var(--text-secondary); display:block; margin-bottom:10px; }
.avatar-row { display:flex; align-items:center; gap:14px; }
.avatar-preview { width:48px; height:48px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:20px; font-weight:700; flex-shrink:0; }

.sp-divider { height:1px; background:var(--glass-border); margin:0 16px; }
.sp-divider-strong { height:2px; background:var(--border); margin:6px 16px; }
.sp-btn { display:block; width:100%; text-align:left; padding:12px 16px; border:none; border-radius:0; background:transparent; color:var(--text-primary); font-size:13px; font-weight:500; cursor:pointer; transition:background 0.15s ease; user-select:none; }
.sp-btn:hover { background:var(--tint-subtle); }
.sp-btn.is-disabled { opacity:0.4; cursor:not-allowed; }
.sp-btn-danger { color:var(--danger); }
.sp-btn-danger:hover:not(.is-disabled) { background:rgba(255, 77, 79, 0.06); }
.sp-btn-icon { width:16px; height:16px; vertical-align:middle; margin-right:6px; display:inline-block; }

.avatar-preview.clickable { cursor:pointer; transition: opacity 0.15s; }
.avatar-preview.clickable:hover { opacity:0.85; }
.sp-btn-small { padding:6px 14px; font-size:12px; font-weight:500; border-radius:8px; border:1px solid var(--glass-border); background:var(--glass-bg-strong); color:var(--text-primary); cursor:pointer; margin-right:6px; transition: all 0.15s; text-align:center; user-select:none; }
.sp-btn-small:hover { border-color:var(--accent); }
.sp-btn-subtle { color:var(--text-secondary); border-color:transparent; background:transparent; }
.sp-btn-subtle:hover { color:var(--danger); border-color:transparent; }
.detail-avatar.clickable { cursor: pointer; transition: opacity 0.15s; }
.detail-avatar.clickable:hover { opacity: 0.85; }
.impression-btn.is-disabled { opacity: 0.5; cursor: not-allowed; }
</style>
