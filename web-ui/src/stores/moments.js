import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '../api/index.js'
// unifiedStream 不依赖 moments store，无循环依赖；统一静态导入（消除构建警告）
import { onEvent as onStreamEvent } from './unifiedStream.js'

const PAGE_SIZE = 20

export const useMomentsStore = defineStore('moments', () => {
  const posts = ref([])           // 全量帖子数据
  const loading = ref(false)
  // 加载失败通道：让界面能区分「请求失败」和「真的没有内容」
  const loadError = ref(null)
  const page = ref(0)             // 当前渲染到第几批（0-based）
  const filterCharacterId = ref(null)  // null = 全部
  const filterLiked = ref(false)        // 是否只显示赞过的
  const filterUser = ref(false)         // 是否只显示「我」发的（与角色筛选互斥）

  // ── 红点通知状态 ──
  const newPostCount = ref(0)
  const isViewingMoments = ref(false)   // 用户当前是否在朋友圈页面

  // ── 滚动到顶部信号 ──
  const scrollToTopSignal = ref(0)
  function requestScrollToTop() {
    scrollToTopSignal.value++
  }

  // 帖子作者的稳定标识：角色用数字 id，镇民用 'npc:{id}' 字符串
  function authorOf(p) {
    if (p.npc_id != null) return `npc:${p.npc_id}`
    return p.character_id ?? null
  }

  // 按作者筛选后的帖子
  const filteredPosts = computed(() => {
    let result = posts.value
    if (filterCharacterId.value !== null) {
      result = result.filter(p => authorOf(p) === filterCharacterId.value)
    }
    if (filterUser.value) {
      // author_type 由后端返回；旧数据缺该字段时按「无角色 / 无镇民」兜底判定
      result = result.filter(p => (p.author_type ? p.author_type === 'user' : authorOf(p) === null))
    }
    if (filterLiked.value) {
      result = result.filter(p => p.liked)
    }
    return result
  })

  // 当前可见的帖子（前 page * PAGE_SIZE 条）
  const visiblePosts = computed(() => filteredPosts.value.slice(0, page.value * PAGE_SIZE))

  const hasMore = computed(() => filteredPosts.value.length > page.value * PAGE_SIZE)

  // 有帖子的作者列表（角色 + 镇民，按最新帖子时间降序）
  const charactersWithPosts = computed(() => {
    const map = new Map()
    for (const p of posts.value) {
      const id = authorOf(p)
      if (id === null) continue
      const existing = map.get(id)
      const postTime = new Date(p.created_at || 0).getTime()
      if (!existing || postTime > existing._latestPostAt) {
        map.set(id, {
          author: id,
          display_name: p.display_name || '未知',
          avatar_path: p.avatar_path || '',
          author_type: p.author_type || 'character',
          _latestPostAt: postTime,
        })
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b._latestPostAt - a._latestPostAt)
      .map(({ _latestPostAt, ...rest }) => rest)
  })

  // 加载全部帖子（页面首次挂载时调用）
  //
  // 2026-10-15 修：后端 `GET /api/moments` 是 **keyset 分页**（默认最新 1000 条 + `?before_id=` 续拉，
  // 返回 `hasMore`），而这里原来只调一次、把第一页当成全量 —— 动态超过 1000 条时**静默丢掉更旧的历史**
  // （页面看不出任何异常，只是"翻不到头"）。
  //
  // 现在按 hasMore 续拉到没有更多为止。为什么不用「滚动到底再拉下一页」那种增量分页：
  //   本 store 的 `charactersWithPosts`（作者筛选列表）与 `filteredPosts`（按作者/我发的/赞过筛选）
  //   都建立在「posts 是全量」这个前提上，改增量分页会让作者列表只剩已加载部分 —— 那是更大的行为倒退。
  //   续拉全量保住原语义，只多几次请求（每次 1000 条，实际库几十条就是一次）。
  // 安全上限：最多 50 页（5 万条），防后端 hasMore 恒真时死循环。
  // 放在函数**内部**（不是模块级常量）：这样 loadPosts 自包含，单测能整段摘出去跑。
  async function loadPosts() {
    const MAX_PAGES = 50
    if (loading.value) return
    loading.value = true
    loadError.value = null
    try {
      const all = []
      let beforeId = null
      for (let i = 0; i < MAX_PAGES; i++) {
        const data = await api.listMoments(beforeId ? { before_id: beforeId } : undefined)
        const batch = data.posts || []
        all.push(...batch)
        if (!data.hasMore || batch.length === 0) break
        beforeId = batch[batch.length - 1].id
        if (!beforeId) break   // 兜底：没有 id 就没法继续 keyset
      }
      // 保留已有帖子的运行时状态：页面切换回来时，_comments / liked 不会因对象替换而丢失
      const prevMap = new Map(posts.value.map(p => [p.id, p]))
      posts.value = all.map(p => {
        const prev = prevMap.get(p.id)
        if (prev) {
          if (prev._comments) p._comments = prev._comments
          if (prev.liked !== undefined) p.liked = prev.liked
        }
        return p
      })
      page.value = 1
      await markSeen()
    } catch (err) {
      console.error('[moments] loadPosts error:', err)
      // 以前只在控制台留一行：请求失败时 posts 为空，界面就渲染成"这里什么都没有"，
      // 用户会以为自己的数据丢了。留一个 error 通道，模板据此显示「加载失败 + 重试」。
      loadError.value = err?.message || '加载失败'
    } finally {
      loading.value = false
    }
  }

  // 设置筛选角色（null = 全部）
  function setFilter(id) {
    filterCharacterId.value = id
    filterUser.value = false
    page.value = 1
  }

  // 切换「赞过」筛选
  function toggleFilterLiked() {
    filterLiked.value = !filterLiked.value
    page.value = 1
  }

  // 切换「我发的」筛选（与角色筛选互斥，避免出现空交集）
  function toggleFilterUser() {
    filterUser.value = !filterUser.value
    filterCharacterId.value = null
    page.value = 1
  }

  // 重置所有筛选条件（进入页面时调用）
  function resetFilters() {
    filterCharacterId.value = null
    filterLiked.value = false
    filterUser.value = false
    page.value = 1
  }

  // 加载更多（滚动到底部 → 前端 slice 多展示一批，无网络请求）
  function loadMore() {
    if (!hasMore.value) return
    page.value++
  }

  // 发评论 → 返回 { comment, replies }
  // 注意：组件侧（MomentCard）已做乐观更新 + 数组操作，store 只负责 comment_count 统计
  async function addComment(postId, content, replyToCommentId = null) {
    const result = await api.commentMoment(postId, content, replyToCommentId)
    const post = posts.value.find(p => p.id === postId)
    if (post) {
      const added = (result.comment ? 1 : 0) + (result.replies?.length || (result.reply ? 1 : 0))
      post.comment_count = (post.comment_count || 0) + added
    }
    return result
  }

  // 用户自己发朋友圈（文字 + 可选 base64 图片），角色随后通过 SSE 陆续来评论
  async function createUserPost(payload) {
    const post = await api.createUserMoment(payload)
    if (post?.id) {
      posts.value.unshift({
        ...post,
        images: post.images || [],
        comment_count: 0,
        like_count: 0,
        liked: false,
      })
      if (isViewingMoments.value) await markSeen()
    }
    return post
  }

  // 加载单个帖子的评论
  async function loadComments(postId) {
    const data = await api.getMoment(postId)
    const post = posts.value.find(p => p.id === postId)
    if (post) {
      post._comments = data.comments || []
      post.comment_count = (data.comments || []).length
    }
    return data.comments || []
  }

  // 切换点赞
  async function toggleLike(postId) {
    const { liked } = await api.likeMoment(postId)
    const post = posts.value.find(p => p.id === postId)
    if (post) {
      post.liked = liked
      post.like_count = Math.max(0, (post.like_count || 0) + (liked ? 1 : -1))
    }
    return liked
  }

  // 按原本的提示词补生成配图（生图失败导致无图的帖子）
  async function regeneratePostImage(postId) {
    const { images } = await api.regenerateMomentImage(postId)
    const post = posts.value.find(p => p.id === postId)
    if (post) post.images = images || []
    return images || []
  }

  // 手动触发某角色发帖（topicId 可选：话题库「立即发送」点题）
  async function generatePost(characterId, topicId) {
    const result = await api.generateMoment(characterId, topicId)
    if (result.id) {
      posts.value.unshift({
        ...result,
        comment_count: 0,
        like_count: 0,
        liked: false,
      })
      if (isViewingMoments.value) await markSeen()
    }
    return result
  }

  // 编辑帖子文字
  async function updatePost(postId, content) {
    const { content: saved } = await api.updateMoment(postId, content)
    const post = posts.value.find(p => p.id === postId)
    if (post && saved) post.content = saved
  }

  // 删除帖子
  async function deletePost(postId) {
    await api.deleteMoment(postId)
    posts.value = posts.value.filter(p => p.id !== postId)
  }

  // ── 未读计数：统一 SSE 订阅 + poll timer 兜底 ──
  let _sseStarted = false
  let _unsubNewPost = null
  let _unsubNewComment = null

  /** 从 DB 拉取最新未读计数（唯一数据源） */
  async function refreshUnreadCount() {
    try {
      const { count } = await api.getMomentsUnread()
      newPostCount.value = count || 0
    } catch { /* 非关键 */ }
  }

  /** 连接统一 SSE 推送流 + 启动 polling */
  async function connectSSE() {
    if (_sseStarted) return
    _sseStarted = true

    // 从 DB 加载初始未读计数
    await refreshUnreadCount()

    _unsubNewPost = onStreamEvent('new_post', (_post) => {
      newPostCount.value++
    })

    // 监听关系网互动产生的新评论，实时追加到帖子评论区
    _unsubNewComment = onStreamEvent('new_comment', (data) => {
      if (!data?.post_id || !data?.comment) return
      const post = posts.value.find(p => p.id === data.post_id)
      if (post) {
        if (!post._comments) post._comments = []
        // 防重复（按 id 去重）
        if (!post._comments.some(c => c.id === data.comment.id)) {
          post._comments.push(data.comment)
          post.comment_count = (post.comment_count || 0) + 1
        }
      }
    })

  }

  /** 断开 SSE 订阅 */
  function disconnectSSE() {
    _sseStarted = false
    if (_unsubNewPost) { _unsubNewPost(); _unsubNewPost = null }
    if (_unsubNewComment) { _unsubNewComment(); _unsubNewComment = null }

  }

  /** 标记已读：更新 last_moments_seen_at 为当前时间 */
  async function markSeen() {
    try { await api.markMomentsRead() } catch { /* 非关键 */ }
    newPostCount.value = 0
  }

  return { posts, visiblePosts, loading, loadError, hasMore, page, filterCharacterId, filterLiked, filterUser, filteredPosts, charactersWithPosts,
    newPostCount, isViewingMoments, scrollToTopSignal, requestScrollToTop,
    loadPosts, setFilter, toggleFilterLiked, toggleFilterUser, resetFilters, loadMore, addComment, loadComments, toggleLike, regeneratePostImage, generatePost, createUserPost, updatePost, deletePost,
    connectSSE, disconnectSSE, markSeen, refreshUnreadCount }
})
