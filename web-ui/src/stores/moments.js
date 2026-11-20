import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as api from '../api/index.js'
// unifiedStream 不依赖 moments store，无循环依赖；统一静态导入（消除构建警告）
import { onEvent as onStreamEvent } from './unifiedStream.js'

const PAGE_SIZE = 20

export const useMomentsStore = defineStore('moments', () => {
  const posts = ref([])           // 当前筛选已加载的帖子，不在后台拉取全量历史
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

  const serverHasMore = ref(false)
  const nextCursor = ref(null)
  let loadGeneration = 0
  const hasMore = computed(() => serverHasMore.value || filteredPosts.value.length > page.value * PAGE_SIZE)

  // 作者列表：优先用服务端聚合结果（P1-19），没拿到时回退到本地计算。
  //
  // 为什么需要服务端聚合：首屏现在只拉一页（见 loadPosts），
  // 而「按作者筛选」必须是**完整**的作者列表——从一页帖子里去重只能得到「这一页出现过的作者」，
  // 筛选功能会残缺。所以作者列表改由 /moments/authors 单独提供。
  const serverAuthors = ref([])

  // 有帖子的作者列表（角色 + 镇民，按最新帖子时间降序）
  const charactersWithPosts = computed(() => {
    if (serverAuthors.value.length) {
      return serverAuthors.value.map(item => ({
        author: item.npc_id != null ? `npc:${item.npc_id}` : item.id,
        display_name: item.display_name || '未知',
        avatar_path: item.avatar_path || '',
        author_type: item.author_type || 'character',
      }))
    }
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

  // 服务端筛选 + 时间/id 双游标。只在首屏、筛选变化或用户继续滚动时请求一页。
  // generation 使慢响应失效，避免上一筛选或旧分页覆盖刚刷新的内容。
  async function loadPage(reset) {
    if (!reset && (loading.value || !serverHasMore.value)) return
    const generation = reset ? ++loadGeneration : loadGeneration
    const existingIds = new Set(posts.value.map(p => p.id))
    const initialState = new Map(posts.value.map(p => [p.id, { liked: p.liked, like_count: p.like_count, comment_count: p.comment_count }]))
    const params = { limit: PAGE_SIZE, liked: filterLiked.value, user_only: filterUser.value }
    const author = filterCharacterId.value
    if (typeof author === 'string' && author.startsWith('npc:')) params.npc_id = Number(author.slice(4))
    else if (author !== null) params.character_id = author
    if (!reset && nextCursor.value) {
      params.before_id = nextCursor.value.id
      params.before_created_at = nextCursor.value.created_at
    }
    loading.value = true
    loadError.value = null
    try {
      const data = await api.listMoments(params)
      if (generation !== loadGeneration) return
      const batch = data.posts || []
      const prevMap = new Map(posts.value.map(p => [p.id, p]))
      const keepState = p => {
        const prev = prevMap.get(p.id)
        if (prev) {
          if (prev._comments) p._comments = prev._comments
          // 请求期间的新评论/点赞不能被迟到的列表响应抹掉；正常刷新仍采用服务端统计。
          const initial = initialState.get(p.id)
          for (const key of ['liked', 'like_count', 'comment_count']) {
            if (initial && prev[key] !== initial[key]) p[key] = prev[key]
          }
        }
        return p
      }
      const retained = reset ? posts.value.filter(p => !existingIds.has(p.id)) : posts.value
      const seen = new Set(retained.map(p => p.id))
      posts.value = [...retained, ...batch.filter(p => !seen.has(p.id)).map(keepState)]
      page.value = reset ? 1 : page.value + 1
      nextCursor.value = data.nextCursor || batch.at(-1) || null
      serverHasMore.value = !!data.hasMore && batch.length > 0
      if (reset) {
        void markSeen()
        void refreshAuthors()
      }
    } catch (err) {
      if (generation !== loadGeneration) return
      console.error('[moments] loadPosts error:', err)
      loadError.value = err?.message || '加载失败'
    } finally {
      if (generation === loadGeneration) loading.value = false
    }
  }

  function loadPosts() { return loadPage(true) }

  function reloadFilter() {
    posts.value = []
    nextCursor.value = null
    serverHasMore.value = false
    return loadPosts()
  }

  // 设置筛选角色（null = 全部）
  function setFilter(id, reload = true) {
    filterCharacterId.value = id
    filterUser.value = false
    page.value = 1
    if (reload) void reloadFilter()
  }

  // 切换「赞过」筛选
  function toggleFilterLiked() {
    filterLiked.value = !filterLiked.value
    page.value = 1
    void reloadFilter()
  }

  // 切换「我发的」筛选（与角色筛选互斥，避免出现空交集）
  function toggleFilterUser() {
    filterUser.value = !filterUser.value
    filterCharacterId.value = null
    page.value = 1
    void reloadFilter()
  }

  // 重置所有筛选条件（进入页面时调用）
  function resetFilters(reload = true) {
    filterCharacterId.value = null
    filterLiked.value = false
    filterUser.value = false
    page.value = 1
    if (reload) void reloadFilter()
  }

  // 先展开本地新增帖子；到已加载列表末尾时只请求下一页。
  function loadMore() {
    if (!hasMore.value) return
    if (filteredPosts.value.length > page.value * PAGE_SIZE) page.value++
    else return loadPage(false)
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
      // P1-19：作者列表现在来自服务端聚合，新帖可能带来一个此前没出现过的作者，
      // 不刷新的话筛选列表里看不到她。
      void refreshAuthors()
    }
    return result
  }

  /** 刷新服务端作者聚合（失败静默：本地回退仍在） */
  async function refreshAuthors() {
    try {
      const data = await api.listMomentAuthors()
      serverAuthors.value = data.authors || []
    } catch (err) {
      console.warn('[moments] 作者聚合刷新失败:', err?.message || err)
    }
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
