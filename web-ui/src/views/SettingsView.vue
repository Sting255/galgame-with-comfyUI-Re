<template>
  <div ref="scrollEl" class="settings-view" @scroll="onSettingsScroll">
    <div class="page-header" :class="{ 'header-hidden': isMobile && !headerVisible }">
      <h2 @click="isMobile && toggleMobileSidebar()" :class="{ 'is-clickable': isMobile }">系统参数</h2>
      <div class="header-meta">
        <span class="hint">修改即时生效，无需重启</span>
        <update-tag />
      </div>
    </div>

    <!-- 运行状态（2026-11-06）：把「后台在静默失败」变成看得见的一行 -->
    <div class="settings-standalone">
      <RuntimeHealthPanel />
    </div>

    <!-- 设备连接（2026-11-06 真机反馈）：它和下面那张很长的「画师串」卡同处一个 grid 行时，
         行高由后者决定，卡片底下会空出一大截。移出 grid 单独占一行。 -->
    <div class="settings-standalone">
      <DeviceAccessPanel />
    </div>

    <div class="settings-grid">
      <!-- ComfyUI params: 对话配图 / 朋友圈配图 / 奇遇配图（Tab 切换） -->
      <ImageParametersPanel />

      <!-- 测试画风：自由画面描述（LLM 完善提示词）或固定提示词测试 -->
      <ImageLabPanel />

      <!-- LLM API 设置 -->
      <LlmConnectionPanel />

      <!-- 全角色统一服装（2026-11-07）：设置里定义一次，对所有人生效 -->
      <div class="card">
        <GlobalOutfitTypesPanel />
      </div>

      <!-- 功能开关 -->
      <FeatureSettingsPanel />

      <!-- 反重复 / 反钻牛角尖（专题·车轱辘话与钻牛角尖 · 阶段一）
           顶上三个开关是纯 prompt 增强（零额外 LLM 调用），默认开；关闭后与加功能前逐字节一致。
           「重写兜底」antiRepetitionReroll（专题 L4 / D2）**已接线**：默认关，打开后每触发一次会**多消耗一次模型调用**，
           故说明里写明代价；替换语义见 stores/chat.js 与 docs/chat/anti-repetition.md。 -->
      <AntiRepetitionPanel />

      <!-- SLG 动作系统（触摸互动 · 专题-SLG动作系统）
           前两个开关默认开：总开关控制聊天页动作条与 POST /touch；即时反应关掉后走"隐式注入"，
           她的反应并进下一轮回复，不额外调用模型（配额清零只影响即时那条路）。
           第三个（群聊敏感动作）**默认关**：关着时群里点 Lv3 一律被拦，行为与加开关前一致。 -->
      <TouchSettingsPanel />

      <!-- 生图服务连接 -->
      <ImageConnectionPanel />

      <!-- 聊天记忆 -->
      <div class="card memory-settings-card">
        <div class="memory-settings-header">
          <div>
            <h3>聊天记忆</h3>
            <p>PAI风格记忆整理：让角色记住你们聊过的重要事情，并在之后的聊天中自然想起来</p>
          </div>
        </div>

        <!-- 状态与配置提示：记忆"记不住 / 搜不到 / 整理没动静"的原因分散在多个开关里，
             这里把结论直接摆在卡片最上面，并明确这一块是可以配置的 -->
        <memory-health-panel mode="compact" class="memory-settings-health" />

        <div class="toggle-row memory-settings-row">
          <div class="memory-settings-copy">
            <div class="tl">启用聊天记忆</div>
          </div>
          <linshe-switch v-model="features.memory" :disabled="featureSaving.has('memory')" title="启用聊天记忆" aria-label="启用聊天记忆" @change="saveFeature('memory', features.memory)" />
        </div>

        <div
          role="button"
          tabindex="0"
          class="memory-settings-entry sheen"
          aria-label="打开记忆设置：调整智能匹配模型、整理节奏、记忆条数与归档管理"
          @click="router.push('/settings/memory')"
          @keydown.enter.prevent="router.push('/settings/memory')"
          @keydown.space.prevent="router.push('/settings/memory')"
        >
          <span class="memory-entry-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 7h10M18 7h2M4 17h2M10 17h10M9 4v6M15 14v6" />
            </svg>
          </span>
          <span class="memory-entry-copy">
            <span class="memory-entry-title">打开记忆设置</span>
            <span class="memory-entry-desc">智能匹配模型、整理节奏、记忆条数与归档，都在这里调</span>
            <span class="memory-entry-tags">
              <span class="memory-entry-tag">智能匹配模型</span>
              <span class="memory-entry-tag">整理节奏</span>
              <span class="memory-entry-tag">记忆条数</span>
              <span class="memory-entry-tag">归档管理</span>
            </span>
          </span>
          <span class="memory-entry-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </span>
        </div>
      </div>

      <!-- 破限规则集：入口卡片（复用「聊天记忆」入口样式，2026-10-15） -->
      <div class="card memory-settings-card">
        <div class="memory-settings-header">
          <div>
            <h3>破限规则集</h3>
            <p>给模型一段「别拒答」的底稿，并决定它注入哪些对话链路（私聊 / 群聊 / 奇遇 / 日程 / 朋友圈 …）</p>
          </div>
          <linshe-switch v-model="features.jailbreak" title="启用破限注入" aria-label="启用破限注入" @change="saveFeatureWithToast('jailbreak', features.jailbreak, '破限注入')" />
        </div>

        <div
          role="button"
          tabindex="0"
          class="memory-settings-entry sheen"
          aria-label="打开破限规则集：多套底稿切换、注入范围与正文编辑"
          @click="router.push('/settings/jailbreak')"
          @keydown.enter.prevent="router.push('/settings/jailbreak')"
          @keydown.space.prevent="router.push('/settings/jailbreak')"
        >
          <span class="memory-entry-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6zM9 12l2 2 4-4" />
            </svg>
          </span>
          <span class="memory-entry-copy">
            <span class="memory-entry-title">打开破限规则集</span>
            <span class="memory-entry-desc">多套底稿随时切换 · 按调用链投递 · 正文可编辑</span>
            <span class="memory-entry-tags">
              <span class="memory-entry-tag">规则集切换</span>
              <span class="memory-entry-tag">注入范围</span>
              <span class="memory-entry-tag">正文编辑</span>
            </span>
          </span>
          <span class="memory-entry-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </span>
        </div>
      </div>

      <!-- MaiBot 桥接：入口卡片（复用「聊天记忆」入口样式） -->
      <div class="card memory-settings-card maibot-settings-card">
        <div class="memory-settings-header">
          <div>
            <h3>MaiBot 桥接（需要邻舍v3.0.0以上支持）</h3>
            <p>管理注入到 MaiBot 主聊天流的人格信息（角色卡 / 风格 / 记忆）与全部插件参数</p>
          </div>
        </div>

        <div
          role="button"
          tabindex="0"
          class="memory-settings-entry sheen"
          aria-label="管理 MaiBot 桥接：连接设置、插件配置、人格信息与记忆整理"
          @click="router.push('/settings/maibot')"
          @keydown.enter.prevent="router.push('/settings/maibot')"
          @keydown.space.prevent="router.push('/settings/maibot')"
        >
          <span class="memory-entry-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 6h16v14H4zM9 3h6M10 3v3M14 3v3M7 11h2M7 14h4M15 11h2M15 14h2" />
            </svg>
          </span>
          <span class="memory-entry-copy">
            <span class="memory-entry-title">人格管理</span>
            <span class="memory-entry-desc">连接设置 · 插件配置 · 人格信息 · 最新记忆整理</span>
          </span>
          <span class="memory-entry-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </span>
        </div>
      </div>

      <!-- 更新说明：重新查看历次更新内容（平时只在版本变化后自动弹一次） -->
      <div class="card memory-settings-card">
        <div class="memory-settings-header">
          <div>
            <h3>更新说明</h3>
            <p>查看历次版本都改了什么，内容随版本一同发布</p>
          </div>
        </div>

        <div
          role="button"
          tabindex="0"
          class="memory-settings-entry sheen"
          aria-label="打开更新说明"
          @click="openChangelog"
          @keydown.enter.prevent="openChangelog"
          @keydown.space.prevent="openChangelog"
        >
          <span class="memory-entry-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5" />
            </svg>
          </span>
          <span class="memory-entry-copy">
            <span class="memory-entry-title">
              {{ changelogLatest ? `最新 ${changelogLatest.version}` : '更新说明' }}
            </span>
            <span class="memory-entry-desc">
              {{ changelogTotal ? `共 ${changelogTotal} 个版本 · 点击查看全文` : '暂无更新条目' }}
            </span>
          </span>
          <span class="memory-entry-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </span>
        </div>
      </div>

      <!-- 程序时间：白天/黑夜、第几天、快进 N 天、设定具体日期时间（现实模拟时钟） -->
      <div class="card card-full memory-settings-card time-control-card">
        <div class="memory-settings-header">
          <div>
            <h3>程序时间</h3>
            <p>游戏里的"现在几点"。快进一天或直接跳到某个日期，所有角色的日程与睡眠会跟着重算；聊天记录的时间戳仍按真实时间走</p>
          </div>
        </div>
        <TimeControlPanel />
      </div>

      <DataBackupPanel />
    </div>
  </div>
