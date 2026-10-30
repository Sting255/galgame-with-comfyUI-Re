import { defaultBackupFileName, parseBackupFileName } from '../utils/dataBackup.js'

const BASE = '/api'

// 统一请求基元：非 2xx 自动抛出服务端错误信息（4xx 取人话 `message`，5xx 只取机器码 `error`），成功返回解析后的 JSON。
//
// 解析策略（2026-10-15 漏合并修复，对齐上游 v3.9.0 的意图但**不破坏本地 mock 形态**）：
//   1. 先试 `res.json()` —— 真实 Response 与既有测试 mock 都走这条，行为与改动前逐字节一致；
//   2. `json()` 不可用或抛错（非 JSON，多半是 Express 默认 HTML 错误页）时，回落 `res.text()` + 手动 parse。
// 为什么不能一刀切改成 `text()`：那样 30 个既有测试的 mock（`text: async () => ''` + `json: async () => body`）
// 会全部拿到空对象。而 `json()` 优先让两种 mock 形态都能活，且**仍然保留上游最看重的那条能力** ——
// "404 + 拿不到结构化 error ⇒ 路由没注册（后端是旧代码）" 的人话提示（已踩三次：日报删除/传媒批量操作/外观扩写）。
async function request(path, { method = 'GET', body, headers, signal } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  let result = {}
  // `json()` 不可用（部分测试 mock 只提供 text()）或抛错（非 JSON，多半是 Express 默认 HTML 错误页）
  // 时，都要回落 `text()` + 手动 parse —— 早先只 catch 了抛错，漏了"方法不存在"这条，导致那些
  // mock 解出空对象、服务端返回的 event 被丢弃（eventChoiceCountdown 的服务端覆盖断言就是这么挂的）。
  let parsed = false
  if (typeof res.json === 'function') {
    try {
      result = await res.json()
      parsed = true
    } catch { /* 非 JSON，走下面的 text() 回落 */ }
  }
  if (!parsed && typeof res.text === 'function') {
    try {
      const raw = await res.text()
      result = raw ? JSON.parse(raw) : {}
    } catch { /* 真的不是 JSON（Express 默认 HTML 错误页） */ }
  }
  if (!res.ok) {
    // 404 + 拿不到结构化 error ⇒ 路由没注册（后端是旧代码），而不是"功能坏了"。
    // ⚠️ 消息里必须保留 `404` 与 `not found`：调用方（如 getTimePerception）是按
    // `/not found|Cannot GET|请求失败 \(404\)/` 认这个错再翻成自己的专业人话的，
    // 换成别的措辞会让那些翻译集体失效（timeControlPerception.test.js 钉着这条）。
    const isMissingRoute = res.status === 404 && !result.error && !result.message
    if (isMissingRoute) {
      throw new Error('接口不存在 (404 not found)：后端服务还是旧代码，请先在启动器里重启服务再试')
    }
    // 2026-10-01 修：**4xx 优先取人话（`message`）**。本仓约定是 `error` = 机器码、`message` = 人话，
    // 而所有调用点都写成 `toast(err.message)`。具体踩到的坑：玩具门控被拒返回
    // `403 { error:'toy_gate_blocked', code:'affinity_low', message:'她握住你的手腕，摇头。…' }`，
    // 原来先取 `error` ⇒ 用户看到的是 `toy_gate_blocked` 这串代码，看着就是「玩具一点就报错」。
    // 5xx 维持原样（只取 `error`）：errorHandler 的注释写明 5xx 的 err.message 可能含 SQL / 路径细节，不透给界面。
    // ⚠️ 这里**不要加可选链**（`result?.message`）：`realMachineFeedback20261001.test.js` 有一条
    // 源码文本守卫钉的就是 `result.message || result.error` 这个写法，加了它那条会红。
    const detail = res.status < 500 ? (result.message || result.error) : result.error
    throw new Error(detail || `请求失败 (${res.status})`)
  }
  return result
}

// 统一 SSE 解析循环：按行解析 event:/data: 帧，每帧回调 onEvent(event, data)。
// data 帧回调 JSON 解析后的对象；仅 event 行时 data 为 undefined。
// 读取错误向上抛（由调用方决定静默断开还是向下游报错），流自然结束则正常返回。
async function consumeSSE(res, onEvent) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventType = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim()
        onEvent(eventType, undefined)
      } else if (line.startsWith('data: ')) {
        try {
          onEvent(eventType, JSON.parse(line.slice(6)))
        } catch { /* ignore parse errors */ }
      }
    }
  }
}

// ── 应用自身版本 ──
// 后端读仓库根目录 VERSION 给出的版本号（不带 v）。「本地装的是哪版」只有本机能知道，
// 所以这一步走后端；对比 GitHub 上有没有新 tag 那一步是浏览器直连，不走后端。
export async function getAppVersion() {
  const data = await request('/version')
  return String(data?.version || '')
}

// ── Characters ──
export async function listCharacters() {
  return request(`/characters`)
}

export async function getMessages(characterId) {
  return request(`/characters/${characterId}/messages`)
}

export async function updateCharacter(id, data) {
  return request(`/characters/${id}`, { method: 'PUT', body: data })
}

// 设置角色置顶状态（幂等写入，不是 toggle —— 传目标值）
export async function togglePin(characterId, pinned) {
  return request(`/characters/${characterId}/pin`, { method: 'PUT', body: { pinned } })
}

// ── 角色专属外观/形态 ──
export function listCharacterOutfits(characterId) {
  return request(`/characters/${characterId}/outfits`)
}

export function createCharacterOutfit(characterId, data) {
  return request(`/characters/${characterId}/outfits`, { method: 'POST', body: data })
}

export function updateCharacterOutfit(characterId, outfitId, data) {
  return request(`/characters/${characterId}/outfits/${outfitId}`, { method: 'PUT', body: data })
}

export function deleteCharacterOutfit(characterId, outfitId) {
  return request(`/characters/${characterId}/outfits/${outfitId}`, { method: 'DELETE' })
}

// ── 事件库 / 话题库：参考图 → 场景方向（2026-10-13 合并上游 v3.9.0）──
/** 上传参考图转写成中文场景方向，供 generate 的 direction 输入框使用 */
export function describeLibraryImage(payload) {
  return request('/library/describe-image', { method: 'POST', body: payload })
}

// ── 场景服装（五态 + 身体单一真源，2026-10-13 合并上游 + PR #24）──/** 列场景服装：{ scenes:[{key,label}], body, outfits:[{scene,name,description,body,text}] } */
export function listSceneOutfits(characterId) {
  return request(`/characters/${characterId}/outfit-scenes`)
}

/** 此刻该穿哪套（source: sleep / schedule / fallback） */
export function getCurrentSceneOutfit(characterId) {
  return request(`/characters/${characterId}/outfit-now`)
}

/**
 * 用 LLM 生成/补全场景外观；save=true 时直接落库。
 * @param {object} [extra]
 * @param {Array<{scene,name,body,description}>} [extra.seeds] 已填分项（反推锚点），本次只补未填的
 * @param {string[]} [extra.scenes] 只补这几套；不传则由后端挑未填的
 * @param {string} [extra.baseAppearance] 没有任何 seed 时的身体来源兜底（如角色卡外观段）
 */
export function generateSceneOutfits(characterId, save = false, extra = {}) {
  return request(`/characters/${characterId}/outfits/generate`, { method: 'POST', body: { save, ...extra } })
}

/**
 * 批量保存五套场景外观（同场景已存在则更新）。
 * @param {Array<{scene,name,description}>} outfits description 只填"这一套的衣服"
 * @param {string} [body] 身体描述 —— 单一真源，后端会同步写进该角色全部服装行
 */
export function saveSceneOutfits(characterId, outfits, body) {
  return request(`/characters/${characterId}/outfits/scene`, {
    method: 'PUT',
    body: body != null ? { outfits, body } : { outfits },
  })
}

// ── 日程生成开关（上游 v3.10.0 合并，2026-10-19）──
// 关掉即不再为该角色刷新日程（省 LLM 调用），已生成的模板照旧铺垫当天日程。
export function setCharacterScheduleEnabled(characterId, enabled) {
  return request(`/characters/${characterId}/schedule-enabled`, { method: 'PUT', body: { enabled } })
}

// 批量开关全体角色的日程生成（「全量省 token」入口）
export function setAllCharactersScheduleEnabled(enabled) {
  return request('/characters/schedule-enabled-all', { method: 'POST', body: { enabled } })
}

// ── 角色文件夹（单层分类，上游 v3.9.0 合并）──
export function listCharacterFolders() {
  return request('/characters/folders')
}

export function createCharacterFolder(name) {
  return request('/characters/folders', { method: 'POST', body: { name } })
}

export function renameCharacterFolder(id, name) {
  return request(`/characters/folders/${id}`, { method: 'PUT', body: { name } })
}

export function deleteCharacterFolder(id) {
  return request(`/characters/folders/${id}`, { method: 'DELETE' })
}

/** 重排文件夹顺序（拖拽排序），ids 为期望的先后顺序 */
export function reorderCharacterFolders(ids) {
  return request('/characters/folders/reorder', { method: 'PUT', body: { ids } })
}

// folderId 传 null 表示移回「未分类」
export function moveCharacterToFolder(characterId, folderId) {
  return request(`/characters/${characterId}/folder`, { method: 'PUT', body: { folder_id: folderId } })
}

// ── 场景立绘（五套形象，详情页左右切换；与场景服装是"图"与"文字"两条线）──
// 路径与上游 v3.10.0 统一：/characters/:id/standings…（旧 /scene-standings… 后端仍留别名）
export function listSceneStandings(characterId) {
  return request(`/characters/${characterId}/standings`)
}

export function generateSceneStanding(characterId, scene) {
  return request(`/characters/${characterId}/standings/generate`, { method: 'POST', body: { scene } })
}

/** 上传某场景的立绘：base64 必须是 data:image/…;base64, 形式 */
export function uploadSceneStanding(characterId, scene, base64) {
  return request(`/characters/${characterId}/standings/upload`, { method: 'POST', body: { scene, base64 } })
}

export function deleteSceneStanding(characterId, scene) {
  return request(`/characters/${characterId}/standings/${encodeURIComponent(scene)}`, { method: 'DELETE' })
}

export async function clearMessages(characterId) {
  return request(`/characters/${characterId}/messages`, { method: 'DELETE' })
}

export async function undoLastRound(characterId) {
  return request(`/characters/${characterId}/messages/last-round`, { method: 'DELETE' })
}

export async function generateCharacter(description) {
  return request(`/characters/generate`, { method: 'POST', body: { description } })
}

/** 预览模式生成角色：只生成不入库，由前端确认后再调 createCharacter */
export async function generateCharacterPreview(description, { searchContext = '' } = {}) {
  return request(`/characters/generate`, { method: 'POST', body: { description, save: false, searchContext } })
}

/** 导入酒馆角色卡（PNG 内嵌 chara / JSON 卡），返回预览数据，直接进入招募预览步骤 */
export async function importCharacterCard({ data, mimetype, filename }) {
  return request(`/characters/import-card`, { method: 'POST', body: { data, mimetype, filename } })
}
/** 直接创建角色（确认入库） */
export async function createCharacter(data) {
  return request(`/characters`, { method: 'POST', body: data })
}

// ── 表情包管理 ──
export function getEmojiOverview() {
  return request(`/characters/emoji/overview`)
}

// ── 表情包配置单（多套独立启用） ──
export function createEmojiSet(characterId, name = '') {
  return request(`/characters/emoji/sets`, { method: 'POST', body: { character_id: characterId, name } })
}

export function activateEmojiSet(setId, enabled = true) {
  return request(`/characters/emoji/sets/${setId}/activate`, { method: 'POST', body: { enabled } })
}

export function renameEmojiSet(setId, name) {
  return request(`/characters/emoji/sets/${setId}`, { method: 'PUT', body: { name } })
}

export function deleteEmojiSet(setId) {
  return request(`/characters/emoji/sets/${setId}`, { method: 'DELETE' })
}

export function getEmojiCategories() {
  return request(`/characters/emoji/categories`)
}

export function updateEmojiCategories(keys) {
  return request(`/characters/emoji/categories`, { method: 'PUT', body: { keys } })
}

export function getEmojiFixedTags() {
  return request(`/characters/emoji/tags`)
}

export function updateEmojiFixedTags(tags, styleMode, resolution) {
  return request(`/characters/emoji/tags`, {
    method: 'PUT',
    body: { tags, styleMode, ...(resolution ? { resolution } : {}) },
  })
}

// options 承载 outfitScene / missingOutfitPolicy（上游 v3.10.0：表情包与表情立绘共用显式选装口径）
export function generateEmojiPrompts(character_ids, style = '', setId = null, options = {}) {
  return request(`/characters/emoji/prompts`, { method: 'POST', body: { character_ids, style, set_id: setId, ...options } })
}
/**
 * 表情包「显式选装」预检：不生成，只告诉前端哪些角色缺该场景的服装。
 * 前端据此弹「自动补全 / 用默认外观」二选一（上游 v3.10.0）。
 */
export function preflightEmojiOutfits(character_ids, outfitScene = 'work') {
  return request(`/characters/emoji/outfits/preflight`, { method: 'POST', body: { character_ids, outfitScene } })
}

export function generateEmojiImages(character_ids, keys = [], artist = '@ebora', includeDone = false, setId = null) {
  return request(`/characters/emoji/images`, {
    method: 'POST',
    body: { character_ids, keys, artist, includeDone: !!includeDone, set_id: setId },
  })
}

export function regenerateEmojiPrompt(characterId, key, style = '', setId = null, options = {}) {
  return request(`/characters/emoji/${characterId}/${key}/prompt`, { method: 'POST', body: { style, set_id: setId, ...options } })
}

