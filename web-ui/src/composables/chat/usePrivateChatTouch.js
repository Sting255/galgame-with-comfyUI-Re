import { ref, computed, watch } from 'vue'
import { useChatActionPanels } from '../useChatActionPanels.js'
import { buildGroupsFromServer, createCoalescer, hypnosisBadgeOf, pendingHintByMode } from '../../components/touchActionLogic.js'
import { getHypnosisState } from '../../api/hypnosis.js'
import * as api from '../../api/index.js'

export function usePrivateChatTouch({ chat, toastFn, isCharSleeping, impressionAffinity }) {
  // ── SLG 动作系统（阶段一·前端）：私聊动作条（task-15 接线）──
  // **门控以服务端为准**：GET /api/characters/:id/touch/actions 里逐 key 的 gate 就是 getTouchGate
  // 的真实结果（含催眠豁免、Lv3 亲密看板授权），前端零翻译、零自算。
  // 下面的 touchGateState 只是**端点不可用时的镜像兜底**（见 docs/characters/touch-system.md §6.3 / §4）。
  const touchServerGroups = ref([])

  async function loadTouchActions() {
    const charId = chat.activeCharId
    if (!charId) { touchServerGroups.value = []; return }
    try {
      const payload = await api.fetchTouchActions(charId, { scene: 'chat' })
      // 拉取期间可能已切换角色：丢弃过期响应
      if (chat.activeCharId !== charId) return
      touchServerGroups.value = buildGroupsFromServer(payload)
    } catch (err) {
      // 端点不可用 → 清空，组件自动回落到镜像门控，功能不至于全废
      console.warn('[touch] 动作清单拉取失败，回落镜像门控:', err?.message || err)
      touchServerGroups.value = []
    }
  }

  // ── 待回应条数（task-25 ③；task-29 问题 3 补「被消费后刷新」）──
  // 数据：GET .../touch/state 的 pendingCount —— 动作做下、还等着她回应的条数。
  // 读不到 / 非数字一律当 0（不显示提示行、不弹错）。
  const touchPendingCount = ref(0)

  /** 分模式待回应数（专题 §七 问题 3；后端未落地时为空对象 → 文案回落） */
  const touchPendingByMode = ref({})

  /** 入口角标标题 / 面板提示行同源文案 */
  const touchPendingHint = computed(() => pendingHintByMode({ count: touchPendingCount.value, byMode: touchPendingByMode.value }))

  /** 动作面板显隐（✋ 入口点开） */
  const { showTouchPanel, showToyPanel, showIntimatePanel, togglePanel } = useChatActionPanels(() => chat.activeCharId)

  /** 每动作的耐受 / 偏好（GET /touch/state 的 states）→ 面板卡片状态行与偏好角标 */
  const touchStates = ref({})

  // ── 玩具系统（2026-09-30 三期，契约见 docs/characters/toys.md）────────────────────────────
  // 门控**一律服务端说了算**（gate.allowed / gate.message 原样吃），前端不算门槛；
  // 未解锁或端点不可用 ⇒ 整块不渲染（不伪造数据）。修复真机反馈：之前父组件漏传这两个 prop、
  // 也漏接三个事件 ⇒ 面板玩具区永远不出现。

  const toysEnabled = ref(false)

  const wornToys = ref([])

  /**
   * 背包可选项（服务端下发，带逐件 gate）。
   * 2026-10-01 修：原来**没把服务端清单传给面板**，ToyPanel 就回落到前端镜像
   * （`toy.js` 里写死 `gate:{allowed:true}`）—— 结果是服务端会拒的玩具在面板上照样是"亮"的，
   * 点下去只吃到 403 错误 toast，而不是服务端那句剧情文案；「门控服务端说了算」在这个面板上等于没落地。
   */
  const toyOptions = ref([])

  async function loadToys() {
    const charId = chat.activeCharId
    if (!charId) { toysEnabled.value = false; wornToys.value = []; toyOptions.value = []; return }
    try {
      const res = await api.fetchToys(charId)
      if (chat.activeCharId !== charId) return          // 期间换了角色：丢弃过期响应
      toysEnabled.value = res?.unlocked === true
      wornToys.value = Array.isArray(res?.worn) ? res.worn : []
      toyOptions.value = Array.isArray(res?.available) ? res.available : []
    } catch {
      toysEnabled.value = false
      wornToys.value = []
      toyOptions.value = []
    }
  }

  /** 面板打开：门控/腻烦度可能变了，玩具状态也一起刷新 */
  // ── 催眠状态徽标（复审遗留 2）──
  // **状态一律服务端说了算**：读 GET /characters/:id/hypnosis 的 { active, mindAwake }，
  // 前端不做任何本地推断；取不到 / 形状不对 ⇒ null（面板不渲染，绝不默认「完全控制」）。
  const touchHypnosisBadge = ref(null)

  async function loadTouchHypnosis() {
    const charId = chat.activeCharId
    if (!charId) { touchHypnosisBadge.value = null; return }
    try {
      const st = await getHypnosisState(charId)
      if (charId !== chat.activeCharId) return   // 过期响应丢弃（切角色了）
      touchHypnosisBadge.value = hypnosisBadgeOf(st)
    } catch {
      touchHypnosisBadge.value = null   // 取不到就不显示，绝不猜
    }
  }

  function onTouchPanelOpen() { loadTouchActions(); loadToys(); loadTouchHypnosis() }

  async function onToyEquip(toyKey) {
    const charId = chat.activeCharId
    if (!charId) return
    try {
      const res = await api.equipToy(charId, toyKey, { intensity: 1 })
      toastFn?.(res?.toy?.label ? `已给她戴上：${res.toy.label}` : '已经戴上了', 'info')
      await loadToys()
    } catch (err) {
      toastFn?.(err?.message || '没戴上', 'error')   // 门控被拒时后端会带人话文案
    }
  }

  async function onToyIntensity({ toyKey, intensity } = {}) {
    const charId = chat.activeCharId
    if (!charId || !toyKey) return
    try {
      await api.setToyIntensity(charId, toyKey, intensity)
      await loadToys()
    } catch (err) { toastFn?.(err?.message || '强度没调成', 'error') }
  }

  async function onToyRemove(toyKey) {
    const charId = chat.activeCharId
    if (!charId) return
    try {
      await api.removeToy(charId, toyKey)
      await loadToys()
    } catch (err) { toastFn?.(err?.message || '没摘下来', 'error') }
  }

  async function loadTouchState() {
    const charId = chat.activeCharId
    if (!charId) { touchPendingCount.value = 0; touchStates.value = {}; return }
    try {
      const payload = await api.fetchTouchState(charId)
      if (chat.activeCharId !== charId) return          // 期间换了角色：丢弃过期响应
      const raw = Number(payload && payload.pendingCount) || 0
      touchPendingCount.value = raw > 0 ? Math.floor(raw) : 0
      // 卡片状态行（耐受档 / 偏好角标）吃 states；缺字段就空着，不影响可用性
      touchStates.value = payload && payload.states && typeof payload.states === 'object' ? payload.states : {}
    } catch (err) {
      // 端点不可用：这只是个提示，静默归零，别打断主流程
      touchPendingCount.value = 0
      touchStates.value = {}
    }
  }

  // 她回应那一轮会连续插好几条消息（见下面 messages.length 监听）——合并成一次刷新，别把请求打爆
  const touchStateCoalescer = createCoalescer({ run: () => { loadTouchState() } })

  function scheduleTouchStateRefresh() { touchStateCoalescer.schedule() }

  // 切角色时重拉；展开动作条时也会再刷（见模板 @open）——门控依赖好感 / 睡眠 / 誓约，会变
  // task-29：顺带取消上一轮待合并的刷新（别让上一个角色的响应落到新角色头上），并立刻重拉条数
  // 2026-10-01：`loadToys()` 也挂进来（immediate ⇒ 初次进页面就跑）。原来它只在「点开 ✋ 动作面板」
  // 和装卸玩具之后被调用 ⇒ **冷启动 / 换角色时 🧸 入口根本不渲染**（`v-if="toysEnabled"` 还是 false），
  // 用户必须先开一次 ✋ 才看得到玩具入口。
  watch(() => chat.activeCharId, () => {
    touchStateCoalescer.cancel()
    loadTouchActions()
    loadTouchState()
    loadToys()
  }, { immediate: true })

  // 镜像门控入参：与服务层 getTouchGate 同名。**仅在服务端不可用时生效**
  // （intimateAuthorized / hypnotized 前端没有独立来源，兜底路径按保守值处理）
  const touchGateState = computed(() => ({
    affinity: impressionAffinity.value,
    isOath: !!chat.activeChar?.is_oath,
    sleeping: isCharSleeping.value,
    scene: 'chat',
    intimateAuthorized: false,
    hypnotized: false,
  }))

  // 正在上报的动作 key：请求期间该胶囊转 loading，并忽略连点
  // §4.2 连点：**同动作在飞时忽略重复点击、不同动作可并发** ⇒ 单个 key 换成 Set
  const touchBusyActions = ref(new Set())

  async function onTouchAction(actionId) {
    const charId = chat.activeCharId
    if (!charId || !actionId || touchBusyActions.value.has(actionId)) return
    touchBusyActions.value = new Set(touchBusyActions.value).add(actionId)
    // 建议 2（专题 §九）：**乐观插入占位** —— 覆盖 0~3 秒的 POST 等待期。
    // （之前放在 await 之后：卡片转 3 秒 spinner 占位才出现，它自己没赶上要盖的静默期。）
    // 门控拒绝 / 异常 / 隐式模式在下面立刻撤；真消息到达由 store 自己撤；15s 超时兜底。
    chat.showTouchPlaceholder?.()
    try {
      const res = await api.performTouchAction(charId, actionId, { scene: 'chat' })

      // 门控拒绝 = **200 + { allowed:false, code, message }**（“她不愿意”是叙事结果，不是请求失败）
      // → 撤占位 + 直接 toast 服务端那句人话；**绝不伪造她的反应**
      if (!res || res.allowed !== true) {
        chat.clearTouchPlaceholder?.()   // 被拒：她不会有反应，占位不能留着
        if (res?.message) toastFn?.(res.message, 'info')
        return
      }
      // 真机反馈问题 2：她开始说话了，面板让位（隐式模式这轮没反应 ⇒ 留着让用户接着来）
      // §4.2：「成功后自动收起」**作废**（§七那条被推翻）—— 面板常驻，用户要连着摸、连点。
      // 隐式模式这轮她不会立刻反应 ⇒ 撤占位（否则误导）；非隐式留着占位，等真消息到达由 store 撤。
      if (res.mode === 'implicit') chat.clearTouchPlaceholder?.()
      if (res.notice) toastFn?.(res.notice, 'info')
      else if (res.mode === 'implicit') toastFn?.('她的反应会在你下次发言时出现', 'info')

      // 即时反应后端已 writeProactiveMessage 落库 + broadcastProactiveMessage 广播：
      // 本页既有链路（App.vue → chat.handleProactiveMessage）会把它当作「她的新消息」插进消息流。
      // 所以这里**不手动渲染、不重复插入**（免得与广播打架，也符合「别另造一套」）。
    } catch (err) {
      // 400 非法 action / 404 角色不存在 / 409 动作系统已关闭
      chat.clearTouchPlaceholder?.()   // 异常路径：占位绝不残留（超时兜底之外的第一道）
      toastFn?.(err?.message || '动作失败', 'error')
    } finally {
      touchBusyActions.value.delete(actionId)
      loadTouchActions()   // 门控 / 腻烦度可能变了，刷新一次
      loadTouchState()     // 待回应条数也变了（task-25 ③）
    }
  }

  return { scheduleTouchStateRefresh, showIntimatePanel, showTouchPanel, touchServerGroups, touchGateState, touchBusyActions, touchHypnosisBadge, touchPendingCount, touchPendingByMode, touchStates, onTouchAction, onTouchPanelOpen, showToyPanel, wornToys, toyOptions, onToyEquip, onToyIntensity, onToyRemove, toysEnabled, touchPendingHint, togglePanel }
}
