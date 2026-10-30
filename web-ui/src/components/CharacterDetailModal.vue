<template>
  <Teleport to="body">
    <ExpressionStandingManager :open="visible && showExpressionStandings" :character="character" @close="showExpressionStandings = false" />
    <!-- ── 角色详情弹窗 ── -->
    <Transition name="modal-fade">
      <div v-if="visible && !showLoraModal && !showOutfitModal && !showRefineModal && !showIntimateModal && !showExpressionStandings && !showClothingLibrary" class="modal-overlay" :class="{ 'detail-inline': inlineLayout }" @mousedown="onOverlayMouseDown" @click.self="onOverlayClick">
        <div class="modal-panel modal-wide detail-panel">
          <div class="modal-header">
            <h3>{{ character?.display_name }}</h3>
            <linshe-button variant="icon" class="modal-close" aria-label="关闭" @click="$emit('close')">✕</linshe-button>
          </div>

          <div class="modal-body modal-body-detail">
            <!-- 头像 -->
            <div class="detail-avatar-row">
              <div class="detail-avatar clickable" @click="$emit('open-avatar-editor', character)">
                <img v-if="character?.avatar_path" :src="character.avatar_path" class="detail-avatar-img" alt="" />
                <span v-else>{{ character?.display_name?.charAt(0) }}</span>
              </div>
              <div>
                <linshe-button size="sm" class="sp-btn-small" @click="$emit('open-avatar-editor', character)">更换头像</linshe-button>
                <linshe-button v-if="character?.avatar_path" variant="ghost" size="sm" class="sp-btn-small" @click="$emit('remove-avatar', character)">移除</linshe-button>
              </div>
              <div v-if="character?.is_oath" class="detail-avatar-oath">
                <span class="oath-badge" @click="removeOath">
                  <span class="oath-badge-default">💍 已誓约</span>
                  <span class="oath-badge-hover">解除誓约</span>
                </span>
              </div>
            </div>

            <div class="preview-card">
              <!-- 角色关系 -->
              <div class="detail-rel-section">
                <div class="detail-rel-header">
                  <span class="detail-rel-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="12" cy="17" r="3" />
                      <line x1="9" y1="6" x2="11" y2="14" /><line x1="15" y1="6" x2="13" y2="14" />
                    </svg>
                    角色关系网
                  </span>
                  <div class="detail-rel-btns">
                    <linshe-button
                      v-if="detail.relationships.length > 0"
                      variant="secondary"
                      class="detail-rel-btn"
                      @click="$emit('open-deduction', character)"
                    >
推演关系
</linshe-button>
                    <linshe-button
                      v-if="detail.relationships.length > 0"
                      variant="secondary"
                      class="detail-rel-btn"
                      @click="$emit('open-relation-graph', character)"
                    >