export function regenerateEmojiImage(characterId, key, artist = '@ebora', setId = null) {
  return request(`/characters/emoji/${characterId}/${key}/image`, { method: 'POST', body: { artist, set_id: setId } })
}

export function uploadEmojiImage(characterId, key, base64, setId = null) {
  return request(`/characters/emoji/${characterId}/${encodeURIComponent(key)}/upload`, {
    method: 'POST',
    body: { base64, set_id: setId },
  })
}

export function deleteEmoji(characterId, key, setId = null) {
  const query = setId ? `?set_id=${setId}` : ''
  return request(`/characters/emoji/${characterId}/${key}${query}`, { method: 'DELETE' })
}

export async function deleteCharacter(id) {
  return request(`/characters/${id}`, { method: 'DELETE' })
}

export async function uploadAvatar(characterId, base64) {
  return request(`/characters/${characterId}/avatar`, { method: 'POST', body: { base64 } })
}

export async function getRecentImages(characterId) {
  return request(`/characters/${characterId}/recent-images`)
}

/** AI 生成角色头像（脸部特写，表情跟随人格） */
export function generateAvatar(characterId) {
  return request(`/characters/${characterId}/generate-avatar`, { method: 'POST' })
}

/** 上传/清除角色聊天背景（base64，空串 = 恢复默认） */
export async function uploadChatBg(characterId, base64) {
  return request(`/characters/${characterId}/chat-bg`, { method: 'POST', body: { base64 } })
}

/**
 * 生成对话背景（上游 v3.10.0 合并，2026-10-19）。
 * target='galgame' 时写进角色 galgame 背景；previewOnly=true 只返回预览不落库。
 */
export function generateChatBg(characterId, requirement = '', target = 'galgame', previewOnly = false) {
  return request(`/characters/${characterId}/generate-chat-bg`, { method: 'POST', body: { requirement, target, previewOnly } })
}

/** 生成角色立绘（requirement 为额外立绘需求，可空） */
export function generateStanding(characterId, requirement = '') {
  return request(`/characters/${characterId}/generate-standing`, { method: 'POST', body: { requirement } })
}

/** 删除角色立绘 */
export function deleteStanding(characterId) {
  return request(`/characters/${characterId}/standing`, { method: 'DELETE' })
}

/** 上传本地图片作为角色立绘（base64 data URL，替换旧立绘） */
export function uploadStanding(characterId, base64) {
  return request(`/characters/${characterId}/standing-upload`, { method: 'POST', body: { base64 } })
}

/** 修正外观：上传参考图（base64 data URL）+ 当前整卡文本（可为待确认的草稿卡），邻舍分析后重写「## 你的外观」（不入库，由前端回填） */
export function refineAppearanceDraft({ image, basePrompt, displayName, sceneLabel }) {
  return request('/characters/refine-appearance-draft', {
    method: 'POST',
    body: { image, base_prompt: basePrompt, display_name: displayName, scene_label: sceneLabel },
  })
}

/** 修正外观·文字模式：按纯文字要点扩写外观描述（不出图，只走文本 LLM；不入库，由前端回填） */
export function expandAppearanceDraft({ brief, characterId, basePrompt, displayName, sceneLabel }) {
  return request('/characters/expand-appearance-draft', {
    method: 'POST',
    body: { brief, character_id: characterId, base_prompt: basePrompt, display_name: displayName, scene_label: sceneLabel },
  })
}

// ── 地图页（世界地图骨架 = 叙事地理，非游戏网格图；2026-10-29 移植自 PR#24）──

/** 层级标签与 POI 类型（口径在后端，前端不写死） */
export function getWorldMapMeta() {
  return request('/worldmap/meta')
}

export function listWorldMaps() {
  return request('/worldmap/maps')
}

export function createWorldMap({ name, worldSettingId = null, note = '' } = {}) {
  return request('/worldmap/maps', { method: 'POST', body: { name, worldSettingId, note } })
}

export function getWorldMap(mapId) {
  return request(`/worldmap/maps/${mapId}`)
}

export function updateWorldMap(mapId, patch = {}) {
  return request(`/worldmap/maps/${mapId}`, { method: 'PUT', body: patch })
}

export function deleteWorldMap(mapId) {
  return request(`/worldmap/maps/${mapId}`, { method: 'DELETE' })
}

/** 复制一张地图（整棵子树）为新地图 —— 用作「新建时套模板」 */
export function duplicateWorldMap(mapId, name = '') {
  return request(`/worldmap/maps/${mapId}/duplicate`, { method: 'POST', body: { name } })
}

/** ① 生成骨架（L1 大地区 + L2 子地区，1 次短 LLM） */
export function generateWorldMapSkeleton(mapId, { brief = '', regionCount, districtPerRegion } = {}) {
  return request(`/worldmap/maps/${mapId}/generate`, {
    method: 'POST', body: { brief, regionCount, districtPerRegion },
  })
}

/** 导出 Markdown（贴回知识库用） */
export function exportWorldMapMarkdown(mapId) {
  return request(`/worldmap/maps/${mapId}/export`)
}

export function addWorldMapPlace(mapId, place) {
  return request(`/worldmap/maps/${mapId}/places`, { method: 'POST', body: place })
}

export function updateWorldMapPlace(placeId, patch) {
  return request(`/worldmap/places/${placeId}`, { method: 'PUT', body: patch })
}

export function deleteWorldMapPlace(placeId) {
  return request(`/worldmap/places/${placeId}`, { method: 'DELETE' })
}

/** ② 逐区展开（L3 场景 + 每场景 POI；重复调用 = 换一批） */
export function expandWorldMapPlace(placeId) {
  return request(`/worldmap/places/${placeId}/expand`, { method: 'POST' })
}

export const getClothingLibrary = () => request('/characters/clothing-library')
export const generateClothingAppearanceDraft = ({ characterId, basePrompt, scene, tags, brief, signal }) => request('/characters/clothing-appearance-draft', {
  method: 'POST', body: { character_id: characterId, base_prompt: basePrompt, scene, tags, brief }, signal,
})

/** 生成角色立绘任务（已有立绘时走对比确认，requirement 为额外需求 / prompt 为直接复用提示词） */
export function generateStandingTask(characterId, body = {}) {
  return request(`/characters/${characterId}/generate-standing-task`, { method: 'POST', body })
}

/** 用已有英文 prompt 直接重出立绘（不重新请求提示词） */
export function regenerateStandingImage(characterId, prompt) {
  return request(`/characters/${characterId}/generate-standing-image`, { method: 'POST', body: { prompt } })
}

/** 当前立绘姿势风格（normal / dynamic，全局设置） */
export function getStandingMode() {
  return request(`/characters/standing-mode`)
}

/** 切换立绘姿势风格（system_settings 持久化） */
export function updateStandingMode(mode) {
  return request(`/characters/standing-mode`, { method: 'PUT', body: { mode } })
}

// ── Workflows ──
export async function getWorkflows() {
  return request(`/workflows`)
}

// ── Character Relationships ──
export async function getRelationships(characterId) {
  return request(`/relationships?character_id=${characterId}`)
}

export async function createRelationship(from_character_id, to_character_id, relationship_text) {
  return request(`/relationships`, { method: 'POST', body: { from_character_id, to_character_id, relationship_text } })
}

export async function updateRelationship(id, relationship_text) {
  return request(`/relationships/${id}`, { method: 'PUT', body: { relationship_text } })
}

export async function deleteRelationship(id) {
  return request(`/relationships/${id}`, { method: 'DELETE' })
}

export async function deduceRelationships(characterId, boost, excludeNames) {
  return request(`/relationships/deduce`, { method: 'POST', body: { characterId, boost, excludeNames } })
}

export async function deduceUserRelationships(boost, excludeNames) {
  return request(`/relationships/deduce`, { method: 'POST', body: { mode: 'user', boost, excludeNames } })
}

// ── User Relationships ──
export async function getUserRelationships() {
  return request(`/user-relationships`)
}

export async function createUserRelationship(character_id, relationship_text) {
  return request(`/user-relationships`, { method: 'POST', body: { character_id, relationship_text } })
}

export async function updateUserRelationship(id, relationship_text) {
  return request(`/user-relationships/${id}`, { method: 'PUT', body: { relationship_text } })
}

export async function deleteUserRelationship(id) {
  return request(`/user-relationships/${id}`, { method: 'DELETE' })
}

export function chatStream(characterId, message, clientMsgId, imageMode = 'smart', deepThink = false, townContext, galgameMode = false) {
  const controller = new AbortController()
  const stream = new ReadableStream({
    async start(outerController) {
      // ── 健壮连接：fetch 异常 + 非 2xx 响应均重试（覆盖代理 ECONNRESET → 502 场景）──
      //    每次尝试带 8s 超时，防止 Vite proxy 挂起导致无限等待
      let res
      let retries = 0
      const MAX_RETRIES = 3
      while (true) {
        let timeoutId, onUserAbort
        const attemptCtrl = new AbortController()
        try {
          // 8s 超时：超时后走重试逻辑，保证连接断开场景下 8 秒内必有一次判决
          timeoutId = setTimeout(() => attemptCtrl.abort(new Error('timeout')), 8000)
          // 用户主动取消也中止本次尝试
          onUserAbort = () => attemptCtrl.abort()
          controller.signal.addEventListener('abort', onUserAbort, { once: true })

          res = await fetch(`${BASE}/characters/${characterId}/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, client_msg_id: clientMsgId, image_mode: imageMode, force_image_gen: imageMode === 'force', deep_think: !!deepThink, ...(galgameMode === true ? { galgame_mode: true } : {}), ...(townContext === undefined ? {} : { townContext }) }),
            signal: attemptCtrl.signal,
          })
          if (res.ok) break  // 成功
          if (townContext !== undefined && [400, 409].includes(res.status)) {
            const detail = await res.json().catch(() => ({}))
            const error = Object.assign(new Error(detail.error || '小镇对话暂时不可用，请重新选择邻居'), { status: res.status, code: detail.code || 'TOWN_CHAT_REJECTED' })
            outerController.error(error)
            return // Admission errors must never retry or fall back to an ordinary request.
          }
          // 非 2xx：也按重试处理（代理 502/504 等）
          retries++
          if (retries > MAX_RETRIES) {
            outerController.error(new Error(`Server returned ${res.status}`))
            return
          }
          console.warn(`[api] bad status ${res.status} (${retries}/${MAX_RETRIES}), retrying in ${retries}s...`)
          await new Promise(r => setTimeout(r, retries * 1000))
        } catch (err) {
          if (err.name === 'AbortError') { outerController.close(); return }
          retries++
          if (retries > MAX_RETRIES) { outerController.error(err); return }
          console.warn(`[api] fetch failed (${retries}/${MAX_RETRIES}): ${err.message}, retrying in ${retries}s...`)
          await new Promise(r => setTimeout(r, retries * 1000))
        } finally {
          clearTimeout(timeoutId)
          if (onUserAbort) controller.signal.removeEventListener('abort', onUserAbort)
        }
      }

      // ── 日程系统：检测 queued 响应（非 SSE，是 JSON）──
      const contentType = res.headers.get('Content-Type') || ''
      if (contentType.includes('application/json')) {
        const json = await res.json()
        if (json.queued) {
          // 返回结构化事件（与正常 SSE 解析路径格式一致，确保 store 能正确识别）
          outerController.enqueue({ type: 'event', event: 'queued' })
          outerController.enqueue({ type: 'data', event: 'queued', data: json })
          outerController.close()
          return
        }
      }

      // ── 流式读取 ──
      try {
        await consumeSSE(res, (event, data) => {
          if (data === undefined) {
            outerController.enqueue({ type: 'event', event })
          } else {
            outerController.enqueue({ type: 'data', event, data })
          }
        })
        outerController.close()
      } catch (err) {
        if (err.name !== 'AbortError') outerController.error(err)
      }
    },
  })
  return { stream, abort: () => controller.abort() }
}

// ── Groups（群聊）──
export async function listGroups() {
  return request(`/groups`)
}

export function createGroup({ name, topic, member_ids }) {
  return request(`/groups`, { method: 'POST', body: { name, topic, member_ids } })
}

export async function updateGroup(id, data) {
  return request(`/groups/${id}`, { method: 'PATCH', body: data })
}

/** 设置群头像（base64 png）；传空值 = 恢复默认的成员拼图 */
export async function uploadGroupAvatar(id, base64) {
  return request(`/groups/${id}/avatar`, { method: 'POST', body: { base64 } })
}

export async function deleteGroup(id) {
  return request(`/groups/${id}`, { method: 'DELETE' })
}

export function undoLastGroupRound(id) {
  return request(`/groups/${id}/messages/last-round`, { method: 'DELETE' })
}

export async function getGroupMessages(id) {
  return request(`/groups/${id}/messages`)
}

export async function markGroupSeen(id) {
  return request(`/groups/${id}/seen`, { method: 'POST' })
}

/** 冷场续聊：用户停留但没人说话时触发角色继续聊（消息经统一 SSE 到达） */
export async function nudgeGroup(id) {
  return request(`/groups/${id}/nudge`, { method: 'POST' })
}

/** 群聊发言：SSE 流式返回本轮剧本（解析格式与 chatStream 一致）
 * @param {Array<{text, client_msg_id}>} items - 支持一次携带多条聚合消息
 * @param {number|null} truncateAfterMsgId - 打断播放时抛弃该 id 之后未上屏的分句
 */
export function groupChatStream(groupId, items, truncateAfterMsgId = null) {
  const controller = new AbortController()
  const stream = new ReadableStream({
    async start(outerController) {
      let res
      try {
        res = await fetch(`${BASE}/groups/${groupId}/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: items, truncate_after_msg_id: truncateAfterMsgId }),
          signal: controller.signal,
        })
      } catch (err) {
        if (err.name === 'AbortError') { outerController.close(); return }
        outerController.error(err)
        return
      }
      if (!res.ok) {
        outerController.error(new Error(`Server returned ${res.status}`))
        return
      }
      try {
        await consumeSSE(res, (event, data) => {
          if (data !== undefined) {
            outerController.enqueue({ type: 'data', event, data })
          }
        })
        outerController.close()
      } catch (err) {
        if (err.name !== 'AbortError') outerController.error(err)
      }
    },
  })
  return { stream, abort: () => controller.abort() }
}