</template>

<script setup>
import DeviceAccessPanel from '../components/settings/DeviceAccessPanel.vue'
import RuntimeHealthPanel from '../components/settings/RuntimeHealthPanel.vue'
import DataBackupPanel from '../components/settings/DataBackupPanel.vue'
import LinsheSwitch from '../components/ui/LinsheSwitch.vue'
import MemoryHealthPanel from '../components/MemoryHealthPanel.vue'
import TimeControlPanel from '../components/TimeControlPanel.vue'
import UpdateTag from '../components/UpdateTag.vue'
import GlobalOutfitTypesPanel from '../components/settings/GlobalOutfitTypesPanel.vue'
import { provide } from 'vue'
import { useSettingsPage } from '../composables/settings/useSettingsPage.js'
import { SETTINGS_PAGE_CONTEXT } from '../composables/settings/settingsContext.js'
import ImageParametersPanel from '../components/settings/ImageParametersPanel.vue'
import ImageLabPanel from '../components/settings/ImageLabPanel.vue'
import LlmConnectionPanel from '../components/settings/LlmConnectionPanel.vue'
import ImageConnectionPanel from '../components/settings/ImageConnectionPanel.vue'
import FeatureSettingsPanel from '../components/settings/FeatureSettingsPanel.vue'
import AntiRepetitionPanel from '../components/settings/AntiRepetitionPanel.vue'
import TouchSettingsPanel from '../components/settings/TouchSettingsPanel.vue'
const context = useSettingsPage()
provide(SETTINGS_PAGE_CONTEXT, context)
const { onSettingsScroll, isMobile, headerVisible, toggleMobileSidebar, features, featureSaving, saveFeature, router, saveFeatureWithToast, openChangelog, changelogLatest, changelogTotal, scrollEl } = context
</script>