管理关系图 &rarr;
</linshe-button>
                  </div>
                </div>
                <div v-if="detail.relationships.length > 0" class="detail-rel-list">
                  <div v-for="rel in detail.relationships.slice(0, 5)" :key="rel.id" class="detail-rel-item">
                    <span class="rel-from">{{ character?.display_name }}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
                    <span class="rel-to">{{ rel.to_display_name }}</span>
                    <span class="rel-text">{{ rel.relationship_text }}</span>
                  </div>
                  <div v-if="detail.relationships.length > 5" class="detail-rel-more" @click="$emit('open-relation-graph', character)">
                    共 {{ detail.relationships.length }} 条关系，查看全部 &rarr;
                  </div>
                </div>
                <div v-else class="detail-rel-empty">
                  <template v-if="detail.relationshipsLoading">
                    <span class="rel-empty-spinner"></span> 加载中…
                  </template>
                  <template v-else>
                    <p class="rel-empty-desc">定义角色之间的关联，所有动作中都会自动感知这些关系</p>
                    <div class="detail-rel-ctas">
                      <linshe-button variant="primary" class="detail-rel-btn" @click="$emit('open-deduction', character)">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        推演关系
                      </linshe-button>
                      <linshe-button variant="primary" class="detail-rel-btn" @click="$emit('open-relation-graph', character)">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="12" cy="17" r="3" />
                          <line x1="9" y1="6" x2="11" y2="14" /><line x1="15" y1="6" x2="13" y2="14" />
                        </svg>
                        手动设置关系
                      </linshe-button>
                    </div>
                  </template>
                </div>
              </div>

              <div class="detail-name-row">
                <div class="detail-name-col">
                  <label class="fl">角色名</label>
                  <linshe-input v-model="detail.editName" class="fi" @input="detail.dirty = true" />
                </div>
                <div class="detail-name-col">
                  <label class="fl">英文名</label>
                  <linshe-input v-model="detail.editCharName" class="fi" @input="detail.dirty = true" placeholder="英文/拼音，唯一标识" />
                </div>
              </div>
              <div class="persona-accordion">
                <section v-for="section in editorSections" :key="section.key" class="persona-section" :class="{ 'is-open': editorSection === section.key }">
                  <h4 class="persona-section-heading">
                    <div
                      :id="`character-editor-${section.key}-toggle`"
                      class="persona-section-trigger" role="button" tabindex="0"
                      :aria-expanded="editorSection === section.key"
                      :aria-controls="`character-editor-${section.key}`"
                      @click="selectEditorSection(section.key)"
                      @keydown.enter.prevent="selectEditorSection(section.key)"
                      @keydown.space.prevent="selectEditorSection(section.key)"
                    >
                      <span class="persona-section-emblem" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <template v-if="section.key === 'persona'"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></template>
                        <template v-else><path d="m8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0Z" /></template>
                      </svg></span>
                      <span class="persona-section-title">{{ section.label }}<span class="persona-section-subtitle">{{ section.key === 'persona' ? '身份 · 性格 · 经历' : '默认 · 私服 · 居家 · 睡衣' }}</span></span>
                      <svg class="persona-section-chevron" :class="{ open: editorSection === section.key }" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                    </div>
                  </h4>
                  <div
                    class="persona-collapse" :class="{ 'is-expanded': editorSection === section.key }"
                    :inert="editorSection !== section.key" :aria-hidden="editorSection !== section.key"
                  >
                    <div :id="`character-editor-${section.key}`" class="persona-section-body" role="region" :aria-labelledby="`character-editor-${section.key}-toggle`">
                      <div class="persona-section-content">
                      <template v-if="section.key === 'persona'">
                        <p class="split-hint">设置角色的身份、性格与经历。外观在「外观服装」中单独编辑。</p>
                        <linshe-input v-model="detail.editPersona" type="textarea" class="prompt-textarea" aria-label="人设提示词" @input="detail.dirty = true" />
                      </template>
                      <div v-else class="scene-block">
                        <div class="scene-block-head">
                          <p class="split-hint">默认造型作为常态外观，其余服装随日程切换。</p>
                          <linshe-button
                            v-if="detail.sceneOutfits.length || detail.sceneOutfitsError"
                            variant="secondary" size="sm"
                            :disabled="outfitGenerating || outfitBatchRunning || standingBusy || !workOutfitText"
                            :loading="outfitGenerating"
                            :title="workOutfitText ? '以默认外观为基准，一次生成其余三套并自动保存' : '先填写默认外观，才能生成其余服装'"
                            @click="generateOtherSceneOutfits"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16 11-11a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4ZM13 7l3 3M19 13v6m-3-3h6M6 2v6M3 5h6" /></svg>
                            一键生成整套系列
                          </linshe-button>
                        </div>
                        <linshe-tabs v-if="detail.sceneOutfits.length" v-model="detail.sceneTab" :options="sceneTabOptions" size="sm" aria-label="外观服装分类" />
                        <Transition name="persona-fold" mode="out-in">
                          <div v-if="activeSceneOutfit" :key="activeSceneOutfit.scene" class="scene-edit">
                            <p class="split-hint">{{ activeSceneOutfit.scene === 'sleep' ? '睡眠时段优先使用睡衣；未配置时沿用其他有效服装。' : activeSceneOutfit.scene === 'work' ? '保留角色的常态形象，作为其他服装的生成基准。' : '只调整这套服装，保留角色的身体特征。' }}</p>
                            <linshe-button variant="secondary" size="sm" class="clothing-library-trigger" :disabled="outfitBatchRunning || outfitGenerating" @click="openClothingLibrary">衣服库 · 选 tag 搭配</linshe-button>
                            <linshe-input
                              v-model="activeSceneOutfit.description" type="textarea" rows="10" :disabled="outfitBatchRunning"
                              :aria-label="`${activeSceneOutfit.scene === 'work' ? '默认' : activeSceneOutfit.sceneLabel}外观描述`"
                              :placeholder="activeSceneOutfit.scene === 'work' ? '常态外观描述（中英混合），生图时作为基础外观' : '这套服装的外观描述（中英混合）'"
                              @input="detail.dirty = true"
                            />
                          </div>
                          <div v-else-if="detail.sceneOutfitsError" class="scene-edit-empty is-error">
                            <p>外观加载失败：{{ detail.sceneOutfitsError }}</p>
                            <linshe-button variant="secondary" size="sm" :loading="detail.sceneOutfitsLoading" @click="retryLoadSceneOutfits">重试</linshe-button>
                          </div>
                          <div v-else class="scene-edit-empty">加载中…</div>
                        </Transition>
                      </div>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>

            <!-- SLG 动作系统 · 阶段三：触摸互动统计小节 -->
            <TouchStatsPanel :character="character" />

            <!-- 移动端「更多设置」：桌面端是右侧悬浮面板，手机端收进正文末尾，保持内容优先 -->
            <div class="mobile-detail-toolbar" v-if="inlineLayout">
              <div class="toolbar-title">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
                </svg>
                更多设置
              </div>
              <div class="toolbar-item toolbar-item-toggle">
                <span>不看ta的朋友圈</span>
                <linshe-switch v-model="detail.momentsDisabled" size="sm" :disabled="detail.momentsToggling" @change="toggleMomentsDisabled" aria-label="不看ta的朋友圈" />
              </div>
              <div class="toolbar-item toolbar-item-toggle">
                <span>不主动聊天</span>
                <linshe-switch v-model="detail.proactiveDisabled" size="sm" :disabled="detail.proactiveToggling" @change="toggleProactiveDisabled" aria-label="不主动聊天" />
              </div>
              <div class="toolbar-item toolbar-item-toggle">
                <span>不发生奇遇</span>
                <linshe-switch v-model="detail.eventsDisabled" size="sm" :disabled="detail.eventsToggling" @change="toggleEventsDisabled" aria-label="不发生奇遇" />
              </div>
              <div class="toolbar-item toolbar-item-btn" role="button" tabindex="0" @click="openLoraModal" @keydown.enter.prevent="openLoraModal" @keydown.space.prevent="openLoraModal">
                <span>设置 Lora</span>
                <span v-if="hasLoraSetup" class="toolbar-badge active">已配置</span>
                <span v-else class="toolbar-badge">未配置</span>
              </div>
              <!-- 外观 / 形态（专属形态 + 场景服装五态）入口 -->
              <div class="toolbar-item toolbar-item-btn" @click="openOutfitModal">
                <span>外观 / 形态</span>
                <span v-if="activeOutfitName" class="toolbar-badge active">{{ activeOutfitName }}</span>
                <span v-else class="toolbar-badge">未启用</span>
              </div>
              <div class="toolbar-item toolbar-item-btn" role="button" tabindex="0" @click="openIntimateModal" @keydown.enter.prevent="openIntimateModal" @keydown.space.prevent="openIntimateModal">
                <span>亲密信息</span>
                <span class="toolbar-badge">看板</span>
              </div>
            </div>

            <!-- 角色立绘（手机端）：桌面端是左侧悬浮窗，手机端收在正文末尾 -->
            <CharacterStandingPanel v-if="inlineLayout" inline :character="character" :ctl="standingPanel" />
          </div>

          <!-- 操作栏 sticky footer -->
          <div class="modal-footer">
            <div class="detail-actions">
              <linshe-button variant="danger" @click="deleteChar">&#x1F5D1; 删除角色</linshe-button>
              <linshe-button variant="secondary" @click="openRefineModal">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16 11-11a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /><path d="m13 7 3 3M19 13v6m-3-3h6M6 2v6M3 5h6" /></svg>
                修正外观
              </linshe-button>
              <linshe-button variant="secondary" @click="showExpressionStandings = true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="12" cy="9" r="3" /><path d="M6 21v-2a6 6 0 0 1 12 0v2" /></svg>
                立绘管理
              </linshe-button>
              <div class="recruit-appearance-hint">
                外观描述补充tag查阅
                <a :href="`https://animadex.net/?mode=characters&q=${encodeURIComponent(character?.name).replaceAll('_', '+')}`" target="_blank">animadex：{{ character?.name }}</a>
              </div>
              <linshe-button variant="primary" :disabled="!detail.dirty" @click="saveCharDetail">保存</linshe-button>
            </div>
          </div>
        </div>

        <!-- 悬浮侧边栏（桌面端）：功能整合为一张卡片 -->
        <div class="detail-float" v-if="!inlineLayout">
          <div class="float-panel">
            <div class="float-panel-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
              </svg>
              更多设置
            </div>
            <div class="float-panel-body">
              <div class="float-row">
                <span class="float-label">不看ta的朋友圈</span>
                <linshe-switch v-model="detail.momentsDisabled" :disabled="detail.momentsToggling" @change="toggleMomentsDisabled" aria-label="不看ta的朋友圈" />
              </div>
              <div class="float-row">
                <span class="float-label">不主动聊天</span>
                <linshe-switch v-model="detail.proactiveDisabled" :disabled="detail.proactiveToggling" @change="toggleProactiveDisabled" aria-label="不主动聊天" />
              </div>
              <div class="float-row">
                <span class="float-label">不发生奇遇</span>
                <linshe-switch v-model="detail.eventsDisabled" :disabled="detail.eventsToggling" @change="toggleEventsDisabled" aria-label="不发生奇遇" />
              </div>
              <div class="float-row float-row-action" role="button" tabindex="0" @click="openLoraModal" @keydown.enter.prevent="openLoraModal" @keydown.space.prevent="openLoraModal">
                <span class="float-label">设置 Lora</span>
                <span v-if="hasLoraSetup" class="float-badge active">已配置</span>
                <span v-else class="float-badge">未配置</span>
              </div>
              <div class="float-row float-row-action" @click="openOutfitModal">
                <span class="float-label">外观 / 形态</span>
                <span v-if="activeOutfitName" class="float-badge active float-badge-name">{{ activeOutfitName }}</span>
                <span v-else class="float-badge">未启用</span>
              </div>
              <div class="float-row float-row-action" role="button" tabindex="0" @click="openIntimateModal" @keydown.enter.prevent="openIntimateModal" @keydown.space.prevent="openIntimateModal">
                <span class="float-label">亲密信息</span>
                <span class="float-badge">看板</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 角色立绘（桌面端）：主面板左侧的悬浮窗；手机端改为正文末尾的内联卡（见 modal-body-detail 末尾） -->
        <CharacterStandingPanel v-if="!inlineLayout" :character="character" :ctl="standingPanel" />

        <!-- ── 立绘大图查看（重新生成 / HiresFix 放大 / 下载；不放删除，面板里有）── 放在 overlay 内以复用其 10000 层级，盖过主面板 ── -->
        <ImageLightbox
          :visible="standingLightboxVisible"
          :imgs="standingDisplayUrl"
          :show-delete="false"
          @hide="standingLightboxVisible = false"
        />
      </div>
    </Transition>

    <!-- ── Lora 设置弹窗 ── -->
    <Transition name="modal-fade">
      <div v-if="showLoraModal" class="modal-overlay" @click.self="closeLoraModal">
        <div class="modal-panel modal-wide">
          <div class="modal-header">
            <h3>LoRA 设置 — {{ character?.display_name }}</h3>
            <linshe-button variant="icon" class="modal-close" @click="closeLoraModal">✕</linshe-button>
          </div>
          <div class="modal-body">
            <div class="lora-body-card">
              <!-- ── Lora 列表 ── -->
              <TransitionGroup name="lora-card" tag="div" class="lora-list">
                <div v-for="(item, idx) in loraItems" :key="idx" class="lora-item-card">
                  <linshe-button variant="icon" size="sm" class="lora-remove-btn" @click="removeLoraGroup(idx)" title="移除">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                  </linshe-button>
                  <div class="lora-item-row">
                    <div class="form-group lora-path-group">
                      <label class="fl lora-inline-label">文件路径</label>
                      <div class="lora-autocomplete-wrap">
                        <linshe-input
                          v-model="item.path"
                          class="fi"
                          placeholder="在ComfyUI-aki-v3(或其他名称)\ComfyUI\models\loras下搜索..."
                          @focus="onLoraInputFocus(idx)"
                          @input="onLoraInput(idx)"
                          @keydown="onLoraKeydown($event, idx)"
                          @blur="onLoraInputBlur"
                        />
                        <ul v-if="activeLoraFileIdx === idx && loraSuggestions.length > 0" class="lora-dropdown">
                          <li
                            v-for="(file, di) in loraSuggestions"
                            :key="file.path"
                            :class="['lora-dropdown-item', { active: di === loraDropdownIdx }]"
                            @mousedown.prevent="selectLoraFile(idx, file)"
                          >
                            <span>{{ loraDisplayName(file) }}</span>
                          </li>
                        </ul>
                        <div v-else-if="activeLoraFileIdx === idx && lorasFiles.length === 0 && !loraFetching" class="lora-dropdown" style="padding:16px;text-align:center;font-size:13px;color:var(--text-secondary)">
                          请先在启动器中配置 ComfyUI 路径
                        </div>
                        <div v-else-if="activeLoraFileIdx === idx && loraFetching" class="lora-dropdown" style="padding:16px;text-align:center;font-size:13px;color:var(--text-secondary)">
                          加载中...
                        </div>
                      </div>
                    </div>
                    <div class="form-group lora-weight-group">
                      <label class="fl lora-inline-label">权重</label>
                      <linshe-input
                        v-model.number="item.weight"
                        type="number"
                        step="0.05"
                        min="0"
                        max="5"
                        class="fi lora-weight-input"
                      />
                    </div>
                  </div>
                  <div class="lora-trigger-row">
                    <label class="fl lora-inline-label">触发词</label>
                    <linshe-input
                      v-model="item.triggerWord"
                      type="textarea"
                      class="fi"
                      rows="3"
                      placeholder="可选，用于增强 lora 效果的提示词"
                    />
                  </div>
                </div>
              </TransitionGroup>

              <!-- ── 空状态 ── -->
              <div v-if="loraItems.length === 0" class="lora-empty-hint">
                尚未配置任何 LoRA，点击下方按钮添加<a href="https://www.bilibili.com/video/BV1wsNu61EX6?t=204.1" target="_blank" rel="noopener noreferrer" class="lora-tutorial-link">添加LoRA教程</a>
              </div>

              <!-- ── 添加 Lora 按钮 ── -->
              <div class="lora-add-btn" role="button" tabindex="0" @click="addLoraGroup" @keydown.enter.prevent="addLoraGroup" @keydown.space.prevent="addLoraGroup">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                添加 LoRA
              </div>

              <div class="lora-separator"></div>

              <!-- ── 自定义工作流 ── -->
              <div class="form-group">
              <label class="lora-check-label" @click.stop>
                <span class="lora-checkbox-wrap">
                  <input type="checkbox" v-model="customWorkflowEnabled" class="lora-checkbox" />
                  <span class="lora-checkmark">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  </span>
                </span>
                <span class="lora-check-text">启用自定义工作流</span>
              </label>
                <Transition name="lora-expand">
                  <div v-if="customWorkflowEnabled" class="lora-workflow-select">
                    <linshe-select v-model="editingCustomWorkflow" :options="customWorkflowOptions" placeholder="请选择自定义工作流（放在workflows文件夹下）" />
                    <p class="form-hint">单人图片才会启用自定工作流，可以给某个角色单独设置完全自由的工作流，同样会默认注入长、宽、画师串、画面描述、lora（如果设置了），不需要的节点可以去掉。</p>
                  </div>
                </Transition>
              </div>

              <!-- ── 单独画师串 ── -->
              <div class="form-group">
                <label class="lora-check-label" @click.stop>
                  <span class="lora-checkbox-wrap">
                    <input type="checkbox" v-model="artistOverrideEnabled" class="lora-checkbox" />
                    <span class="lora-checkmark">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    </span>
                  </span>
                  <span class="lora-check-text">单独设置画师串</span>
                </label>
                <Transition name="lora-expand">
                  <div v-if="artistOverrideEnabled" class="lora-workflow-select">
                    <linshe-input v-model="artistOverride" class="fi" placeholder="该角色专属画师串，留空则不注入画师串" />
                    <p class="form-hint">勾选后，遇到该角色生成图片时会无条件覆盖系统设置里注入的画师串；留空则用空画师串覆盖，不注入任何画师串。</p>
                  </div>
                </Transition>
              </div>
            </div>

            <div class="modal-actions" style="margin-top:16px">
              <span class="lora-civitai-label">LoRA 获取：</span>
              <a :href="civitaiRedSearchUrl" target="_blank" rel="noopener noreferrer" class="lora-civitai-link">
                CivitAI.red 搜索：{{ civitaiDisplayName }}
              </a>
              <div style="flex:1"></div>
              <linshe-button variant="primary" @click="saveLora" :disabled="loraLoading">
                {{ loraLoading ? '保存中…' : '保存' }}
              </linshe-button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ── 外观 / 形态设置弹窗 ── -->
    <Transition name="modal-fade">
      <div v-if="showOutfitModal" class="modal-overlay" @click.self="closeOutfitModal">
        <div class="modal-panel modal-wide">
          <div class="modal-header">
            <h3>外观 / 形态 — {{ character?.display_name }}</h3>
            <linshe-button variant="icon" class="modal-close" @click="closeOutfitModal">✕</linshe-button>
          </div>
          <div class="modal-body">
            <div class="lora-body-card">
              <p class="outfit-intro">
                配置该角色专属的额外形态、装甲或服装。启用后，角色生图时会优先穿着这里的外观，
                人物卡里的原有外观用于填补未提及的部位；同一时间只启用一套。
              </p>
              <TransitionGroup name="lora-card" tag="div" class="lora-list">
                <div v-for="(item, idx) in outfitItems" :key="item.id ?? `new-${idx}`" class="lora-item-card" :class="{ 'outfit-deleted': item._deleted }">
                  <linshe-button variant="icon" size="sm" class="lora-remove-btn" @click="removeOutfit(idx)" title="移除">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                  </linshe-button>
                  <div class="lora-item-row">
                    <div class="form-group lora-path-group">
                      <label class="fl lora-inline-label">名称</label>
                      <linshe-input v-model="item.name" class="fi" placeholder="如：机甲形态 / 女仆装 / 常服" />
                    </div>
                    <label class="outfit-enabled-label">
                      <input type="checkbox" v-model="item.enabled" @change="onOutfitEnabledChange(idx)" />
                      <span>启用中</span>
                    </label>
                  </div>
                  <div class="lora-trigger-row">
                    <label class="fl lora-inline-label">外观描述</label>
                    <linshe-input
                      v-model="item.description"
                      type="textarea"
                      class="fi"
                      rows="3"
                      placeholder="可用逗号分隔的 tag 组合（如 maid headdress, black maid dress, white apron），也可以用自然语言描述形态变化"
                    />
                  </div>
                </div>
              </TransitionGroup>

              <div v-if="activeOutfitCount === 0" class="lora-empty-hint">
                尚未配置专属外观，点击下方按钮添加
              </div>

              <linshe-button variant="secondary" size="sm" class="lora-add-btn" @click="addOutfit">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                添加形态
              </linshe-button>
            </div>

            <!-- ── 场景服装（五态 + 身体单一真源，2026-10-13 合并上游 + PR #24）── -->
            <div class="lora-body-card" style="margin-top:16px">
              <p class="outfit-intro">
                场景服装由<strong>日程</strong>决定此刻穿哪套（上班穿常服、睡觉穿睡衣、洗浴穿裸体），
                朋友圈配图 / 聊天 / 立绘都会自动跟随场合。<strong>身体</strong>是五套共用的单一真源，
                每套只填「这一套的衣服」，生图时由后端拼成完整外观。
              </p>

              <div class="scene-body-field">
                <label class="scene-body-label">
                  身体
                  <span class="scene-body-hint">五套共用 · 发色/发型/瞳色/肤色/体型/显著特征</span>
                </label>
                <linshe-input
                  v-model="sceneBody"
                  type="textarea"
                  class="fi scene-edit-desc"
                  rows="3"
                  placeholder="long silver hair with blue gradient tips, high ponytail, purple eyes, pale skin, slim build"
                  @input="sceneDirty = true"
                />
              </div>

              <div class="scene-tabs" role="tablist">
                <div
                  v-for="(s, i) in sceneScenes"
                  :key="s.key"
                  role="tab"
                  :aria-selected="i === sceneTab"
                  class="scene-tab"
                  :class="{ active: i === sceneTab, filled: !!sceneDescOf(s.key).trim() }"
                  @click="sceneTab = i"
                >
                  {{ s.label }}
                  <span v-if="s.key === 'sleep'" class="scene-tab-tag">强制</span>
                  <span v-else-if="s.key === 'nude'" class="scene-tab-tag is-nude">私密</span>
                </div>
              </div>
              <div v-if="sceneScenes[sceneTab]" class="scene-edit">
                <linshe-input
                  v-model="sceneOutfits[sceneScenes[sceneTab].key]"
                  type="textarea"
                  class="fi scene-edit-desc"
                  rows="6"
                  :placeholder="scenePlaceholder(sceneScenes[sceneTab].key)"
                  @input="sceneDirty = true"
                />
                <p v-if="sceneScenes[sceneTab].key === 'nude'" class="scene-edit-note">
                  裸体只用于洗浴与私密性场景，睡眠时段一律穿睡衣。这里保持「completely nude…」不动即可，画面主体由上面的身体描述决定。
                </p>
              </div>

              <div class="scene-actions">
                <linshe-button
                  variant="secondary"
                  size="sm"
                  :disabled="sceneGenerating"
                  :loading="sceneGenerating"
                  title="按已经填好的分项反推还没填的那些（身体取自已填项，只补衣服）"
                  @click="generateSceneOutfits"
                >✨ 反推未填的分项</linshe-button>
                <span class="scene-hint-left">由日程决定此刻穿哪套 · 睡眠硬规则优先 · 兜底绝不落裸体</span>
              </div>
            </div>

            <div class="modal-actions" style="margin-top:16px">
              <span class="outfit-save-hint">启用中的形态会注入到所有生图链路，优先级高于人物卡原有外观</span>
              <div style="flex:1"></div>
              <linshe-button variant="primary" @click="saveOutfits" :disabled="outfitLoading">
                {{ outfitLoading ? '保存中…' : '保存' }}
              </linshe-button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- ── 修正外观弹窗（共享组件）：上传 / 粘贴 / 拖拽参考图，邻舍分析后重写「## 你的外观」── -->
    <AppearanceRefineModal
      v-model="showRefineModal"
      :character-id="character?.id ?? null"
      :display-name="character?.display_name || ''"
      :base-prompt="detail.editPrompt"
      @applied="onAppearanceRefined"
    />

    <ClothingLibraryModal
      v-model="showClothingLibrary" :character-id="character?.id" :display-name="detail.editName"
      :base-prompt="fullPrompt" :scene="clothingLibraryScene" :scene-label="clothingLibrarySceneLabel"
      :current-appearance="detail.sceneOutfits.find(outfit => outfit.scene === clothingLibraryScene)?.description || ''"
      @applied="applyClothingLibrary"
    />
  </Teleport>