// ── Config ──
export async function getConfig() {
  return request(`/config`)
}

export async function updateComfyConfig(data) {
  return request(`/config/comfy`, { method: 'PUT', body: data })
}

export async function fetchLorasFiles() {
  return request(`/config/loras-files`)
}

export async function updateGlobalLora(loras) {
  await request(`/config/global-lora`, { method: 'PUT', body: { loras } })
}

/** 更新 HiresFix 细化专用 LoRA（仅作用于放大细化工作流） */
/** 更新 HiresFix 细化完整设置（LoRA + 步数/重绘幅度/CFG） */
export function updateHiresSettings({ loras, steps, cfg, denoise, maxSize, artistMode, artist, samplingMode, globalLoraScale, sourceBlend, upscaleModel, workflowMode, turboMode }) {
  return request(`/config/hires`, { method: 'PUT', body: { loras, steps, cfg, denoise, maxSize, artistMode, artist, samplingMode, globalLoraScale, sourceBlend, upscaleModel, workflowMode, turboMode } })
}

export async function updateFeatureFlag(key, value) {
  await request(`/config/features`, { method: 'PUT', body: { key, value } })
}

// ── 提示词破限（Prompt Shield）──────────────────────────────────────────────
// 往每次 LLM 调用最前面注入一段「不拒答」system 提示词，避免模型拿
// "世界观涉及成人/校园内容"为由拒答（真机上日程生成被拒两次 → 500）。
// 开关走通用 feature 分支（key='jailbreak'），正文单独一对读写。
// GET  → { ok, enabled, source:'db'|'default', bytes, content, defaultContent }
// PUT  → { enabled?, content?, reset? } 三者至少给一个；reset:true 恢复默认正文
export async function getJailbreak() {
  return request(`/config/jailbreak`)
}

export async function updateJailbreak(patch) {
  return request(`/config/jailbreak`, { method: 'PUT', body: patch })
}

// ── 破限规则集（多提示词切换 + 按调用链投递）──────────────────────────────
// 2026-10-15：把原来"只有一份正文"升级成规则集。上面那对 getJailbreak/updateJailbreak
// 保留（老界面与"只想改那唯一一份正文"的用法继续可用），下面是规则集那组端点。
//
// GET /config/jailbreak/rules → { ok, rules[], activeId, active, targets[], availableTargets[], targetLabels{}, limits{} }
export async function getJailbreakRules() {
  return request(`/config/jailbreak/rules`)
}

// { name?, content?, targets? } → { ok, rule }
export async function createJailbreakRule(payload) {
  return request(`/config/jailbreak/rules`, { method: 'POST', body: payload })
}

export async function getJailbreakRule(id) {
  return request(`/config/jailbreak/rules/${encodeURIComponent(id)}`)
}

// 内置规则集只允许改 name / targets（改 content 会 400）
export async function updateJailbreakRule(id, patch) {
  return request(`/config/jailbreak/rules/${encodeURIComponent(id)}`, { method: 'PUT', body: patch })
}

// 内置项与"最后一个自定义项"会 400
export async function deleteJailbreakRule(id) {
  return request(`/config/jailbreak/rules/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 传空串 = 清掉激活标记，回落旧单正文键 / 代码默认
export async function activateJailbreakRule(id) {
  return request(`/config/jailbreak/rules/${encodeURIComponent(id)}/activate`, { method: 'POST' })
}

export async function getActiveJailbreakRule() {
  return request(`/config/jailbreak/rules/active`)
}

// GET → { ok, targets[], available[], labels{} }
export async function getJailbreakTargets() {
  return request(`/config/jailbreak/targets`)
}

export async function setJailbreakTargets(targets) {
  return request(`/config/jailbreak/targets`, { method: 'PUT', body: { targets } })
}

// ── SLG 动作系统（触摸互动）───────────────────────────────────────────────
// 契约见 docs/touch-system.md §6.3。
// 注意：**门控拒绝是 200 + { allowed:false, code, message }**（“她不愿意”是叙事结果，不是服务端错误），
// 所以走上面的 request() 不会抛；只有非法 action / 角色（400 / 404）或功能关闭（409）才抛。

/** 动作清单 + 服务端算好的逐条门控（gate 就是 getTouchGate 的真实结果，已含催眠豁免 / Lv3 授权） */
export function fetchTouchActions(characterId, { maxLevel, scene, allowGroupAdult } = {}) {
  const query = new URLSearchParams()
  if (maxLevel !== undefined && maxLevel !== null) query.set('maxLevel', String(maxLevel))
  if (scene) query.set('scene', scene)
  if (allowGroupAdult) query.set('allowGroupAdult', '1')
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request(`/characters/${characterId}/touch/actions${suffix}`)
}

/**
 * 腻烦度 / 偏好状态：{ states: { <key>: { annoyance, tier, likeRatio, updatedAt } }, quota, pendingCount }
 *
 * `pendingCount` = 已经做下、但还没被她回应的动作条数（task-25 ③ 的「还有 N 个动作等她回应」）。
 * task-29：后端把本端点扩成接受 `?scene=chat|group&groupId=<n>`，返回对应口径的 pendingCount；
 * **不传参数 = 旧行为（私聊口径）**，所以历史调用点零改动。
 */
export function fetchTouchState(characterId, { scene, groupId } = {}) {
  const query = new URLSearchParams()
  if (scene) query.set('scene', scene)
  // groupId 用 undefined/null/'' 判空：**0 是合法群 id，不能被假值判断吃掉**
  if (groupId !== undefined && groupId !== null && groupId !== '') query.set('groupId', String(groupId))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return request(`/characters/${characterId}/touch/state${suffix}`)
}

/**
 * 触摸互动统计（阶段三）：次数 / 等级分布 / 最近一次 / 腻烦峰值。
 * ⚠️ 后端端点尚未落地（task-20 时点）；形状以后端为准，前端 normalizeTouchStats 写得宽容，落地后对齐字段名即可。
 */
/**
 * 玩具接口的**场景参数**（2026-10-03 群聊 bug，两位独立审查者复现）。
 *
 * 为什么必须带：前端以前从不告诉服务端"这一下是在群里点的" ⇒ 后端按私聊口径写 `char_<id>` +
 * `proactive_message`，而群聊页只认 `group_message` / `group_message_update`（`stores/groups.js`）
 * ⇒ 玩家在群聊玩具面板里装/调/摘，她的反应与配图**全跑到私聊**、群里什么都看不到。
 * 口径与 touch / 亲密一致：**不传 = 私聊**（URL 与请求体逐字节与改造前一致，老调用点零改动）；
 * `scene='group'` 时才带上 groupId（group 场景缺 groupId 时后端回 400 人话，所以照传不吞）。
 * 位置：参数统一放**最后一个** `sceneOpts`，调用方只有 ToyPanel / GroupChatView 两处。
 */
function toySceneFields({ scene, groupId } = {}) {
  if (scene !== 'group') return {}
  return { scene: 'group', groupId }
}
function toySceneQuery({ scene, groupId } = {}) {
  if (scene !== 'group') return ''
  const query = new URLSearchParams({ scene: 'group' })
  // groupId 用 undefined/null/'' 判空：**0 是合法群 id，不能被假值判断吃掉**（同 fetchTouchState）
  if (groupId !== undefined && groupId !== null && groupId !== '') query.set('groupId', String(groupId))
  return `?${query.toString()}`
}

/**
 * 玩具清单 + 佩戴状态（专题 §2.9-2）。
 * 路径 / 形状以 `agent-core/src/routes/toys.js` 为准；形状不同时**只改这里**（组件侧刻意写得宽容）。
 * 群聊里要带 `sceneOpts`：服务端据此给出**群里**的逐件门控（群聊成人开关关着 = 每件 allowed:false）。
 */
export function fetchToys(characterId, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys' + toySceneQuery(sceneOpts))
}

// ── 角色操作反馈（右下角轻通知）──

/** 本次候选需要的素材：该角色启用表情包配置单里已完成的图片 + 头像（不做任何生成） */
export function getCharacterReactionAssets(characterId) {
  return request(`/characters/${characterId}/reaction-assets`)
}

/** 低概率即时反应：一次获准事件至多一次请求，由后端校验事实与额度 */
export function requestCharacterReaction(payload, { signal } = {}) {
  return request(`/character-reactions/instant`, { method: 'POST', body: payload, signal })
}

/** 短句包（M2）：按角色读取 / 用户主动生成 / 删除。只有 generate 会产生模型调用 */
export function getCharacterReactionPack(characterId) {
  return request(`/character-reactions/packs/${characterId}`)
}

export function generateCharacterReactionPack(characterId, eventTypes) {
  const body = Array.isArray(eventTypes) ? { eventTypes } : {}
  return request(`/character-reactions/packs/${characterId}/generate`, { method: 'POST', body })
}

export function deleteCharacterReactionPack(characterId) {
  return request(`/character-reactions/packs/${characterId}`, { method: 'DELETE' })
}

/** 保存用户手动编辑的短句包（服务端走同一套严格校验） */
export function saveCharacterReactionPack(characterId, pack) {
  return request(`/character-reactions/packs/${characterId}`, { method: 'PUT', body: { pack } })
}

// ⚠️ 2026-10-01 真机 bug：这三个函数原来写的是 `body: JSON.stringify({ intensity })`，
// 而下面的 request() 基元**自己就会 stringify**（`JSON.stringify(body)`）——
// 于是发出去的是 `"{\"intensity\":1}"`（一个 JSON 字符串），Express 的 body-parser 直接报
// `Unexpected token '"', ""{\"intensity\":1}"" is not valid JSON`，现象就是「玩具一点就报错」。
// 契约：`body` 一律传**对象**，别在这里自己 stringify（对照 performTouchAction 的写法）。
// ⚠️ 2026-10-01 真机 bug（第二条）：`POST /api/characters/13/toys/undefined/equip`。
// `encodeURIComponent(undefined)` 会**静默变成字符串 `"undefined"`**，于是请求打到
// `/toys/undefined/equip`、服务端只能回 404/400 —— 用户看到的就是「玩具一点就报错」，
// 而根因在前端某条路径拿不到 key，日志里完全看不出。这里加一道共用闸门：
// key 缺失时**当场抛人话错误**（调用方 ChatView 三个 handler 都有 try/catch + toast），
// 绝不再让 `undefined` 变成 URL 的一部分。
function requireToyKey(toyKey) {
  const key = typeof toyKey === 'string' ? toyKey.trim() : ''
  if (!key || key === 'undefined' || key === 'null') {
    const err = new Error('玩具标识缺失，请刷新后重试')
    err.code = 'toy_key_missing'
    throw err
  }
  return encodeURIComponent(key)
}

// 场景参数（`sceneOpts`）统一放最后一个：群聊里必须传 `{ scene:'group', groupId }`，
// 否则她的反应会写到私聊（见上面 toySceneFields 的说明）。不传 = 私聊，请求体逐字节不变。
export function equipToy(characterId, toyKey, { intensity = 1 } = {}, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys/' + requireToyKey(toyKey) + '/equip', {
    method: 'POST', body: { intensity, ...toySceneFields(sceneOpts) },
  })
}

export function setToyIntensity(characterId, toyKey, intensity, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys/' + requireToyKey(toyKey) + '/set-intensity', {
    method: 'POST', body: { intensity, ...toySceneFields(sceneOpts) },
  })
}

export function removeToy(characterId, toyKey, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys/' + requireToyKey(toyKey) + '/remove', {
    method: 'POST', body: { ...toySceneFields(sceneOpts) },
  })
}

export function fetchTouchStats(characterId) {
  return request(`/characters/${characterId}/touch/stats`)
}

/** 执行一次动作；返回体可能 allowed:false（她不愿意），也可能是成功后的即时反应与提醒 */
export function performTouchAction(characterId, actionKey, { mode, scene, groupId } = {}) {
  return request(`/characters/${characterId}/touch/${actionKey}`, {
    method: 'POST',
    body: { mode, scene, groupId },
  })
}

/**
 * 反重复采样参数（presence_penalty / frequency_penalty）。
 * 传 null / '' = 清空 → 后端请求体里完全不发送该字段（与加参数前的请求体逐字节一致）。
 */
export function updateAntiRepetitionPenalty({ presence, frequency } = {}) {
  return request(`/config/anti-repetition`, { method: 'PUT', body: { presence, frequency } })
}

/**
 * 「AI 判断行为」的每日判定上限（全局配额，与角色无关）。
 * 读侧：GET /api/config 顶层 aiJudge = { dailyLimit, usedToday, remaining, unlimited }；
 * 写侧：PUT /api/config/ai-judge 返回同一个对象（dailyLimit 传 0 = 不限制）。
 */
export function updateAiJudgeDailyLimit(dailyLimit) {
  return request('/config/ai-judge', { method: 'PUT', body: { dailyLimit: Number(dailyLimit) } })
}