<style scoped>
.settings-view { padding: 32px; overflow-y: auto; height: 100vh; height: 100dvh; flex: 1; }
.page-header {
  margin-bottom: 28px;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
  position: relative;
  z-index: 20;
}
.page-header.header-hidden { transform: translateY(-200%); margin-bottom: 0; }
.page-header h2 { font-size: 24px; color: var(--text-bright); font-weight: 700; }
.is-clickable { cursor: pointer; }
.header-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 4px; }
.hint { font-size: 13px; color: var(--text-secondary); }

.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.settings-standalone { margin-bottom: 16px; }
.memory-settings-card { gap: 0; }
.time-control-card .memory-settings-header { margin-bottom: 12px; }

.maibot-settings-card .memory-settings-entry { margin-top: 14px; }
.memory-settings-header h3 { margin-bottom: 4px; }
.memory-settings-header p {
  max-width: 560px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.memory-settings-copy { flex: 1; min-width: 0; }
.memory-settings-row { margin-top: 6px; }
.memory-settings-health { display: block; margin-top: 12px; }
.memory-entry-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.memory-entry-tag {
  font-size: 11px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 999px;
  padding: 1px 8px;
  line-height: 1.7;
}
.memory-settings-entry {
  width: 100%; min-height: 68px; margin-top: auto; padding: 12px 14px;
  display: flex; align-items: center; gap: 12px;
  color: var(--text-primary); text-align: left;
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 12px;
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s var(--ease-out);
}
.memory-settings-entry:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  box-shadow: var(--shadow-sm), var(--shadow-hard-sm);
  transform: translateY(-2px);
}
.memory-settings-entry:active { background: rgba(var(--accent-rgb), 0.16); }
.memory-settings-entry:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.memory-entry-icon {
  width: 40px; height: 40px; flex: 0 0 40px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 13%, transparent);
  border: 1.5px solid color-mix(in srgb, var(--accent) 20%, transparent);
  border-radius: 12px;
}
.memory-entry-icon svg,
.memory-entry-arrow svg {
  width: 20px; height: 20px;
  fill: none; stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round;
}
.memory-entry-copy { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 2px; }
.memory-entry-title { color: var(--text-bright); font-size: 14px; font-weight: 600; line-height: 1.4; }
.memory-entry-desc { color: var(--text-secondary); font-size: 12px; line-height: 1.4; }
.memory-entry-arrow {
  width: 32px; height: 40px; flex: 0 0 32px;
  display: inline-flex; align-items: center; justify-content: flex-end;
  color: var(--text-secondary);
  transition: color 0.2s ease, transform 0.2s ease;
}
.memory-settings-entry:hover .memory-entry-arrow { color: var(--accent); transform: translateX(2px); }
.card {
  padding: 24px;
  display: flex;
  flex-direction: column;
}
.card-full { grid-column: 1 / -1; margin-top: 16px; }
.card h3 { font-size: 15px; color: var(--text-bright); margin-bottom: 12px; font-weight: 600; }

.toggle-row { display: flex; gap: 14px; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--glass-border); }
.toggle-row:last-child { border-bottom: none; }
.tl { font-size: 14px; font-weight: 500; color: var(--text-bright); }
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
@media (max-width: 767px) {
  .settings-view { padding: 16px; }
  .page-header {
    position: sticky; top: 0; z-index: 20;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    padding: 8px 0; margin-bottom: 20px;
  }
  .settings-grid { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .memory-settings-entry,
  .memory-entry-arrow,
  .thinking-option span,
  .thinking-options::before { transition: none; }
  .memory-settings-entry:hover .memory-entry-arrow { transform: none; }
}
</style>