</template>

<script setup>
import { ref, reactive, computed, watch, inject, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '../stores/chat.js'
import * as api from '../api/index.js'
import LinsheSelect from './ui/LinsheSelect.vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSwitch from './ui/LinsheSwitch.vue'
import LinsheModal from './ui/LinsheModal.vue'
import ImageLightbox from './ImageLightbox.vue'
import CharacterStandingPanel from './CharacterStandingPanel.vue'
import TouchStatsPanel from './TouchStatsPanel.vue'
import RecentImageCropper from './RecentImageCropper.vue'
import IntimatePanel from './character/IntimatePanel.vue'
import ExpressionStandingManager from './ExpressionStandingManager.vue'
import AppearanceRefineModal from './AppearanceRefineModal.vue'
import ClothingLibraryModal from './ClothingLibraryModal.vue'
import { bustUrlIfOverwritten, overwriteBustTick } from '../utils/imageUrlRefresh.js'
import { useImageEditTasksStore } from '../stores/imageEditTasks.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  character: { type: Object, default: null },
})

const showExpressionStandings = ref(false)
watch(() => props.visible, value => { if (!value) showExpressionStandings.value = false })

const emit = defineEmits([
  'close',
  'saved',
  'deleted',
  'open-avatar-editor',
  'remove-avatar',
  'open-relation-graph',
  'open-deduction',
  'lora-saved',
])

const chat = useChatStore()
const confirmFn = inject('confirm')
const toastFn = inject('toast')
const isMobile = inject('isMobile')
const imageEditTasks = useImageEditTasksStore()

// ── 窄视口判定（上游 v3.9.1）──
// 立绘悬浮窗与右侧功能栏需要足够横向空间；手机一律内联，平板等窄视口也内联，
// 否则左右两块悬浮窗会被截掉一截（平板上「两边看不全」的根因）。
const SIDE_LAYOUT_MIN = 1532
const sideRoomQuery = typeof window === 'undefined' ? null : window.matchMedia(`(min-width: ${SIDE_LAYOUT_MIN}px)`)
const hasSideRoom = ref(sideRoomQuery?.matches ?? false)
function syncSideRoom() { hasSideRoom.value = sideRoomQuery?.matches ?? false }
onMounted(() => { syncSideRoom(); sideRoomQuery?.addEventListener('change', syncSideRoom) })
onUnmounted(() => { sideRoomQuery?.removeEventListener('change', syncSideRoom) })
const inlineLayout = computed(() => isMobile.value || !hasSideRoom.value)

// ── 详情编辑状态 ──
const detail = reactive({
  editCharName: '',
  editName: '',
  editPrompt: '',
  relationships: [],
  relationshipsLoading: false,
  momentsDisabled: false,
  proactiveDisabled: false,
  eventsDisabled: false,
  dirty: false,
  momentsToggling: false,
  proactiveToggling: false,
  eventsToggling: false,
  // 五套场景服装：**必须有默认空数组**（2026-10-19 浏览器 E2E 抓到）。
  // 组件在 ChatView / TavernView 里都是常挂载的，模板与 computed 在 `loadScenes()` 之前就会求值，
  // 没有默认值 ⇒ `Cannot read properties of undefined (reading 'find')`，控制台每渲染一次报一次。
  sceneOutfits: [],
  // 用**场景 key**（work/home/private/sleep）而不是数组索引：
  // 重新加载/接口失败后数组长度会变，索引会指错项甚至落空（2026-10-20 排查「一直加载中」时发现）
  sceneTab: 'work',
  originalAppearance: '',
  sceneOutfitsLoading: false,
  sceneOutfitsError: '',
})

// ── 人格 / 外观拆分（口径与后端 services/characterPersona.js 的 splitAppearanceSection 一致）──
// 整卡 = 人设 + 「## 你的外观」段。拆分后人设独立成框，外观段归入「外观服装 · 工装」，
// 于是人设保持纯粹，四套造型也能统一管理。保存时再重组成整卡，后端锚点不变。
const APPEARANCE_HEADING_RE = /##\s*你的外观/

/** 整卡 → { persona, appearance, tail } */
function splitPersona(full) {
  const s = String(full || '')
  const m = s.match(APPEARANCE_HEADING_RE)
  if (!m) return { persona: s.trimEnd(), appearance: '', tail: '' }
  const next = s.indexOf('\n## ', m.index + 1)
  const before = s.slice(0, m.index)
  const bodyStart = s.indexOf('\n', m.index)
  const body = bodyStart >= 0
    ? s.slice(bodyStart + 1, next >= 0 ? next : undefined).trim()
    : ''
  return { persona: before.trimEnd(), appearance: body, tail: next >= 0 ? s.slice(next) : '' }
}

/** { persona, appearanceBody, tail } → 整卡（外观正文为空时不写该段） */
function composePersona(persona, appearanceBody, tail = '') {
  const head = String(persona || '').trimEnd()
  const body = String(appearanceBody || '').trim()
  const t = String(tail || '')
  if (!body) return `${head}${t}`
  return `${head}\n\n## 你的外观\n${body}${t}`
}

/** 工装描述 —— 它就是整卡的「## 你的外观」段，双向绑定 */
function workOutfitDesc() {
  return detail.sceneOutfits.find(o => o.scene === 'work')?.description || ''
}

/** 外观服装当前编辑的那一套（标签页选中的）。返回的是 detail.sceneOutfits 里的同一对象引用，
 *  所以 v-model 直接写它的字段即可回写原数组。 */
const activeSceneOutfit = computed(() => detail.sceneOutfits.find(o => o.scene === detail.sceneTab) || null)
const showClothingLibrary = ref(false)
const clothingLibraryScene = ref('work')
const clothingLibrarySceneLabel = computed(() => clothingLibraryScene.value === 'work' ? '默认' : detail.sceneOutfits.find(outfit => outfit.scene === clothingLibraryScene.value)?.sceneLabel || '外观')
function openClothingLibrary() {
  if (!props.character || !activeSceneOutfit.value || outfitBatchRunning.value || outfitGenerating.value) return
  clothingLibraryScene.value = activeSceneOutfit.value.scene
  showClothingLibrary.value = true
}
function applyClothingLibrary({ characterId, scene, appearance }) {
  if (!props.visible || Number(characterId) !== Number(props.character?.id) || outfitBatchRunning.value) return
  const target = detail.sceneOutfits.find(outfit => outfit.scene === scene)
  if (!target) return
  target.description = appearance
  if (!target.name) target.name = target.sceneLabel
  detail.dirty = true
  toastFn(`已回填「${scene === 'work' ? '默认' : target.sceneLabel}」，点击保存后生效`, 'success')
}
watch(() => [props.visible, props.character?.id], () => { showClothingLibrary.value = false })

/** 实际生效的外观正文：工装被清空时回退到打开时的原外观，避免角色突然失去外观描述 */
function effectiveAppearance() {
  return String(workOutfitDesc() || '').trim() || detail.originalAppearance
}

/** 当前编辑中的整卡（供「修正外观」弹窗读取，口径与保存完全一致） */
const editorSections = [{ key: 'persona', label: '人设提示词' }, { key: 'outfits', label: '外观服装' }]
const editorSection = ref('persona')
function selectEditorSection(key) {
  if (editorSection.value === key) return
  editorSection.value = key
}
const sceneTabOptions = computed(() => detail.sceneOutfits.map(outfit => ({
  value: outfit.scene,
  label: outfit.scene === 'work' ? '默认' : outfit.sceneLabel,
  title: outfit.description.trim() ? '已填写外观描述' : '尚未填写外观描述',
})))

const fullPrompt = computed(() => composePersona(detail.editPersona, effectiveAppearance(), detail.appearanceTail))

/** 工装（常态外观）当前文本：作「按工装生成其余三套」的基准，也用于判断按钮是否可用 */
const workOutfitText = computed(() => effectiveAppearance())

async function loadSceneOutfits(characterId, fallbackWorkDesc = '') {
  if (!characterId) { detail.sceneOutfits = []; detail.sceneOutfitsError = ''; return }
  detail.sceneOutfitsLoading = true
  detail.sceneOutfitsError = ''
  try {
    const d = await api.listSceneOutfits(characterId)
    const scenes = d.scenes || []
    const exist = d.outfits || []
    if (!scenes.length) throw new Error('后端未返回场景列表')
    detail.sceneOutfits = scenes.map(s => {
      const hit = exist.find(o => o.scene === s.key)
      const isWork = s.key === 'work'
      // 工装的外观看 base_prompt 原外观段（那是角色的常态外观）；其余场景看已存的服装
      const desc = isWork
        ? (String(fallbackWorkDesc || '').trim() || hit?.description || '')
        : (hit?.description || '')
      return {
        scene: s.key,
        sceneLabel: s.label,
        // 名称界面不展示（也不让改）：仅用于日程标注「这一刻换了哪套」的匹配。
        // 沿用库里已有的（保住已生成日程里的标注），没有才用场景默认名。
        defaultName: s.defaultName || s.label,
        name: hit?.name || s.defaultName || s.label,
        description: desc,
      }
    })
  } catch (err) {
    console.error('loadSceneOutfits failed:', err)
    detail.sceneOutfits = []
    // 关键：以前这里只清空数组 ⇒ 模板固定渲染「加载中…」，用户永远等不到结果。
    // 现在把原因写进错误态，模板给「重试」，接口 404/500/超时都能自救（2026-10-20）。
    detail.sceneOutfitsError = err?.message || '外观加载失败'
  } finally {
    detail.sceneOutfitsLoading = false
  }
}

