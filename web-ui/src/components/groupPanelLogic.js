/**
 * 群聊里的「🧸 玩具 / ❤ 推进」入口逻辑（2026-10-02 用户：「群聊里也没有动作系统和玩具 性爱系统的按钮」）
 *
 * 群聊与私聊的关键差别：**群里有很多人**，而这两个面板一次只能作用于一个人
 * （私聊里 `:character-id` 就是当前会话角色，群里必须由用户先指定"对谁"）。
 *
 * 所以把"该不该打开、打开谁"抽成纯函数放在这里 —— 视图只负责调它、把 id 喂给面板：
 *   · 没选目标 ⇒ 返回一句人话，**不打开面板、也不默认拿第一个群成员**（用户明确要求：不要默默无反应）；
 *   · 选的人已经不在当前群里（换群 / 退群）⇒ 同样拒绝，并提示重选；
 *   · 选好了 ⇒ 返回那个人 id，调用方拿去传 `:character-id`。
 *
 * ⚠️ 为什么不在视图里内联判断：这几条口径（尤其是"绝不默认第一个成员"）要靠测试钉住，
 *    而 SFC 里的内联逻辑测不到 —— 纯函数才能"钉行为"而不是"钉源码里有没有某一行"。
 */

export const GROUP_PANEL_HINTS = Object.freeze({
  noMembers: '这个群里还没有成员',
  noTarget: '先在「✋ 动作」里选一个人，再开玩具 / 推进面板',
  gone: '你选的那个人已经不在这个群里了，重新选一个吧',
})

/**
 * 判断能不能为当前选中的群成员打开面板。
 *
 * @param {{ targetId?: number|string|null, members?: Array<{id:number|string, display_name?:string}> }} input
 * @returns {{ ok:true, characterId:number|string, name:string }
 *          | { ok:false, code:'no_members'|'no_target'|'target_gone', message:string }}
 */
export function resolveGroupPanelTarget({ targetId = null, members = [] } = {}) {
  const list = Array.isArray(members) ? members : []
  if (list.length === 0) {
    return { ok: false, code: 'no_members', message: GROUP_PANEL_HINTS.noMembers }
  }
  // 只在"确实没选"时提示 —— 注意这里**故意**不回落到 list[0]：
  // 默认第一个人会让用户以为"点一下就能玩"，实际作用在别人身上，是更难查的错。
  if (targetId === null || targetId === undefined || targetId === '') {
    return { ok: false, code: 'no_target', message: GROUP_PANEL_HINTS.noTarget }
  }
  const hit = list.find((m) => String(m?.id) === String(targetId))
  if (!hit) {
    return { ok: false, code: 'target_gone', message: GROUP_PANEL_HINTS.gone }
  }
  return {
    ok: true,
    characterId: hit.id,
    name: String(hit.display_name || '').trim(),
  }
}

/** 两个入口的文案（供视图与测试共用，避免两处各写一份） */
export const GROUP_PANEL_META = Object.freeze({
  toy: {
    key: 'toy',
    ariaLabel: '玩具',
    titleClosed: '玩具（先选一个人）',
    titleOpen: '收起玩具面板',
  },
  intimate: {
    key: 'intimate',
    ariaLabel: '推进',
    titleClosed: '推进（继续抽插 / 加速 / 换姿势）（先选一个人）',
    titleOpen: '收起推进面板',
  },
})

/**
 * 群聊面板的初始状态。**换目标时要回到这个状态**（见 `panelStateOnTargetChange`）。
 * 抽成常量而不是在视图里散写三个 `= false/[]`，是为了让"关干净"有唯一定义 ——
 * 漏关一个字段（比如忘了清 `groupWornToys`）会表现为"面板关了但角标还挂着上一个人的玩具"。
 */
export const EMPTY_GROUP_PANEL_STATE = Object.freeze({
  showToyPanel: false,
  showIntimatePanel: false,
  groupWornToys: [],
  groupToyOptions: [],
})

/**
 * 换目标（或换群导致目标被清空）后，两个面板该变成什么样。
 *
 * ## 为什么要有这个纯函数（2026-10-18 补）
 * 这条行为原来是 `GroupChatView.vue` 里一个内联的 `watch(touchTargetId, () => { … })`。
 * 它**结构上无法用浏览器 E2E 驱动**：要验"面板会自动关"，前提是面板正开着；而面板一开，
 * 它自己的 `LinsheModal` 遮罩就压在那排图标上，Playwright 点不到触发换人的按钮
 * （会一直重试到超时）。所以 `e2e/check-group-panels.mjs` 的 ⑦ 一直只能挂 SKIP。
 *
 * 这条行为本身很重要：面板里的 `characterId` 是**打开那一刻锁定**的，
 * 换了目标却让面板继续开着，就会"看着是 A 的面板、实际动作落在 B 身上"——
 * 属于很难查的错（用户以为在跟 A 互动）。所以它不能只靠"人工点一次"兜着。
 *
 * 抽成纯函数之后：口径可被单测钉住（见 `web-ui/test/groupPanelTargetSwitch.test.js`），
 * 视图只负责把返回值铺到 ref 上；E2E 那条 SKIP 也就有了明确的替代验收方式。
 *
 * @param {{ prevTargetId?: number|string|null, nextTargetId?: number|string|null }} input
 * @returns {typeof EMPTY_GROUP_PANEL_STATE} 目标**变了**（含从有到无、从无到有）就是空状态；
 *          目标没变则返回 null —— 调用方据此跳过写入，避免"点开面板时因为无关重渲染被关掉"。
 */
export function panelStateOnTargetChange({ prevTargetId = null, nextTargetId = null } = {}) {
  const norm = (v) => (v === null || v === undefined || v === '' ? '' : String(v))
  if (norm(prevTargetId) === norm(nextTargetId)) return null
  return { ...EMPTY_GROUP_PANEL_STATE }
}