/**
 * 亲密推进动作的独立每日配额（全局配额，与角色无关；2026-10-15 补）。
 * 读侧：GET /api/config 顶层 intimateActionQuota = { dailyLimit, usedToday, remaining, unlimited }；
 *       角色面板另从 GET /api/intimate-actions/:id/state 的回执里读同一形状的 quota。
 * 写侧：PUT /api/config/intimate-action-quota 返回同一个对象（dailyLimit 传 0 = 不限制）。
 *
 * 这个配额只决定"要不要真的调模型"：用完**不哑玩法**，状态照常推进、反应留到下一轮补演。
 */
export function updateIntimateActionQuota(dailyLimit) {
  return request('/config/intimate-action-quota', { method: 'PUT', body: { dailyLimit: Number(dailyLimit) } })
}

/** 更新主动聊天频率 0~1 */
export async function updateProactiveFreq(value) {
  await request(`/config/proactive-freq`, { method: 'PUT', body: { value } })
}

/** 更新群聊 LLM 温度 0.5~1.2（所有群共享） */
export function updateGroupTemperature(value) {
  return request(`/config/group-temperature`, { method: 'PUT', body: { value } })
}

/** 更新群聊记忆总结/滑动窗口推进轮次 2~6（所有群共享） */
export function updateGroupActivity(value) {
  return request('/config/group-activity', { method: 'PUT', body: { value } })
}

export function updateGroupSummaryInterval(value) {
  return request(`/config/group-summary-interval`, { method: 'PUT', body: { value } })
}

/** 更新奇遇触发频率 0~1 */
export async function updateEventFreq(value) {
  await request(`/config/event-freq`, { method: 'PUT', body: { value } })
}

/** 更新朋友圈频率（0~24）；mode 区分「默认」与具体时间档。 */
export async function updateMomentFreq(value, mode) {
  await request(`/config/moment-freq`, { method: 'PUT', body: { value, mode } })
}

/** 更新日程刷新周期（天，1~3） */
export async function updateScheduleRefreshDays(value) {
  await request(`/config/schedule-refresh-days`, { method: 'PUT', body: { value } })
}

/** 更新后台 LLM 并发数 1~10 */
export async function updateBackgroundConcurrency(value) {
  await request(`/config/background-llm-concurrency`, { method: 'PUT', body: { value } })
}

/** 更新防打扰模式总开关 */
export async function updateDisturbMode(value) {
  return request(`/config/disturb-mode`, { method: 'PUT', body: { value } })
}

/** 更新防打扰时间段和角色列表 */
export async function updateDisturbSettings(data) {
  return request(`/config/disturb-settings`, { method: 'PUT', body: data })
}

/** 设置天气城市 */
export async function updateWeatherCity(city) {
  return request(`/config/weather-city`, { method: 'PUT', body: { city } })
}

export async function updateLlmConfig(data) {
  return request(`/config/llm`, { method: 'PUT', body: data })
}

export function testLlmConnection(data) {
  return request(`/config/llm/test`, { method: 'POST', body: data })
}
/** 校验 Vertex 服务账号 JSON（不落库，供设置页「测试」按钮用；上游 v3.10.0） */
export function validateVertexServiceAccount(data) {
  return request('/config/llm/vertex/validate', { method: 'POST', body: data })
}

/** 每日免费鸡蛋开关（opencode zen 免费端点，免 Key） */
export function setLlmFreeEgg(enabled) {
  return request(`/config/llm/free-egg`, { method: 'PUT', body: { enabled } })
}

export function fetchLlmApiKey() {
  return request(`/config/llm/key`)
}

export function fetchLlmModels(data) {
  return request(`/config/llm/models`, { method: 'POST', body: data })
}

// ── LLM Profile 管理 ──

export async function getLlmProfiles() {
  return request(`/config/llm/profiles`)
}

export async function addLlmProfile(name, config = {}) {
  return request(`/config/llm/profiles`, { method: 'POST', body: { name, ...config } })
}

export async function deleteLlmProfile(id) {
  return request(`/config/llm/profiles/${id}`, { method: 'DELETE' })
}

export async function activateLlmProfile(id) {
  return request(`/config/llm/profiles/${id}/activate`, { method: 'POST' })
}

export async function syncActiveLlmProfile() {
  await request(`/config/llm/profiles/active/sync`, { method: 'PUT' })
}

// ── 上下文窗口用量 / 压缩 ──
// 走 jsonRequest：需要把 409（正在压缩）的 status 透传给调用方区分提示，
// 而 request() 会把状态码吞成一个普通 Error。

/** 当前会话的上下文用量（conversationId 形如 char_2 / group_7） */
export function getContextUsage(conversationId) {
  return jsonRequest(`/api/context/usage?conversationId=${encodeURIComponent(conversationId)}`)
}

/** 手动压缩当前会话上下文；服务端已有压缩在跑时抛 status=409 */
export function compressContext(conversationId) {
  return jsonRequest('/api/context/compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId }),
  })
}

// ── 数据备份（一键导出 / 一键导入）──
//
// 契约（后端 agent-core/src/routes/data.js）：
//   GET  /api/data/export?includeConfig=0|1 → 200 二进制 tar.gz（Content-Disposition 给文件名）
//   GET  /api/data/export/info              → { ok, dbBytes, counts, lastExportAt }
//   POST /api/data/import                   → body 为归档原始字节，Content-Type: application/gzip
//
// 导出/导入都绕开 request()：一个要拿二进制 blob + 响应头，一个要发非 JSON 的原始字节。
// 失败时把后端的人话（error / detail）和 backupPath 挂在 Error 上交给页面展示。

/** 导出摘要：角色/消息/群/记忆条数 + 预估大小（dbBytes 是估算上界，文案不写「精确」） */
export function getDataExportInfo() {
  return request('/data/export/info')
}

function backupError(status, payload) {
  const result = payload && typeof payload === 'object' ? payload : {}
  const error = new Error(result.error || result.detail || `请求失败 (${status})`)
  error.status = status
  error.detail = result.detail || ''
  // 500 时后端会把导入前的自动备份路径带回来，页面必须能显示它以便回滚
  error.backupPath = result.backupPath || ''
  return error
}

/**
 * 触发浏览器下载整个数据归档。
 * @param {boolean} includeConfig 是否把 config/.env（含 API Key）一起打包
 * @returns {Promise<{fileName:string, bytes:number}>}
 */
export async function downloadDataArchive(includeConfig = false) {
  const res = await fetch(`${BASE}/data/export?includeConfig=${includeConfig ? 1 : 0}`)
  if (!res.ok) throw backupError(res.status, await res.json().catch(() => ({})))
  const blob = await res.blob()
  const fileName = parseBackupFileName(res.headers.get('Content-Disposition')) || defaultBackupFileName()
  saveBlobAsFile(blob, fileName)
  return { fileName, bytes: blob.size }
}

/**
 * 上传归档并覆盖当前数据。上传前必须已经二次确认过。
 * @param {File|Blob} file 原始 .tar.gz 字节
 * @returns {Promise<{ok:boolean, restored:object, backupPath:string, restartRecommended:boolean, message:string}>}
 */
export async function importDataArchive(file) {
  const res = await fetch(`${BASE}/data/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip' },
    body: file,
  })
  const result = await res.json().catch(() => ({}))
  if (!res.ok) throw backupError(res.status, result)
  return result
}

/** 临时 <a download> 触发下载（不进模板，因此不受「不用裸元素」约束） */
function saveBlobAsFile(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 立刻 revoke 会让部分浏览器中断下载，留足时间再回收
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// ── Chat Memory ──
async function jsonRequest(url, options) {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code, requestId: data.requestId, characterId: data.characterId })
  return data
}

export function getMemoryConfig() {
  return request(`/config/memory`)
}

export function updateMemoryConfig(data) {
  return request(`/config/memory`, { method: 'PUT', body: data })
}

export function testMemoryEmbedding(data) {
  return request(`/config/memory/test-embedding`, { method: 'POST', body: data })
}

export function testMemoryReranker(data) {
  return request(`/config/memory/test-reranker`, { method: 'POST', body: data })
}

export function getMemoryStats() {
  return request(`/memory/stats`)
}

// 记忆系统体检：当前生效配置 + 缺失项 + 每条问题的处置建议（设置页展示用）
export function getMemoryHealth() {
  return request(`/memory/health`)
}

// 阶段三：整理 daemon 运行状态 + 待整理候选数
export function getConsolidationState() {
  return request(`/memory/consolidation/state`)
}

// 阶段四：archived 记忆恢复
export function restoreMemoryFragment(id) {
  return request(`/memory/fragments/${encodeURIComponent(id)}/restore`, { method: 'POST' })
}

// 阶段三：整理 daemon 任务队列与手动触发
export function getConsolidationJobs(limit = 30) {
  return request(`/memory/consolidation/jobs?limit=${encodeURIComponent(limit)}`)
}

export function runConsolidationNow() {
  return request(`/memory/consolidation/run`, { method: 'POST' })
}

export function getMemoryFragments(params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, value)
  }
  return request(`/memory/fragments?${query}`)
}

export function searchMemories(queryText, options = {}) {
  const query = new URLSearchParams({ q: queryText })
  if (options.conversationId) query.set('conversation_id', options.conversationId)
  if (options.topK) query.set('top_k', options.topK)
  return request(`/memory/search?${query}`)
}

export function deleteMemoryFragment(id) {
  return request(`/memory/fragments/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function getMemoryIndexJobs(limit = 30) {
  return request(`/memory/index-jobs?limit=${encodeURIComponent(limit)}`)
}

export function reindexMemories() {
  return request(`/memory/reindex`, { method: 'POST' })
}

export function retryFailedMemories() {
  return request(`/memory/retry-failed`, { method: 'POST' })
}

// ── World Settings ──
export async function getWorldSettings() {
  return request(`/config/world-settings`)
}
// ── 世界书（上游 v3.10.0：Sillytraven 预设兼容；挂在 /config/world-settings/:id/lorebook）──
export const getWorldLorebook = id => request(`/config/world-settings/${id}/lorebook`)
export const saveWorldLorebook = (id, body) => request(`/config/world-settings/${id}/lorebook`, { method: 'PUT', body })
export const previewWorldLorebook = (id, body) => request(`/config/world-settings/${id}/lorebook/preview`, { method: 'POST', body })
export const probeWorldLorebookCache = id => request(`/config/world-settings/${id}/lorebook/cache-probe`, { method: 'POST', body: {} })

export async function createWorldSetting(data) {
  return request(`/config/world-settings`, { method: 'POST', body: data })
}

export async function updateWorldSetting(id, data) {
  return request(`/config/world-settings/${id}`, { method: 'PUT', body: data })
}

export async function deleteWorldSetting(id) {
  return request(`/config/world-settings/${id}`, { method: 'DELETE' })
}

export async function getSystemRules() {
  return request(`/config/system-rules`)
}

export async function polishWorldSetting(data) {
  return request(`/config/world-settings/polish`, { method: 'POST', body: data })
}

export async function activateWorldSetting(id) {
  return request(`/config/world-settings/${id}/activate`, { method: 'POST' })
}

// ── Global Rules ──
export async function getGlobalRules() {
  return request(`/config/rules`)
}

export async function updateGlobalRule(key, data) {
  return request(`/config/rules/${encodeURIComponent(key)}`, { method: 'PUT', body: data })
}

/** 获取单条规则的默认值（不修改，仅供预览） */
export async function getDefaultRule(key) {
  return request(`/config/rules/${encodeURIComponent(key)}/default`)
}

/** 重置单条全局规则为默认值 */
export async function resetGlobalRule(key) {
  return request(`/config/rules/${encodeURIComponent(key)}/reset`, { method: 'POST' })
}

// ── User Avatar ──
export async function getUserAvatar() {
  return request(`/config/user-avatar`)
}

export async function uploadUserAvatar(base64) {
  return request(`/config/user-avatar`, { method: 'POST', body: { base64 } })
}

// ── User config (nickname + persona) ──
export async function getUserConfig() {
  return request(`/config/user`)
}

export async function updateUserConfig(data) {
  return request(`/config/user`, { method: 'PUT', body: data })
}

// ── 测试画风（固定提示词，不存 DB；mode: 'chat' | 'moments'；prompt 可选覆盖默认；
// sceneDesc 可选自由画面描述 → LLM 完善；reuseSceneLoras 复用上次自由画面测试匹配到的角色 lora）──
// 传了 onPrompt 就走流式（body.stream = true）：后端在最终结果到达前先推 prompt 事件，
// 用户在「完善提示词」和「出图」两段里都能看到提示词；不传 onPrompt 保持旧的整包 JSON 口径。
export async function testStyle({ artist, width, height, mode = 'chat', prompt = '', sceneDesc = '', reuseSceneLoras = false, alreadyPrepared = false } = {}, { onPrompt } = {}) {
  const body = { artist, width, height, mode };
  if (prompt) body.prompt = prompt;
  if (sceneDesc) body.sceneDesc = sceneDesc;
  if (reuseSceneLoras) body.reuseSceneLoras = true;
  if (alreadyPrepared) body.alreadyPrepared = true;
  if (!onPrompt) return request(`/images/test-style`, { method: 'POST', body })
  const res = await fetch(`${BASE}/images/test-style`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  })
  // 兼容尚未重启的旧后端，以及鉴权等中间件返回的 JSON 错误。
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
    const result = await res.json()
    if (!res.ok) throw new Error(result.error || `请求失败 (${res.status})`)
    return result
  }
  let result
  await consumeSSE(res, (event, data) => {
    if (!data) return
    if (event === 'prompt') onPrompt(data)
    else if (event === 'result') result = data
  })
  if (!result) throw new Error('生成连接已中断，请重试')
  return result
}

/** 测试细化（最近一张图，HiresFix 参数流程，不落盘，返回原图+细化图） */
export function testHires() {
  return request(`/images/test-hires`, { method: 'POST' });
}