/** 外观加载失败后的重试（不关弹窗，直接重拉） */
async function retryLoadSceneOutfits() {
  const c = props.character
  if (!c) return
  await loadSceneOutfits(c.id, detail.originalAppearance)
  if (!detail.sceneOutfitsError && !detail.sceneOutfits.length) {
    detail.sceneOutfitsError = '后端没有返回任何服装场景'
  }
}

// ── 按工装（常态外观）为基准生成其余几套 ──
// 为什么这么设计：四套若各自从人设凭空设计，发色发型都可能漂移，看着不像同一个人。
// 以工装为锚，只让模型换衣服，身体特征保持不变。
// 注意变量名别与立绘的 sceneGenerating 撞（那是「生成某场景立绘」用的）。
const outfitGenerating = ref(false)
const activeOutfitBatch = computed(() => imageEditTasks.tasks.find(task =>
  task.action === 'scene_outfits' && task.status === 'running' && Number(task.meta?.characterId) === Number(props.character?.id)
))
const outfitBatchRunning = computed(() => !!activeOutfitBatch.value)
const refreshedOutfitTasks = new Set()
watch(() => imageEditTasks.tasks.filter(task => task.action === 'scene_outfits'
  && Number(task.meta?.characterId) === Number(props.character?.id)
  && ['ready', 'failed'].includes(task.status)).map(task => task.id).join(','), async () => {
  const c = props.character
  if (!c) return
  const finished = imageEditTasks.tasks.filter(task => task.action === 'scene_outfits'
    && Number(task.meta?.characterId) === Number(c.id) && ['ready', 'failed'].includes(task.status)
    && !refreshedOutfitTasks.has(task.id))
  if (!finished.length) return
  try {
    const [outfits, standings] = await Promise.all([api.listSceneOutfits(c.id), api.listSceneStandings(c.id)])
    if (props.character?.id !== c.id) return
    detail.sceneOutfits = detail.sceneOutfits.map(outfit => {
      const saved = outfits.outfits?.find(row => row.scene === outfit.scene)
      return outfit.scene !== 'work' && saved ? { ...outfit, name: saved.name, description: saved.description } : outfit
    })
    standingScenes.value = standings.standings || []
    syncPromptFromScene()
    finished.forEach(task => refreshedOutfitTasks.add(task.id))
  } catch (error) { toastFn('任务已结束，重新打开角色卡可刷新服装和形象', 'warning') }
})

async function generateOtherSceneOutfits() {
  const c = props.character
  if (!c || outfitGenerating.value || outfitBatchRunning.value || standingBusy.value) return
  const base = workOutfitText.value
  if (!base) { toastFn('先填写默认（常态外观），才能以它为基准生成', 'warning'); return }
  // 场景列表没加载出来（接口失败）时用后端固定四套的 key，保证按钮仍然可用
  const FALLBACK_SCENE_KEYS = ['home', 'private', 'sleep']
  const targets = detail.sceneOutfits.length
    ? detail.sceneOutfits.filter(o => o.scene !== 'work').map(o => o.scene)
    : FALLBACK_SCENE_KEYS
  if (!targets.length) return
  outfitGenerating.value = true
  try {
    const result = await api.generateSceneOutfits(c.id, true, { baseAppearance: base, scenes: targets, generateImages: true })
    if (!result?.task_id) throw new Error('未收到后台任务，请重启后端加载自动生成形象功能')
    await imageEditTasks.refresh()
    // 生成是后台任务；这里轻量重拉一次，让已落库的套数立即出现在面板上
    await loadSceneOutfits(c.id, detail.originalAppearance)
  } catch (err) {
    console.error('generateOtherSceneOutfits failed:', err)
    toastFn('生成失败：' + (err?.message || ''), 'error')
  } finally {
    outfitGenerating.value = false
  }
}

// ── Lora 设置状态 ──
const showLoraModal = ref(false)
const customWorkflows = ref([])
const customWorkflowEnabled = ref(false)
const editingCustomWorkflow = ref('')
const artistOverrideEnabled = ref(false)
const artistOverride = ref('')
const loraLoading = ref(false)
const loraItems = ref([])
const lorasFiles = ref([])
const activeLoraFileIdx = ref(null)
const loraDropdownIdx = ref(-1)
const loraSuggestions = ref([])
const loraFetching = ref(false)

// ── 亲密信息看板 ──
const showIntimateModal = ref(false)
function openIntimateModal() {
  if (!props.character) return
  showIntimateModal.value = true
}

// ── 外观/形态设置状态 ──
const showOutfitModal = ref(false)
const outfitLoading = ref(false)
const outfitItems = ref([]) // 本地编辑副本：{ id, name, description, enabled, _deleted }

const clickShouldClose = ref(false)

function onOverlayMouseDown(e) {
  if (e.target === e.currentTarget) {
    const textareaWasFocused = document.activeElement?.closest?.('.prompt-textarea') ?? false
    clickShouldClose.value = !textareaWasFocused
  } else {
    clickShouldClose.value = false
  }
}
function onOverlayClick() {
  if (clickShouldClose.value) {
    clickShouldClose.value = false
    emit('close')
  }
  clickShouldClose.value = false
}

const FILTERED_CUSTOM_WORKFLOW_NAMES = ['制图工作流.json', '制图工作流-加入lora.json', '制图工作流-加入lora2.json', '制图工作流-加入lora3.json']
const filteredWorkflows = computed(() =>
  (customWorkflows.value || []).filter(w => !FILTERED_CUSTOM_WORKFLOW_NAMES.includes(w.filename))
)
const customWorkflowOptions = computed(() =>
  filteredWorkflows.value.map(w => ({ value: w.filename, label: w.label }))
)

const civitaiRedSearchUrl = computed(() => {
  const name = (props.character?.name || props.character?.display_name || '').replaceAll('_', ' ')
  return `https://civitai.red/search/models?baseModel=Anima&sortBy=models_v9&query=${encodeURIComponent(name)}`
})
const civitaiDisplayName = computed(() => {
  return (props.character?.name || props.character?.display_name || '').replaceAll('_', ' ')
})

const hasLoraSetup = computed(() => {
  const c = props.character
  if (!c) return false
  return (_parseCharLoras(c.loras).length > 0) || !!c.custom_workflow || c.artist_override != null
})

const activeOutfit = computed(() =>
  outfitItems.value.find(o => o.enabled && !o._deleted && (o.name || '').trim())
)
const activeOutfitName = computed(() => activeOutfit.value?.name || '')
const activeOutfitCount = computed(() => outfitItems.value.filter(o => !o._deleted).length)

// ── Lora 辅助 ──
function _parseCharLoras(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return []
}

// ═══════════════════════════════════════
// 详情弹窗
// ═══════════════════════════════════════

watch(() => [props.visible, props.character], ([v, c]) => {
  // 详情卡收起时一并收起亲密信息子窗，避免留下孤儿弹窗
  if (!v) showIntimateModal.value = false
  if (v && c) {
    init(c)
  }
})

function refreshRelationships() {
  if (!props.character) return
  detail.relationshipsLoading = true
  api.getRelationships(props.character.id).then(res => {
    detail.relationships = res.relationships || []
  }).catch(() => {
    detail.relationships = []
  }).finally(() => {
    detail.relationshipsLoading = false
  })
}

defineExpose({ refreshRelationships })

function init(c) {
  detail.editCharName = c.name || ''
  detail.editName = c.display_name || ''
  detail.editPrompt = c.base_prompt || ''
  detail.momentsDisabled = !!c.moments_disabled
  detail.proactiveDisabled = !!c.proactive_disabled
  detail.eventsDisabled = !!c.events_disabled
  detail.dirty = false
  detail.relationships = []
  detail.relationshipsLoading = true
  standingFuncOpen.value = false
  standingRequirement.value = ''
  standingPrompt.value = ''
  fetchOutfits()
  api.getRelationships(c.id).then(res => {
    detail.relationships = res.relationships || []
  }).catch(() => {
    detail.relationships = []
  }).finally(() => {
    detail.relationshipsLoading = false
  })
}

async function removeOath() {
  const c = props.character
  if (!c || !c.is_oath) return
  const ok = await confirmFn({
    title: '解除誓约',
    message: `确定要解除与「${c.display_name}」的誓约吗？\n解除后，双方的特殊关系状态将会结束。`,
    okText: '解除誓约',
  })
  if (!ok) return
  try {
    await api.removeOath(c.id)
    c.is_oath = 0
    const inList = chat.characters.find(x => x.id === c.id)
    if (inList) inList.is_oath = 0
    toastFn('誓约已解除', 'success')
  } catch (e) {
    toastFn('解除誓约失败', 'error')
    console.error('removeOath failed:', e)
  }
}

async function saveCharDetail() {
  const c = props.character
  if (!c || !detail.dirty) return
  // 人格 / 外观拆分后，整卡由「人设 + 外观服装（默认那套）+ 尾部」重组回 base_prompt。
  const composed = fullPrompt.value
  await api.updateCharacter(c.id, {
    name: detail.editCharName,
    display_name: detail.editName,
    base_prompt: composed,
    moments_disabled: detail.momentsDisabled,
    proactive_disabled: detail.proactiveDisabled,
    events_disabled: detail.eventsDisabled,
  })
  c.name = detail.editCharName
  c.display_name = detail.editName
  detail.dirty = false
  emit('saved', c)
}

async function deleteChar() {
  const c = props.character
  if (!c) return
  if (c.name === 'default') {
    toastFn('默认角色不能删除', 'warning')
    return
  }
  const ok = await confirmFn({
    title: '删除角色',
    message: `确定要删除「${c.display_name}」吗？\n聊天记录和朋友圈内容也将一并删除。`,
    okText: '删除', danger: true,
  })
  if (!ok) return
  await api.deleteCharacter(c.id)
  emit('deleted', c)
}

// ── 开关 — 即时持久化 ──

async function toggleMomentsDisabled() {
  const c = props.character
  if (!c) return
  detail.momentsToggling = true
  try {
    await api.updateCharacter(c.id, { moments_disabled: detail.momentsDisabled })
    c.moments_disabled = detail.momentsDisabled
    const inList = chat.characters.find(x => x.id === c.id)
    if (inList) inList.moments_disabled = detail.momentsDisabled
  } catch (e) {
    detail.momentsDisabled = !detail.momentsDisabled
    console.error('toggleMomentsDisabled failed:', e)
  } finally {
    detail.momentsToggling = false
  }
}

async function toggleProactiveDisabled() {
  const c = props.character
  if (!c) return
  detail.proactiveToggling = true
  try {
    await api.updateCharacter(c.id, { proactive_disabled: detail.proactiveDisabled })
    c.proactive_disabled = detail.proactiveDisabled
    const inList = chat.characters.find(x => x.id === c.id)
    if (inList) inList.proactive_disabled = detail.proactiveDisabled
  } catch (e) {
    detail.proactiveDisabled = !detail.proactiveDisabled
    console.error('toggleProactiveDisabled failed:', e)
  } finally {
    detail.proactiveToggling = false
  }
}

async function toggleEventsDisabled() {
  const c = props.character
  if (!c) return
  detail.eventsToggling = true
  try {
    await api.updateCharacter(c.id, { events_disabled: detail.eventsDisabled })
    c.events_disabled = detail.eventsDisabled
    const inList = chat.characters.find(x => x.id === c.id)
    if (inList) inList.events_disabled = detail.eventsDisabled
  } catch (e) {
    detail.eventsDisabled = !detail.eventsDisabled
    console.error('toggleEventsDisabled failed:', e)
  } finally {
    detail.eventsToggling = false
  }
}

