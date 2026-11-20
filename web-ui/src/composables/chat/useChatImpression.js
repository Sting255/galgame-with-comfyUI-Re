import { ref } from 'vue'
import { getCharacterPortrait, addPortrait, updatePortrait, deletePortrait } from '../../api/index.js'

export function useChatImpression({ chat, clock, confirmFn, toastFn, showSettings }) {
  // ── 角色详情编辑弹窗（酒馆同款） ──
  // ── 印象弹窗 ──
  const showImpression = ref(false)

  const impressionLoading = ref(false)

  const impressionError = ref('')

  const impressionGrouped = ref({ personality: [], preference: [] })

  const impressionVad = ref(null)

  // { instant, mood, dominantEmotion }
  const impressionAffinity = ref(50)

  const impressionLastDelta = ref(null)

  const impressionLastReason = ref('')

  const VAD_LABELS = {
    valence: { name: '愉悦度', left: '低落', right: '愉悦', range: [-1, 1] },
    arousal: { name: '唤醒度', left: '平静', right: '激动', range: [0, 1] },
    dominance: { name: '支配度', left: '顺从', right: '自主', range: [0, 1] },
  }

  const EMOTION_VAD_MAP = [
    // ═══ 高愉悦 · 高自主 (V > 0.4, D > 0.60) — 意气风发的快乐 ═══
    // V≈0.82-0.88, A≈0.75-0.85
    { label: '欣喜若狂', v: 0.87, a: 0.82, d: 0.72 },
    { label: '踌躇满志', v: 0.82, a: 0.75, d: 0.78 },
    // V≈0.70-0.82, A≈0.55-0.75
    { label: '得意洋洋', v: 0.78, a: 0.68, d: 0.76 },
    { label: '扬眉吐气', v: 0.80, a: 0.55, d: 0.78 },
    // V≈0.60-0.78, A≈0.45-0.65
    { label: '昂首阔步', v: 0.70, a: 0.60, d: 0.72 },
    { label: '意气风发', v: 0.68, a: 0.65, d: 0.68 },
    { label: '春风得意', v: 0.75, a: 0.50, d: 0.70 },
    // V≈0.48-0.68, A≈0.30-0.60
    { label: '泰然自若', v: 0.62, a: 0.38, d: 0.78 },
    { label: '意气扬扬', v: 0.55, a: 0.60, d: 0.72 },
    { label: '从容不迫', v: 0.52, a: 0.48, d: 0.65 },
    { label: '谈笑自若', v: 0.48, a: 0.55, d: 0.62 },
    { label: '傲睨得志', v: 0.58, a: 0.35, d: 0.82 },
    { label: '睥睨天下', v: 0.65, a: 0.45, d: 0.88 },

    // ═══ 高愉悦 · 温和自主 (V > 0.4, D: 0.35~0.60) — 自然流露的快乐 ═══
    // V≈0.85, A≈0.80
    { label: '欢天喜地', v: 0.85, a: 0.80, d: 0.52 },
    { label: '乐不可支', v: 0.86, a: 0.76, d: 0.46 },
    // V≈0.75-0.82, A≈0.68-0.78
    { label: '喜不自胜', v: 0.78, a: 0.72, d: 0.50 },
    { label: '欣喜万分', v: 0.72, a: 0.68, d: 0.52 },
    { label: '心花怒放', v: 0.80, a: 0.70, d: 0.55 },
    { label: '喜出望外', v: 0.75, a: 0.65, d: 0.45 },
    { label: '兴高采烈', v: 0.70, a: 0.75, d: 0.55 },
    // V≈0.55-0.70, A≈0.55-0.75
    { label: '眉飞色舞', v: 0.60, a: 0.70, d: 0.60 },
    { label: '轻松愉快', v: 0.70, a: 0.55, d: 0.55 },
    { label: '喜上眉梢', v: 0.62, a: 0.52, d: 0.52 },
    { label: '兴致盎然', v: 0.58, a: 0.58, d: 0.52 },
    { label: '津津有味', v: 0.52, a: 0.58, d: 0.50 },
    { label: '兴致勃勃', v: 0.55, a: 0.65, d: 0.55 },
    // V≈0.50-0.70, A≈0.25-0.50
    { label: '称心如意', v: 0.62, a: 0.48, d: 0.50 },
    { label: '心满意足', v: 0.65, a: 0.35, d: 0.55 },
    { label: '怡然自乐', v: 0.60, a: 0.30, d: 0.45 },
    { label: '悠然自得', v: 0.55, a: 0.25, d: 0.55 },
    // V≈0.40-0.55, A≈0.30-0.55
    { label: '含笑盈盈', v: 0.48, a: 0.52, d: 0.48 },
    { label: '乐在其中', v: 0.50, a: 0.45, d: 0.50 },
    { label: '心平气和', v: 0.45, a: 0.38, d: 0.48 },
    { label: '闲适自在', v: 0.42, a: 0.35, d: 0.45 },
    { label: '安心自在', v: 0.50, a: 0.30, d: 0.50 },
    { label: '舒舒服服', v: 0.40, a: 0.25, d: 0.40 },

    // ═══ 高愉悦 · 柔软依恋 (V > 0.4, D < 0.35) — 被动接收的快乐 ═══
    // V≈0.84-0.90, A≈0.78-0.86
    { label: '喜极而泣', v: 0.88, a: 0.84, d: 0.22 },
    { label: '雀跃不已', v: 0.84, a: 0.80, d: 0.28 },
    // V≈0.70-0.80, A≈0.70-0.80
    { label: '心潮澎湃', v: 0.76, a: 0.75, d: 0.25 },
    { label: '欢呼雀跃', v: 0.72, a: 0.78, d: 0.30 },
    // V≈0.60-0.75, A≈0.40-0.65
    { label: '甜甜蜜蜜', v: 0.65, a: 0.50, d: 0.28 },
    { label: '心驰神往', v: 0.68, a: 0.60, d: 0.25 },
    // V≈0.50-0.65, A≈0.18-0.45
    { label: '身心融化', v: 0.70, a: 0.22, d: 0.18 },
    { label: '柔情蜜意', v: 0.60, a: 0.42, d: 0.25 },
    { label: '小鸟依人', v: 0.58, a: 0.38, d: 0.20 },
    { label: '依偎安眠', v: 0.62, a: 0.22, d: 0.18 },
    { label: '柔情似水', v: 0.52, a: 0.25, d: 0.25 },
    // V≈0.40-0.58, A≈0.30-0.58
    { label: '含情脉脉', v: 0.52, a: 0.42, d: 0.22 },
    { label: '娇羞可人', v: 0.48, a: 0.48, d: 0.18 },
    { label: '温温柔柔', v: 0.50, a: 0.35, d: 0.30 },
    { label: '仰慕崇拜', v: 0.45, a: 0.48, d: 0.22 },
    { label: '又惊又喜', v: 0.50, a: 0.70, d: 0.32 },
    { label: '感激涕零', v: 0.55, a: 0.55, d: 0.18 },
    { label: '撒娇弄痴', v: 0.48, a: 0.52, d: 0.15 },
    { label: '受宠若惊', v: 0.40, a: 0.65, d: 0.22 },

    // ═══ 中低愉悦 / 中性 (V: -0.2 ~ 0.4) ═══
    // ── 高自主 (>0.55) ──
    { label: '跃跃欲试', v: 0.28, a: 0.55, d: 0.68 },
    { label: '自信满满', v: 0.40, a: 0.50, d: 0.75 },
    { label: '掌控全局', v: 0.30, a: 0.50, d: 0.85 },
    { label: '稳如泰山', v: 0.10, a: 0.32, d: 0.72 },
    { label: '不动声色', v: 0.00, a: 0.28, d: 0.65 },
    // ── 温和自主 (0.35~0.55) ──
    { label: '意兴盎然', v: 0.32, a: 0.50, d: 0.52 },
    { label: '若有所思', v: 0.28, a: 0.42, d: 0.50 },
    { label: '饶有兴趣', v: 0.25, a: 0.48, d: 0.48 },
    { label: '充满好奇', v: 0.20, a: 0.55, d: 0.45 },
    { label: '侧耳倾听', v: 0.22, a: 0.48, d: 0.45 },
    { label: '洗耳恭听', v: 0.15, a: 0.45, d: 0.42 },
    { label: '心如止水', v: 0.20, a: 0.35, d: 0.50 },
    { label: '不知不觉', v: 0.10, a: 0.35, d: 0.45 },
    { label: '意兴阑珊', v: -0.18, a: 0.25, d: 0.45 },
    { label: '兴致索然', v: -0.15, a: 0.20, d: 0.45 },
    // ── 低自主 (<0.35) ──
    { label: '将信将疑', v: 0.20, a: 0.42, d: 0.28 },
    { label: '忐忑犹豫', v: 0.12, a: 0.45, d: 0.25 },
    { label: '小心翼翼', v: 0.05, a: 0.40, d: 0.25 },
    { label: '惴惴小心', v: 0.02, a: 0.32, d: 0.22 },
    { label: '犹豫不决', v: 0.10, a: 0.28, d: 0.28 },
    { label: '胆怯羞涩', v: 0.15, a: 0.48, d: 0.20 },
    { label: '唯唯诺诺', v: -0.05, a: 0.20, d: 0.15 },

    // ═══ 负面 · 低唤醒 · 低支配 (V < 0, A < 0.4, D < 0.4) ═══
    { label: '昏昏欲睡', v: -0.10, a: 0.20, d: 0.40 },
    { label: '无精打采', v: -0.20, a: 0.22, d: 0.30 },
    { label: '萎靡不振', v: -0.25, a: 0.15, d: 0.25 },
    { label: '百无聊赖', v: -0.25, a: 0.18, d: 0.40 },
    { label: '闷闷不乐', v: -0.40, a: 0.28, d: 0.30 },
    { label: '郁郁寡欢', v: -0.50, a: 0.30, d: 0.35 },
    { label: '垂头丧气', v: -0.55, a: 0.22, d: 0.25 },
    { label: '心灰意冷', v: -0.55, a: 0.20, d: 0.30 },
    { label: '茫然若失', v: -0.30, a: 0.30, d: 0.20 },
    { label: '黯然神伤', v: -0.60, a: 0.25, d: 0.20 },
    { label: '悲从中来', v: -0.70, a: 0.30, d: 0.15 },
    { label: '万念俱灰', v: -0.78, a: 0.15, d: 0.10 },
    { label: '孤立无援', v: -0.35, a: 0.25, d: 0.15 },

    // ═══ 负面 · 高唤醒 · 低自主 (V < 0, A > 0.4, D < 0.35) — 恐惧/焦虑 ═══
    { label: '心神不宁', v: -0.18, a: 0.48, d: 0.32 },
    { label: '惴惴不安', v: -0.25, a: 0.50, d: 0.30 },
    { label: '忐忑不安', v: -0.30, a: 0.55, d: 0.25 },
    { label: '如坐针毡', v: -0.35, a: 0.70, d: 0.20 },
    { label: '忧心忡忡', v: -0.40, a: 0.65, d: 0.30 },
    { label: '心惊胆战', v: -0.45, a: 0.75, d: 0.20 },
    { label: '魂飞魄散', v: -0.60, a: 0.80, d: 0.15 },

    // ═══ 负面 · 高唤醒 · 中高自主 (V < 0, A > 0.4, D ≥ 0.35) — 愤怒/焦躁 ═══
    { label: '怏怏不乐', v: -0.22, a: 0.48, d: 0.42 },
    { label: '焦躁不安', v: -0.32, a: 0.62, d: 0.40 },
    { label: '心烦意乱', v: -0.30, a: 0.60, d: 0.55 },
    { label: '心头火起', v: -0.35, a: 0.55, d: 0.55 },
    { label: '愤懑不平', v: -0.38, a: 0.52, d: 0.48 },
    { label: '气急败坏', v: -0.50, a: 0.65, d: 0.55 },
    { label: '愤愤不平', v: -0.45, a: 0.55, d: 0.60 },
    { label: '恼羞成怒', v: -0.55, a: 0.70, d: 0.50 },
    { label: '怒不可遏', v: -0.65, a: 0.75, d: 0.70 },
    { label: '咬牙切齿', v: -0.70, a: 0.70, d: 0.75 },
    { label: '暴跳如雷', v: -0.72, a: 0.85, d: 0.82 },

    // ═══ 负面 · 低唤醒 · 高自主 (V < 0, A < 0.4, D > 0.55) — 冷漠/疏离 ═══
    { label: '不屑一顾', v: -0.20, a: 0.35, d: 0.70 },
    { label: '若即若离', v: -0.15, a: 0.30, d: 0.55 },
    { label: '冷若冰霜', v: -0.25, a: 0.28, d: 0.65 },
    { label: '漠不关心', v: -0.30, a: 0.25, d: 0.55 },
    { label: '鄙夷不屑', v: -0.38, a: 0.32, d: 0.62 },
    { label: '嗤之以鼻', v: -0.42, a: 0.30, d: 0.68 },
    { label: '大失所望', v: -0.40, a: 0.40, d: 0.35 },
  ]

  function vadDistance(e, vad) {
    // D 权重 1.8×：实践中 D 偏离幅度远小于 V/A（~0.02 vs ~0.15），
    // 等权会导致 D 几乎不参与匹配，造成欢天喜地(D=0.50)包揽所有高 V 状态
    const D_WEIGHT = 1.8
    return Math.sqrt(
      Math.pow(e.v - vad.valence, 2) +
      Math.pow(e.a - vad.arousal, 2) +
      Math.pow((e.d - vad.dominance) * D_WEIGHT, 2)
    )
  }

  function topEmotions(vad, n = 3) {
    if (!vad) return []
    return [...EMOTION_VAD_MAP]
      .map(e => ({ ...e, dist: vadDistance(e, vad) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, n)
  }

  function vadPercent(key, value) {
    const { range } = VAD_LABELS[key]
    return ((value - range[0]) / (range[1] - range[0])) * 100
  }

  function affinityLabel(val) {
    if (val >= 80) return '深度信任'
    if (val >= 60) return '亲切友好'
    if (val >= 40) return '中性友善'
    if (val >= 20) return '保持距离'
    return '冷淡疏离'
  }

  async function openImpression() {
    showSettings.value = false
    showImpression.value = true
    impressionLoading.value = true
    impressionError.value = ''
    impressionGrouped.value = { personality: [], preference: [] }
    impressionVad.value = null
    impressionAffinity.value = 50
    try {
      const data = await getCharacterPortrait(chat.activeChar.id)
      impressionGrouped.value = data.grouped || { personality: [], preference: [] }
      impressionVad.value = data.vad || null
      impressionAffinity.value = data.affinity ?? 50
      impressionLastDelta.value = data.lastAffinityDelta ?? null
      impressionLastReason.value = data.lastReason || ''
    } catch (err) {
      impressionError.value = err.message
    } finally {
      impressionLoading.value = false
    }
  }

  // ── 印象编辑/删除 ──
  const editingId = ref(null)

  const editingContent = ref('')

  const savingEdit = ref(false)

  function startEdit(trait) {
    editingId.value = trait.id
    editingContent.value = trait.content
  }

  function cancelEdit() {
    if (savingEdit.value) return
    editingId.value = null
    editingContent.value = ''
  }

  async function saveEdit(trait) {
    if (savingEdit.value || editingContent.value.trim().length < 2) return
    const trimmed = editingContent.value.trim()
    savingEdit.value = true
    try {
      await updatePortrait(trait.id, trimmed)
      // 更新本地数据
      trait.content = trimmed
      editingId.value = null
      editingContent.value = ''
    } catch (err) {
      toastFn('保存失败: ' + err.message, 'error')
    } finally {
      savingEdit.value = false
    }
  }

  async function removeTrait(trait) {
    if (!confirmFn) {
      if (!confirm(`确定删除「${trait.content}」？`)) return
    } else {
      const ok = await confirmFn(`确定删除「${trait.content}」？`)
      if (!ok) return
    }
    try {
      await deletePortrait(trait.id)
      // 从本地分组中移除
      const group = impressionGrouped.value[trait.trait_type]
      if (group) {
        const idx = group.findIndex(t => t.id === trait.id)
        if (idx !== -1) group.splice(idx, 1)
      }
    } catch (err) {
      toastFn('删除失败: ' + err.message, 'error')
    }
  }

  // ── 印象添加 ──
  const addingKey = ref(null)

  const addingContent = ref('')

  const savingAdd = ref(false)

  function startAdd(key) {
    // 如果正在编辑某条，先取消
    if (editingId.value !== null) cancelEdit()
    addingKey.value = key
    addingContent.value = ''
  }

  function cancelAdd() {
    if (savingAdd.value) return
    addingKey.value = null
    addingContent.value = ''
  }

  async function saveAdd(key) {
    if (savingAdd.value || addingContent.value.trim().length < 2) return
    const trimmed = addingContent.value.trim()
    savingAdd.value = true
    try {
      const row = await addPortrait(chat.activeChar.id, key, trimmed)
      // 添加到本地分组
      if (!impressionGrouped.value[key]) impressionGrouped.value[key] = []
      impressionGrouped.value[key].push(row)
      addingKey.value = null
      addingContent.value = ''
    } catch (err) {
      toastFn('添加失败: ' + err.message, 'error')
    } finally {
      savingAdd.value = false
    }
  }

  function formatTime(dateStr) {
    if (!dateStr) return ''
    // 一律按程序时间显示：角色住在调过的时间线里，消息时间跟着走才不会出现
    // 「她说晚上好、时间戳是中午」这种割裂（2026-10-30 用户反馈）
    const d = clock.toProgram(dateStr)
    if (!d) return ''
    const now = clock.now()
    const diffMs = now - d
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return '刚刚'
    if (diffMin < 60) return `${diffMin}分钟前`
    const diffHour = Math.floor(diffMin / 60)
    if (diffHour < 24) return `${diffHour}小时前`
    const diffDay = Math.floor(diffHour / 24)
    if (diffDay === 1) return '昨天'
    if (diffDay < 7) return `${diffDay}天前`
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  const typeLabel = { personality: '性格特征', preference: '偏好习惯' }

  const typeIcon = { personality: '🧠', preference: '❤️' }

  const typeColor = { personality: '#9b7fd4', preference: '#e05a7a' }

  const groupKeys = ['personality', 'preference']

  function confidenceLevel(confidence, index = 0) {
    const val = confidence ?? 0.5
    const threshold = (index + 1) / 3
    return val >= threshold ? 'on' : 'off'
  }

  return { impressionAffinity, openImpression, showImpression, impressionLoading, impressionError, groupKeys, typeColor, typeIcon, typeLabel, impressionGrouped, startAdd, addingKey, addingContent, cancelAdd, saveAdd, savingAdd, editingId, editingContent, cancelEdit, saveEdit, savingEdit, confidenceLevel, formatTime, startEdit, removeTrait, impressionVad, VAD_LABELS, vadPercent, topEmotions, affinityLabel, impressionLastDelta, impressionLastReason }
}
