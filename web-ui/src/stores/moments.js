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

  // 加载帖子（页面首次挂载时调用）
  //
  // 2026-11-16（P1-19）改成分两段：
  //   ① **首屏只拉一页**（PAGE_SIZE 条）并立刻上屏，不再等 50 页顺序请求；
  //   ② 剩下的历史在后台静默续拉，拉到后追加，不阻塞渲染。
  //
  // 为什么以前是「一次拉全量」：作者筛选列表（charactersWithPosts）与
  // filteredPosts（按作者 / 我发的 / 赞过筛选）都建立在「posts 是全量」这个前提上。
  // 现在作者列表改由服务端聚合（/moments/authors）提供，筛选仍然完整；
  // 帖子本身分两段加载，首屏在 2000+ 帖时从「最多 50 次顺序请求」降到 1 次。
  //
  // 后台续拉保留 50 页上限（5 万条），防后端 hasMore 恒真时死循环。
  async function loadPosts() {
    const MAX_PAGES = 50
    if (loading.value) return
    loading.value = true
    loadError.value = null
    try {
      // ① 首屏一页：先让用户看到内容
      const first = await api.listMoments({ limit: PAGE_SIZE })
      const firstBatch = first.posts || []
      const prevMap = new Map(posts.value.map(p => [p.id, p]))
      const keepState = p => {
        const prev = prevMap.get(p.id)
        if (prev) {
          if (prev._comments) p._comments = prev._comments
          if (prev.liked !== undefined) p.liked = prev.liked
        }
        return p
      }
      posts.value = firstBatch.map(keepState)
      page.value = 1
      await markSeen()

      // ② 作者列表：与服务端聚合并行，不依赖已加载的帖子
      void api.listMomentAuthors()
        .then(data => { serverAuthors.value = data.authors || [] })
        .catch(err => console.warn('[moments] 作者聚合失败，回退本地计算:', err?.message || err))

      // ③ 后台续拉剩余历史
      if (first.hasMore && firstBatch.length > 0) {
        void (async () => {
          const all = [...firstBatch]
          let beforeId = firstBatch[firstBatch.length - 1].id
          for (let i = 1; i < MAX_PAGES && beforeId; i++) {
            const data = await api.listMoments({ before_id: beforeId })
            const batch = data.posts || []
            all.push(...batch)
            if (!data.hasMore || batch.length === 0) break
            beforeId = batch[batch.length - 1].id
          }
          // 续拉期间用户可能已经切页或筛选，只在本 store 仍是活跃加载者时替换
          posts.value = all.map(keepState)
        })().catch(err => {
          // 续拉失败不影响首屏：已经看到的内容留着，只是翻不到更早的
          console.warn('[moments] 历史续拉中断:', err?.message || err)
        })
      }
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