// ═══════════════════════════════════════
// Lora 弹窗
// ═══════════════════════════════════════

async function fetchWorkflows() {
  try {
    const data = await api.getWorkflows()
    customWorkflows.value = data.workflows || []
  } catch { customWorkflows.value = [] }
}

function addLoraGroup() {
  loraItems.value.push({ path: '', weight: 0.6, triggerWord: '' })
}

function removeLoraGroup(idx) {
  loraItems.value.splice(idx, 1)
}

async function fetchLorasFiles() {
  loraFetching.value = true
  try {
    const data = await api.fetchLorasFiles()
    lorasFiles.value = data.files || []
  } catch { lorasFiles.value = [] }
  loraFetching.value = false
}

function loraDisplayName(file) {
  return file.source ? `[${file.source}] ${file.name}` : file.name
}

function filterLoras(query) {
  if (!query) return lorasFiles.value
  const q = query.toLowerCase().replace(/\\/g, '/')
  return lorasFiles.value.filter(f => {
    const display = loraDisplayName(f).toLowerCase()
    return display.includes(q) || f.name.toLowerCase().includes(q)
  })
}

function onLoraInputFocus(idx) {
  activeLoraFileIdx.value = idx
  loraDropdownIdx.value = -1
  loraSuggestions.value = filterLoras(loraItems.value[idx]?.path || '')
}

function onLoraInput(idx) {
  activeLoraFileIdx.value = idx
  loraDropdownIdx.value = -1
  loraSuggestions.value = filterLoras(loraItems.value[idx]?.path || '')
}

function onLoraInputBlur() {
  setTimeout(() => { activeLoraFileIdx.value = null }, 150)
}

function selectLoraFile(idx, file) {
  loraItems.value[idx].path = file.name
  activeLoraFileIdx.value = null
}

function onLoraKeydown(e, idx) {
  if (activeLoraFileIdx.value !== idx) return
  const items = loraSuggestions.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    loraDropdownIdx.value = Math.min(loraDropdownIdx.value + 1, items.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    loraDropdownIdx.value = Math.max(loraDropdownIdx.value - 1, -1)
  } else if (e.key === 'Enter' && loraDropdownIdx.value >= 0) {
    e.preventDefault()
    selectLoraFile(idx, items[loraDropdownIdx.value])
  } else if (e.key === 'Escape') {
    activeLoraFileIdx.value = null
  }
}

function openLoraModal() {
  if (!props.character) return
  const c = props.character
  customWorkflowEnabled.value = !!c.custom_workflow
  editingCustomWorkflow.value = c.custom_workflow || ''
  artistOverrideEnabled.value = c.artist_override != null
  artistOverride.value = c.artist_override || ''
  const loras = _parseCharLoras(c.loras)
  loraItems.value = loras.length > 0
    ? JSON.parse(JSON.stringify(loras))
    : []
  showLoraModal.value = true
  if (customWorkflows.value.length === 0) fetchWorkflows()
  fetchLorasFiles()
}

function closeLoraModal() {
  showLoraModal.value = false
}

async function saveLora() {
  if (!props.character) return
  const c = props.character
  const customWf = (customWorkflowEnabled.value && editingCustomWorkflow.value) ? editingCustomWorkflow.value : ''
  const validLoras = loraItems.value.filter(l => l.path && l.path.trim())
  const artistVal = artistOverrideEnabled.value ? (artistOverride.value || '').trim() : null
  loraLoading.value = true
  try {
    await api.updateCharacter(c.id, {
      custom_workflow: customWf || null,
      loras: validLoras,
      artist_override: artistVal,
    })
    c.custom_workflow = customWf || null
    c.loras = validLoras.length > 0 ? JSON.stringify(validLoras) : null
    c.artist_override = artistVal
    showLoraModal.value = false
    emit('lora-saved', c)
  } catch (e) {
    console.error('saveLora failed:', e)
  } finally {
    loraLoading.value = false
  }
}

// ═══════════════════════════════════════
// 场景服装（五态 + 身体单一真源）
// 2026-10-13 合并上游 v3.9.0 + PR #24：日程驱动选装、睡眠硬规则、裸体仅私密场景。
// ═══════════════════════════════════════

const sceneScenes = ref([
  { key: 'nude', label: '裸体' },
  { key: 'work', label: '常服' },
  { key: 'casual', label: '私服' },
  { key: 'home', label: '居家' },
  { key: 'sleep', label: '睡衣' },
])
const sceneBody = ref('')
const sceneOutfits = ref({})       // sceneKey → 这一套的"衣服"描述
const sceneTab = ref(1)            // 默认停在「常服」
const sceneDirty = ref(false)
const sceneGenerating = ref(false)

function sceneDescOf(key) { return String(sceneOutfits.value[key] || '') }

