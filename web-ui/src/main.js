// 全局样式体系：字体 → token → 基础 → 组件类 → 动效
// HarmonyOS Sans 由 Vite 打包（src/assets/fonts），与旧版字体加载方式一致
import './assets/fonts/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/animations.css'
import { initTheme } from './theme.js'
// 坏图兜底（2026-10-02）：库里 606 条 /images/** 引用指向已被清理的图 ⇒ 装一个全局兜底，
// 图片加载失败时隐藏、或按 data-img-fallback="text" 换成中文占位，不再出现浏览器碎图。
// 只处理同源的 /images/** 与 /avatars/**（外链与 data: 不碰）⇒ 正常图片零影响。
import { installImageFallback } from './imageFallback.js'

// 挂载前同步应用本地主题，避免首帧闪烁
initTheme()
// 越早装越好：首屏渲染出来的图也走同一套兜底
installImageFallback()

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './AppRoot.vue'
// 小镇（世界页）已于 2026-10-20 从产品里彻底剥离：页面、子组件、渲染器、store 全部删除。
// 上游 4.1.0 的 TownView 一并拒绝：路由与页面都不再注册（保留删除，不随上游回退）。

const StandingDisplayView = () => import('./views/StandingDisplayView.vue')
const ChatView = () => import('./views/ChatView.vue')
const MomentsView = () => import('./views/MomentsView.vue')
const EventsView = () => import('./views/EventsView.vue')
const ScheduleView = () => import('./views/ScheduleView.vue')
const GalleryView = () => import('./views/GalleryView.vue')
const DormView = () => import('./views/DormView.vue')
const TavernView = () => import('./views/TavernView.vue')
const MailboxView = () => import('./views/MailboxView.vue')
const BackpackView = () => import('./views/BackpackView.vue')
const SettingsView = () => import('./views/SettingsView.vue')
const MemorySettingsView = () => import('./views/MemorySettingsView.vue')
const JailbreakSettingsView = () => import('./views/JailbreakSettingsView.vue')
const MaibotBridgeView = () => import('./views/MaibotBridgeView.vue')
const GroupChatView = () => import('./views/GroupChatView.vue')
const MediaView = () => import('./views/MediaView.vue')
const GodSaysView = () => import('./views/GodSaysView.vue')

const routes = [
  { path: '/standing-display', component: StandingDisplayView, meta: { standingDisplay: true } },
  { path: '/', redirect: '/chat' },
  { path: '/chat', component: ChatView },
  { path: '/god-says', component: GodSaysView },
  { path: '/chat/:id', component: ChatView },
  { path: '/group/:id', component: GroupChatView },
  { path: '/moments', component: MomentsView },
  { path: '/events', component: EventsView },

  { path: '/media', component: MediaView },   // 上游 v3.9.0 合并：媒体内容页
  { path: '/schedule', component: ScheduleView },
  { path: '/gallery', component: GalleryView },
  { path: '/dorm', component: DormView },   // 宿舍页：房间与入住安排（2026-11-07 取代原地图页）
  { path: '/tavern', component: TavernView },
  { path: '/mailbox', component: MailboxView },
  { path: '/backpack', component: BackpackView },
  { path: '/settings', component: SettingsView },
  { path: '/settings/memory', component: MemorySettingsView },
  { path: '/settings/jailbreak', component: JailbreakSettingsView },   // 破限规则集（2026-10-15）
  { path: '/settings/maibot', component: MaibotBridgeView },
  // 已剥离页面（如旧书签 #/town）统一回聊天，别让用户停在空白壳
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
]

const router = createRouter({ history: createWebHashHistory(), routes })
const pinia = createPinia()

const app = createApp(App).use(router).use(pinia)
router.isReady().then(() => app.mount('#app'))