// ── Moments 朋友圈 ──
/**
 * 朋友圈帖子列表（keyset 分页）
 * @param {{ before_id?: number, limit?: number }} [params] 不传 = 后端默认（最新 1000 条）
 *   续拉更旧的一批：传上一批最后一条的 id 作 before_id。
 *   返回 `{ posts, hasMore }` —— hasMore 由后端多取一条探测。
 */
export async function listMoments(params) {
  const qs = new URLSearchParams()
  if (params?.before_id) qs.set('before_id', String(params.before_id))
  if (params?.limit) qs.set('limit', String(params.limit))
  const suffix = qs.toString() ? `?${qs}` : ''
  return request(`/moments${suffix}`)
}

/**
 * 连接朋友圈 SSE 推送流
 * @param {(post: object) => void} onNewPost 新帖回调
 * @returns {{ close: () => void }} 关闭函数，含 _closed 标记用于重连判断
 */
export function connectMomentsStream(onNewPost) {
  const controller = new AbortController()
  const conn = { _closed: false }

  conn.close = () => {
    conn._closed = true
    controller.abort()
  }

  fetch(`${BASE}/moments/stream`, { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) {
        console.warn('[api] moments SSE connection failed:', res.status)
        conn._closed = true
        return
      }
      try {
        await consumeSSE(res, (event, data) => {
          if (data !== undefined && event === 'new_post') onNewPost(data)
        })
      } catch { /* 连接中断，交给上层重连逻辑 */ }
      conn._closed = true
    })
    .catch(err => {
      conn._closed = true
      if (err.name !== 'AbortError') {
        console.warn('[api] moments SSE error:', err.message)
      }
    })

  return conn
}

/**
 * 连接主动聊天 SSE 推送流
 * @param {(data: object) => void} onProactiveMessage 新主动消息回调
 * @returns {{ close: () => void }} 关闭函数，含 _closed 标记用于重连判断
 */
export function connectNotificationsStream(onProactiveMessage) {
  const controller = new AbortController()
  const conn = { _closed: false }

  conn.close = () => {
    conn._closed = true
    controller.abort()
  }

  fetch(`${BASE}/notifications/stream`, { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) {
        console.warn('[api] notifications SSE connection failed:', res.status)
        conn._closed = true
        return
      }
      try {
        await consumeSSE(res, (event, data) => {
          if (data !== undefined && event === 'proactive_message') onProactiveMessage(data)
        })
      } catch { /* 连接中断，交给上层重连逻辑 */ }
      conn._closed = true
    })
    .catch(err => {
      conn._closed = true
      if (err.name !== 'AbortError') {
        console.warn('[api] notifications SSE error:', err.message)
      }
    })

  return conn
}

/** 获取有未读主动消息的角色列表 */
export async function getProactiveUnread() {
  return request(`/notifications/unread`)
}

/** 标记某角色的主动消息已读 */
export async function markProactiveRead(characterId) {
  await request(`/notifications/mark-read/${characterId}`, { method: 'POST' })
}

/** 调试：强制随机角色发起一次主动聊天 */
export async function forceProactive() {
  return request(`/notifications/force-proactive`, { method: 'POST' })
}

export async function getMoment(id) {
  return request(`/moments/${id}`)
}

/** 获取朋友圈未读计数 */
export async function getMomentsUnread() {
  return request(`/moments/unread-count`)
}

/** 清零朋友圈未读计数 */
export async function markMomentsRead() {
  return request(`/moments/mark-read`, { method: 'POST' })
}

export async function generateMoment(characterId, topicId) {
  // topicId 为「话题库点题」：带上它后端按 id 读原条目（失效话题返回 400/404）；
  // 不传时后端保持原随机/日程抽题口径。undefined 会被 JSON.stringify 丢掉，兼容旧调用。
  return request(`/moments/generate`, { method: 'POST', body: { character_id: characterId, topic_id: topicId } })
}

export async function updateMoment(postId, content) {
  return request(`/moments/${postId}`, { method: 'PUT', body: { content } })
}

export async function deleteMoment(id) {
  return request(`/moments/${id}`, { method: 'DELETE' })
}

export async function commentMoment(postId, content, replyToCommentId = null) {
  return request(`/moments/${postId}/comments`, {
    method: 'POST',
    body: { content, reply_to_comment_id: replyToCommentId },
  })
}

/** 用户自己发朋友圈（文字 + 可选 base64 图片数组），角色随后陆续来评论 */
export async function createUserMoment({ content, images = [] }) {
  return request(`/moments/user-post`, { method: 'POST', body: { content, images } })
}

export async function deleteMomentComment(postId, commentId) {
  return request(`/moments/${postId}/comments/${commentId}`, { method: 'DELETE' })
}

export async function likeMoment(postId) {
  return request(`/moments/${postId}/like`, { method: 'POST' })
}

/** 按帖子原本的提示词重新出图，补上因生图失败缺失的配图 */
export async function regenerateMomentImage(postId) {
  return request(`/moments/${postId}/regenerate-image`, { method: 'POST' })
}

// ── 角色对用户的画像（user_portraits）──
export async function getCharacterPortrait(characterId) {
  return request(`/portraits/${characterId}`)
}

export function addPortrait(characterId, traitType, content) {
  return request(`/portraits`, { method: 'POST', body: { characterId, traitType, content } })
}

export function updatePortrait(id, content) {
  return request(`/portraits/${id}`, { method: 'PUT', body: { content } })
}

export function deletePortrait(id) {
  return request(`/portraits/${id}`, { method: 'DELETE' })
}

// ── ComfyUI health ──
export async function comfyuiHealth() {
  try {
    return await request(`/images/comfyui-health`)
  } catch { return { connected: false } }
}

export async function imageProviderHealth(data = {}) {
  try {
    return await request(`/images/provider-health`, { method: 'POST', body: data })
  } catch { return { connected: false, provider: data.provider || 'comfyui' } }
}

// ── Gift 送礼 ──
export async function sendGift(characterId, giftType, giftLine = '') {
  return request(`/characters/${characterId}/gift`, { method: 'POST', body: { giftType, giftLine } })
}

export async function getGiftCooldowns() {
  return request(`/characters/gift/cooldowns`)
}

export async function resetGiftCooldowns() {
  return request(`/characters/gift/cooldowns`, { method: 'DELETE' })
}

// ── 誓约系统 ──

export async function getOathStatus(characterId) {
  return request(`/characters/${characterId}/oath`)
}

export async function removeOath(characterId) {
  return request(`/characters/${characterId}/oath`, { method: 'DELETE' })
}

// ── Gallery 相册 ──
export function listGalleryImages(limit = 100, offset = 0, folder = '', characterId = null) {
  let path = `/images/gallery?limit=${limit}&offset=${offset}`
  if (folder) path += `&folder=${encodeURIComponent(folder)}`
  if (characterId) path += `&character=${encodeURIComponent(characterId)}`
  return request(path)
}

/** 提交后台重新生成任务（完成后需确认才覆盖原图） */
export function regenerateImage(imageUrl) {
  return request(`/images/regenerate`, { method: 'POST', body: { url: imageUrl } })
}

/** 提交后台 HiresFix 细化任务（完成后需确认才覆盖原图） */
export function upscaleImage(imageUrl) {
  return request(`/images/upscale`, { method: 'POST', body: { url: imageUrl } })
}

/** 运行中 / 待确认 / 失败的图片编辑任务 */
export function listImageEditTasks() {
  return request(`/images/edit-tasks`)
}

/** 确认覆盖：用暂存结果原子替换原图 */
export function applyImageEditTask(taskId, token) {
  return request(`/images/edit-tasks/${taskId}/apply`, { method: 'POST', body: { token } })
}

/** 重新生成：按原动作 + 原图再跑一次 */
export function rerunImageEditTask(taskId, token) {
  return request(`/images/edit-tasks/${taskId}/rerun`, { method: 'POST', body: { token } })
}

/** 保留原图：删除暂存结果 */
export function discardImageEditTask(taskId, token) {
  return request(`/images/edit-tasks/${taskId}/discard`, { method: 'POST', body: { token } })
}
/** 删除指定图片（物理文件） */
export function deleteImage(imageUrl) {
  return request(`/images/delete`, { method: 'DELETE', body: { url: imageUrl } })
}

/**
 * 批量删除图片（与上游 v3.10.0 统一）。
 * 后端逐张复用单张删除逻辑：幂等（已不存在也算成功）、百分号编码、.avif 孪生、聊天引用清理。
 * 注意：相册页的多选入口还没做 —— 接口先就绪，UI 等真要做多选时一起上。
 */
export function deleteImagesBatch(urls) {
  return request(`/images/delete-batch`, { method: 'POST', body: { urls } })
}

// ── 图片压缩 ──
export async function getCompressStatus() {
  return request(`/images/compress/status`)
}

export async function updateCompressConfig(data) {
  return request(`/images/compress/config`, { method: 'PUT', body: data })
}

export async function startCompress() {
  return request(`/images/compress/start`, { method: 'POST' })
}

export async function cancelCompress() {
  return request(`/images/compress/cancel`, { method: 'POST' })
}

// ── 画师串收藏夹 ──
export async function getArtistFavorites() {
  return request(`/config/artist-favorites`)
}

export async function addArtistFavorite({ label, artist }) {
  return request(`/config/artist-favorites`, { method: 'POST', body: { label, artist } })
}

export async function updateArtistFavorite(id, data) {
  return request(`/config/artist-favorites/${id}`, { method: 'PUT', body: data })
}

export async function deleteArtistFavorite(id) {
  return request(`/config/artist-favorites/${id}`, { method: 'DELETE' })
}

// ── Events 奇遇 ──
export async function listEvents() {
  return request(`/events`)
}

export async function getActiveEvent(characterId) {
  return request(`/events/active/${characterId}`)
}

/** 按 id 取历史事件详情；未找到（非 2xx）返回 null 而不抛错 */
export async function getEventById(eventId) {
  try {
    return await request(`/events/by-id/${eventId}`)
  } catch { return null }
}