/** 取角色卡「## 你的外观」段的正文（老数据兜底用；前端自含一份，避免跨端依赖） */
function cardAppearanceBody(basePrompt) {
  const base = String(basePrompt || '')
  const m = base.match(/##\s*你的外观/)
  if (!m) return ''
  return base.slice(m.index).replace(/^##\s*你的外观\s*/, '').trim()
}

function scenePlaceholder(key) {
  if (key === 'nude') return 'completely nude, wearing no clothing at all, bare skin visible'
  if (key === 'sleep') return '睡衣（英文 tag）—— 记得写 barefoot，且不要出现任何鞋袜'
  if (key === 'home') return '居家时穿的衣服（英文 tag）'
  if (key === 'work') return '这套上班/职务场合穿的衣服（英文 tag）'
  return '这套的衣服（英文 tag）'
}

async function fetchSceneOutfits() {
  if (!props.character) return
  try {
    const d = await api.listSceneOutfits(props.character.id)
    sceneBody.value = String(d.body || '')
    sceneOutfits.value = {}
    for (const o of (d.outfits || [])) sceneOutfits.value[o.scene] = String(o.description || '')
    // 工装没建行时（老数据），用角色卡原外观段兜底，让用户先看到东西再拆分
    if (!sceneDescOf('work')) sceneOutfits.value.work = cardAppearanceBody(props.character.base_prompt)
  } catch {
    sceneBody.value = ''
    sceneOutfits.value = {}
  }
}

/** 反推：以已填分项为锚，只补没填的那些（身体取自已填项） */
async function generateSceneOutfits() {
  const c = props.character
  if (!c || sceneGenerating.value) return
  const seeds = Object.entries(sceneOutfits.value)
    .filter(([, desc]) => String(desc || '').trim())
    .map(([scene, description]) => ({ scene, name: sceneScenes.value.find(s => s.key === scene)?.label || scene, body: sceneBody.value, description }))
  const targets = sceneScenes.value
    .filter(s => !sceneDescOf(s.key).trim())
    .map(s => s.key)
  if (!targets.length) { toastFn('五套都已经填好了，没有需要反推的', 'info'); return }
  if (!seeds.length) { toastFn('先填任意一套（或先填「身体」），才能据此反推其余', 'warning'); return }
  sceneGenerating.value = true
  try {
    // 只出草稿不落库：用户核对后点「保存」
    const d = await api.generateSceneOutfits(c.id, false, { seeds, scenes: targets, baseAppearance: sceneBody.value })
    for (const o of (d.outfits || [])) {
      if (sceneDescOf(o.scene)) continue
      sceneOutfits.value[o.scene] = o.description || ''
      if (!String(sceneBody.value || '').trim() && o.body) sceneBody.value = o.body
    }
    sceneDirty.value = true
    toastFn(`已反推 ${targets.length} 套，核对后点「保存」生效`, 'success')
  } catch (err) {
    console.error('generateSceneOutfits failed:', err)
    toastFn('反推失败：' + (err?.message || ''), 'error')
  } finally {
    sceneGenerating.value = false
  }
}

/** 随弹窗打开一起拉（沿用原 fetchOutfits 的位置） */
async function saveSceneOutfitsIfDirty() {
  const c = props.character
  if (!c || !sceneDirty.value) return
  const payload = sceneScenes.value.map(s => ({
    scene: s.key,
    name: s.label,
    description: sceneDescOf(s.key).trim(),
  }))
  await api.saveSceneOutfits(c.id, payload, sceneBody.value)
}

// ═══════════════════════════════════════
// 外观 / 形态弹窗
// ═══════════════════════════════════════

async function fetchOutfits() {
  if (!props.character) return
  try {
    const list = await api.listCharacterOutfits(props.character.id)
    outfitItems.value = (Array.isArray(list) ? list : []).map(o => ({ ...o, _deleted: false }))
  } catch {
    outfitItems.value = []
  }
  fetchSceneOutfits()
}

function openOutfitModal() {
  if (!props.character) return
  showOutfitModal.value = true
  fetchOutfits()
}

function closeOutfitModal() {
  showOutfitModal.value = false
}

function addOutfit() {
  outfitItems.value.push({ id: null, name: '', description: '', enabled: false, _deleted: false })
}

async function removeOutfit(idx) {
  const item = outfitItems.value[idx]
  if (!item) return
  if (item.id) {
    const ok = await confirmFn({
      title: '移除外观',
      message: `确定移除「${item.name || '未命名外观'}」吗？`,
      okText: '移除',
    })
    if (!ok) return
    item._deleted = true
  } else {
    outfitItems.value.splice(idx, 1)
  }
}

// 启用互斥（同角色同时只启用一套，与服务端规则一致）；全部取消勾选 = 不启用任何形态
function onOutfitEnabledChange(idx) {
  const target = outfitItems.value[idx]
  if (target.enabled) {
    outfitItems.value.forEach((o, i) => { if (i !== idx) o.enabled = false })
  }
}

async function saveOutfits() {
  if (!props.character) return
  const c = props.character
  const invalid = outfitItems.value.find(o => !o._deleted && (!(o.name || '').trim() || !(o.description || '').trim()))
  if (invalid) {
    toastFn('外观的名称和描述不能为空', 'warning')
    return
  }
  outfitLoading.value = true
  try {
    for (const o of outfitItems.value) {
      if (o._deleted) {
        await api.deleteCharacterOutfit(c.id, o.id)
        continue
      }
      const name = o.name.trim()
      const description = o.description.trim()
      if (o.id) {
        await api.updateCharacterOutfit(c.id, o.id, { name, description, enabled: !!o.enabled })
      } else {
        const created = await api.createCharacterOutfit(c.id, { name, description })
        const wantEnabled = !!o.enabled
        Object.assign(o, created)
        o.enabled = wantEnabled
        if (wantEnabled) await api.updateCharacterOutfit(c.id, created.id, { enabled: true })
      }
    }
    outfitItems.value = outfitItems.value.filter(o => !o._deleted)
    outfitItems.value.forEach(o => { delete o._deleted })
    // 场景服装（五态 + body 单一真源）一并保存
    try {
      await saveSceneOutfitsIfDirty()
    } catch (e) {
      console.error('saveSceneOutfits failed:', e)
      toastFn('专属形态已保存，但场景服装保存失败：' + (e?.message || ''), 'error')
    }
    toastFn('外观已保存', 'success')
    showOutfitModal.value = false
  } catch (e) {
    console.error('saveOutfits failed:', e)
    toastFn('外观保存失败', 'error')
  } finally {
    outfitLoading.value = false
  }
}

// ═══════════════════════════════════════
// 修正外观弹窗：上传/粘贴/拖拽参考图 → 邻舍分析后重写「## 你的外观」。
// 弹窗本体在 AppearanceRefineModal.vue；这里只负责打开，以及把应用结果
// 回填到人格卡文本框（dirty 待保存）走既有保存链路。
// ═══════════════════════════════════════

const showRefineModal = ref(false)

function openRefineModal() {
  if (!props.character) return
  showRefineModal.value = true
}

async function onAppearanceRefined({ basePrompt }) {
  detail.editPrompt = basePrompt
  detail.dirty = true
  // 复用详情卡的保存链路（PUT /:id 会同步重裁 short_prompt、标记日程重生成）
  try {
    await saveCharDetail()
    toastFn('外观已修正并保存', 'success')
  } catch (err) {
    console.error('onAppearanceRefined save failed:', err)
    toastFn('外观已应用到人格卡，但自动保存失败，请手动点击「保存」', 'error')
  }
}

// ═══════════════════════════════════════
// 立绘面板：状态与请求逻辑都在本组件，展示层见 CharacterStandingPanel.vue
// （桌面端是左侧悬浮窗、手机端是正文末尾的内联卡，两者共用下面的 standingPanel 接口）
// ═══════════════════════════════════════

const standingFuncOpen = ref(false)
const standingRequirement = ref('')
// 本轮弹窗会话中已生成的立绘提示词：存在时功能区拆为「重新生成提示词 / 再次生成」
const standingPrompt = ref('')
const standingHasPrompt = computed(() => standingPrompt.value.trim().length > 0)
// 生图请求以角色 id 记账：弹窗关闭再打开时，进行中的生成仍能接回画面
const standingGenCharId = ref(null)
const standingRegenCharId = ref(null)
const standingGenerating = computed(() =>
  standingGenCharId.value != null && standingGenCharId.value === props.character?.id
)
const standingReimageing = computed(() =>
  standingRegenCharId.value != null && standingRegenCharId.value === props.character?.id
)
// 后台出图任务：立绘画完前一直算忙碌（扫描线要持续到待确认 / 失败才算结束）
const standingTaskRunning = computed(() => {
  const c = props.character
  if (!c) return false
  const base = (c.standing_url || '').replace(/\?.*$/, '')
  return imageEditTasks.tasks.some(t =>
    t.action === 'standing' && t.status === 'running' &&
    (t.characterId === c.id || (t.characterId == null && !!base && (t.url || '').replace(/\?.*$/, '') === base))
  )
})
const standingBusy = computed(() =>
  standingGenCharId.value != null || standingRegenCharId.value != null || standingTaskRunning.value
)
const standingBusyForChar = computed(() => standingGenerating.value || standingReimageing.value || standingTaskRunning.value)
const standingLightboxVisible = ref(false)

// 立绘展示 URL：大图「重新生成 / 放大细化」确认覆盖后原 URL 内容已换，
// 经共享登记表补 ?_t= 防止浏览器缓存旧图（弹窗关闭期间确认覆盖也生效，重开即见新图）
const standingDisplayUrl = computed(() => {
  overwriteBustTick.value // 依赖登记表 tick：覆盖确认后即使弹窗开着也能立即换新图
  return bustUrlIfOverwritten(props.character?.standing_url || '')
})

// 立绘姿势风格（普通 / 张力！）：全局设置，system_settings 持久化
const standingMode = ref('normal')

onMounted(() => {
  api.getStandingMode()
    .then(r => { standingMode.value = r.mode === 'dynamic' ? 'dynamic' : 'normal' })
    .catch(() => {})
  window.addEventListener('standing-overwritten', onStandingOverwritten)
  // 场景立绘：跟着当前角色拉一次（切角色会再触发）
  fetchSceneStandings()
})

// 切角色时重拉场景立绘，并把视图重置回默认
watch(() => props.character?.id, () => {
  sceneView.value = ''
  fetchSceneStandings()
})

async function toggleStandingMode() {
  if (standingBusy.value) return
  const prev = standingMode.value
  const next = prev === 'dynamic' ? 'normal' : 'dynamic'
  standingMode.value = next
  try {
    await api.updateStandingMode(next)
  } catch (e) {
    standingMode.value = prev
    console.error('toggleStandingMode failed:', e)
    toastFn(e?.message || '风格切换保存失败', 'error')
  }
}

// 生成中轮播趣语（与角色招募同款风格）
const STANDING_TIPS = [
  '正在铺开画布…',
  '正在研磨颜料…',
  '正在挑选最上镜的角度…',
  '正在勾勒轮廓线…',
  '正在为立绘打光…',
  '正在邀请衣匠量体…',
  '正在查阅公会画册…',
  '正在与画师讨价还价…',
  '正在等待颜料晾干…',
  '正在擦拭相框…',
  '正在向馆长申请展厅…',
]
const standingTip = ref(STANDING_TIPS[0])
let _standingTipTimer = null

function stopStandingTips() {
  if (_standingTipTimer) {
    clearInterval(_standingTipTimer)
    _standingTipTimer = null
  }
}

watch(standingBusyForChar, (busy) => {
  stopStandingTips()
  if (busy) {
    standingTip.value = STANDING_TIPS[0]
    let idx = 0
    _standingTipTimer = setInterval(() => {
      idx = (idx + 1) % STANDING_TIPS.length
      standingTip.value = STANDING_TIPS[idx]
    }, 2200)
  }
})

// 后台任务跑到终点后收起本地记账，扫描线随之停止
watch(standingTaskRunning, (running) => {
  if (running) return
  standingGenCharId.value = null
  standingRegenCharId.value = null
})

onUnmounted(() => {
  stopStandingTips()
  window.removeEventListener('standing-overwritten', onStandingOverwritten)
})

function toggleStandingFunc() {
  standingFuncOpen.value = !standingFuncOpen.value
}

// 点击画面：第一下弹出功能区；功能区已展开且有立绘时，再点查看大图
function onStandingStageClick() {
  if (!standingFuncOpen.value) {
    standingFuncOpen.value = true
    return
  }
  if (props.character?.standing_url) {
    standingLightboxVisible.value = true
  } else {
    standingFuncOpen.value = false
  }
}

async function generateStanding() {
  const c = props.character
  if (!c || standingBusy.value) return
  standingFuncOpen.value = true
  standingGenCharId.value = c.id
  try {
    if (c.standing_url) {
      // 已有立绘：后台出图 → 前后对比确认 → 确认后才覆盖旧立绘
      const res = await imageEditTasks.start('standing', c.standing_url, {
        characterId: c.id,
        requirement: standingRequirement.value.trim(),
      })
      standingPrompt.value = res?.promptText || standingPrompt.value
      return
    }
    const res = await api.generateStanding(c.id, standingRequirement.value.trim())
    c.standing_url = res.standing_url
    standingPrompt.value = res.promptText || ''
    toastFn('立绘已生成', 'success')
  } catch (e) {
    console.error('generateStanding failed:', e)
    toastFn(e?.message || '立绘生成失败', 'error')
  } finally {
    if (!standingTaskRunning.value) standingGenCharId.value = null
  }
}

// 用当前提示词直接重出图，不重新请求 LLM
async function regenerateStanding() {
  const c = props.character
  const prompt = standingPrompt.value.trim()
  if (!c || !prompt || standingBusy.value) return
  standingFuncOpen.value = true
  standingRegenCharId.value = c.id
  try {
    if (c.standing_url) {
      // 已有立绘：后台出图 → 前后对比确认 → 确认后才覆盖旧立绘
      await imageEditTasks.start('standing', c.standing_url, { characterId: c.id, prompt })
      return
    }
    const res = await api.regenerateStandingImage(c.id, prompt)
    c.standing_url = res.standing_url
    toastFn('立绘已生成', 'success')
  } catch (e) {
    console.error('regenerateStanding failed:', e)
    toastFn(e?.message || '立绘生成失败', 'error')
  } finally {
    if (!standingTaskRunning.value) standingRegenCharId.value = null
  }
}

// 对比确认后新立绘是新文件名（不会撞浏览器缓存），直接把 URL 换到当前角色
function onStandingOverwritten(e) {
  const c = props.character
  if (!c || !e?.detail || c.id !== e.detail.characterId) return
  c.standing_url = e.detail.url
}

async function removeStanding() {
  const c = props.character
  if (!c?.standing_url || standingBusy.value) return
  const ok = await confirmFn({
    title: '删除立绘',
    message: `确定删除「${c.display_name}」的立绘吗？\n删除后可以重新生成。`,
    okText: '删除',
  })
  if (!ok) return
  try {
    await api.deleteStanding(c.id)
    c.standing_url = null
    toastFn('立绘已删除', 'success')
  } catch (e) {
    console.error('removeStanding failed:', e)
    toastFn(e?.message || '立绘删除失败', 'error')
  }
}

// 上传本地图片作为立绘：替换当前立绘（已生成立绘时也允许，AI 重绘会覆盖）。
// 文件由面板里的隐藏 input 选好再传进来 —— DOM 细节归面板，校验与请求留在弹窗里。
const standingUploading = ref(false)

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function uploadStandingFile(file) {
  if (!file) return
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    toastFn('请选择 PNG / JPG / WEBP 图片', 'error')
    return
  }
  if (file.size > 6 * 1024 * 1024) {
    toastFn('图片不能超过 6MB', 'error')
    return
  }
  const c = props.character
  if (!c) return
  let base64
  try {
    base64 = await readFileAsDataURL(file)
  } catch (err) {
    toastFn('读取图片失败: ' + err.message, 'error')
    return
  }
  standingUploading.value = true
  try {
    const res = await api.uploadStanding(c.id, base64)
    c.standing_url = res.standing_url
    toastFn('立绘已上传', 'success')
  } catch (err) {
    console.error('uploadStanding failed:', err)
    toastFn(err?.message || '立绘上传失败', 'error')
  } finally {
    standingUploading.value = false
  }
}

// 立绘面板接口：状态与方法都留在弹窗里（弹窗会因打开 LoRA / 外观设置整体重建，放面板里会丢），
// 面板只负责渲染。reactive 里的 ref 会自动解包，面板侧可以当普通值读写。
//
// 场景立绘（2026-10-13）：五套场景各有一张图时，面板可以左右切换查看。
// sceneView 为空 = 看角色默认立绘（characters.standing_url，原行为）；
// 指向某场景 = 看那套场景立绘（character_standings，work 槽缺图时后端以默认立绘兜底）。
const sceneStandings = ref([])      // [{scene, sceneLabel, image_url, is_fallback}]
const sceneView = ref('')           // 当前看的场景 key（'' = 默认立绘）

async function fetchSceneStandings() {
  const c = props.character
  if (!c) { sceneStandings.value = []; return }
  try {
    const d = await api.listSceneStandings(c.id)
    sceneStandings.value = (d.standings || []).map(s => ({ ...s, sceneLabel: s.sceneLabel || s.scene }))
    // 默认立绘没配时，自动落到有图的第一套（避免面板空白）
    if (!c.standing_url) {
      const first = sceneStandings.value.find(s => s.image_url)
      if (first) sceneView.value = first.scene
    }
  } catch {
    sceneStandings.value = []
  }
}

/** 场景立绘的展示 URL（当前选中那套；没选场景则交给原 displayUrl） */
const sceneDisplayUrl = computed(() => {
  if (!sceneView.value) return ''
  const hit = sceneStandings.value.find(s => s.scene === sceneView.value)
  return hit?.image_url || ''
})

// ── 场景立绘上传（上游 v3.10.0）：把本地图片作为**当前场景**的形象 ──
// 复用上面立绘上传用的 readFileAsDataURL（同一套编码/读取逻辑）
const sceneUploading = ref(false)
async function uploadSceneStandingFile(file) {
  if (!file) return
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    toastFn('请选择 PNG / JPG / WEBP 图片', 'error')
    return
  }
  if (file.size > 6 * 1024 * 1024) {
    toastFn('图片不能超过 6MB', 'error')
    return
  }
  const c = props.character
  const scene = sceneView.value
  if (!c || !scene) return
  let base64
  try {
    base64 = await readFileAsDataURL(file)
  } catch (err) {
    toastFn('读取图片失败: ' + err.message, 'error')
    return
  }
  sceneUploading.value = true
  try {
    const res = await api.uploadSceneStanding(c.id, scene, base64)
    if (Array.isArray(res?.standings)) {
      sceneStandings.value = res.standings.map(s => ({ ...s, sceneLabel: s.sceneLabel || s.scene }))
    } else {
      await fetchSceneStandings()
    }
    toastFn('形象已上传', 'success')
  } catch (err) {
    console.error('uploadSceneStandingFile failed:', err)
    toastFn(err?.message || '上传失败', 'error')
  } finally {
    sceneUploading.value = false
  }
}

/**
 * 在当前场景列表里前后切换（上游 v3.9.1 的 CharacterStandingPanel 用它做轮播/左右切）。
 * @param {number} step -1 上一个 / 1 下一个
 * @param {boolean} existingOnly 只停在已有图的场景上
 */
function stepScene(step, existingOnly = false) {
  const list = sceneStandings.value
  const n = list.length
  if (n <= 1) return
  let idx = list.findIndex(s => s.scene === sceneView.value)
  if (idx < 0) idx = 0
  for (let i = 0; i < n; i++) {
    idx = (idx + step + n) % n
    if (!existingOnly || list[idx]?.image_url) break
  }
  sceneView.value = list[idx]?.scene || ''
}

const standingPanel = reactive({
  funcOpen: standingFuncOpen,
  autoplayEnabled: computed(() => props.visible && !standingLightboxVisible.value),
  requirement: standingRequirement,
  hasPrompt: standingHasPrompt,
  generating: standingGenerating,
  reimageing: standingReimageing,
  busy: standingBusy,
  busyForChar: standingBusyForChar,
  uploading: standingUploading,
  tip: standingTip,
  // 选中了场景立绘时优先展示它（原 displayUrl 是角色默认立绘那条链）
  displayUrl: computed(() => sceneDisplayUrl.value || standingDisplayUrl.value),
  mode: standingMode,
  toggleFunc: toggleStandingFunc,
  onStageClick: onStandingStageClick,
  toggleMode: toggleStandingMode,
  generate: generateStanding,
  regenerate: regenerateStanding,
  remove: removeStanding,
  uploadFile: uploadStandingFile,
  // 场景立绘（五套切换）—— 本地实现
  sceneStandings,
  sceneView,
  switchScene(key) { sceneView.value = key },
  // 场景立绘上传（上游 v3.10.0）：把本地图片作为当前场景的形象
  sceneUploading,
  sceneUploadFile: uploadSceneStandingFile,
  // 兼容上游 v3.9.1 的 CharacterStandingPanel 轮播/切场景接口（同一套数据，换成上游的键名）
  scenes: sceneStandings,
  get sceneIndex() { return sceneStandings.value.findIndex(s => s.scene === sceneView.value) },
  get sceneLabel() { return sceneStandings.value.find(s => s.scene === sceneView.value)?.sceneLabel || '' },
  autoplayEnabled: false,
  prevScene: () => stepScene(-1, false),
  nextScene: () => stepScene(1, false),
  nextExistingScene: () => stepScene(1, true),
})

</script>

<style scoped>
/* ═══ 弹窗骨架已迁移至全局 .modal-*（styles/components.css）═══
   此处仅保留本组件的布局覆写 */
.modal-body {
  padding: 0px 22px 22px;
}

.modal-body-detail {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-body-detail .preview-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.modal-body-detail .prompt-textarea {
  flex: 1;
  min-height: 0;
  resize: none;
  overflow-y: auto;
  scrollbar-width: auto;
  scrollbar-color: var(--text-secondary) transparent;
}
.modal-body-detail .prompt-textarea::-webkit-scrollbar { width: 10px; }
.modal-body-detail .prompt-textarea::-webkit-scrollbar-track { background: transparent; }
.modal-body-detail .prompt-textarea::-webkit-scrollbar-thumb { background: var(--text-secondary); border-radius: 5px; }
.modal-body-detail .prompt-textarea::-webkit-scrollbar-thumb:hover { background: var(--text-primary); }

/* 面板高度：桌面端固定 95vh（原写作行内 style，移动端要按遮罩留白重算高度，故收进类里） */
.detail-panel { height: 95vh; max-height: 95vh; }

.modal-actions {
  display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px;align-items: center;
}

/* ═══ 详情编辑 ═══ */
.fl { font-size: 13px; font-weight: 600; color: var(--text-bright); display: block; margin-bottom: 4px; }

.detail-name-row { display: flex; gap: 12px; }
.detail-name-col { flex: 1; min-width: 0; }

.detail-avatar-row { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
.detail-avatar {
  width: 64px; height: 64px; border-radius: 50%;
  background: var(--accent);
  display: flex; align-items: center; justify-content: center;
  color: var(--on-accent); font-size: 26px; font-weight: 700; flex-shrink: 0;
}
.detail-avatar-img {
  width: 100%; height: 100%;
  object-fit: cover;
  border-radius: inherit;
  display: block;
}
.detail-avatar.clickable { cursor: pointer; transition: opacity 0.15s; }
.detail-avatar.clickable:hover { opacity: 0.85; }

/* ═══ 角色关系区块 ═══ */
.detail-rel-section {
  margin-bottom: 16px;
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(var(--accent-rgb), 0.04);
  border: 1px solid rgba(var(--accent-rgb), 0.1);
}
.detail-rel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.detail-rel-title { font-size: 13px; font-weight: 700; color: var(--text-bright); display: flex; align-items: center; gap: 6px; }
.detail-rel-title svg { color: var(--accent); }
/* detail-rel-btn 家族样式已收编至全局 components.css */
.detail-rel-btns { display: flex; align-items: center; gap: 6px; }
.detail-rel-ctas { display: flex; align-items: center; gap: 8px; }
.detail-rel-list { display: flex; flex-direction: column; gap: 6px; }
.detail-rel-item { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; background: var(--bg-primary); font-size: 12px; }
.rel-from, .rel-to { font-weight: 600; color: var(--text-bright); }
.rel-text { color: var(--accent); font-weight: 500; padding: 1px 8px; border-radius: 4px; background: rgba(var(--accent-rgb), 0.1); }
.detail-rel-more { font-size: 12px; color: var(--accent); font-weight: 500; cursor: pointer; text-align: center; padding: 4px 0; transition: opacity 0.15s; }
.detail-rel-more:hover { opacity: 0.7; }
.detail-rel-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 18px 8px 8px; text-align: center; }
.rel-empty-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin: 0; max-width: 360px; }
.rel-empty-spinner { width: 14px; height: 14px; border: 2px solid rgba(var(--accent-rgb), 0.2); border-top-color: var(--accent); border-radius: 50%; animation: rel-spin 0.6s linear infinite; }
@keyframes rel-spin { to { transform: rotate(360deg); } }

/* ═══ 誓约状态（头像行内） ═══ */
.detail-avatar-oath { display: flex; align-items: center; margin-left: auto; flex-shrink: 0; }
.oath-badge {
  position: relative; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; padding: 4px 14px; border-radius: 20px;
  background: linear-gradient(135deg, rgba(212, 168, 83, 0.18), rgba(212, 168, 83, 0.08));
  border: 1px solid rgba(212, 168, 83, 0.25);
  cursor: pointer; user-select: none; overflow: hidden;
  transition: all 0.25s ease; min-width: 80px; height: 28px;
}
.oath-badge:hover {
  border-color: rgba(var(--accent-rgb), 0.25);
  background: linear-gradient(135deg, rgba(var(--accent-rgb), 0.08), rgba(var(--accent-rgb), 0.03));
}
.oath-badge-default, .oath-badge-hover {
  position: absolute; transition: all 0.25s ease;
  white-space: nowrap; letter-spacing: 0.3px;
}
.oath-badge-default { opacity: 1; transform: translateY(0); color: var(--fun-gold); }
.oath-badge-hover { opacity: 0; transform: translateY(8px); color: rgba(var(--accent-rgb), 0.6); }
.oath-badge:hover .oath-badge-default { opacity: 0; transform: translateY(-8px); }
.oath-badge:hover .oath-badge-hover { opacity: 1; transform: translateY(0); }

/* ═══ 悬浮侧边栏 ═══ */
.detail-float {
  position: absolute;
  left: calc(50% + min(450px, 48.5vw) + 16px);
  top: 2.5vh;
  width: 228px;
  height: 95vh;
  z-index: 0;
}
.float-panel {
  display: flex; flex-direction: column;
  height: 100%;
  padding: 12px;
  border-radius: 18px;
  background: var(--side-panel-bg);
  border: var(--side-panel-border);
  box-shadow: var(--side-panel-shadow);
  /* 主面板 modal-pop(0.28s) 结束后，再从面板背后向右弹出；
     初始多藏 60px，避免面板 0.92 缩放阶段露出右缘 */
  animation: float-emerge 0.5s cubic-bezier(0.3, 1.35, 0.55, 1) 0.32s both;
}
@keyframes float-emerge {
  0%   { transform: translateX(calc(-100% - 60px)); }
  100% { transform: translateX(0); }
}
.float-panel-header {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 700; letter-spacing: 1px;
  color: var(--text-secondary);
  margin: 2px 2px 10px;
}
.float-panel-body {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 4px;
}
.float-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 8px 10px;
}
.float-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); white-space: nowrap; }
.float-row-action {
  margin-top: 2px; padding: 8px 10px;
  border-radius: 10px; cursor: pointer;
  transition: background 0.15s;
}
.float-row-action:hover { background: rgba(var(--accent-rgb), 0.08); }
.float-row-action:hover .float-label { color: var(--accent); }
.float-badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--bg-tertiary); color: var(--text-secondary); }
.float-badge.active { background: rgba(var(--accent-rgb), 0.15); color: var(--accent); }


/* ═══ 操作栏 ═══ */
.modal-footer {
  flex-shrink: 0;
  padding: 10px 22px 18px;
  border-top: 1px solid var(--glass-border);
  background: inherit;
}
/* 撑满 footer：全局 .modal-footer 是 justify-content:flex-end 的 flex 容器，
   不撑满会把「删除角色」和「保存」挤到右下角；撑满后由 .recruit-appearance-hint 的
   margin-left:auto 把「说明 + 保存」推到右端，与左侧「删除角色」分列两端 */
.detail-actions { flex: 1; min-width: 0; display: flex; align-items: center; margin-top: 0; gap: 10px; }
.recruit-appearance-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.recruit-appearance-hint a {
  color: var(--text-secondary);
  text-decoration: underline;
}

/* ═══ 弹窗动画已迁移至全局 animations.css（modal-fade + modal-pop）═══ */

/* ═══ 通用 ═══ */
.sp-btn-small { margin-right: 6px; }

.prompt-textarea { min-height: 500px; }

.modal-wide .prompt-textarea { padding: 12px; border-radius: 10px; font-size: 12px; line-height: 1.7; color: var(--text-primary); }