export async function chooseEventOption(eventId, choice, customText) {
  // 120s 超时：LLM (~15s) + ComfyUI 生图 (~90s) 的总耗时上限
  // 避免请求无限挂起耗尽浏览器 HTTP/1.1 连接池（6 连接限制 + 3 SSE = 仅剩 3 可用）
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 120_000)
  try {
    return request(`/events/${eventId}/choose`, { method: 'POST', body: { choice, customText }, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function undoEventOption(eventId) {
  return request(`/events/${eventId}/undo`, { method: 'POST' })
}

export async function dismissEvent(eventId) {
  return request(`/events/${eventId}/dismiss`, { method: 'POST' })
}

export async function concludeEvent(eventId) {
  return request(`/events/${eventId}/conclude`, { method: 'POST' })
}

export async function deleteEvent(eventId) {
  return request(`/events/${eventId}`, { method: 'DELETE' })
}

/**
 * 给已有奇遇补一张配图（§3.5）
 * 后端用行里存的 prompt/style/resolution 重跑一次生图链路。
 * 成功 `{ok:true, image:'/images/events/…'}`；
 * 失败 `{ok:false, error:'人话原因'}` —— 注意失败也是 200，
 * 这里要把它当"一次正常的业务结果"来处理（把 error 显示给用户），不要当成请求异常。
 */
export async function regenerateEventImage(eventId) {
  return request(`/events/${eventId}/image`, { method: 'POST' })
}

export async function getEventsUnread() {
  return request(`/events/unread-count`)
}

export async function markEventsRead() {
  return request(`/events/mark-read`, { method: 'POST' })
}

export async function generateEvent(characterId, eventTypeKey, customPrompt) {
  return request(`/events/generate`, { method: 'POST', body: { characterId, eventTypeKey, customPrompt } })
}

/**
 * 连接统一 SSE 推送流（替代 3 个独立 SSE 长连接）
 *
 * 合并以下三条流为一个 HTTP 连接，释放 HTTP/1.1 6 连接限制下的 2 个连接位：
 *   - /api/events/stream    → handlers['new_event'|'event_update'|...]
 *   - /api/moments/stream    → handlers['new_post']
 *   - /api/notifications/stream → handlers['proactive_message']
 *
 * @param {{ [eventType: string]: Function }} handlers - key = SSE event type, value = callback(data)
 * @returns {{ close: () => void, _closed: boolean }}
 */
export function connectUnifiedStream(handlers = {}, { onClose } = {}) {
  const controller = new AbortController()
  const conn = { _closed: false }

  conn.close = () => {
    conn._closed = true
    controller.abort()
  }

  function _handleClose() {
    if (conn._closed) return  // 已经关闭过（可能是主动 close）
    conn._closed = true
    if (onClose) onClose()
  }

  fetch(`${BASE}/stream`, { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) {
        console.warn('[api] unified SSE connection failed:', res.status)
        _handleClose()
        return
      }
      try {
        await consumeSSE(res, (event, data) => {
          if (data === undefined) return
          const fn = handlers[event]
          if (fn) fn(data)
        })
      } catch { /* 连接中断，交给上层重连逻辑 */ }
      _handleClose()
    })
    .catch(err => {
      if (err.name !== 'AbortError') {
        console.warn('[api] unified SSE error:', err.message)
      }
      _handleClose()
    })

  return conn
}

/** @deprecated 使用 connectUnifiedStream 替代 */
export function connectEventsStream(handlers = {}) {
  const controller = new AbortController()
  const conn = { _closed: false }

  conn.close = () => {
    conn._closed = true
    controller.abort()
  }

  fetch(`${BASE}/events/stream`, { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) {
        console.warn('[api] events SSE connection failed:', res.status)
        conn._closed = true
        return
      }
      try {
        await consumeSSE(res, (event, data) => {
          if (data === undefined) return
          if (event === 'new_event') handlers.onNewEvent?.(data)
          else if (event === 'event_update') handlers.onUpdate?.(data)
          else if (event === 'event_concluded') handlers.onConclusion?.(data)
          else if (event === 'event_expired') handlers.onExpired?.(data)
        })
      } catch { /* 连接中断，交给上层重连逻辑 */ }
      conn._closed = true
    })
    .catch(err => {
      conn._closed = true
      if (err.name !== 'AbortError') {
        console.warn('[api] events SSE error:', err.message)
      }
    })

  return conn
}

// ── Schedule 日程系统 ──

export function getScheduleOverview() {
  return request(`/schedule`)
}

export function getCharacterSchedule(characterId) {
  return request(`/schedule/${characterId}`)
}

export function getCurrentActivity(characterId) {
  return request(`/schedule/${characterId}/current`)
}

/**
 * 她今天的「私密时刻」（2026-10-02 新玩法：自慰 / 你闯进来了）。
 *
 * 用户原话：「再增加一个事件 叫自慰 和角色敏感度也相关 越高发生概率也就越高 这个可以算到日程里」。
 * 返回 `{ characterId, has, active, caught, label, line, startTime, endTime, minutesLeft }`；
 * `has:false` ⇒ 今天没有这一段（前端零渲染）。判定在后端是确定性的，轮询不会闪来闪去。
 */
export function getPrivateMoment(characterId) {
  return request(`/schedule/${characterId}/private-moment`)
}

/** 编辑单条日程（标记为已编辑，进入当天特殊朋友圈队列） */
export function updateScheduleActivity(characterId, index, patch) {
  return request(`/schedule/${characterId}/activity`, { method: 'PUT', body: { index, ...patch } })
}

export function peekSnapshot(characterId, genImage = true, activityContext = null) {
  const body = { gen_image: genImage };
  if (activityContext) body.activity = activityContext;
  return request(`/schedule/${characterId}/peek`, { method: 'POST', body })
}

/** 瞄一眼再拍一张：使用已生成的 prompt 重新提交 ComfyUI 生图 */
export function retakePeekSnapshot(characterId, prompt) {
  return request(`/schedule/${characterId}/peek/retake`, { method: 'POST', body: { prompt } })
}

export function regenerateSchedule(characterId, direction) {
  const body = {}
  if (direction) body.direction = direction
  return request(`/schedule/${characterId}/regenerate`, { method: 'POST', body })
}

/** 重置世界线：重新生成所有角色日程（后端 SSE 推送进度） */
export function regenerateAllSchedules(direction) {
  const body = {}
  if (direction) body.direction = direction
  return request(`/schedule/regenerate-all`, { method: 'POST', body })
}

/** 取消正在进行的重置世界线任务 */
export async function cancelRegenerateAll() {
  return request(`/schedule/regenerate-all/cancel`, { method: 'POST' })
}

/** 查询当前重置世界线任务状态（页面刷新恢复用） */
export function getResetStatus() {
  return request(`/schedule/reset-status`)
}

/** 清空指定角色的所有日程（模板、快照、禁用自动生成） */
export function clearSchedule(characterId) {
  return request(`/schedule/${characterId}/clear`, { method: 'POST' })
}

// ── 叫醒系统 ──

/** 电话叫醒（40% 概率成功） */
export function wakeUpByPhone(characterId) {
  return request(`/schedule/${characterId}/wake-up-phone`, { method: 'POST' })
}

/** 上门摇醒（必定成功） */
export function wakeUpByDoor(characterId) {
  return request(`/schedule/${characterId}/wake-up-door`, { method: 'POST' })
}

// ── 工作流管理 ──
export async function checkWorkflowStatus() {
  return request(`/workflows/status`)
}

export async function restoreWorkflow() {
  return request(`/workflows/restore`, { method: 'POST' })
}

export async function updateWorkflowMode(mode, customTemplate) {
  // customTemplate 只在 mode === 'custom' 时有意义（workflow/ 目录下的文件名）
  return request(`/config/workflow-mode`, {
    method: 'PUT',
    body: customTemplate === undefined ? { mode } : { mode, customTemplate },
  })
}

export async function updateWorkflowScene(scene) {
  return request(`/config/workflow-scene`, { method: 'PUT', body: { scene } })
}

// ── 信箱 ──

export async function listLetters(page = 1, limit = 20) {
  return request(`/mailbox?page=${page}&limit=${limit}`)
}

export async function getUnreadCount() {
  return request(`/mailbox/unread`)
}

export async function sendLetter(characterId, title, content) {
  return request(`/mailbox/send`, { method: 'POST', body: { character_id: characterId, title, content } })
}

export async function getLetter(id) {
  return request(`/mailbox/${id}`)
}

export async function markLetterRead(id) {
  return request(`/mailbox/${id}/mark-read`, { method: 'PUT' })
}

export async function deleteLetter(id) {
  return request(`/mailbox/${id}`, { method: 'DELETE' })
}

/**
 * 手动重新投递一封失败的信（2026-10-17 §P2-1）。
 * 后端把 `failed` 打回 `pending` 并清零 retry_count；`processing`/`completed` 会返回 409（语义化拒绝）。
 */
export async function retryLetter(id) {
  return request(`/mailbox/${id}/retry`, { method: 'POST' })
}

// ── 角色日记（上游 v3.9.0 合并；只追加，不改已有函数）──

/** 取某个角色某一天的日记（date 省略 = 今天） */
export function getDiary(characterId, date) {
  const q = date ? `?date=${encodeURIComponent(date)}` : ''
  return request(`/diaries/${characterId}${q}`)
}

/** 历史日记简目（最新在前，供日记本翻页导航） */
export function listDiaries(characterId, limit = 60) {
  return request(`/diaries/${characterId}/history?limit=${limit}`)
}

/** 生成 / 重新生成某一天的日记（后台执行，进度走 SSE 与右下角生成提示） */
export function generateDiary(characterId, date) {
  const body = {}
  if (date) body.date = date
  return request(`/diaries/${characterId}/generate`, { method: 'POST', body })
}

// ── 《邻舍日报》预告报纸 ──

export async function getTodayNewspaper() {
  return request(`/newspaper/today`)
}

// 历史期简目（最新在前，供期号导航）
export async function listNewspaperEditions() {
  return request(`/newspaper/editions`)
}

// 按日期回看某一期
export async function getNewspaperByDate(date) {
  return request(`/newspaper/by-date/${date}`)
}

export async function generateNewspaper() {
  return request(`/newspaper/generate`, { method: 'POST' })
}

// 重新生成今天的报纸（文字重印，配图后台补）—— 上游 v3.10.0 合并，2026-10-19
export async function regenerateTodayNewspaper() {
  return request('/newspaper/regenerate', { method: 'POST' })
}

// 手动补印一张缺失的报纸配图（slot: lead=特稿 / world=今日异闻 / item=普通新闻，index 为新闻下标；
// date 省略 = 今天，带日期可给历史期补图）
export async function regenerateNewspaperImage({ slot, index, date } = {}) {
  return request(`/newspaper/regenerate-image`, { method: 'POST', body: { slot, index, date } })
}

// 消除/恢复今天的世界影响（异闻不再/重新注入角色提示词）
export async function dismissNewspaperWorldState(dismissed) {
  return request(`/newspaper/dismiss-world`, { method: 'POST', body: { dismissed } })
}


// ── 事件库管理（奇遇事件类型 / 朋友圈话题）──

export async function listEventTypes() {
  return request(`/library/event-types`)
}

export function createEventType(data) {
  return request(`/library/event-types`, { method: 'POST', body: data })
}

export function updateEventType(id, data) {
  return request(`/library/event-types/${id}`, { method: 'PUT', body: data })
}

export function deleteEventType(id) {
  return request(`/library/event-types/${id}`, { method: 'DELETE' })
}

export function generateEventTypes(direction) {
  return request(`/library/event-types/generate`, { method: 'POST', body: { direction } })
}

export function saveEventTypeBatch(items) {
  return request(`/library/event-types/save-batch`, { method: 'POST', body: { items } })
}

export async function listTopics() {
  return request(`/library/topics`)
}

export function createTopic(data) {
  return request(`/library/topics`, { method: 'POST', body: data })
}

export function updateTopic(id, data) {
  return request(`/library/topics/${id}`, { method: 'PUT', body: data })
}

export function deleteTopic(id) {
  return request(`/library/topics/${id}`, { method: 'DELETE' })
}

// 批量勾选/取消勾选话题（{ ids } 或 { all: true }）—— 上游 v3.10.0 合并，2026-10-19
export function setTopicsChecked({ ids = null, all = false, checked }) {
  return request(`/library/topics/set-checked`, { method: 'POST', body: { ids, all, checked } })
}

export function generateTopics(direction) {
  return request(`/library/topics/generate`, { method: 'POST', body: { direction } })
}

export function saveTopicBatch(items) {
  return request(`/library/topics/save-batch`, { method: 'POST', body: { items } })
}

// ── MaiBot 桥接（供系统设置内「MaiBot 桥接」页面调用）──
async function maibotFetch(path, options = {}) {
  const headers = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}/maibot${path}`, {
    ...options,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* 非 JSON 响应按 null 处理 */ }
  if (!res.ok) throw new Error((data && data.error) || (`HTTP ${res.status}`))
  return data
}

export function maibotGetWebuiSettings() {
  return maibotFetch('/webui-settings')
}
export function maibotSaveWebuiSettings(token) {
  return maibotFetch('/webui-settings', { method: 'POST', body: { token } })
}
export function maibotListCharacters() {
  return maibotFetch('/characters')
}
export function maibotGetPluginConfig() {
  return maibotFetch('/plugin-config')
}
export function maibotUpdatePluginConfig(config) {
  return maibotFetch('/plugin-config', { method: 'PUT', body: { config } })
}
export function maibotGetPluginPersona() {
  return maibotFetch('/plugin-persona')
}
export function maibotUpdatePluginPersona(payload) {
  return maibotFetch('/plugin-persona', { method: 'PUT', body: payload })
}
export function maibotDeriveStyle(basePrompt) {
  return maibotFetch('/derive-style', { method: 'POST', body: { base_prompt: basePrompt } })
}
export function maibotGetLatestMemory() {
  return maibotFetch('/latest-memory')
}
export function maibotDeleteLatestMemory(sessionId) {
  return maibotFetch(`/latest-memory?session_id=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

// ── 背包 / 道具系统 ──

// 背包内容（已收下）+ 待收下道具 + 宝箱冷却状态 + 生效中的效果
export function listItems() {
  return request(`/items`)
}

// 开启每日宝箱（16 小时冷却；道具图片异步生成，完成后经 item_ready 事件刷新）
export function openChest() {
  return request(`/items/chest/open`, { method: 'POST' })
}

// 收下道具（开箱后需收下才出现在背包）
export function collectItem(itemId) {
  return request(`/items/${itemId}/collect`, { method: 'POST' })
}

// 使用道具
export function useItem(itemId, characterId) {
  return request(`/items/${itemId}/use`, { method: 'POST', body: { character_id: characterId } })
}

// 丢弃道具
export function discardItem(itemId) {
  return request(`/items/${itemId}`, { method: 'DELETE' })
}

// 提前移除已生效的效果（服饰/变身会同步撤销临时外观）
export function removeActiveEffect(effectId) {
  return request(`/items/effects/${effectId}`, { method: 'DELETE' })
}

// ── 媒体内容页（传媒 / 数字媒体，2026-10-13 合并上游 v3.9.0）──

// 匿名 NPC 头像库
export function listMediaAvatars() {
  return request('/media/avatars')
}
export function generateMediaAvatars(direction = '', artist = '@ebora', count = 10) {
  return request('/media/avatars/generate', { method: 'POST', body: { direction, artist, count } })
}
export function regenerateMediaAvatar(id, direction = '', artist = '@ebora') {
  return request(`/media/avatars/${id}/regenerate`, { method: 'POST', body: { direction, artist } })
}
export function removeMediaAvatar(id) {
  return request(`/media/avatars/${id}`, { method: 'DELETE' })
}

// 媒体 CRUD
export function listMediaOutlets() {
  return request('/media/outlets')
}
export function createMediaOutlet(body) {
  return request('/media/outlets', { method: 'POST', body })
}
export function generateMediaOutletDraft(body, signal) {
  return request('/media/outlets/draft', { method: 'POST', body, signal })
}
export function updateMediaOutlet(id, body) {
  return request(`/media/outlets/${id}`, { method: 'PUT', body })
}
export function deleteMediaOutlet(id) {
  return request(`/media/outlets/${id}`, { method: 'DELETE' })
}

// 板块 CRUD
export function listMediaBoards(outletId) {
  return request(`/media/outlets/${outletId}/boards`)
}
export function createMediaBoard(outletId, body) {
  return request(`/media/outlets/${outletId}/boards`, { method: 'POST', body })
}
export function updateMediaBoard(boardId, body) {
  return request(`/media/boards/${boardId}`, { method: 'PUT', body })
}
export function deleteMediaBoard(boardId) {
  return request(`/media/boards/${boardId}`, { method: 'DELETE' })
}

// 帖子
export function getMediaUnread(seen = {}) {
  const q = new URLSearchParams()
  if (seen?.digital != null) q.set('digital', String(seen.digital))
  if (seen?.social != null) q.set('social', String(seen.social))
  const s = q.toString()
  return request(`/media/unread-count${s ? `?${s}` : ''}`)
}
export function listMediaPosts({ outlet = null, board = null, category = null, favoritesOnly = false, limit = 40, offset = 0 } = {}) {
  const q = new URLSearchParams()
  if (outlet) q.set('outlet', String(outlet))
  if (board) q.set('board', String(board))
  if (category) q.set('category', category)
  if (favoritesOnly) q.set('favorites', '1')
  if (limit) q.set('limit', String(limit))
  if (offset) q.set('offset', String(offset))
  const s = q.toString()
  return request(`/media/posts${s ? `?${s}` : ''}`)
}
export function setMediaPostFavorite(postId, favorite) {
  return request(`/media/posts/${postId}/favorite`, { method: 'PUT', body: { favorite } })
}
export function regenerateMediaPostImage(postId) {
  return request(`/media/posts/${postId}/regenerate-image`, { method: 'POST' })
}
export function deleteMediaPost(postId) {
  return request(`/media/posts/${postId}`, { method: 'DELETE' })
}
export function deleteMediaPosts(ids) {
  return request('/media/posts/batch', { method: 'DELETE', body: { ids } })
}
export function regenerateMediaPostImages(ids) {
  return request('/media/posts/batch/regenerate-image', { method: 'POST', body: { ids } })
}

// 数字报刊（门户·两层生成）
export function generateMediaSection(postId, sectionKey) {
  return request(`/media/posts/${postId}/sections/${encodeURIComponent(sectionKey)}`, { method: 'POST' })
}

// 生成 / 补图 / 自动档位
export function refreshMediaPosts(body = {}) {
  return request('/media/refresh', { method: 'POST', body })
}
export function fillMediaImages(limit = 6) {
  return request('/media/fill-images', { method: 'POST', body: { limit } })
}
export function getMediaAuto() {
  return request('/media/auto')
}
export function setMediaAuto(minutes) {
  return request('/media/auto', { method: 'PUT', body: { minutes } })
}

// ── AI 小镇（世界页）──

// 全量快照：地图/POI/agents/玩家/天气/活跃相遇
// mapId 省略 = 玩家当前那张图；显式指定用于出行前预载目标图（不含玩家坐标）
export function fetchTownState(mapId = null) {
  return jsonRequest(`${BASE}/town/state${mapId != null ? `?mapId=${encodeURIComponent(mapId)}` : ''}`)
}

// 出行目录：所有小镇（含居民数与建成状态）+ 玩家所在地图 + 场景修订号
export function fetchTownMaps() {
  return jsonRequest(`${BASE}/town/maps`)
}

// 给一座小镇改名（只动名字，不重写图层与 POI）
export function renameTownMap(mapId, name) {
  return jsonRequest(`${BASE}/town/maps/${encodeURIComponent(mapId)}`, townJson('PATCH', { name }))
}

// 出行：把玩家搬到另一张图。expectedPlayerRevision 用于并发时只让第一个请求生效
export function travelTown(targetMapId, { expectedPlayerRevision = null, worldId, worldEpoch } = {}) {
  return jsonRequest(`${BASE}/town/travel`, townJson('POST', { targetMapId, expectedPlayerRevision, worldId, worldEpoch }))
}

// 世界页在线打点：TownView 挂载期间定期调用，服务端据此开启相遇/气泡等页面演出
export function townViewerHeartbeat() {
  return jsonRequest(`${BASE}/town/viewer/heartbeat`, townJson('POST'))
}

// 居民详细状态（需求/心情/目标/技能/最近来往，只读展示层）
export function fetchTownActorStatus(actorId) {
  return jsonRequest(`${BASE}/town/actors/${encodeURIComponent(actorId)}/status`)
}

// 居民活动流水（只读展示层）：全镇信息流（左上角浮窗/动态面板）+ 单居民行动记录
export function fetchTownActivity(limit = 40) {
  return jsonRequest(`${BASE}/town/activity?limit=${encodeURIComponent(limit)}`)
}
export function fetchTownActorActivity(actorId, limit = 100) {
  return jsonRequest(`${BASE}/town/actors/${encodeURIComponent(actorId)}/activity?limit=${encodeURIComponent(limit)}`)
}

// 玩家 token 移动（服务端寻路 + town_move 广播）；带 mapId 让跨图后的旧请求被服务端拒掉
export function moveTownPlayer(x, y, { worldId, worldEpoch, mapId } = {}) {
  return jsonRequest(`${BASE}/town/player/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, worldId, worldEpoch, ...(mapId != null ? { mapId } : {}) }),
  })
}

// 相遇对话记录
export function fetchTownEncounterMessages(encounterId) {
  return jsonRequest(`${BASE}/town/encounters/${encounterId}/messages`)
}

// 小镇角色名单（在场状态）
export function fetchTownCharacters() {
  return jsonRequest(`${BASE}/town/characters`)
}

// ── AI 小镇 v2：素材库 / 瓦片地图 / 初始化向导 / 轻量居民 ──

function townJson(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }
}

// 素材库
export function fetchTownAssets(kind = null) {
  return jsonRequest(`${BASE}/town/assets${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`)
}

export function createTownAsset(payload) {
  return jsonRequest(`${BASE}/town/assets`, townJson('POST', payload))
}

export function regenerateTownAsset(id, overrides = {}) {
  return jsonRequest(`${BASE}/town/assets/${id}/regenerate`, townJson('POST', overrides))
}

export function deleteTownAsset(id) {
  return jsonRequest(`${BASE}/town/assets/${id}`, { method: 'DELETE' })
}

export function fetchTownAsset(id) {
  return jsonRequest(`${BASE}/town/assets/${id}`)
}

export function regenerateTownAssetPrompt(id, requirement, options = {}) {
  return jsonRequest(`${BASE}/town/assets/${id}/regenerate-prompt`, townJson('POST', { requirement, ...options }))
}

// 保存单张素材的画师串 / LoRA / 固定前缀
export function updateTownAssetGeneration(id, payload) {
  return jsonRequest(`${BASE}/town/assets/${id}/generation`, townJson('PATCH', payload))
}
// 保存前端编辑后的素材图（点击抠除颜色 / 裁剪，dataUrl PNG）
export function saveTownAssetImage(id, dataUrl) {
  return jsonRequest(`${BASE}/town/assets/${id}/image`, townJson('POST', { dataUrl }))
}

// 手动上传本地图片替换素材（base64 dataUrl）：后端按素材规格走生成同款后处理
export function uploadTownAssetImage(id, dataUrl) {
  return jsonRequest(`${BASE}/town/assets/${id}/upload`, townJson('POST', { dataUrl }))
}
// 按截取框裁剪素材并覆盖（放大查看后划定最终成图范围）
export function cropTownAsset(id, rect) {
  return jsonRequest(`${BASE}/town/assets/${id}/crop`, townJson('POST', rect))
}

// 地砖专用：按菱形框（x/y/w，高 = 宽 / 2）在裁剪前原图上重裁并覆盖成品
export function cropTownTileAsset(id, diamond) {
  return jsonRequest(`${BASE}/town/assets/${id}/crop-tile`, townJson('POST', diamond))
}

// 小镇立绘 HiresFix 细化（按全局 HiresFix 设置覆盖原图）
export function refineTownAssetHires(id) {
  return jsonRequest(`${BASE}/town/assets/${id}/hires`, townJson('POST', {}))
}

// 地图（编辑器保存 / 渲染载荷）；mapId 省略 = 玩家当前那张图
export function fetchTownMap(mapId = null) {
  return jsonRequest(`${BASE}/town/map${mapId != null ? `?mapId=${encodeURIComponent(mapId)}` : ''}`)
}

export function saveTownMap(payload) {
  return jsonRequest(`${BASE}/town/map`, townJson('PUT', payload))
}

// 天空远景：生成/重生成地图外圈的两层剪影（世界观 LLM 出词 + ComfyUI）
export function generateTownSkyBackdrops() {
  return jsonRequest(`${BASE}/town/sky-backdrops`, townJson('POST', {}))
}

// 初始化向导
export function fetchTownInitState() {
  return jsonRequest(`${BASE}/town/init`)
}

export function startTownInit(payload) {
  return jsonRequest(`${BASE}/town/init/start`, townJson('POST', payload))
}

export function updateTownBlueprint(blueprint) {
  return jsonRequest(`${BASE}/town/init/blueprint`, townJson('PUT', blueprint))
}

export function generateTownAssetPrompts(payload) {
  return jsonRequest(`${BASE}/town/init/asset-prompts`, townJson('POST', payload))
}

export function generateTownSamples() {
  return jsonRequest(`${BASE}/town/init/samples`, townJson('POST', {}))
}

export function startTownBatch() {
  return jsonRequest(`${BASE}/town/init/batch`, townJson('POST', {}))
}

export function fetchTownInitPreview() {
  return jsonRequest(`${BASE}/town/init/preview`)
}

export function generateTownLayout() {
  return jsonRequest(`${BASE}/town/init/layout`, townJson('POST', {}))
}

export function rerollTownLayout() {
  return jsonRequest(`${BASE}/town/init/reroll`, townJson('POST', {}))
}

// 向导居民步：按蓝图提前建档居民（稳定人格卡）
export function commitTownWizardNpcs() {
  return jsonRequest(`${BASE}/town/init/npcs`, townJson('POST', {}))
}

// 向导居民步：按数量重新生成名单（拉条）
export function regenerateTownNpcRoster(count) {
  return jsonRequest(`${BASE}/town/init/npc-roster`, townJson('POST', { count }))
}

export function confirmTownInit() {
  return jsonRequest(`${BASE}/town/init/confirm`, townJson('POST', {}))
}

export function cancelTownInit() {
  return jsonRequest(`${BASE}/town/init`, { method: 'DELETE' })
}

// 轻量居民（NPC）
export function fetchTownNpcs() {
  return jsonRequest(`${BASE}/town/npcs`)
}

export function fetchTownNpc(id) {
  return jsonRequest(`${BASE}/town/npcs/${id}`)
}

export function createTownNpc(payload) {
  return jsonRequest(`${BASE}/town/npcs`, townJson('POST', payload))
}

export function updateTownNpc(id, payload) {
  return jsonRequest(`${BASE}/town/npcs/${id}`, townJson('PUT', payload))
}

export function deleteTownNpc(id) {
  return jsonRequest(`${BASE}/town/npcs/${id}`, { method: 'DELETE' })
}

export function generateTownNpcSprites(id, overrides = {}) {
  const body = { ...overrides }
  if (typeof body.refreshAppearance !== 'boolean') delete body.refreshAppearance
  return jsonRequest(`${BASE}/town/npcs/${id}/sprites`, townJson('POST', body))
}

export function generateTownNpcPortrait(id, overrides = {}) {
  return jsonRequest(`${BASE}/town/npcs/${id}/portrait`, townJson('POST', overrides))
}

/** 一次出齐全套素材（正面 / 背面 / 大立绘）：后端一次 LLM 返回三条提示词再分别出图 */
export function generateTownNpcAssetSet(id, overrides = {}) {
  const body = { ...overrides }
  if (typeof body.refreshAppearance !== 'boolean') delete body.refreshAppearance
  return jsonRequest(`${BASE}/town/npcs/${id}/asset-set`, townJson('POST', body))
}

export function regenerateTownNpcPersonaCard(id, overrides = {}) {
  return jsonRequest(`${BASE}/town/npcs/${id}/persona-card`, townJson('POST', overrides))
}

export function inviteTownNpc(id) {
  return jsonRequest(`${BASE}/town/npcs/${id}/invite`, townJson('POST', {}))
}

export function generateTownCharacterPortrait(characterId) {
  return jsonRequest(`${BASE}/town/characters/${characterId}/portrait`, townJson('POST', {}))
}

// 入住角色的全套素材（立绘 + 正/背小人；已有素材的环节后端自动跳过，force = true 时整套重新生成）
export function ensureTownCharacterAssets(characterId, options = {}) {
  return jsonRequest(`${BASE}/town/characters/${characterId}/assets`, townJson('POST', options?.force === true ? { force: true } : {}))
}

export function rerollTownNpc(id) {
  return jsonRequest(`${BASE}/town/npcs/${id}/reroll`, townJson('POST', {}))
}

export function fetchTownNpcMessages(id) {
  return jsonRequest(`${BASE}/town/npcs/${id}/messages`)
}

export function chatWithTownNpc(id, message, { clientMessageId, worldId, worldEpoch } = {}) {
  return jsonRequest(`${BASE}/town/npcs/${id}/chat`, townJson('POST', { message, clientMessageId, worldId, worldEpoch }))
}

// 入住角色开关
export function setTownCharacterEnabled(characterId, townEnabled) {
  return jsonRequest(`${BASE}/town/characters/${characterId}`, townJson('PUT', { townEnabled }))
}

// 入住角色的职能权限（打工 / 服务 / 交易，至少一项）
export function setTownCharacterCapabilities(characterId, capabilities) {
  return jsonRequest(`${BASE}/town/characters/${characterId}`, townJson('PUT', { capabilities }))
}

// 为酒馆角色建托管居民档案（服务 / 打工 / 货架项目落库用，幂等）
export function ensureTownCharacterProfile(characterId) {
  return jsonRequest(`${BASE}/town/characters/${characterId}/profile`, townJson('POST', {}))
}

// 角色四方向spirit生成（管理面板）
export function generateTownCharacterSprites(characterId, options = {}) {
  return jsonRequest(`${BASE}/town/characters/${characterId}/sprites`, townJson('POST',
    typeof options.refreshAppearance === 'boolean' ? { refreshAppearance: options.refreshAppearance } : {}))
}

// 玩家形象套装（立绘 + 正/背小人）
export function fetchTownPlayerKit() {
  return jsonRequest(`${BASE}/town/player/kit`)
}

export function regenerateTownPlayerKit(overrides = {}) {
  return jsonRequest(`${BASE}/town/player/kit`, townJson('POST', overrides))
}

export function regenerateTownPlayerSprite(direction, overrides = {}) {
  return jsonRequest(`${BASE}/town/player/sprites/${direction}`, townJson('POST', overrides))
}

// 小镇设置 / 世界重置
export function fetchTownSettings() {
  return jsonRequest(`${BASE}/town/settings`)
}

export function updateTownSettings(patch) {
  return jsonRequest(`${BASE}/town/settings`, townJson('PUT', patch))
}

export function relayoutTownMap() {
  return jsonRequest(`${BASE}/town/map/relayout`, townJson('POST', {}))
}

export function resetTownWorld() {
  return jsonRequest(`${BASE}/town/world`, { method: 'DELETE' })
}

// 重新初始化**一座小镇**：只清这一张图的地图/POI/居民/相遇，别的镇不受影响
export function resetTownMap(mapId) {
  return jsonRequest(`${BASE}/town/maps/${encodeURIComponent(mapId)}`, { method: 'DELETE' })
}
// 玩家方向键单步移动（本地节流上报）；带 mapId 让跨图后的旧按键请求被服务端拒掉
export function moveTownPlayerDir(dx, dy, { worldId, worldEpoch, mapId } = {}) {
  return jsonRequest(`${BASE}/town/player/dir`, townJson('POST', { dx, dy, worldId, worldEpoch, ...(mapId != null ? { mapId } : {}) }))
}

// 对话驻留：打开对话框时让对方停走（服务端租约制，开窗续租、关闭释放、失联自动过期）
export function holdTownActor(actorId, { worldId, worldEpoch } = {}) {
  return jsonRequest(`${BASE}/town/actors/${encodeURIComponent(actorId)}/hold`, townJson('POST', { worldId, worldEpoch }))
}

export function releaseTownActor(actorId, { worldId, worldEpoch } = {}) {
  return jsonRequest(`${BASE}/town/actors/${encodeURIComponent(actorId)}/release`, townJson('POST', { worldId, worldEpoch }))
}


// 拎起小镇角色（上游 v3.10.0 合并，2026-10-19）：把居民从地图占位里提起来，随玩家移动
export function carryTownActor(actorId, body) {
  return jsonRequest(`${BASE}/town/actors/${encodeURIComponent(actorId)}/carry`, townJson('POST', body))
}

export function regenerateTownPlayerPortrait(overrides = {}) {
  return jsonRequest(`${BASE}/town/player/portrait`, townJson('POST', overrides))
}

export { getTownWallet, executeTownLifeCommand, createTownTargetTradeCommand,
  fetchTownInteractions, offerTownInteraction, respondTownInteraction,
  fetchTownNpcFunctions, receiveTownNpcGift } from './townLife.js'


// 独立角色表情立绘；与普通立绘和小镇素材分开存储。
const expressionStandingPath = (id, slot = '') => `/characters/${id}/expression-standings${slot ? '/' + encodeURIComponent(slot) : ''}`
export const getStandingOverview = () => request('/expression-standings/overview')
export const preflightAllExpressionStandings = body => request('/expression-standings/preflight', { method: 'POST', body })
export const preflightExpressionStandings = (id, body) => request(expressionStandingPath(id) + '/preflight', { method: 'POST', body })
export const generateAllExpressionStandings = body => request('/expression-standings/generate', { method: 'POST', body })
export const listExpressionStandings = id => request(expressionStandingPath(id))
export const generateExpressionStandings = (id, body) => request(expressionStandingPath(id) + '/generate', { method: 'POST', body })
export const controlExpressionStandingTask = (id, jobId, action) => request(expressionStandingPath(id) + `/jobs/${encodeURIComponent(jobId)}/${action}`, { method: 'POST' })
export const updateExpressionStandingPrompt = (id, slot, prompt, generation) => request(expressionStandingPath(id, slot) + '/prompt', { method: 'PATCH', body: { prompt, generation } })
export const editExpressionStanding = (id, slot, action, body = {}) => request(expressionStandingPath(id, slot) + '/' + action, { method: 'POST', body })
export const deleteExpressionStanding = (id, slot) => request(expressionStandingPath(id, slot), { method: 'DELETE' })
export const getStandingDisplayState = () => request('/standing-display/state')
export const setStandingDisplayCharacter = body => request('/standing-display/active', { method: 'PUT', body })

// ── 上游 v3.9.0 合并：朋友圈回填（补发今日动态）──────────────────────────────
// 后端 agent-core/src/services/momentBackfill.js；任务走 image_edit_task_* 那套被动型
// 后台任务（同一个 imageEditTasks store 就能看到进度），无需新增 SSE 事件与白名单。
export const backfillMoments = () => request('/moments/backfill', { method: 'POST' })
export const stopBackfillMoments = taskId => request(`/moments/backfill/${encodeURIComponent(taskId)}/stop`, { method: 'POST' })

// ── 上游 v3.9.0 合并：立绘互动（空手触摸台词 + 触碰配置）──────────────────────
// 后端 agent-core/src/services/standingTouchLines.js / standingInteractionService.js。
// 触碰配置目前只有台词一条链路（本地没有实验版的区域编辑器），所以这里不接
// standing-interaction 的读改写接口，只保留台词三件套。
export const getStandingTouchLines = (id, { signal } = {}) => request(`/characters/${id}/expression-standings/touch-lines`, { signal })
export const saveStandingTouchLines = (id, body) => request(`/characters/${id}/expression-standings/touch-lines`, { method: 'PUT', body })
export const generateStandingTouchLines = (id, expectedVersion) => request(`/characters/${id}/expression-standings/touch-lines/generate`, { method: 'POST', body: { expectedVersion } })
export const fillAllStandingTouchLines = () => request('/expression-standings/touch-lines/fill', { method: 'POST' })
/**
 * 立绘互动配置（上游 v3.9.0 契约；后端 routes/expressionStandings.js 已挂
 * `GET /characters/:id/standing-interaction`）：
 * 一次返回 { characterId, name, isSleeping, version, touchLines: { status, lines, error, version } }
 * —— 睡眠标记与台词同源，前端不必再自己拼一个 isSleeping:false。
 * 支持 AbortSignal（立绘触摸会话的超时 / 中断要能取消在飞的读取）。
 */
export const getStandingInteraction = (id, { signal } = {}) => request(`/characters/${id}/standing-interaction`, { signal })

// ── 角色资产「一键后台生成」（2026-10-01）────────────────────────────────────
// 后端 `agent-core/src/routes/assetGeneration.js`；计划由**后端**展开（前端不自己算张数）。
export const createAssetGenerationJob = body => request('/asset-generation/jobs', { method: 'POST', body })
export const getAssetGenerationJob = jobId => request(`/asset-generation/jobs/${encodeURIComponent(jobId)}`)
export const listAssetGenerationJobs = ({ active = false } = {}) =>
  request(`/asset-generation/jobs${active ? '?active=1' : ''}`)
export const controlAssetGenerationJob = (jobId, action) =>
  request(`/asset-generation/jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(action)}`, { method: 'POST', body: {} })

// ── 程序时间（世界钟）感知快照（2026-10-02 task-3 追加）──────────────────────────
// 只读：后端 `agent-core/src/routes/time.js` 的 `GET /api/time/perception`
// （同一个 router 也挂在旧路径 `/api/schedule/time/perception`，形状一致）。
// 返回**与注入提示词同源**的时间标签（后端现算 `timeLight.getTimeTag()` / `getTimeLightTag()` /
// `getLightHint()`）+ 各角色此刻的时段 / 光线 / 在做什么。
// 纪律：前端**不自己算偏移**（偏移只存在于后端 `program_time_state`），这里只负责取数，
// 并把后端的机器码翻成人话（409 `time control disabled` 等）。
export async function getTimePerception({ signal } = {}) {
  try {
    return await request('/time/perception', { signal })
  } catch (err) {
    const text = String(err?.message || '')
    if (/disabled/i.test(text)) throw new Error('程序时间功能当前已关闭')
    if (/not found|Cannot GET|请求失败 \(404\)/i.test(text)) throw new Error('后端还没有时间感知接口（等更新）')
    throw err
  }
}

// ── 性爱交互「可点击推进」（2026-10-01 task-1 追加）─────────────────────────────
// 后端 `agent-core/src/routes/intimateActions.js`，**独立前缀** `/api/intimate-actions`
// （不走 /api/characters：那一族里 intimate 与 characters 必须紧邻挂载，是冻结契约）。
//
// 契约（与面板 IntimateActionPanel.vue 一一对应）：
//   GET  /api/intimate-actions/:id/state          → { characterId, enabled, state, her, position, positionOptions, paceLevels, actions }
//   POST /api/intimate-actions/:id/:action        → body { positionKey }（只有换姿势需要）
//        · 成功   ：{ allowed:true, code:'ok', state, reaction|null, message|null, beat, climaxed, ... }
//        · 被拒   ：HTTP 200 + { allowed:false, code, message }（message 已是人话 → 直接 toast）
//        · 400/404/409 交给 request() 抛错（它已经优先取 `message` 人话）

/**
 * 读进行中状态 + 体位清单 + 逐动作可用性（面板打开 / 每次动作后刷新）
 *
 * 2026-10-02：加**场景**参数（用户报「群聊里点插入动作，消息跑到私聊」）——
 * `scene='group'` 时必须带 `groupId`，后端校验"群存在 + 她是成员"并把会话切到 `group_<gid>`；
 * 不传 = 私聊（老调用逐字不变）。
 */
export function fetchIntimateActionState(characterId, { scene = 'chat', groupId = null, signal } = {}) {
  const query = scene === 'group' && groupId ? `?scene=group&groupId=${encodeURIComponent(groupId)}` : ''
  return request(`/intimate-actions/${encodeURIComponent(characterId)}/state${query}`, { signal })
}

/**
 * 点一下推进。
 * @param {number|string} characterId
 * @param {'enter'|'thrust'|'faster'|'slower'|'stop'|'position'|'climax'} actionKey
 * @param {{positionKey?:string, scene?:'chat'|'group', groupId?:number|string}} [payload]
 *        换姿势必带目标体位 key；**群聊场景必须带** `scene:'group'` + `groupId`（否则她的反应会落到私聊）
 */
export function postIntimateAction(characterId, actionKey, payload = {}) {
  return request(`/intimate-actions/${encodeURIComponent(characterId)}/${encodeURIComponent(actionKey)}`, {
    method: 'POST',
    body: payload && Object.keys(payload).length ? payload : {},
  })
}

// ── 玩具玩法扩充（2026-10-02 task-2 追加）──────────────────────────────────────
// 后端同一个 router：`agent-core/src/routes/toys.js`（已由 app.js 挂在 `/api/characters`，
// **不需要新挂载点**）。契约：
//   POST /characters/:id/toys/:toyKey/mode   body { mode }   → 振动模式（steady/pulse/wave/random）
//   POST /characters/:id/toys/:toyKey/curve  body { curve }  → 强度曲线；`null` / 'off' 关掉
//   POST /characters/:id/toys/tick           body {}         → **推进曲线**（返回本 tick 的档位变化）
//   GET  /characters/:id/toys/self-play                       → 她自己会不会玩的判定预览（无副作用）
//   POST /characters/:id/toys/self-play      body { encourage } → 让她自己判断一次（愿意才真的动手）
// 口径：`GET /toys` 已经顺带 tick（面板轮询它就能看到 liveIntensity 在变）；模式/曲线只对
// **已佩戴**的玩具生效，未佩戴后端回 404 `toy_not_worn` —— 前端不自己拦（服务端说了算）。
// 场景：群聊里这五个（含 tick / 判定预览）都要带 `sceneOpts = { scene:'group', groupId }` ——
// 她自己玩那一句台词是要**发在她正在聊的那个地方**的（2026-10-03 群聊 bug，见 toySceneFields）。
export function setToyMode(characterId, toyKey, mode, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys/' + requireToyKey(toyKey) + '/mode', {
    method: 'POST', body: { mode, ...toySceneFields(sceneOpts) },
  })
}

export function setToyCurve(characterId, toyKey, curve, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys/' + requireToyKey(toyKey) + '/curve', {
    method: 'POST', body: { curve: curve || null, ...toySceneFields(sceneOpts) },
  })
}

export function tickToys(characterId, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys/tick', { method: 'POST', body: { ...toySceneFields(sceneOpts) } })
}

export function getSelfPlayState(characterId, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys/self-play' + toySceneQuery(sceneOpts))
}

export function triggerSelfPlay(characterId, { encourage = false } = {}, sceneOpts = {}) {
  return request('/characters/' + characterId + '/toys/self-play', {
    method: 'POST', body: { encourage, ...toySceneFields(sceneOpts) },
  })
}

// ── 上游 v3.9.0 合并：对话转录 / 角色立绘展示快照（galgame 模式） ──
export const getDialogueTranscript = (id, cursor = {}) => request(`/characters/${id}/dialogue?${new URLSearchParams(cursor)}`)
export const getCharacterStandingState = id => request(`/characters/${id}/standing-display`)

// ── 提示词预设（上游 v3.10.0：挂在 /api/presets；预设可在设置页切换启用）──
export const getPromptPresets = () => request('/presets')
export const createPromptPreset = body => request('/presets', { method: 'POST', body })
export const updatePromptPreset = (id, body) => request(`/presets/${id}`, { method: 'PUT', body })
export const activatePromptPreset = (id, active, expectedRevision) => request(`/presets/${id}/active`, { method: 'PUT', body: { active, expectedRevision } })
export const deletePromptPreset = (id, expectedRevision) => request(`/presets/${id}`, { method: 'DELETE', body: { expectedRevision } })
export const previewPromptPreset = body => request('/presets/preview', { method: 'POST', body })