/* 人设与服装复用统一表单、按钮和分段控件，仅定义布局。 */
.persona-accordion { margin-top: 0; flex: 1; display: flex; flex-direction: column; min-height: 0; }
.persona-section { flex: 0 0 auto; display: flex; flex-direction: column; min-height: 0; transition: flex-grow 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
.persona-section.is-open { flex-grow: 1; }
.persona-section + .persona-section { margin-top: 16px; }
.persona-section-heading { margin: 0; }
.persona-section-trigger { display: flex; align-items: center; gap: 11px; padding: 10px 0; border-bottom: 1px solid var(--border-strong); cursor: pointer; text-align: left; color: var(--text-secondary); }
.persona-section-trigger:hover, .persona-section.is-open .persona-section-trigger { color: var(--text-primary); }
.persona-section-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: var(--radius-sm); }
.persona-section-emblem { display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; border-radius: 9px 7px 9px 6px; background: var(--bg-sunken); border: 1px solid var(--border-strong); transform: rotate(-4deg); transition: transform 0.3s var(--ease-spring); }
.persona-section.is-open .persona-section-emblem { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-primary)); box-shadow: var(--shadow-hard-sm); }
.persona-section-trigger:hover .persona-section-emblem { transform: rotate(0); }
.persona-section-title { flex: 1; text-align: left; font-size: var(--fs-sm); font-weight: 700; }
.persona-section-subtitle { display: block; margin-top: 3px; font-size: var(--fs-xs); font-weight: 400; color: var(--text-secondary); }
.persona-section.is-open .persona-section-trigger { border-bottom-color: var(--accent); }
.persona-section-chevron { flex-shrink: 0; transition: transform 0.3s ease; }
.persona-section-chevron.open { transform: rotate(180deg); }
/* 用真实布局高度收展，标题随内容移动；保留 DOM，切换不丢失编辑位置。 */
.persona-collapse {
  display: grid; grid-template-rows: 0fr; flex: 1; min-height: 0;
  visibility: hidden;
  transition: grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1), visibility 0s 0.3s;
}
.persona-collapse.is-expanded { grid-template-rows: 1fr; visibility: visible; transition-delay: 0s; }
.persona-section-body { min-height: 0; overflow: hidden; }
.persona-section-content { padding-top: 12px; min-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; }
.persona-section-heading { flex-shrink: 0; }
.split-hint { margin: 0 0 12px; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.7; }
.scene-block { flex: 1; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.scene-block-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.scene-block-head .split-hint { flex: 1 1 220px; margin: 0; }
.scene-edit { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.scene-edit > .ls-input { flex: 1; }
.clothing-library-trigger { margin-bottom: 8px; }
.scene-edit-empty { font-size: var(--fs-xs); color: var(--text-secondary); padding: 12px 0; }
/* 加载失败态：给原因 + 重试，不再让面板永远停在「加载中…」 */
.scene-edit-empty.is-error { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; color: var(--danger, #c0392b); }
.persona-fold-enter-active, .persona-fold-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.persona-fold-enter-from, .persona-fold-leave-to { opacity: 0; transform: translateY(-4px); }
@media (prefers-reduced-motion: reduce) {
  .persona-fold-enter-active, .persona-fold-leave-active, .persona-section-chevron, .persona-section, .persona-collapse { transition: none; }
}

.preview-card { background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 14px; padding: 18px; }

/* ═══ Lora 设置 ═══ */
.lora-body-card { background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 14px; padding: 18px; }
.lora-expand-enter-active { transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1); overflow: hidden; }
.lora-expand-leave-active { transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); overflow: hidden; }
.lora-expand-enter-from { opacity: 0; max-height: 0; transform: translateY(-6px); }
.lora-expand-enter-to { opacity: 1; max-height: 180px; transform: translateY(0); }
.lora-expand-leave-from { opacity: 1; max-height: 180px; transform: translateY(0); }
.lora-expand-leave-to { opacity: 0; max-height: 0; transform: translateY(-6px); }
.form-group { margin-bottom: 16px; }
.form-group .fl { display: block; margin-bottom: 6px; }
.form-hint { margin: 4px 0 0; font-size: 11px; color: var(--text-secondary); line-height: 1.5; }
.lora-workflow-select { margin-top: 8px; }
.lora-workflow-select .fi { width: 100%; }
.lora-separator { border-top: 1px solid var(--border); margin: 24px 0 20px; }
.lora-check-label { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.lora-checkbox { position: absolute; opacity: 0; width: 0; height: 0; }
.lora-checkbox-wrap { position: relative; width: 18px; height: 18px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.lora-checkmark { width: 18px; height: 18px; border-radius: 4px; border: 1.5px solid var(--glass-border); background: var(--bg-primary); display: flex; align-items: center; justify-content: center; transition: all 0.15s; cursor: pointer; }
.lora-checkmark svg { opacity: 0; transform: scale(0.5); transition: all 0.15s; }
.lora-checkbox:checked + .lora-checkmark { background: var(--accent); border-color: var(--accent); }
.lora-checkbox:checked + .lora-checkmark svg { opacity: 1; transform: scale(1); }
.lora-check-text { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.lora-list { display: flex; flex-direction: column; gap: 10px; }
.lora-item-card { position: relative; background: var(--bg-primary); border: 1px solid var(--glass-border); border-radius: 12px; padding: 10px 32px 10px 12px; }
.lora-remove-btn { position: absolute; top: 6px; right: 6px; z-index: 1; }
.lora-item-row { display: flex; gap: 10px; align-items: flex-end; }
.lora-item-row .form-group, .lora-trigger-row .form-group { margin-bottom: 0; }
.lora-path-group { flex: 2; min-width: 0; }
.lora-autocomplete-wrap { position: relative; }
.lora-dropdown {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px);
  max-height: 220px;
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  z-index: 10001;
  list-style: none;
  padding: 4px;
  margin: 0;
  box-shadow: var(--shadow-md);
  transform-origin: top center;
}
.lora-dropdown-item {
  display: flex; align-items: center;
  padding: 9px 10px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-bright);
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}
.lora-dropdown-item:hover {
  background: rgba(var(--accent-rgb),0.08);
  color: var(--accent);
}
.lora-dropdown-item.active {
  background: rgba(var(--accent-rgb),0.06);
  color: var(--accent);
  font-weight: 600;
}
.lora-weight-group { flex: 0 0 72px; }
.lora-inline-label { font-size: 11px; margin-bottom: 3px; }
.lora-weight-input { text-align: center; padding: 9px 4px; }
.lora-trigger-row { margin-top: 8px; }
.lora-trigger-row textarea { min-height: 60px; width: 100%; }
.lora-card-enter-active, .lora-card-leave-active { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); overflow: hidden; }
.lora-card-enter-from, .lora-card-leave-to { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; margin-bottom: 0; border-width: 0; }
.lora-card-enter-to, .lora-card-leave-from { opacity: 1; max-height: 120px; }
.lora-empty-hint { text-align: center; font-size: 13px; color: var(--text-secondary); padding: 20px 0; margin-bottom: 8px; }
.lora-add-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 10px 0; border: 1.5px dashed var(--glass-border); border-radius: 10px; background: transparent; color: var(--accent); font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s; margin: 5px 0; user-select: none; }
.lora-add-btn:hover { border-color: var(--accent); background: rgba(var(--accent-rgb), 0.05); }

/* ═══ 外观 / 形态设置 ═══ */
.outfit-intro { margin: 0 0 12px; font-size: 12px; color: var(--text-secondary); line-height: 1.6; }
.outfit-enabled-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); cursor: pointer; user-select: none; flex-shrink: 0; padding-bottom: 6px; }
.outfit-enabled-label input { accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; }
.outfit-enabled-label span { font-weight: 600; }
.outfit-deleted { opacity: 0.4; }
.outfit-deleted input, .outfit-deleted textarea { text-decoration: line-through; }
.float-badge-name { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.outfit-save-hint { font-size: 11px; color: var(--text-secondary); }

/* ═══ 场景服装（五态 + 身体单一真源）═══ */
.scene-body-field {
  display: flex; flex-direction: column; gap: 5px;
  margin-bottom: 10px; padding: 10px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  border: 1px dashed var(--glass-border);
}
.scene-body-label { display: flex; align-items: baseline; gap: 7px; font-size: 12px; font-weight: 600; color: var(--text-primary); }
.scene-body-hint { font-size: 10.5px; font-weight: 400; color: var(--text-secondary); }
.scene-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.scene-tab {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 12px; border-radius: 999px;
  border: 1.5px solid var(--glass-border);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 12px; font-weight: 600;
  cursor: pointer; transition: all 0.15s;
}
.scene-tab:hover { border-color: var(--accent); color: var(--text-primary); }
.scene-tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.scene-tab.filled::after { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.scene-tab.active.filled::after { background: #fff; }
.scene-tab-tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(var(--accent-rgb), 0.22); color: var(--accent); }
.scene-tab.active .scene-tab-tag { background: rgba(255, 255, 255, 0.25); color: #fff; }
/* 裸体那套是"私密场景专用"，标签用中性色区分，别和"强制"的睡眠混同一种强调 */
.scene-tab-tag.is-nude { background: var(--glass-bg); color: var(--text-secondary); }
.scene-tab.active .scene-tab-tag.is-nude { background: var(--glass-bg); color: var(--text-secondary); }
.scene-edit { display: flex; flex-direction: column; gap: 7px; }
.scene-edit-desc { width: 100%; }
.scene-edit-note { margin: 0; font-size: 11px; line-height: 1.6; color: var(--text-secondary); }
.scene-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.scene-hint-left { font-size: 11px; color: var(--text-secondary); }

/* 修正外观样式已随弹窗本体收编至 AppearanceRefineModal.vue */

.lora-civitai-label { font-size: 12px; color: var(--text-secondary); white-space: nowrap; margin: 0 2px; }
.lora-civitai-link, .lora-tutorial-link { font-size: 12px; color: var(--accent); text-decoration: none; white-space: nowrap; opacity: 0.85; transition: opacity 0.15s; }
.lora-civitai-link:hover, .lora-tutorial-link:hover { opacity: 1; text-decoration: underline; }
.lora-tutorial-link { margin-left: 6px; }

/* ═══ 内联布局（手机 + 放不下左右悬浮窗的窄视口，由模板 inlineLayout 决定渲染）═══
   上游 v3.9.1 把原来的 `@media (max-width:767px)` 改成按「有没有侧栏空间」判定（1532px），
   因为平板（768–1531）同样放不下左右两块悬浮窗，会两边看不全。
   这里把断点与模板的 inlineLayout 对齐（hasSideRoom = min-width:1532px）。
   几何与 LinsheModal 的移动端段落同口径：遮罩只收留白（8px + 安全区），面板保留
   圆角 / 描边 / 白内衬的浮层观感 —— 不要再退回 100vw/100dvh + border-radius:0 的全屏面板。
   正文改成「内容优先」的纵向流：头像 → 内容卡 → 更多设置，底部操作区固定。 */
@media (max-width: 1531px) {
  .modal-overlay {
    padding: calc(8px + env(safe-area-inset-top, 0px))
             calc(8px + env(safe-area-inset-right, 0px))
             calc(8px + env(safe-area-inset-bottom, 0px))
             calc(8px + env(safe-area-inset-left, 0px));
  }
  .modal-panel, .modal-wide { width: 100%; max-width: 100%; max-height: 100%; }
  .detail-panel { height: 100%; max-height: 100%; }

  /* 安全区由上方的遮罩留白让出，头部 / 底部不再各自叠加 */
  .modal-header { padding: 12px 16px; }
  .modal-header h3 { font-size: 15px; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
  .modal-close { flex-shrink: 0; }
  .modal-body { padding: 4px 14px 14px; }
  .modal-footer { padding: 10px 14px 14px; }

  .modal-body-detail { overflow-y: auto; }
  .modal-body-detail .preview-card { flex: none; padding: 14px; border-radius: 12px; }
  .modal-body-detail .prompt-textarea { flex: none; min-height: 300px; }
  .modal-wide .fi, .modal-wide .prompt-textarea { font-size: 16px; }

  /* 头像行：允许换行，誓约徽章不再把「更换头像 / 移除」挤出屏幕 */
  .detail-avatar-row { flex-wrap: wrap; gap: 12px; margin-bottom: 14px; padding: 0 2px; }
  .detail-avatar { width: 56px; height: 56px; font-size: 24px; }

  /* 角色关系：标题独占一行，入口按钮并排平分（原先是标题被两个按钮挤成两行） */
  .detail-rel-section { padding: 12px; margin-bottom: 14px; }
  .detail-rel-header { flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 10px; }
  .detail-rel-btns, .detail-rel-ctas { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .detail-rel-btn { width: 100%; justify-content: center; }

  /* 角色名 / 英文名：窄屏改单列，别把两个输入框挤进半屏 */
  .detail-name-row { flex-direction: column; gap: 10px; }

  /* 底部操作区：说明独占一行，删除 / 保存分列两端 */
  .detail-actions { flex-wrap: wrap; justify-content: space-between; gap: 10px; }
  .recruit-appearance-hint { order: -1; flex: 1 1 100%; margin-left: 0; white-space: normal; }

  /* 更多设置：与桌面端右侧悬浮面板同款卡片 */
  .mobile-detail-toolbar {
    display: flex; flex-direction: column;
    margin-top: 14px; padding: 8px;
    border-radius: 14px;
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
  }
  .toolbar-title { display: flex; align-items: center; gap: 5px; margin: 2px 6px 6px; font-size: 11px; font-weight: 700; letter-spacing: 1px; color: var(--text-secondary); }
  .toolbar-title svg { color: var(--accent); }
  .toolbar-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 6px; border-radius: 10px; color: var(--text-secondary); font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent; user-select: none; }
  .toolbar-item + .toolbar-item { border-top: 1px solid var(--border); }
  .toolbar-item:active { background: rgba(var(--accent-rgb), 0.08); }
  .toolbar-item-toggle { cursor: default; }
  .toolbar-item-btn { color: var(--accent); font-weight: 600; }
  .toolbar-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg-tertiary); color: var(--text-secondary); flex-shrink: 0; }
  .toolbar-badge.active { background: rgba(var(--accent-rgb), 0.15); color: var(--accent); }

  .form-group .fl { font-size: 12px; }
  .form-hint { font-size: 10px; }
}
</style>
