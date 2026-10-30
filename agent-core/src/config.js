import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
// 设置读写走独立的 db/settings 模块（不经过 db/index.js，避免形成 config ↔ db 循环依赖）
import { setSetting, getSetting } from './db/settings.js';
import { notifyWeatherSourceChange } from './services/weatherSource.js';
// 上游 v3.10.0 合并（2026-10-19）：
// · NovelAI 三协议（official / native / relay）的归一化只认 novelaiClient 里那一份
// · 输出额度（MAX_tokens）与 Vertex 接入的默认值来自这两个模块
import { normalizeNovelaiFormat, normalizeNovelaiKey } from './services/novelaiClient.js';
import { defaultMaxTokens, isValidMaxTokens } from './llm/modelCapabilities.js';
import { parseServiceAccount, normalizeVertexRegion } from './llm/vertex-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

// 每日免费鸡蛋：opencode zen 免费端点（无需 API Key，按 IP 限流）
const FREE_EGG_BASE_URL = 'https://opencode.ai/zen/v1';
// 免费模型名单（2026-09-28 全量复测 82 个模型，逐个匿名打一次 /chat/completions）：
//   仅 space-bunny-free 仍返回 200；原名单 mimo-v2.5-free 以及 mimo-v2.6-flash-free、
//   nemotron-3-ultra-free、nemotron-3.5-lightning-free、longcat-2.5-preview-free、big-pickle、
//   ling-3.0-flash-fin-free 等免费档已统一改为 403 FreeTierError
//   「OpenCode's free tier can only be used from within OpenCode」= 必须登录 OpenCode（带 Key）才能用；
//   muse-spark-*-contributor-free 为 403 地区封锁，deepseek-v4-flash-free 已 400 下线，
//   jev-1.13-free 只能走 /systemone 端点、不能当聊天模型。
//   上游模型会随时变动，重新复测的方法见 docs/hypnosis-acceptance-report.md §K。
// 本轮失败过的模型只记内存，下次开启重新开始
export const FREE_EGG_MODELS = ['space-bunny-free'];
const FREE_EGG_MODEL = FREE_EGG_MODELS[0];

/**
 * HiresFix 细化精度三档（2026-09-30 · D1 实测用户裁决）。
 *
 * · `high` = 12 步 / `medium` = 10 步 / `low` = **8 步（默认）**，CFG 固定 1.0（turbo 蒸馏模型）。
 * · 只认这三个值，其它（空/大写混写之外的怪值）一律回落 `low` —— 与 updateFeatureFlag 的三态分支持同一口径。
 * · 步数的**实际映射**在 `services/imageRefine.js` 的 `HIRES_QUALITY_STEPS` / `resolveTurboSteps()`。
 * @returns {'high'|'medium'|'low'}
 */
export function normalizeHiresQuality(value) {
  // 只 trim 首尾空白；**不做大小写折叠**（'HIGH' 视为非法回落 low）——
  // 与前端 web-ui 那份 normalizeHiresQuality 的判定保持一致，避免两边对同一个值有两种理解。
  const text = String(value ?? '').trim();
  return HIRES_QUALITY_VALUES.includes(text) ? text : HIRES_QUALITY_DEFAULT;
}

export const HIRES_QUALITY_VALUES = ['high', 'medium', 'low'];
export const HIRES_QUALITY_DEFAULT = 'low';

export const config = {
  // 开发环境检测：生产启动（launcher / PM2）会注入 NODE_ENV=production；npm run dev 等开发启动不设置
  isDev: process.env.NODE_ENV !== 'production',
  port: parseInt(process.env.PORT, 10) || 3099,
  // 监听地址（2026-10-18 补）。**默认不传 = 监听全部接口**，与历史行为逐字节一致。
  //
  // 为什么默认是全接口而不是 127.0.0.1：手机端（Android WebView 壳）访问 PC 上的服务是刚需，
  // 改默认值会直接把这个用法打断。想只给本机用时再显式设 `HOST=127.0.0.1`。
  //
  // 注意别把它写成 `undefined` 之外的假值：`app.listen(port, undefined)` 与
  // `app.listen(port)` 等价（都监听全部接口），但传 `'0.0.0.0'` 是显式全接口、
  // 传空串 `''` 在 Node 里会被当成"监听所有地址"的通配符 —— 所以这里**非空才用**。
  host: process.env.HOST && process.env.HOST.trim() ? process.env.HOST.trim() : undefined,
  // DB_PATH 显式配置时原样使用（支持绝对路径）；默认值锚定 agent-core/，不随启动 cwd 漂移
  dbPath: process.env.DB_PATH || resolve(__dirname, '..', 'data', 'agent.db'),
  llm: {
    provider: process.env.LLM_PROVIDER || 'deepseek',
    // 接入方式：openai 兼容接口 / Google Vertex AI（服务账号）（上游 v3.10.0 合并，2026-10-19）
    _connectionType: 'openai',
    vertexRegion: 'global',
    vertexServiceAccount: '',
    // 免费鸡蛋模式强制走 openai（鸡蛋端点不是 Vertex）
    get connectionType() { return this.freeEgg ? 'openai' : this._connectionType; },
    set connectionType(v) { this._connectionType = v; },
    // 每日免费鸡蛋开关（仅内存，不做持久化：重启后默认关闭）。
    // 开启后通过下方 getter 覆盖生效值：免 Key 走免费端点 + 不发送 thinking 参数；
    // 用户自有的 Key/地址/模型保存在 _* 字段中，关闭开关即原样恢复。
    freeEgg: false,
    _apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
    _baseURL: process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    _model: process.env.LLM_MODEL || 'deepseek-flash',
    // 输出额度（MAX_tokens）：null = 按「地址 + 模型」算默认值（上游 v3.10.0 合并）
    _maxTokens: isValidMaxTokens(Number(process.env.LLM_MAX_TOKENS)) ? Number(process.env.LLM_MAX_TOKENS) : null,
    // 思考模式三态：enabled / disabled / omit（omit = 请求体完全不出现 thinking 字段）。
    // **默认 'disabled'**（2026-10-20 用户口径「默认直接关掉思考」）：请求里明确禁用思考，
    // 回复更快、更省 token。少数第三方中转不认这个非标准字段、直接回 400 时，
    // 用户在设置里改「不传」即可（同时也不发 reasoning_effort）；
    // llm-client 另有 400 自动降级重试兜底。
    // 免费鸡蛋通道由 getter 强制 'omit'，与用户口径互不影响。
    _thinkingMode: (() => {
      const raw = String(process.env.LLM_THINKING_MODE ?? '').trim().toLowerCase();
      return ['enabled', 'disabled', 'omit'].includes(raw) ? raw : 'disabled';
    })(),
    // 思考强度（部分网关只认这个，不认 thinking.type）。合法值 low / high / max。
    // **默认 'low'，且空串/非法值一律归一回 'low'**（2026-10-15 实测结论 + 用户明确要求
    // "默认一定要关掉思考"）：
    //   · `thinking:{type:'disabled'}` 是主力 —— deepseek 系靠它真正关掉
    //     （实测 cn:deepseek-v4-flash：不传 reasoning_len=294，传了 =0）
    //   · `reasoning_effort:'low'` 是兜底 —— 少数模型**不传就直接报错**
    //     （cn:glm-5.1 实测：不传 → 网关回 "the reasoning effort value is not supported
    //      by the current model"；传 low → 正常出正文）
    //   两个一起发对 deepseek 无害（实测仍 reasoning_len=0），所以默认两个都发。
    // ⚠️ 这里**故意不提供"置空"出口**：历史口径里空串表示"不发该字段"，
    //    但用户要求是"默认一定关思考"—— 置空会让 deepseek 系退回开着思考跑
    //    （实测 reasoning_len≈294、白烧 token 还变慢）。真要放开思考请传 high/max。
    _reasoningEffort: (() => {
      const raw = String(process.env.LLM_REASONING_EFFORT ?? '').trim().toLowerCase();
      return ['low', 'high', 'max'].includes(raw) ? raw : 'low';
    })(),
    _headers: (() => { try { return JSON.parse(process.env.LLM_HEADERS || '{}'); } catch { return {}; } })(),
    _extraBody: (() => { try { return JSON.parse(process.env.LLM_EXTRA_BODY || '{}'); } catch { return {}; } })(),
    // 反重复采样层（专题 L3 / 规划 C5）：presence_penalty / frequency_penalty。
    // **默认 0**（= 与加参数前的请求体逐字节一致）；唯一真值来源是 DB system_settings
    // （anti_repetition_penalty / anti_repetition_frequency），由设置页写入。
    // 口径：null 表示"不设置 → 请求体里完全不发送该字段"；数字（含 0）按 OpenAI 语义透传。
    antiRepetitionPenalty: null,
    antiRepetitionFrequency: null,
    // 上下文窗口（token）：用户声明 / 上游 /v1/models 探到的值 / 保守默认，三者的取舍见 services/contextUsage.js。
    // 值可能来自上游，因此必须与来源一起存：只有 source='declared' 才算用户声明。
    _contextWindow: parseInt(process.env.LLM_CONTEXT_WINDOW, 10) || null,
    _contextWindowSource: ['declared', 'provider', 'default'].includes(process.env.LLM_CONTEXT_WINDOW_SOURCE)
      ? process.env.LLM_CONTEXT_WINDOW_SOURCE
      : null,
    get apiKey() { return this.freeEgg ? '' : this._apiKey; },
    set apiKey(v) { this._apiKey = v; },
    get baseURL() { return this.freeEgg ? FREE_EGG_BASE_URL : this._baseURL; },
    set baseURL(v) { this._baseURL = v; },
    get model() { return this.freeEgg ? FREE_EGG_MODEL : this._model; },
    set model(v) { this._model = v; },
    // 输出额度：免费鸡蛋按免费模型的默认上限；否则用显式配置，没有再按「地址 + 模型」算默认
    get maxTokens() {
      return this.freeEgg
        ? defaultMaxTokens(this.baseURL, this.model)
        : (this._maxTokens ?? defaultMaxTokens(this.baseURL, this.model));
    },
    set maxTokens(v) { this._maxTokens = v; },
    get contextWindow() { return this.freeEgg ? null : this._contextWindow; },
    set contextWindow(v) { this._contextWindow = v; },
    get contextWindowSource() { return this.freeEgg ? null : this._contextWindowSource; },
    set contextWindowSource(v) { this._contextWindowSource = v; },
    // 免费鸡蛋：端点免 Key，且免费档（space-bunny-free）对 thinking:{type:'disabled'}
    // 直接返回 400 invalid_request，故取 'omit' —— configuredThinking() 返回 null，
    // 请求体里完全不发送 thinking 字段（传 'disabled' 会让鸡蛋每次请求都失败）。
    get thinkingMode() { return this.freeEgg ? 'omit' : this._thinkingMode; },
    // 三态直通：enabled / disabled / omit（omit = 不发 thinking 字段）；脏值归一到默认 'disabled'。
    set thinkingMode(v) { this._thinkingMode = ['enabled', 'disabled', 'omit'].includes(v) ? v : 'disabled'; },
    // 思考强度（部分网关只认这个，不认 thinking.type）。合法值 low / high / max。
    // **默认 'low'**：见上面 _reasoningEffort 的实测注释 —— thinking:{disabled} 与
    // reasoning_effort:'low' 两个一起发，才能覆盖"deepseek 系靠前者关、少数模型靠后者才不报错"。
    get reasoningEffort() { return this.freeEgg ? '' : this._reasoningEffort; },
    set reasoningEffort(v) {
      // 显式空串/非法值也归一到默认 'low'（用户口径：默认关思考）
      this._reasoningEffort = ['low', 'high', 'max'].includes(v) ? v : 'low';
    },
    get headers() { return this.freeEgg ? {} : this._headers; },
    set headers(v) { this._headers = v; },
    get extraBody() { return this.freeEgg ? {} : this._extraBody; },
    set extraBody(v) { this._extraBody = v; },
  },
  vectorService: {
    url: process.env.VECTOR_SERVICE_URL || 'http://localhost:8765',
    // 默认宽松超时：主聊天流 RAG 的 2.5s 限时在 chatMemoryRecall 层单独处理，
    // 后台记忆索引（upsert/delete）、画像提取等不受此限制。
defaultTimeoutMs: parseInt(process.env.VECTOR_DEFAULT_TIMEOUT_MS, 10) || 120000,
  },
  comfyui: {
    imageProvider: 'comfyui',
    url: (process.env.COMFYUI_URL || 'http://localhost:8188').replace(/\/+$/, ''),
    novelaiApiFormat: normalizeNovelaiFormat(process.env.NOVELAI_API_FORMAT || 'relay'),
    // 出图请求的代理（NovelAI 直连常被墙）：空串 = 走环境变量代理（上游 v3.10.0 合并）
    novelaiProxyUrl: String(process.env.NOVELAI_PROXY_URL || '').trim(),
    novelaiUrl: (process.env.NOVELAI_URL || '').replace(/\/+$/, ''),
    novelaiModel: process.env.NOVELAI_MODEL || 'nai-diffusion-4-5-full',
    novelaiArtist: process.env.NOVELAI_ARTIST || '@ebora',
    novelaiWidth: parseInt(process.env.NOVELAI_WIDTH, 10) || 1216,
    novelaiHeight: parseInt(process.env.NOVELAI_HEIGHT, 10) || 832,
    novelaiSteps: Math.min(50, Math.max(1, parseInt(process.env.NOVELAI_STEPS, 10) || 28)),
    novelaiSampler: process.env.NOVELAI_SAMPLER || 'k_euler_ancestral',
    novelaiNoiseSchedule: process.env.NOVELAI_NOISE_SCHEDULE || 'karras',
    novelaiGuidance: Number.isFinite(Number.parseFloat(process.env.NOVELAI_GUIDANCE)) ? Number.parseFloat(process.env.NOVELAI_GUIDANCE) : 5,
    novelaiQualityPrompt: process.env.NOVELAI_QUALITY_PROMPT || 'masterpiece, best quality, score_9, score_8, highres, absurdres, year 2025',
    novelaiNegativePrompt: process.env.NOVELAI_NEGATIVE_PROMPT || 'lowres, bad_anatomy, bad_hands, text, error, missing_fingers, extra_digit, fewer_digits, cropped, worst_quality, low_quality, normal_quality, jpeg_artifacts, signature, watermark, username, blurry, bad_feet, fused_fingers, too_many_fingers, long_neck, cross-eyed, mutated_hands, polar_lowres, bad_body, bad_proportions, gross_proportions, text, error, missing_fingers, missing_arms, missing_legs, extra_digit, extra_arms, extra_leg, extra_foot',
    outputDir: process.env.COMFYUI_OUTPUT_DIR || './output',
    artist: process.env.COMFYUI_ARTIST || '@ebora',
    width: parseInt(process.env.COMFYUI_WIDTH, 10) || 768,
    height: parseInt(process.env.COMFYUI_HEIGHT, 10) || 512,
    momentsArtist: process.env.COMFYUI_MOMENTS_ARTIST || process.env.COMFYUI_ARTIST || '@ebora',
    momentsWidth: parseInt(process.env.COMFYUI_MOMENTS_WIDTH, 10) || 1600,
    momentsHeight: parseInt(process.env.COMFYUI_MOMENTS_HEIGHT, 10) || 1200,
    eventArtist: process.env.COMFYUI_EVENT_ARTIST || process.env.COMFYUI_MOMENTS_ARTIST || process.env.COMFYUI_ARTIST || '@ebora',
    eventWidth: parseInt(process.env.COMFYUI_EVENT_WIDTH, 10) || 1600,
    eventHeight: parseInt(process.env.COMFYUI_EVENT_HEIGHT, 10) || 1200,
    qualityPrompt: process.env.COMFYUI_QUALITY_PROMPT || '',  // 质量提示词覆盖（留空=沿用工作流默认）
    negativePrompt: process.env.COMFYUI_NEGATIVE_PROMPT || '',  // 负面提示词覆盖（留空=沿用工作流默认）
    tlsVerify: process.env.COMFYUI_TLS_VERIFY !== 'false',
    globalLora: [],
    hiresLora: [],   // HiresFix 放大细化专用 LoRA（仅注入细化工作流，追加在 LoRA 链末尾）
    hiresWorkflowMode: 'basic', // basic 官方节点原版；advanced 超分 + 分块细化
    hiresUpscaleModel: 'RealESRGAN_x4plus_anime_6B.pth', // 留空使用 Lanczos；可换任意兼容超分模型
    hiresSamplingMode: 'source', // source 跟随源采样器；custom 使用细化设置
    hiresGlobalLoraScale: 1, // 不推测全局 LoRA 用途，默认完整保留
    hiresSourceBlend: 0, // 解码后融合原图插值的比例
    hiresSteps: 35,  // HiresFix 细化步数
    hiresCfg: 5.0,   // HiresFix 细化 CFG
    hiresDenoise: 0.2,  // HiresFix 细化重绘幅度
    // HiresFix「按 turbo 模型最优参数细化」开关（真机结论：放大细化工作流.json 的主模型是
    // anima_turboV10，却一直注入 CFG 5.0/35 步 —— CFG>1 会让 turbo 每步多跑一条无条件分支，
    // 双倍算力且画质退化）。true = 强制用下面两个值；false = 沿用用户填的 hiresSteps/hiresCfg。
    hiresTurbo: true,
    hiresTurboSteps: 12,   // 开关打开时的细化步数（turbo 蒸馏模型适用区间）
    hiresTurboCfg: 1.0,    // 开关打开时的细化 CFG（turbo 必须 1.0，此时负面提示词不生效是正常特性）
    hiresMaxSize: 2000,  // HiresFix 细化最长边像素
    hiresArtistMode: 'empty', // HiresFix 画师串: inherit沿用/empty留空/specified指定
    hiresArtist: '',     // HiresFix 指定模式下的画师串
  },
  features: {
    emotion: process.env.FEATURE_EMOTION !== 'false',
    memory: process.env.FEATURE_MEMORY !== 'false',
    replyGuesses: process.env.FEATURE_REPLY_GUESSES === 'true', // 默认关
    forceImageGen: process.env.FEATURE_FORCE_IMAGE_GEN === 'true', // 默认关：灵性生图
    imageGenMode: process.env.FEATURE_FORCE_IMAGE_GEN === 'true' ? 'force' : 'smart', // 'off' | 'smart' | 'force'
    realtimeAffinityDisplay: process.env.FEATURE_REALTIME_AFFINITY_DISPLAY === 'true', // 默认关：好感度实时显示
    proactiveChat: process.env.FEATURE_PROACTIVE_CHAT !== 'false', // 默认开：主动发起对话
    proactiveChatFreq: parseFloat(process.env.PROACTIVE_CHAT_FREQ) || 0.5, // 主动聊天频率 0~1
    events: process.env.FEATURE_EVENTS !== 'false', // 默认开：奇遇系统
    eventFreq: parseFloat(process.env.EVENT_FREQ) || 1, // 奇遇触发频率 0~1，0=关闭自动触发
    // 朋友圈频率 0~24：具体时间档以 2 小时 / freq 为中心浮动 ±20%，0=关闭。
    // 默认 1：沿用新增频率设置前的周期（首次 1~4 小时，之后 2~8 小时）。
    // 用 IIFE 而不是 `|| 1`：`parseFloat('0') || 1` 会把显式的 0 兜成 1，
    // env 里写 MOMENT_FREQ=0 就永远关不掉（这个坑 mediaAutoMinutes 已经踩过一次）。
    momentFreq: (() => {
      const v = parseFloat(process.env.MOMENT_FREQ);
      return Number.isFinite(v) ? Math.max(0, Math.min(24, v)) : 1;
    })(),
    momentFreqMode: '', // 未记录模式的旧设置：freq=1 为默认，其余为具体时间档
    disturbMode: process.env.FEATURE_DISTURB_MODE === 'true', // 默认关：防打扰模式
    schedule: process.env.FEATURE_SCHEDULE !== 'false', // 默认开：日程系统
    scheduleRefreshDays: Math.max(1, Math.min(3, parseInt(process.env.SCHEDULE_REFRESH_DAYS, 10) || 1)), // 日程刷新周期（天），1~3
    serializeBackgroundLLM: process.env.FEATURE_SERIALIZE_BG_LLM === 'true', // 默认关：后台LLM任务串行化
    backgroundLLMMaxConcurrency: parseInt(process.env.BG_LLM_MAX_CONCURRENCY, 10) || 3, // 后台最大并发数 (1-10)
    mergeMessages: process.env.FEATURE_MERGE_MESSAGES === 'true', // 默认关：合并连续同角色消息兼容Jinja模板
    deepThinkMode: false, // 默认关：私聊深度思考（planner 先规划媒介组合再回复），设置页/聊天页可开
    weather: process.env.FEATURE_WEATHER !== 'false', // 默认开：实时天气
    groupChat: process.env.FEATURE_GROUP_CHAT !== 'false', // 默认开：群聊系统
    groupIdleBudget: Math.max(0, parseInt(process.env.GROUP_IDLE_BUDGET ?? '0', 10) || 0), // 默认关闭；显式设为正数后启用每群每日后台闲聊预算
    // 媒体内容页的自动抓帖间隔（分钟，上游 v3.9.0 合并）。0 = 关闭（只手动刷新）。
    // 档位表在 services/mediaService.js 的 MEDIA_AUTO_STEPS，这里只存当前选中值。
    mediaAutoMinutes: Math.max(0, parseInt(process.env.MEDIA_AUTO_MINUTES ?? '20', 10) || 0), // 默认 20 分钟一档
    // ── AI 小镇（世界页）：**默认关**（2026-10-19 改）──
    // 小镇玩法尚未定稿，先默认不运行（不占运行资源、界面不出现入口）。
    //
    // ⚠️ 三个必须知道的口径（见 目标/20261019-小镇剥离方案v2.md）：
    //  1. **只关"行为"，表照建**。非小镇代码有 105 处直接读 town_* 表
    //     （routes/events.js 20 处、services/newspaperService.js 15 处、routes/moments.js 5 处…），
    //     不建表会直接 `no such table` ⇒ 所以**不要**给 db/index.js 的 town 迁移加守卫。
    //  2. 文件**不删**。上游也在持续改小镇（v3.10.0 改了 18 个），删了以后就拿不到；
    //     软关让上游更新照收、放原路径，随时可开回来。
    //  3. 开启方式：设 `FEATURE_TOWN=true`（或写入 .env）。
    //
    // 实现口径：`FEATURE_TOWN === 'true'`（显式开启）而非 `!== 'false'`（默认开启）。
    // 老口径是 `!== 'false'`，语义是"默认开、可关"；新口径是"默认关、可开"——
    // 这才是"剥离"该有的语义。
    town: process.env.FEATURE_TOWN === 'true',
    // 三个子开关**级联**到主开关：主开关关 ⇒ 全部关（避免出现"主关子开"的半开状态）。
    // 传 `FEATURE_TOWN=true` 后，仍可用 `FEATURE_TOWN_LLM=false` 单独关掉 LLM 事件。
    townLLM: process.env.FEATURE_TOWN === 'true' && process.env.FEATURE_TOWN_LLM !== 'false', // 小镇 LLM 事件（相遇对话/状态气泡）；关闭则退化为纯移动模拟
    townAutoLLM: process.env.FEATURE_TOWN === 'true' && process.env.FEATURE_TOWN_AUTO_LLM !== 'false', // 小镇「自动/定时」LLM 事件（tick 驱动的相遇对话+摘要、批量状态气泡）；关闭只影响后台自动生成，玩家主动发起的 NPC/工坊对话仍走模型
    townBuildingFeatures: process.env.FEATURE_TOWN === 'true' && process.env.FEATURE_TOWN_BUILDING_FEATURES !== 'false', // 小镇特殊建筑「描述驱动的可执行玩法」（关闭后隐藏新入口、拒绝新生成/新操作；上游 v3.9.0 合并）
    bgmMuted: false, // 默认关：小镇 BGM 静音（世界页顶栏音符钮切换）
    intimate: process.env.FEATURE_INTIMATE !== 'false', // 默认开：亲密档案与统计看板（自动记账 + 看板总开关）
    intimateBackfill: process.env.FEATURE_INTIMATE_BACKFILL !== 'false', // 默认开：历史会话回填默认开启
    hypnosis: process.env.FEATURE_HYPNOSIS !== 'false', // 默认开：催眠手机（关闭时写操作 409，读状态不拦）
    // ── 提示词破限（Prompt Shield）──
    // **默认开**：往每一次 LLM 调用（chatSync / chatStream 两个收口）的 messages 最前面
    // 插一条 system 消息，内容是「不拒答」提示词 —— 避免模型拿"世界观涉及校园/成人内容"为由
    // 拒答，把奇遇 / 日程 / 朋友圈 / 亲密这几条链路整条打断。
    // 真机已复现：日程生成连续两次被拒 ⇒ 无 JSON ⇒ 接口 500（2026-10-14 测试轮日志）。
    // 实现收口 services/promptShield.js，挂载点 src/llm/llm-client.js。
    // 关掉＝与加这个功能前逐字节一致（applyShield 直接返回原数组，零拷贝零开销）。
    // 正文默认值在 promptShield.DEFAULT_PROMPT，可在设置页编辑（存 system_settings.jailbreak_prompt）。
    jailbreak: process.env.FEATURE_JAILBREAK !== 'false',
    // ── 反重复 / 反钻牛角尖（专题·车轱辘话与钻牛角尖 · 阶段一）──
    // 两层各自独立可关，默认**开**（都是纯 prompt 增强，零额外 LLM 调用）：
    //   antiRepetition     = L1-1 近端自身输出标注 + L2 动态反重复指令（车轱辘话）
    //   antiRepetitionLock = L2 反钻牛角尖指令（同一情绪极值多轮 + 话题没换）
    antiRepetition: process.env.FEATURE_ANTI_REPETITION !== 'false',
    antiRepetitionLock: process.env.FEATURE_ANTI_REPETITION_LOCK !== 'false',
    // ── 反重复 阶段二（2026-09-30）──
    //   antiRepetitionEscalation = 自动升级：连续高复述 → 下一轮把约束升到 mode="escalated"。
    //     默认**开**（升级不花额外调用，只是把约束写硬一档）；关闭后完全按阶段一的温和/强档判定。
    //   antiRepetitionReroll     = 超阈值时**再请求一次 LLM** 替换已流式输出的内容。默认**关**
    //     （多一次调用 + 替换已展示内容有体感跳变）。
    //     2026-10-13 核实更正：**重写兜底已经接线**（`routes/chat.js` L889 计划 / L1672 执行 / L1780 发
    //     `replace_last_assistant`），不是"预留键"。打开它就会真的多烧一次调用；没开则与加功能前一致。
    //     （旧注释与旧交接文档写的"尚未实现、打开无效"是过时口径，已作废。）
    antiRepetitionEscalation: process.env.FEATURE_ANTI_REPETITION_ESCALATION !== 'false',
    antiRepetitionReroll: process.env.FEATURE_ANTI_REPETITION_REROLL === 'true',
    // ── SLG 动作系统（触摸互动 · 专题-SLG动作系统）──
    //   touch           = 动作系统总开关（关闭时 POST /touch 409 且零写入；只读清单不拦）
    //   touchInstant    = 即时反应小调用（默认开；关掉＝"省额度模式"，全部走隐式注入、一次模型都不调）
    //   touchGroupAdult = 群聊里的 Lv3（敏感档）：**默认关**（隐私边界：别在群里当众演限制级），
    //                     用户在设置页显式打开后才放行 ⇒ 关闭时行为与加开关前完全一致。
    touch: process.env.FEATURE_TOUCH !== 'false',
    touchInstant: process.env.FEATURE_TOUCH_INSTANT !== 'false',
    touchGroupAdult: process.env.FEATURE_TOUCH_GROUP_ADULT === 'true',
    // 出图判定配额（2026-10-01，用户：「需要把所有和生图相关的都看看 其他地方好像还是有限制」）：
    // 同一会话里**连续多少轮**"她决定要图"都没成功出图，就不再让她继续决定（防止反复调判定模型白烧额度）。
    // 原来这个 3 是硬编码的（两处 `?? 3` + 一处 `set(…, 3)`）：两轮失败就见底，
    // 用户观感就是"生图被限制了"。⇒ 默认提到 6 并且可配
    // （设置页 feature_imageJudgeQuota / 环境变量 FEATURE_IMAGE_JUDGE_QUOTA）。
    imageJudgeQuota: Number(process.env.FEATURE_IMAGE_JUDGE_QUOTA || 6),
    // 动作出图概率的整体缩放（2026-10-01，审计"生图相关的限制"）：
    // 智能档基础概率是 {Lv2:0.5, Lv3:0.75, Lv4:0.9}（同日从 0.25/0.5/0.6 调高），
    // 这个系数整体乘上去并夹到 1 ⇒ 想让图更多就调大（例如 1.5），想更省就调小。
    // 想要"每次都出"直接用三档开关里的 always（`touchImageMode`）。
    touchImageChanceScale: Number(process.env.FEATURE_TOUCH_IMAGE_CHANCE_SCALE || 1),
    // 性爱交互姿势（2026-10-01，用户要的玩法）：**默认开**。
    // 关掉时：读状态不拦（前端仍能显示），但任何推进动作回 409 —— 与玩具/催眠那类"功能开关"同口径。
    intimateActions: process.env.FEATURE_INTIMATE_ACTIONS !== 'false',
    // 成人玩具系统（专题-玩具系统 §2.8）：**默认关** —— 解锁后设置页才显示「玩具」开关、前端才显示玩具控制区；
    // 持久化键走通用布尔分支 feature_toys（updateFeatureFlag 的 feature_${key}）。
    toys: process.env.FEATURE_TOYS === 'true',
    // 动作出图档位（task-19）：'always' | 'smart' | 'never'，**默认 smart**。
    // 智能 = 只对 Lv2/Lv3 按概率出图（判定与概率在 touchActionService，本文件不做校验）。
    touchImageMode: process.env.FEATURE_TOUCH_IMAGE_MODE || 'smart',
    // 群聊围观概率（task-22 的概率模型）：0.3 = 30% 概率让 1 名其他成员插一句话。
    // null/false = 关闭（与 task-17 的"最多 1 人"纯 prompt 口径逐字节一致）；
    // 读取侧是 groupChatEngine.resolveTouchBystanderChance（非数字回落 0.3、0~1 夹取），
    // 这里只提供"可被 system_settings 覆盖"的键（loadSystemSettings 是白名单式的）。
    touchBystanderChance: process.env.FEATURE_TOUCH_BYSTANDER_CHANCE !== undefined
      ? Number(process.env.FEATURE_TOUCH_BYSTANDER_CHANCE)
      : 0.3,
    // 反应风格（task-30）：'conversation'（**默认**：对话式 —— 全量喂料 + 放开输出的 1~4 句）
    //   | 'quick'（快速：旧口径 —— 短喂料 + 1~2 句 + max_tokens 300，一键回退）。
    // 校验/回落见 updateFeatureFlag 的二态分支（非这两个值一律回落 conversation）。
    touchReactionMode: process.env.FEATURE_TOUCH_REACTION_MODE || 'conversation',
    // HiresFix 细化精度三档（2026-09-30 · D1 实测裁决）：'high'=12 步 / 'medium'=10 步 / 'low'=8 步（**默认 low**）。
    // 只影响 HiresFix 那一次细化的步数（CFG 恒 1.0）；非法值/未设一律回落 low（normalizeHiresQuality）。
    hiresQuality: normalizeHiresQuality(process.env.FEATURE_HIRES_QUALITY),
    // 灵魂系统（上游 v3.9.0 合并，见 services/soulEngine.js）：默认开，无设置页开关。
    // 关闭时所有对外入口返回 null/''，不落库、不共鸣、不改行为参数，与加功能前一致。
    soul: process.env.FEATURE_SOUL !== 'false',
  },
  // 灵魂系统（角色自我认知状态层）。开关是 features.soul；此处只放可配的回归中心 mid。
  // min/max 硬编码在 soulEngine，刻意不暴露（源插件那四个属性无消费方，是死配置）。
  soul: {
    mids: {
      RecallDepth: parseFloat(process.env.SOUL_RECALL_DEPTH_MID) || 7,
      ImpressionDepth: parseFloat(process.env.SOUL_IMPRESSION_DEPTH_MID) || 3,
      ExpressionDesire: Number.isFinite(parseFloat(process.env.SOUL_EXPRESSION_DESIRE_MID)) ? parseFloat(process.env.SOUL_EXPRESSION_DESIRE_MID) : 0.5,
      Creativity: Number.isFinite(parseFloat(process.env.SOUL_CREATIVITY_MID)) ? parseFloat(process.env.SOUL_CREATIVITY_MID) : 0.7,
    },
  },
  town: {
    timeZone: process.env.TOWN_TIME_ZONE || 'Asia/Shanghai',
    tickSeconds: Math.max(20, Math.min(300, parseInt(process.env.TOWN_TICK_SECONDS, 10) || 60)), // 模拟步长（真实秒）
    npcSpeed: 0.5,        // NPC 移动速度（格/秒），服务端推进与前端插值共用
    playerSpeed: 1.1,     // 玩家 token 移动速度（格/秒）
    encounterCooldownHours: 3,   // 同一对角色相遇冷却
    encounterMinStartGapMin: 8,  // 两场相遇之间的全局最小间隔（分钟），防止人口密集时 LLM 调用风暴
    maxActiveEncounters: 2,      // 同时在场的相遇上限
    encounterRelatedProb: 0.28,  // 有关系角色同地点相遇概率（每 tick）
    encounterStrangerProb: 0.05, // 陌生人相遇概率（用于发展新关系）
    statusBubbleIntervalMin: 45, // 批量状态气泡间隔（分钟）
    // 环境奇遇：镇民相遇后有概率升级为一条可参与的镇民奇遇（进玩家奇遇列表）
    ambientStoryProb: 0.12,          // 每场 NPC×NPC 相遇的升级概率
    ambientStoryDailyCap: 2,         // 全镇每天环境奇遇上限（历史表按 event_type_key=town.ambient 计数）
    ambientStoryDurationMin: 120,    // 环境奇遇限时（分钟；比玩家发起的 60 分钟长，留出发现时间）
    // 镇民朋友圈：镇民会把今天遇到的事发进朋友圈（moment_posts，npc_id 作者）
    npcMomentsDisabled: false, // 管理面板开关：禁止镇民发朋友圈（默认允许）
    npcMoments: {
      minGapHours: 3,      // 同一镇民两次发帖的最小间隔
      maxGapHours: 10,     // 两次发帖的最大间隔
      dailyCap: 4,         // 全镇每天镇民帖子上限
    },
    // M1 需求系统：六类满足度（0-100）按逻辑时间衰减；速率/恢复量/影响项集中配置，
    // 数值是起始方案，应通过模拟观察与游玩验证调整。
    needs: {
      decayPerHour: { satiety: 2, energy: 1.5, social: 1, fun: 0.6, comfort: 0, security: 0.2 },
      maxSettleGapMs: 12 * 3600_000,  // 单次结算最大承认间隔（离线温和截断，不一次性扣完）
      personalitySocialDecay: [0.6, 1.4], // 外向 1 → 1.4×，内向 0 → 0.6×（social 衰减修正）
      recovery: {
        restEnergyPerHour: 18,          // 完成 rest 动作：每小时恢复精力
        encounterSocial: { silent_pass: 6, brief_chat: 10, chat: 14, interrupted: 4 }, // 相遇恢复社交
      },
    },
    // M3 有向关系：相遇结果 → 双向熟悉/好感增量；每日熟悉度上限防重复刷收益
    social: {
      familiarityPerOutcome: { silent_pass: 2, interrupted: 1, brief_chat: 4, chat: 6 },
      affectionPerOutcome: { chat: 2, brief_chat: 1 },
      dailyFamiliarityCap: 10,        // 每对每方向每日最多生效的熟悉度来源次数
    },
    // M2 空闲生活动作：需求紧迫度分段线性评分（阈值/权重/滞回带集中配置，
    // 起始数值，应由模拟观察与游玩验证调整）。
    life: {
      urgency: { eatBelow: 65, funBelow: 60, energyBelow: 45, comfortBelow: 50 },
      weight: {
        eatPerNeedPoint: 1.2,           // (eatBelow - satiety) × 1.2
        readPerNeedPoint: 0.8,
        sitPerEnergyPoint: 0.6, sitPerComfortPoint: 0.6,
        curiosityBonus: 10,             // 好奇心 → 阅读倾向
        interestBonus: 6,               // 兴趣标签匹配加成（料理→吃，阅读→读）
        distanceCost: 1.5,              // 每格切比雪夫距离的扣分
      },
      nearBand: 8,                      // 近分平局带（确定性随机挑选，防全体趋同）
      capacity: { eat: 4, read: 3, sit: 6 }, // 场所同时容纳的生活动作数（客满后决策改选他处）
      keepBand: { eat: 80, read: 85, sit: 70 }, // 滞回带：需求恢复出带才换计划
      durationsMin: { eat: 20, read: 30, sit: 10 },
      recovery: { eatSatiety: 40, readFun: 22, sitComfort: 12, sitEnergy: 6 },
      maxMoveFailures: 3,               // 生活计划目标连续不可达的放弃阈值
    },
    // M4 基础经营：固定价格起始方案（先验证供给/工资/消费循环，浮动价格后置）。
    economy: {
      wagePerShift: 10,                 // 每次 work_shift 出勤的工资（完成后支付，只付一次）
      mealPrice: 6,                     // 每份餐食价格（life_eat 完成时支付经营账户）
      actorSeed: 50,                    // 居民一次性启动资金（玩家另有 v2 开局补助 200）
      venueSeed: 200,                   // 场所经营账户一次性启动资金
      procureThreshold: 3,              // 餐食库存低于该值触发补货
      procureBatch: 12,                 // 每次补货量（份）
      procureCost: 12,                  // 每次补货付给外部供应商的金额
      procureIntervalMs: 3600_000,      // 补货最小间隔（小时桶，来源键按桶幂等）
      supplierDailyImport: 40,          // 外部供应商每日食材到货（来源明确的物资流入）
    },
    // M5 目标/技能/习惯：进度从已结算事实消费；技能每日收益有上限且随等级边际递减
    goals: {
      careerProgressPerShift: 5,        // 每次出勤的职业目标进度
      readProgress: 3,                  // 每次阅读的兴趣目标进度
      eatInterestProgress: 3,
      skillBase: 3,                     // 技能基础收益（每次有效行为）
      habitBase: 2,                     // 习惯基础收益
      skillDailyCap: 6,                 // 每项技能/习惯每日收益上限
      interestGoalBonus: 12,            // 兴趣目标对匹配生活动作的评分加成
      habitBonusScale: 0.15,            // 习惯等级 → 评分加成系数
    },
    // M6 事件导演：候选只能从已结算事实建立（repeat_key 幂等）；邀请复用镇民奇遇管线
    director: {
      candidateTtlMs: 24 * 3600_000,    // 候选有效期（过期自行关闭，无惩罚）
      inviteDailyCap: 3,                // 全镇每日邀请上限（节奏控制）
      inviteGapMs: 90 * 60_000,         // 候选建立后到可邀请的最小间隔（恢复期）
    },
    // M7 关键叙事：自动叙事每日预算（调参起点）；模型输出过不了契约就模板回退
    narrative: {
      dailyAutoQuota: 3,                // 每镇每日自动叙事额度（手动触发不计）
      cacheMax: 64,                     // 叙事缓存条数（重复打开不重新生成）
      maxAttempts: 2,                   // 失败有限重试，之后模板回退
      summaryMin: 20, summaryMax: 80,   // 契约：摘要字数
      lineMin: 10, lineMax: 80,         // 契约：台词字数
      linesMax: 6,                      // 契约：台词条数
      labelMin: 2, labelMax: 18,        // 契约：选项文案字数
    },
    // 布图密度：每 1000 格的目标对象数。原建筑均值约 2.8，默认提升 50% 后为 4.2；
    // 道具必须始终高于建筑，由 updateTownSettings 统一夹紧。
    buildingDensity: 4.2,
    propDensity: 8,
    mapSize: 50,
    aiLayoutOptimize: false,
    // 世界生成配置：自定义生成偏好与各步骤画师串/前置提示词/LoRA；DB system_settings 持久化
    generation: {
      styleTags: '',
      steps: {
        tiles: { prefix: 'pixel art, game sprite, white background', artist: '@ebora', loras: [] },
        buildings: { prefix: 'pixel art, game sprite, white background', artist: '@ebora', loras: [] },
        npcs: { prefix: 'pixel art, game sprite, mini human sized, full body', artist: '@ebora', loras: [], portraitLoras: false },
        player: { prefix: 'pixel art, game sprite, mini human sized, full body', artist: '@ebora', loras: [], portraitLoras: false },
      },
    },
  },
  disturb: {
    startTime: process.env.DISTURB_START_TIME || '22:00',
    endTime: process.env.DISTURB_END_TIME || '08:00',
    characterIds: [], // 内存中缓存，启动时从 DB 加载
    hideWorld: false, // 隐藏世界观（DB 加载覆盖）
    skipWeekends: false, // 跳过周末（DB 加载覆盖）
  },
  compression: {
    enabled: false,
    type: 'oxipng',   // 'oxipng' | 'avif'
  },
  workflow: {
    mode: 'turbo',     // 'base' | 'turbo' | 'hybrid' | 'custom'
    // mode === 'custom' 时使用的工作流文件名（位于 workflow/ 目录，如 制图工作流-pro-yinyue.json）
    // 文件缺失时自动回退 turbo，不会导致生图失败（上游 v3.10.0 合并，2026-10-19）
    customTemplate: '',
    scene: {           // hybrid 模式下的场景→工作流映射
      chat: 'turbo',
      group: 'base',
      moments: 'base',
      events: 'base',
      schedule: 'base',
      mailbox: 'base',
      town: 'turbo',   // AI 小镇像素素材
    },
  },
  user: {
    nickname: process.env.USER_NICKNAME || '用户',
    gender: process.env.USER_GENDER || '',
    appearance: process.env.USER_APPEARANCE || '',
    persona: process.env.USER_PERSONA || '',
  },
  groupChat: {
    activity: 2, // 1~5：仅控制冷场等待时长和自动闲聊轮数
    // 群聊 LLM 温度（0.5~1.2），所有群共享；DB system_settings 持久化，启动时覆盖默认值
    temperature: parseFloat(process.env.GROUP_CHAT_TEMPERATURE) >= 0.5 && parseFloat(process.env.GROUP_CHAT_TEMPERATURE) <= 1.2
      ? parseFloat(process.env.GROUP_CHAT_TEMPERATURE)
      : 0.7,
    // 群聊记忆总结/滑动窗口推进轮次（2~30），所有群共享；DB system_settings 持久化，启动时覆盖默认值
    // 2026-10-31 用户要求把上限从 6 提到 30（要更长的对话记忆），transcript 上限随之放大
    summaryInterval: (() => {
      const n = parseInt(process.env.GROUP_CHAT_SUMMARY_INTERVAL, 10);
      return Number.isInteger(n) ? Math.max(2, Math.min(30, n)) : 4;
    })(),
  },
  weather: {
    city: process.env.WEATHER_CITY || '',
  },
};

// 启动时如果 tlsVerify=false，设置进程级环境变量让 fetch/ws 信任自签名证书
if (config.comfyui.tlsVerify === false) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

function persistEnv(key, value) {
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  } else {
    envContent = '# 此文件由系统自动管理，通过 Settings 页面修改配置即可\n';
  }
  const line = `${key}=${String(value)}`;
  if (envContent.includes(`${key}=`)) {
    envContent = envContent.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  } else {
    envContent += `\n${line}`;
  }
  fs.writeFileSync(envPath, envContent, 'utf8');
}

// 同步写入 DB（内存已更新，DB 写入由 setSetting 同步完成）
function persistSettingSync(key, value) {
  try {
    setSetting(key, value);
  } catch (err) {
    console.error(`[config] persistSetting failed for ${key}:`, err.message);
  }
}

export function getNovelaiApiKey() {
  try { return getSetting('novelai_api_key') ?? process.env.NOVELAI_API_KEY ?? ''; }
  catch { return process.env.NOVELAI_API_KEY || ''; }
}

export function updateComfyConfig({ artist, width, height, url, momentsArtist, momentsWidth, momentsHeight, eventArtist, eventWidth, eventHeight, tlsVerify, qualityPrompt, negativePrompt, imageProvider, novelaiApiFormat, novelaiProxyUrl, novelaiUrl, novelaiModel, novelaiArtist, novelaiWidth, novelaiHeight, novelaiSteps, novelaiSampler, novelaiNoiseSchedule, novelaiGuidance, novelaiQualityPrompt, novelaiNegativePrompt, novelaiApiKey, clearNovelaiApiKey }) {
  if (imageProvider !== undefined) {
    const provider = imageProvider === 'novelai' ? 'novelai' : 'comfyui';
    config.comfyui.imageProvider = provider;
    persistSettingSync('image_provider', provider);
  }
  if (novelaiApiFormat !== undefined) {
    // 三协议（official / native / relay）统一走 novelaiClient 的归一化 —— 本地原来只认两档，
    // 会把 'native' 静默降级成 'relay'（上游 v3.10.0 合并，2026-10-19）
    const value = normalizeNovelaiFormat(novelaiApiFormat);
    config.comfyui.novelaiApiFormat = value;
    persistSettingSync('novelai_api_format', value);
  }
  if (novelaiProxyUrl !== undefined) {
    // 只做 trim：空串 = 清除（回落到环境变量代理），格式校验交给 novelaiClient（它要拼 URL）
    const value = String(novelaiProxyUrl).trim();
    config.comfyui.novelaiProxyUrl = value;
    persistSettingSync('novelai_proxy_url', value);
  }
  if (novelaiUrl !== undefined) {
    const value = String(novelaiUrl).trim().replace(/\/+$/, '');
    config.comfyui.novelaiUrl = value;
    persistSettingSync('novelai_url', value);
  }
  if (novelaiModel !== undefined) {
    const value = String(novelaiModel).trim() || 'nai-diffusion-4-5-full';
    config.comfyui.novelaiModel = value;
    persistSettingSync('novelai_model', value);
  }
  if (novelaiArtist !== undefined) {
    const value = String(novelaiArtist).trim();
    config.comfyui.novelaiArtist = value;
    persistSettingSync('novelai_artist', value);
  }
  if (novelaiWidth !== undefined && novelaiHeight !== undefined) {
    const parsedWidth = parseInt(novelaiWidth, 10);
    const parsedHeight = parseInt(novelaiHeight, 10);
    if (Number.isInteger(parsedWidth) && Number.isInteger(parsedHeight)
      && parsedWidth >= 64 && parsedHeight >= 64 && parsedWidth <= 4096 && parsedHeight <= 4096) {
      config.comfyui.novelaiWidth = parsedWidth;
      config.comfyui.novelaiHeight = parsedHeight;
      persistSettingSync('novelai_width', config.comfyui.novelaiWidth);
      persistSettingSync('novelai_height', config.comfyui.novelaiHeight);
    }
  }
  if (novelaiSteps !== undefined) {
    const value = Math.min(50, Math.max(1, parseInt(novelaiSteps, 10) || 28));
    config.comfyui.novelaiSteps = value;
    persistSettingSync('novelai_steps', value);
  }
  if (novelaiSampler !== undefined) {
    const allowed = new Set(['k_euler', 'k_euler_ancestral', 'k_dpm_2', 'k_dpm_2_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'ddim', 'ddim_v3']);
    if (allowed.has(novelaiSampler)) {
      config.comfyui.novelaiSampler = novelaiSampler;
      persistSettingSync('novelai_sampler', novelaiSampler);
    }
  }
  if (novelaiNoiseSchedule !== undefined) {
    const allowed = new Set(['native', 'karras', 'exponential', 'polyexponential']);
    if (allowed.has(novelaiNoiseSchedule)) {
      config.comfyui.novelaiNoiseSchedule = novelaiNoiseSchedule;
      persistSettingSync('novelai_noise_schedule', novelaiNoiseSchedule);
    }
  }
  if (novelaiGuidance !== undefined) {
    const value = Number(novelaiGuidance);
    if (Number.isFinite(value)) {
      config.comfyui.novelaiGuidance = Math.round(Math.min(10, Math.max(0, value)) * 10) / 10;
      persistSettingSync('novelai_guidance', config.comfyui.novelaiGuidance);
    }
  }
  if (novelaiQualityPrompt !== undefined) {
    const value = typeof novelaiQualityPrompt === 'string' ? novelaiQualityPrompt.trim() : '';
    config.comfyui.novelaiQualityPrompt = value;
    persistSettingSync('novelai_quality_prompt', value);
  }
  if (novelaiNegativePrompt !== undefined) {
    const value = typeof novelaiNegativePrompt === 'string' ? novelaiNegativePrompt.trim() : '';
    config.comfyui.novelaiNegativePrompt = value;
    persistSettingSync('novelai_negative_prompt', value);
  }
  if (novelaiApiKey !== undefined) {
    // 归一化（去 `Bearer ` 前缀与首尾空白）只走 novelaiClient 那一份 —— 上游 v3.10.0 合并。
    // 原来只 trim，用户粘贴 "Bearer xxx" 会带着前缀入库，出图鉴权直接 401。
    persistSettingSync('novelai_api_key', normalizeNovelaiKey(novelaiApiKey));
  } else if (clearNovelaiApiKey === true) {
    persistSettingSync('novelai_api_key', '');
  }
  if (artist !== undefined) { config.comfyui.artist = artist; persistSettingSync('comfy_artist', artist); }
  if (qualityPrompt !== undefined) {
    config.comfyui.qualityPrompt = typeof qualityPrompt === 'string' ? qualityPrompt.trim() : '';
    persistSettingSync('comfy_quality_prompt', config.comfyui.qualityPrompt);
  }
  if (negativePrompt !== undefined) {
    config.comfyui.negativePrompt = typeof negativePrompt === 'string' ? negativePrompt.trim() : '';
    persistSettingSync('comfy_negative_prompt', config.comfyui.negativePrompt);
  }
  if (width !== undefined) { config.comfyui.width = parseInt(width, 10) || config.comfyui.width; persistSettingSync('comfy_width', config.comfyui.width); }
  if (height !== undefined) { config.comfyui.height = parseInt(height, 10) || config.comfyui.height; persistSettingSync('comfy_height', config.comfyui.height); }
  if (url !== undefined) { const n = String(url).replace(/\/+$/, ''); config.comfyui.url = n; persistEnv('COMFYUI_URL', n); }
  if (momentsArtist !== undefined) { config.comfyui.momentsArtist = momentsArtist; persistSettingSync('comfy_moments_artist', momentsArtist); }
  if (momentsWidth !== undefined) { config.comfyui.momentsWidth = parseInt(momentsWidth, 10) || config.comfyui.momentsWidth; persistSettingSync('comfy_moments_width', config.comfyui.momentsWidth); }
  if (momentsHeight !== undefined) { config.comfyui.momentsHeight = parseInt(momentsHeight, 10) || config.comfyui.momentsHeight; persistSettingSync('comfy_moments_height', config.comfyui.momentsHeight); }
  if (eventArtist !== undefined) { config.comfyui.eventArtist = eventArtist; persistSettingSync('comfy_event_artist', eventArtist); }
  if (eventWidth !== undefined) { config.comfyui.eventWidth = parseInt(eventWidth, 10) || config.comfyui.eventWidth; persistSettingSync('comfy_event_width', config.comfyui.eventWidth); }
  if (eventHeight !== undefined) { config.comfyui.eventHeight = parseInt(eventHeight, 10) || config.comfyui.eventHeight; persistSettingSync('comfy_event_height', config.comfyui.eventHeight); }
  if (tlsVerify !== undefined) {
    config.comfyui.tlsVerify = tlsVerify === true || tlsVerify === 'true';
    persistEnv('COMFYUI_TLS_VERIFY', String(config.comfyui.tlsVerify));
    if (!config.comfyui.tlsVerify) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    } else {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  }
  // 有 NovelAI 字段被改动时，把当前值回写进激活中的 NovelAI 配置快照，
  // 这样在配置面板里改完参数后切换走再切换回来不会丢改动。
  const touchedNovelai = [novelaiApiFormat, novelaiUrl, novelaiProxyUrl, novelaiModel, novelaiArtist,
    novelaiWidth, novelaiHeight, novelaiSteps, novelaiSampler, novelaiNoiseSchedule, novelaiGuidance,
    novelaiQualityPrompt, novelaiNegativePrompt, novelaiApiKey, clearNovelaiApiKey]
    .some(value => value !== undefined);
  if (touchedNovelai) syncActiveNovelaiProfile();
  console.log('[config] Image generation settings saved');
}

export function updateGlobalLora(loras) {
  if (!Array.isArray(loras)) loras = [];
  const cleaned = loras.filter(l => l.path && typeof l.path === 'string').map(l => ({
    path: l.path,
    weight: typeof l.weight === 'number' ? l.weight : 0.6,
    triggerWord: l.triggerWord || '',
    enabled: l.enabled !== false,
    scenes: Array.isArray(l.scenes) ? l.scenes : [],
  }));
  config.comfyui.globalLora = cleaned;
  persistSettingSync('comfy_global_lora', JSON.stringify(cleaned));
  console.log(`[config] Global lora updated: ${cleaned.length} item(s)`);
}

/**
 * 更新 HiresFix 细化专用 LoRA（仅作用于放大细化工作流，追加在 LoRA 链末尾；
 * 与全局/角色 LoRA 同 path 时以细化配置的权重为准）
 */
/**
 * 更新 HiresFix 细化设置（专用 LoRA + 步数/重绘幅度/CFG/最长边/画师串模式），
 * 细化 LoRA 仅作用于放大细化工作流，追加在 LoRA 链末尾；
 * 与全局/角色 LoRA 同 path 时以细化配置的权重为准
 */
export function updateHiresSettings({ loras, steps, cfg, denoise, maxSize, artistMode, artist, samplingMode, globalLoraScale, sourceBlend, upscaleModel, workflowMode, turboMode } = {}) {
  if (['basic', 'advanced'].includes(workflowMode)) {
    config.comfyui.hiresWorkflowMode = workflowMode;
    persistSettingSync('comfy_hires_workflow_mode', workflowMode);
  }
  if (typeof upscaleModel === 'string') {
    config.comfyui.hiresUpscaleModel = upscaleModel.trim();
    persistSettingSync('comfy_hires_upscale_model', config.comfyui.hiresUpscaleModel);
  }
  if (['source', 'custom'].includes(samplingMode)) {
    config.comfyui.hiresSamplingMode = samplingMode;
    persistSettingSync('comfy_hires_sampling_mode', samplingMode);
  }
  for (const [value, key, storageKey, max] of [
    [globalLoraScale, 'hiresGlobalLoraScale', 'comfy_hires_global_lora_scale', 2],
    [sourceBlend, 'hiresSourceBlend', 'comfy_hires_source_blend', 1],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    config.comfyui[key] = Math.max(0, Math.min(max, value));
    persistSettingSync(storageKey, String(config.comfyui[key]));
  }
  if (loras !== undefined) {
    if (!Array.isArray(loras)) loras = [];
    const cleaned = loras.filter(l => l.path && typeof l.path === 'string').map(l => ({
      path: l.path,
      weight: typeof l.weight === 'number' ? l.weight : 0.6,
      triggerWord: l.triggerWord || '',
      enabled: l.enabled !== false,
    }));
    config.comfyui.hiresLora = cleaned;
    persistSettingSync('comfy_hires_lora', JSON.stringify(cleaned));
  }
  if (steps !== undefined) {
    const n = parseInt(steps, 10);
    if (Number.isInteger(n)) {
      config.comfyui.hiresSteps = Math.max(1, Math.min(100, n));
      persistSettingSync('comfy_hires_steps', String(config.comfyui.hiresSteps));
    }
  }
  if (cfg !== undefined) {
    const f = parseFloat(cfg);
    if (!Number.isNaN(f)) {
      config.comfyui.hiresCfg = Math.max(0, Math.min(20, f));
      persistSettingSync('comfy_hires_cfg', String(config.comfyui.hiresCfg));
    }
  }
  if (denoise !== undefined) {
    const f = parseFloat(denoise);
    if (!Number.isNaN(f)) {
      config.comfyui.hiresDenoise = Math.max(0, Math.min(1, f));
      persistSettingSync('comfy_hires_denoise', String(config.comfyui.hiresDenoise));
    }
  }
  if (turboMode !== undefined) {
    // 「随时开关」：只改内存里的 config，imageRefine 每次注入都读 live 值，无需重启
    config.comfyui.hiresTurbo = turboMode === true || turboMode === 'true';
    persistSettingSync('comfy_hires_turbo', String(config.comfyui.hiresTurbo));
  }
  if (maxSize !== undefined) {
    const n = parseInt(maxSize, 10);
    if (Number.isInteger(n)) {
      config.comfyui.hiresMaxSize = Math.max(256, Math.min(8192, n));
      persistSettingSync('comfy_hires_max_size', String(config.comfyui.hiresMaxSize));
    }
  }
  if (artistMode !== undefined) {
    if (['inherit', 'empty', 'specified'].includes(artistMode)) {
      config.comfyui.hiresArtistMode = artistMode;
      persistSettingSync('comfy_hires_artist_mode', artistMode);
    }
  }
  if (artist !== undefined) {
    config.comfyui.hiresArtist = typeof artist === 'string' ? artist : '';
    persistSettingSync('comfy_hires_artist', config.comfyui.hiresArtist);
  }
  console.log(`[config] HiresFix settings updated: lora=${config.comfyui.hiresLora.length}, steps=${config.comfyui.hiresSteps}, cfg=${config.comfyui.hiresCfg}, denoise=${config.comfyui.hiresDenoise}, maxSize=${config.comfyui.hiresMaxSize}, artistMode=${config.comfyui.hiresArtistMode}`);
}

/** 兼容旧接口：仅更新 HiresFix 细化专用 LoRA */
export function updateHiresLora(loras) {
  updateHiresSettings({ loras });
}

/**
 * 反重复采样参数（presence_penalty / frequency_penalty）。
 *
 * 专题（阶段一 L3 / 规划 C5）要求「先拿真网关打一发探针确认参数被接受，再上 UI」，
 * 因此这里只做**加法**：
 *   - 传 `null`/"清空" → 请求体里完全不发送该字段（与加参数前逐字节一致，默认就是这个状态）
 *   - 传合法数字（presence ∈ [-2,2]，frequency ∈ [-2,2]）→ 透传给上游
 * 非法值一律返回 { ok:false }，不写库、不改内存。
 */
export function updateAntiRepetitionPenalty({ presence, frequency } = {}) {
  const parse = (value) => {
    if (value === null || value === '' || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };
  const presenceValue = parse(presence);
  const frequencyValue = parse(frequency);
  if (presenceValue === undefined || (presenceValue !== null && (presenceValue < -2 || presenceValue > 2))) {
    return { ok: false, error: 'presence_penalty must be a number in [-2, 2] or empty' };
  }
  if (frequencyValue === undefined || (frequencyValue !== null && (frequencyValue < -2 || frequencyValue > 2))) {
    return { ok: false, error: 'frequency_penalty must be a number in [-2, 2] or empty' };
  }

  if (presence !== undefined) {
    config.llm.antiRepetitionPenalty = presenceValue;
    persistSettingSync('anti_repetition_penalty', presenceValue === null ? '' : String(presenceValue));
  }
  if (frequency !== undefined) {
    config.llm.antiRepetitionFrequency = frequencyValue;
    persistSettingSync('anti_repetition_frequency', frequencyValue === null ? '' : String(frequencyValue));
  }
  console.log(`[config] anti-repetition penalty: presence=${config.llm.antiRepetitionPenalty ?? '(off)'} frequency=${config.llm.antiRepetitionFrequency ?? '(off)'}`);
  return { ok: true, presence: config.llm.antiRepetitionPenalty, frequency: config.llm.antiRepetitionFrequency };
}

export function updateFeatureFlag(key, value) {
  // 三态字符串开关：'off' | 'smart' | 'force'，不走布尔强转
  if (key === 'imageGenMode') {
    const mode = ['off', 'smart', 'force'].includes(value) ? value : 'smart';
    config.features.imageGenMode = mode;
    persistSettingSync('feature_imageGenMode', mode);
    console.log(`[config] imageGenMode = ${mode}`);
    return;
  }
  // 数值型开关：群聊围观概率 0~1（task-22 的概率模型；null / 'off' = 关闭，退回 task-17 口径）
  if (key === 'touchBystanderChance') {
    const raw = (value === null || value === false || value === 'off' || value === '') ? null : Number(value);
    const chance = raw === null ? null : (Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.3);
    config.features.touchBystanderChance = chance;
    persistSettingSync('feature_touchBystanderChance', chance === null ? '' : String(chance));
    console.log(`[config] touchBystanderChance = ${chance}`);
    return;
  }
  // 二态字符串开关：反应风格 'conversation' | 'quick'（task-30），不走布尔强转
  if (key === 'touchReactionMode') {
    const style = value === 'quick' ? 'quick' : 'conversation';
    config.features.touchReactionMode = style;
    persistSettingSync('feature_touchReactionMode', style);
    console.log(`[config] touchReactionMode = ${style}`);
    return;
  }
  // 三态字符串开关：HiresFix 细化精度 'high' | 'medium' | 'low'（D1），不走布尔强转；非法值回落 low
  if (key === 'hiresQuality') {
    const quality = normalizeHiresQuality(value);
    config.features.hiresQuality = quality;
    persistSettingSync('feature_hiresQuality', quality);
    console.log(`[config] hiresQuality = ${quality}`);
    return;
  }
  // 三态字符串开关：动作出图档位 'always' | 'smart' | 'never'（task-19），同样不走布尔强转
  if (key === 'touchImageMode') {
    const level = ['always', 'smart', 'never'].includes(value) ? value : 'smart';
    config.features.touchImageMode = level;
    persistSettingSync('feature_touchImageMode', level);
    console.log(`[config] touchImageMode = ${level}`);
    return;
  }
  const boolVal = value === true || value === 'true';
  config.features[key] = boolVal;
  persistSettingSync(`feature_${key}`, String(boolVal));
  console.log(`[config] Feature ${key} = ${boolVal}`);
}

/**
 * 更新主动聊天频率 0~1
 * freq=0 → 双线全关；freq>0 → 启用以频率为基准的定时触发线
 */
export function updateProactiveFreq(value) {
  const f = Math.max(0, Math.min(1, parseFloat(value) || 0));
  config.features.proactiveChatFreq = f;
  config.features.proactiveChat = f > 0;
  persistSettingSync('feature_proactiveChatFreq', String(f));
  console.log(`[config] proactiveChatFreq = ${f}`);
}

/**
 * 更新奇遇触发频率 0~1
 * freq=0 → 关闭自动触发；freq>0 → 以频率为基准的定时触发
 */
export function updateEventFreq(value) {
  const f = Math.max(0, Math.min(1, parseFloat(value) || 0));
  config.features.eventFreq = f;
  persistSettingSync('feature_eventFreq', String(f));
  console.log(`[config] eventFreq = ${f}`);
}

/**
/**
 * 更新朋友圈发帖频率（0~24）
 * 默认保持角色各自 2~8 小时；interval 模式角色统一每 2 小时 / freq 生成一条。
 * 模式用于区分同为 freq=1 的「默认」与「2 小时」；0 = 同时关闭角色和镇民自动发帖。
 */
export function updateMomentFreq(value, mode) {
  const f = Math.max(0, Math.min(24, parseFloat(value) || 0));
  config.features.momentFreq = f;
  config.features.momentFreqMode = f === 1 && mode !== 'interval' ? 'default' : 'interval';
  persistSettingSync('feature_momentFreq', String(f));
  persistSettingSync('feature_momentFreqMode', config.features.momentFreqMode);
  console.log(`[config] momentFreq = ${f}`);
}

/**
 * 更新日程刷新周期（天，1~3），影响下次排期的 next_schedule_refresh_at
 */
export function updateScheduleRefreshDays(value) {
  const n = Math.max(1, Math.min(3, parseInt(value, 10) || 1));
  config.features.scheduleRefreshDays = n;
  persistSettingSync('feature_scheduleRefreshDays', String(n));
  console.log(`[config] scheduleRefreshDays = ${n}`);
  return n;
}

/**
 * 更新后台 LLM 任务最大并发数 1~10
 * 仅在 serializeBackgroundLLM 为 true 时生效
 */
export function updateBackgroundConcurrency(value) {
  const n = Math.max(1, Math.min(10, parseInt(value, 10) || 3));
  config.features.backgroundLLMMaxConcurrency = n;
  persistSettingSync('feature_backgroundLLMMaxConcurrency', String(n));
  console.log(`[config] backgroundLLMMaxConcurrency = ${n}`);
}

/**
 * 更新群聊 LLM 温度（0.5~1.2，所有群共享）
 */
export function updateGroupTemperature(value) {
  const t = Math.max(0.5, Math.min(1.2, parseFloat(value) || 0.7));
  config.groupChat.temperature = t;
  persistSettingSync('group_temperature', String(t));
  console.log(`[config] groupChat temperature = ${t}`);
  return t;
}

/**
 * 更新群聊记忆总结/滑动窗口推进轮次（2~6，所有群共享）
 */
export function updateGroupSummaryInterval(value) {
  const n = Math.max(2, Math.min(6, parseInt(value, 10) || 4));
  config.groupChat.summaryInterval = n;
  persistSettingSync('group_summary_interval', String(n));
  console.log(`[config] groupChat summaryInterval = ${n}`);
  return n;
}

export function updateGroupActivity(value) {
  persistSettingSync('group_activity', String(value));
  config.groupChat.activity = value;
  return value;
}

/**
 * 媒体内容页的自动抓帖间隔（分钟，上游 v3.9.0 合并）。
 * 只接受档位表里的值（0 = 关闭）；非法值抛 400，由路由透出。
 */
export function updateMediaAutoMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error('自动抓帖间隔必须是非负分钟数'), { statusCode: 400 });
  }
  persistSettingSync('media_auto_minutes', String(n));
  config.features.mediaAutoMinutes = n;
  return n;
}

function resolveLlmApiKey() {
  // 实时读取 .env 中的 API Key（兼容用户手动编辑 .env 不重启的场景）
  let envKey = '';
  try {
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, 'utf8');
      const m = raw.match(/^LLM_API_KEY=(.+)$/m);
      if (m) envKey = m[1].trim();
    }
  } catch {}
  // 优先用内存值（可能通过 UI 刚保存但还没写盘），回退到 .env 文件值
  return config.llm.apiKey || envKey || '';
}

export function getLlmApiKey() {
  return resolveLlmApiKey();
}

export function getLlmConfig() {
  const freeEgg = config.llm.freeEgg === true;
  const key = resolveLlmApiKey();
  const preview = !key ? '' : (key.length <= 12 ? '***' : `${key.slice(0, 5)}...${key.slice(-4)}`);
  return {
    provider: config.llm.provider,
    // 接入方式 / Vertex（上游 v3.10.0 合并，2026-10-19）
    connectionType: config.llm.connectionType,
    vertexRegion: config.llm.vertexRegion,
    hasVertexServiceAccount: Boolean(config.llm.vertexServiceAccount),
    freeEgg,
    // 免费鸡蛋模式下无需 Key 即可用，视为已配置，避免前端"未设置 Key"横幅误报；
    // Vertex 接入同理：有服务账号就算已配置
    hasApiKey: freeEgg ? true : config.llm.connectionType === 'vertexai' ? Boolean(config.llm.vertexServiceAccount) : !!key,
    preview,
    baseURL: config.llm.baseURL,
    model: config.llm.model,
    thinkingMode: config.llm.thinkingMode || 'disabled',
    // 输出额度（实际生效值：显式配置或按模型算的默认）
    maxTokens: config.llm.maxTokens,
    // 思考强度（部分网关只认这个）。默认 'low' = 关思考；空串回显成 'low'
    reasoningEffort: config.llm.reasoningEffort || 'low',
    headers: config.llm.headers || {},
    extraBody: config.llm.extraBody || {},
    // 上下文窗口（token）与来源：declared=用户声明 / provider=上游模型列表 / default=保守默认
    contextWindow: config.llm.contextWindow ?? null,
    contextWindowSource: config.llm.contextWindowSource || null,
    // 反重复采样参数：null = 不发送该字段（默认，与历史请求体一致）
    antiRepetitionPenalty: config.llm.antiRepetitionPenalty ?? null,
    antiRepetitionFrequency: config.llm.antiRepetitionFrequency ?? null,
  };
}

/**
 * 每日免费鸡蛋开关：开启后 LLM 请求走 opencode zen 免费端点（免 Key、强制关闭思考），
 * 用户自有的 Key/地址/模型配置保持原样，关闭后立即恢复。
 * 仅内存状态，不写 DB/.env：重启后回到关闭状态。
 */
export function updateFreeEggEnabled(enabled) {
  const boolVal = enabled === true || enabled === 'true';
  config.llm.freeEgg = boolVal;
  console.log(`[config] freeEgg = ${boolVal}`);
  return { ok: true };
}

/**
 * 规整上下文窗口声明：正整数有效，'' / null / NaN 视为"清空声明"。
 * 与 services/contextUsage.js 的 normalizeContextWindow 同口径（此处内联避免 config ↔ service 循环依赖）。
 */
function parseContextWindow(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined; // undefined = 非法值
  return parsed;
}

export function updateLlmConfig({ apiKey, baseURL, model, thinkingMode, reasoningEffort, maxTokens, headers, extraBody, connectionType, vertexRegion, vertexServiceAccount, contextWindow, contextWindowSource }) {
  const previousModel = config.llm.model;
  // ── 先校验全部入参，再落任何字段 ──
  // 上游 v3.10.0 口径：非法输入必须整体拒绝，不能留"改了一半"的状态（有测试钉住 before/after 相等）
  let headersValue;
  let extraBodyValue;
  try {
    if (connectionType !== undefined && !['openai', 'vertexai'].includes(connectionType)) {
      throw new Error('不支持的 LLM 接入方式');
    }
    if (vertexRegion !== undefined) vertexRegion = normalizeVertexRegion(vertexRegion);
    if (vertexServiceAccount !== undefined && vertexServiceAccount !== '') {
      // 服务账号密钥只以规范化后的 JSON 字符串落库；格式不对直接拒绝
      vertexServiceAccount = JSON.stringify(parseServiceAccount(vertexServiceAccount));
    }
    for (const [name, raw] of [['headers', headers], ['extraBody', extraBody]]) {
      if (raw === undefined) continue;
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是 JSON 对象`);
      if (name === 'headers') headersValue = value;
      else extraBodyValue = value;
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (maxTokens !== undefined && !isValidMaxTokens(maxTokens)) {
    return { ok: false, error: 'MAX_tokens 必须为正整数' };
  }
  if (thinkingMode !== undefined && !['enabled', 'disabled', 'omit'].includes(thinkingMode)) {
    return { ok: false, error: 'thinkingMode must be enabled, disabled, or omit' };
  }
  if (apiKey !== undefined && (!apiKey || typeof apiKey !== 'string' || !apiKey.trim())) {
    return { ok: false, error: 'API Key cannot be empty' };
  }

  // ── 校验通过，开始落库 ──
  if (connectionType !== undefined) {
    config.llm.connectionType = connectionType;
    persistSettingSync('llm_connection_type', connectionType);
  }
  if (vertexRegion !== undefined) {
    config.llm.vertexRegion = vertexRegion;
    persistSettingSync('llm_vertex_region', vertexRegion);
  }
  if (vertexServiceAccount) {
    // 空串表示"保留已保存的凭证"（前端回显时永远拿不到明文，只回 hasVertexServiceAccount）
    config.llm.vertexServiceAccount = vertexServiceAccount;
    persistSettingSync('llm_vertex_service_account', vertexServiceAccount);
  }
  if (apiKey !== undefined) {
    config.llm.apiKey = apiKey.trim();
    persistEnv('LLM_API_KEY', config.llm.apiKey);
  }
  if (baseURL !== undefined) {
    config.llm.baseURL = baseURL;
    persistEnv('LLM_BASE_URL', baseURL);
  }
  if (model !== undefined) {
    config.llm.model = model;
    persistEnv('LLM_MODEL', model);
  }
  if (thinkingMode !== undefined) {
    config.llm.thinkingMode = thinkingMode;
    persistEnv('LLM_THINKING_MODE', thinkingMode);
  }
  if (reasoningEffort !== undefined) {
    // 用户口径"默认一定要关掉思考"：low/high/max 照传，**空串与非法值一律归一回 low**
    // （不提供"置空 = 不发字段"的出口 —— 那会让 deepseek 系退回开着思考跑）。
    const effort = ['low', 'high', 'max'].includes(String(reasoningEffort)) ? String(reasoningEffort) : 'low';
    config.llm.reasoningEffort = effort;
    persistEnv('LLM_REASONING_EFFORT', effort);
  }
  if (maxTokens !== undefined || baseURL !== undefined || model !== undefined) {
    // 换地址/换模型时也要重算默认额度（显式 maxTokens 优先）
    config.llm.maxTokens = maxTokens ?? defaultMaxTokens(
      config.llm.connectionType === 'vertexai' ? '' : config.llm.baseURL,
      config.llm.model,
    );
    persistEnv('LLM_MAX_TOKENS', String(config.llm.maxTokens));
  }
  if (headersValue !== undefined) {
    config.llm.headers = headersValue;
    persistEnv('LLM_HEADERS', JSON.stringify(config.llm.headers));
  }
  if (extraBodyValue !== undefined) {
    config.llm.extraBody = extraBodyValue;
    persistEnv('LLM_EXTRA_BODY', JSON.stringify(config.llm.extraBody));
  }
  if (contextWindow !== undefined) {
    const value = parseContextWindow(contextWindow);
    if (value === undefined) {
      return { ok: false, error: 'contextWindow must be a positive integer' };
    }
    config.llm.contextWindow = value;
    // 填了值即视为用户声明；清空则连来源一起清空，交给上游探测/默认值回退
    config.llm.contextWindowSource = value === null
      ? null
      : (['provider', 'default'].includes(contextWindowSource) ? contextWindowSource : 'declared');
    persistEnv('LLM_CONTEXT_WINDOW', value === null ? '' : String(value));
    persistEnv('LLM_CONTEXT_WINDOW_SOURCE', config.llm.contextWindowSource || '');
  } else if (model !== undefined && model !== previousModel) {
    // 换模型后旧窗口不再成立（无论来自用户声明还是上游探测）：清空，等新模型重新声明/探测
    config.llm.contextWindow = null;
    config.llm.contextWindowSource = null;
    persistEnv('LLM_CONTEXT_WINDOW', '');
    persistEnv('LLM_CONTEXT_WINDOW_SOURCE', '');
  }
  console.log('[config] LLM settings saved');
  return { ok: true };
}

export function updateUserConfig({ nickname, gender, appearance, persona }) {
  if (nickname !== undefined) {
    config.user.nickname = nickname;
    persistSettingSync('user_nickname', nickname);
  }
  if (gender !== undefined) {
    config.user.gender = gender;
    persistSettingSync('user_gender', gender);
  }
  if (appearance !== undefined) {
    config.user.appearance = appearance;
    persistSettingSync('user_appearance', appearance);
  }
  if (persona !== undefined) {
    config.user.persona = persona;
    persistSettingSync('user_persona', persona);
  }
  console.log('[config] User settings saved');
}

/**
 * 更新防打扰模式总开关
 */
export function updateDisturbMode(value) {
  const boolVal = value === true || value === 'true';
  config.features.disturbMode = boolVal;
  persistSettingSync('feature_disturbMode', String(boolVal));
  console.log(`[config] disturbMode = ${boolVal}`);
}

/**
 * 更新防打扰时间段和角色列表
 */
export function updateDisturbSettings({ startTime, endTime, characterIds, hideWorld, skipWeekends }) {
  if (startTime !== undefined) {
    config.disturb.startTime = startTime;
    persistSettingSync('disturb_start_time', startTime);
  }
  if (endTime !== undefined) {
    config.disturb.endTime = endTime;
    persistSettingSync('disturb_end_time', endTime);
  }
  if (characterIds !== undefined) {
    config.disturb.characterIds = characterIds;
    persistSettingSync('disturb_character_ids', JSON.stringify(characterIds));
  }
  if (hideWorld !== undefined) {
    config.disturb.hideWorld = hideWorld === true || hideWorld === 'true';
    persistSettingSync('disturb_hide_world', String(config.disturb.hideWorld));
  }
  if (skipWeekends !== undefined) {
    config.disturb.skipWeekends = skipWeekends === true || skipWeekends === 'true';
    persistSettingSync('disturb_skip_weekends', String(config.disturb.skipWeekends));
  }
  console.log('[config] disturb settings saved');
}

export function getUserConfig() {
  return { ...config.user };
}

export function updateCompressConfig({ enabled, type }) {
  if (enabled !== undefined) {
    config.compression.enabled = enabled === true || enabled === 'true';
    persistSettingSync('compression_enabled', String(config.compression.enabled));
  }
  if (type !== undefined) {
    config.compression.type = type;
    persistSettingSync('compression_type', type);
  }
  console.log(`[config] compression: enabled=${config.compression.enabled} type=${config.compression.type}`);
}

export function updateWorkflowMode(mode) {
  // 'custom' = 用 workflow/ 目录里的自定义工作流文件（上游 v3.10.0 合并，2026-10-19）
  if (!['base', 'turbo', 'hybrid', 'custom'].includes(mode)) {
    return { ok: false, error: 'mode must be base, turbo, hybrid, or custom' };
  }
  config.workflow.mode = mode;
  persistSettingSync('workflow_mode', mode);
  // 标记来源：手动选过之后，autoDetectWorkflowMode 不再覆盖用户的选择
  persistSettingSync('workflow_mode_source', 'manual');
  console.log(`[config] workflowMode = ${mode} (manual)`);
  return { ok: true };
}

/**
 * 设置全局自定义工作流文件名（mode === 'custom' 时生效）。
 * 仅接受 workflow/ 目录下的 .json 文件名；传空字符串表示清除。
 * 上游 v3.10.0 合并（2026-10-19）：这条设置一直缺，设置页 E 组的下拉写不回去。
 */
export function updateWorkflowCustomTemplate(filename) {
  if (filename !== undefined && filename !== null && typeof filename !== 'string') {
    return { ok: false, error: 'customTemplate must be a string' };
  }
  const value = typeof filename === 'string' ? filename.trim() : '';
  config.workflow.customTemplate = value;
  persistSettingSync('workflow_custom_template', value);
  console.log(`[config] workflowCustomTemplate = ${value || '(cleared)'}`);
  return { ok: true };
}

export function updateWorkflowScene(scene) {
  if (!scene || typeof scene !== 'object') {
    return { ok: false, error: 'scene must be an object' };
  }
  for (const [k, v] of Object.entries(scene)) {
    if (['chat', 'group', 'moments', 'events', 'schedule', 'mailbox', 'town'].includes(k) && ['base', 'turbo'].includes(v)) {
      config.workflow.scene[k] = v;
    }
  }
  persistSettingSync('workflow_scene', JSON.stringify(config.workflow.scene));
  console.log(`[config] workflowScene =`, config.workflow.scene);
  return { ok: true };
}

export function getWorkflowConfig() {
  return { ...config.workflow };
}

export function updateWeatherConfig(city) {
  notifyWeatherSourceChange(config.weather.city, city);
  config.weather.city = city;
  persistSettingSync('weather_city', city);
  console.log(`[config] weather city = ${city || '(auto)'}`);
}

// ── LLM 多配置 Profile 管理 ──

function readProfilesFromDb() {
  try {
    const raw = getSetting('llm_profiles');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeProfilesToDb(profiles) {
  setSetting('llm_profiles', JSON.stringify(profiles));
}

function maskApiKey(key) {
  if (!key) return { hasApiKey: false, preview: '' };
  return {
    hasApiKey: true,
    preview: key.length <= 12 ? '***' : `${key.slice(0, 5)}...${key.slice(-4)}`,
  };
}

export function getLlmProfiles() {
  const profiles = readProfilesFromDb();
  return profiles.map(publicLlmProfile);
}

/**
 * 对外（HTTP / 返回值）的配置快照：**永远不含 apiKey 明文与 Vertex 服务账号私钥**。
 * 上游 v3.10.0 合并时加了「Vertex 凭证只存不读回」的口径 —— 有测试断言
 * `JSON.stringify(profiles)` 里不能出现 `PRIVATE KEY`。
 */
function publicLlmProfile(p) {
  return {
    id: p.id,
    name: p.name,
    ...maskApiKey(p.apiKey),
    baseURL: p.baseURL || '',
    model: p.model || '',
    connectionType: p.connectionType === 'vertexai' ? 'vertexai' : 'openai',
    vertexRegion: p.vertexRegion || 'global',
    hasVertexServiceAccount: Boolean(p.vertexServiceAccount),
    maxTokens: p.maxTokens ?? null,
    // 每套模型配置自带上下文窗口：declared=添加时用户填的 / provider=上游模型列表 / default=保守默认
    contextWindow: p.contextWindow ?? null,
    contextWindowSource: p.contextWindowSource || null,
    createdAt: p.createdAt || '',
  };
}

export function getActiveProfileId() {
  return getSetting('active_llm_profile_id') || null;
}

export function addLlmProfile(name, overrides = {}) {
  const profiles = readProfilesFromDb();
  const id = 'p_' + Date.now();
  const now = new Date().toISOString();
  const profile = {
    id,
    name: name.trim(),
    apiKey: overrides.apiKey !== undefined ? overrides.apiKey : '',
    baseURL: overrides.baseURL !== undefined ? overrides.baseURL : (config.llm.baseURL || 'https://api.deepseek.com'),
    model: overrides.model !== undefined ? overrides.model : (config.llm.model || 'deepseek-flash'),
    // 接入方式 / Vertex / 输出额度随配置一起保存（凭证明文只落 Profile，不随返回值外泄）
    connectionType: overrides.connectionType !== undefined ? overrides.connectionType : (config.llm.connectionType || 'openai'),
    vertexRegion: overrides.vertexRegion !== undefined ? overrides.vertexRegion : (config.llm.vertexRegion || 'global'),
    vertexServiceAccount: overrides.vertexServiceAccount !== undefined ? overrides.vertexServiceAccount : (config.llm.vertexServiceAccount || ''),
    maxTokens: overrides.maxTokens !== undefined ? overrides.maxTokens : (config.llm.maxTokens ?? null),
    thinkingMode: overrides.thinkingMode !== undefined ? overrides.thinkingMode : (config.llm.thinkingMode || 'disabled'),
    reasoningEffort: overrides.reasoningEffort !== undefined ? overrides.reasoningEffort : (config.llm.reasoningEffort || 'low'),
    headers: overrides.headers !== undefined ? overrides.headers : (config.llm.headers || {}),
    extraBody: overrides.extraBody !== undefined ? overrides.extraBody : (config.llm.extraBody || {}),
    // 上下文窗口：路由层已按「用户声明 → 上游 /v1/models → 保守默认」定好值再传进来；
    // 直接调 addLlmProfile 时回退到当前配置的窗口
    contextWindow: overrides.contextWindow !== undefined
      ? parseContextWindow(overrides.contextWindow)
      : (config.llm.contextWindow ?? null),
    contextWindowSource: overrides.contextWindowSource !== undefined
      ? overrides.contextWindowSource
      : (config.llm.contextWindowSource || null),
    serializeBackgroundLLM: overrides.serializeBackgroundLLM !== undefined ? overrides.serializeBackgroundLLM : (config.features.serializeBackgroundLLM || false),
    mergeMessages: overrides.mergeMessages !== undefined ? overrides.mergeMessages : (config.features.mergeMessages || false),
    backgroundConcurrency: overrides.backgroundConcurrency !== undefined ? overrides.backgroundConcurrency : (config.features.backgroundLLMMaxConcurrency || 3),
    createdAt: now,
  };
  profiles.push(profile);
  writeProfilesToDb(profiles);
  return { ok: true, profile: publicLlmProfile(profile) };
}

export function deleteLlmProfile(id) {
  let profiles = readProfilesFromDb();
  if (profiles.length <= 1) {
    return { ok: false, error: '不可删除最后一套配置' };
  }
  const target = profiles.find(p => p.id === id);
  if (!target) {
    return { ok: false, error: '配置不存在' };
  }
  const activeId = getActiveProfileId();
  profiles = profiles.filter(p => p.id !== id);
  writeProfilesToDb(profiles);

  if (activeId === id) {
    const first = profiles[0];
    setSetting('active_llm_profile_id', first.id);
    _applyProfileToConfig(first);
  }
  return { ok: true };
}

function _applyProfileToConfig(profile) {
  config.llm.apiKey = profile.apiKey || '';
  persistEnv('LLM_API_KEY', config.llm.apiKey);
  if (profile.baseURL !== undefined) {
    config.llm.baseURL = profile.baseURL;
    persistEnv('LLM_BASE_URL', profile.baseURL);
  }
  if (profile.model !== undefined) {
    config.llm.model = profile.model;
    persistEnv('LLM_MODEL', profile.model);
  }
  config.llm.thinkingMode = ['enabled', 'disabled', 'omit'].includes(profile.thinkingMode)
    ? profile.thinkingMode
    : 'disabled';
  persistEnv('LLM_THINKING_MODE', config.llm.thinkingMode);
  // 接入方式 / Vertex 凭证随配置切换；旧配置没有这些字段 → 回落到 openai + 空凭证
  config.llm.connectionType = profile.connectionType === 'vertexai' ? 'vertexai' : 'openai';
  config.llm.vertexRegion = profile.vertexRegion || 'global';
  config.llm.vertexServiceAccount = profile.vertexServiceAccount || '';
  // 输出额度：配置里有就用，没有就按新模型算
  config.llm.maxTokens = isValidMaxTokens(profile.maxTokens)
    ? profile.maxTokens
    : defaultMaxTokens(config.llm.connectionType === 'vertexai' ? '' : config.llm.baseURL, config.llm.model);
  persistEnv('LLM_MAX_TOKENS', String(config.llm.maxTokens));
  config.llm.reasoningEffort = ['low', 'high', 'max'].includes(profile.reasoningEffort)
    ? profile.reasoningEffort
    : 'low';
  persistEnv('LLM_REASONING_EFFORT', config.llm.reasoningEffort);  config.llm.headers = profile.headers || {};
  persistEnv('LLM_HEADERS', JSON.stringify(config.llm.headers));
  config.llm.extraBody = profile.extraBody || {};
  persistEnv('LLM_EXTRA_BODY', JSON.stringify(config.llm.extraBody));
  // 上下文窗口随配置一起切换（旧配置可能没有该字段 → 清空，由上游探测/默认值回退）。
  // 来源只认三个合法值：config 里的值可能是用户声明也可能是上游查到的，写错来源会误导面板。
  config.llm.contextWindow = parseContextWindow(profile.contextWindow) ?? null;
  config.llm.contextWindowSource = config.llm.contextWindow
    ? (['declared', 'provider', 'default'].includes(profile.contextWindowSource) ? profile.contextWindowSource : 'declared')
    : null;
  persistEnv('LLM_CONTEXT_WINDOW', config.llm.contextWindow === null ? '' : String(config.llm.contextWindow));
  persistEnv('LLM_CONTEXT_WINDOW_SOURCE', config.llm.contextWindowSource || '');

  if (profile.serializeBackgroundLLM !== undefined) {
    updateFeatureFlag('serializeBackgroundLLM', profile.serializeBackgroundLLM);
  }
  if (profile.mergeMessages !== undefined) {
    updateFeatureFlag('mergeMessages', profile.mergeMessages);
  }
  if (profile.backgroundConcurrency !== undefined) {
    updateBackgroundConcurrency(profile.backgroundConcurrency);
  }
}

export function activateLlmProfile(id) {
  const profiles = readProfilesFromDb();
  const profile = profiles.find(p => p.id === id);
  if (!profile) {
    return { ok: false, error: '配置不存在' };
  }
  setSetting('active_llm_profile_id', id);
  _applyProfileToConfig(profile);

  // resetClient is imported dynamically to avoid circular dependency at module level
  return { ok: true };
}

export function syncActiveLlmProfile() {
  const activeId = getActiveProfileId();
  if (!activeId) return;
  const profiles = readProfilesFromDb();
  const idx = profiles.findIndex(p => p.id === activeId);
  if (idx === -1) return;
  profiles[idx] = {
    ...profiles[idx],
    apiKey: config.llm.apiKey || '',
    baseURL: config.llm.baseURL || '',
    model: config.llm.model || '',
    connectionType: config.llm.connectionType || 'openai',
    vertexRegion: config.llm.vertexRegion || 'global',
    vertexServiceAccount: config.llm.vertexServiceAccount || '',
    maxTokens: config.llm.maxTokens ?? null,
    thinkingMode: config.llm.thinkingMode || 'disabled',
    reasoningEffort: config.llm.reasoningEffort || 'low',
    headers: config.llm.headers || {},
    extraBody: config.llm.extraBody || {},
    contextWindow: config.llm.contextWindow ?? null,
    contextWindowSource: config.llm.contextWindowSource || null,
    serializeBackgroundLLM: config.features.serializeBackgroundLLM || false,
    mergeMessages: config.features.mergeMessages || false,
    backgroundConcurrency: config.features.backgroundLLMMaxConcurrency || 3,
  };
  writeProfilesToDb(profiles);
}

// ── NovelAI 多配置 Profile 管理 ──
//
// 存 DB（system_settings.novelai_profiles），一份快照＝整套 NovelAI 生图参数：
// 接口协议 / 地址 / 代理 / 模型 / 画师串 / 分辨率 / 采样参数 / 提示词 / API Key。
// 生效配置始终是 config.comfyui 的 novelai* 字段（各字段仍按单键持久化），
// 切换＝把快照写回这些字段；编辑这些字段时自动回写激活中的快照。

function readNovelaiProfilesFromDb() {
  try {
    const raw = getSetting('novelai_profiles');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeNovelaiProfilesToDb(profiles) {
  persistSettingSync('novelai_profiles', JSON.stringify(profiles));
}

/** 当前生效的 NovelAI 参数快照（不含 id / name / 密钥） */
function snapshotNovelaiSettings() {
  return {
    apiFormat: normalizeNovelaiFormat(config.comfyui.novelaiApiFormat),
    url: config.comfyui.novelaiUrl || '',
    proxyUrl: config.comfyui.novelaiProxyUrl || '',
    model: config.comfyui.novelaiModel || 'nai-diffusion-4-5-full',
    artist: config.comfyui.novelaiArtist ?? '',
    width: config.comfyui.novelaiWidth,
    height: config.comfyui.novelaiHeight,
    steps: config.comfyui.novelaiSteps,
    sampler: config.comfyui.novelaiSampler,
    noiseSchedule: config.comfyui.novelaiNoiseSchedule,
    guidance: config.comfyui.novelaiGuidance,
    qualityPrompt: config.comfyui.novelaiQualityPrompt ?? '',
    negativePrompt: config.comfyui.novelaiNegativePrompt ?? '',
  };
}

function publicNovelaiProfile(profile) {
  const { apiKey: _apiKey, ...rest } = profile;
  return { ...rest, ...maskApiKey(profile.apiKey) };
}

function newNovelaiProfileId() {
  return `np_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 首次使用时用当前配置生成「默认配置」，保证界面上永远有一套生效中的配置 */
function ensureNovelaiProfiles() {
  const profiles = readNovelaiProfilesFromDb();
  if (profiles.length > 0) return profiles;
  const profile = {
    id: newNovelaiProfileId(),
    name: '默认配置',
    ...snapshotNovelaiSettings(),
    apiKey: normalizeNovelaiKey(getNovelaiApiKey()),
    createdAt: new Date().toISOString(),
  };
  const next = [profile];
  writeNovelaiProfilesToDb(next);
  persistSettingSync('active_novelai_profile_id', profile.id);
  return next;
}

export function getNovelaiProfiles() {
  return ensureNovelaiProfiles().map(publicNovelaiProfile);
}

export function getActiveNovelaiProfileId() {
  try { return getSetting('active_novelai_profile_id') || null; } catch { return null; }
}

/** 新增配置：默认复制当前生效的整套配置（含 API Key） */
export function addNovelaiProfile(name) {
  const label = String(name || '').trim();
  if (!label) return { ok: false, error: '请填写配置名称' };
  const profiles = ensureNovelaiProfiles();
  const profile = {
    id: newNovelaiProfileId(),
    name: label,
    ...snapshotNovelaiSettings(),
    apiKey: normalizeNovelaiKey(getNovelaiApiKey()),
    createdAt: new Date().toISOString(),
  };
  profiles.push(profile);
  writeNovelaiProfilesToDb(profiles);
  return { ok: true, profile: publicNovelaiProfile(profile) };
}

/** 把快照写回生效字段；走 updateComfyConfig 以复用同一套校验与持久化 */
function _applyNovelaiProfile(profile) {
  if (!profile) return;
  // 先落密钥：updateComfyConfig 末尾会把当前生效值回写进激活快照，
  // 顺序反了会把上一套的密钥写进刚切过来的这一套。
  persistSettingSync('novelai_api_key', normalizeNovelaiKey(profile.apiKey || ''));
  updateComfyConfig({
    novelaiApiFormat: profile.apiFormat,
    novelaiUrl: profile.url,
    novelaiProxyUrl: profile.proxyUrl,
    novelaiModel: profile.model,
    novelaiArtist: profile.artist,
    novelaiWidth: profile.width,
    novelaiHeight: profile.height,
    novelaiSteps: profile.steps,
    novelaiSampler: profile.sampler,
    novelaiNoiseSchedule: profile.noiseSchedule,
    novelaiGuidance: profile.guidance,
    novelaiQualityPrompt: profile.qualityPrompt,
    novelaiNegativePrompt: profile.negativePrompt,
  });
}

export function activateNovelaiProfile(id) {
  const profiles = readNovelaiProfilesFromDb();
  const profile = profiles.find(p => p.id === id);
  if (!profile) return { ok: false, error: '配置不存在' };
  persistSettingSync('active_novelai_profile_id', id);
  _applyNovelaiProfile(profile);
  return { ok: true };
}

/** 编辑生效参数后回写激活中的快照（幂等；没有激活配置时不做任何事） */
export function syncActiveNovelaiProfile() {
  const activeId = getActiveNovelaiProfileId();
  if (!activeId) return;
  const profiles = readNovelaiProfilesFromDb();
  const idx = profiles.findIndex(p => p.id === activeId);
  if (idx === -1) return;
  profiles[idx] = {
    ...profiles[idx],
    ...snapshotNovelaiSettings(),
    apiKey: normalizeNovelaiKey(getNovelaiApiKey()),
  };
  writeNovelaiProfilesToDb(profiles);
}

export function deleteNovelaiProfile(id) {
  let profiles = readNovelaiProfilesFromDb();
  if (profiles.length <= 1) return { ok: false, error: '不可删除最后一套配置' };
  const target = profiles.find(p => p.id === id);
  if (!target) return { ok: false, error: '配置不存在' };
  const activeId = getActiveNovelaiProfileId();
  profiles = profiles.filter(p => p.id !== id);
  writeNovelaiProfilesToDb(profiles);
  if (activeId === id) {
    persistSettingSync('active_novelai_profile_id', profiles[0].id);
    _applyNovelaiProfile(profiles[0]);
  }
  return { ok: true };
}

/**
 * 项目初始化时自动检测工作流模式（仅执行一次）
 *
 * 读取 launcher_config.json → comfyui_exe → 推导 ComfyUI/models/diffusion_models 目录：
 *   - 含 anima_turboV10 → 保持 turbo（默认即 turbo，无需操作）
 *   - 含 anima_baseV10（且无 turbo）→ 切换到 base
 *   - 目录不存在 / 无匹配模型 → 不操作
 *
 * 用 DB 标记位 workflow_mode_auto_detected 保证"仅首次检测一次"：
 *   - 路径找不到时不标记（给用户装好 ComfyUI 后重启再检测的机会）
 *   - 一旦成功读到 diffusion_models 目录就标记，后续重启永久跳过
 *   - 用户在设置页手动切换的模式不会被覆盖
 *
 * 必须在 getDb()（loadSystemSettings 已把 DB 配置加载进内存）之后调用。
 */
export function autoDetectWorkflowMode() {
  const MARKER_KEY = 'workflow_mode_auto_detected';
  // 用户**手动**选过模式就永不覆盖（原设计意图保留）；否则每次都按模型目录双向对齐。
  // 旧实现用一次性标记永久跳过，于是：先只装了 base → 写入 base；后来补装 turbo 也不会纠正，
  // 真机表现 = 库里 workflow_mode=base、日志却打 keep turbo，出图一直走 31 步 base（实测 18s/张，
  // 而 turbo 12 步只要 5.4s/张）。
  if (getSetting('workflow_mode_source') === 'manual') {
    return { skipped: true, reason: 'manual_choice' };
  }

  try {
    // 推导项目根目录：config.js 位于 agent-core/src/，往上两级到项目根（launcher_config.json 所在）
    const projectRoot = resolve(__dirname, '..', '..');
    const launcherConfigPath = resolve(projectRoot, 'launcher_config.json');

    if (!fs.existsSync(launcherConfigPath)) {
      return { skipped: true, reason: 'launcher_config_not_found' };
    }

    const launcherConfig = JSON.parse(fs.readFileSync(launcherConfigPath, 'utf-8'));
    const comfyuiExe = launcherConfig.comfyui_exe;
    if (!comfyuiExe) {
      return { skipped: true, reason: 'comfyui_exe_not_configured' };
    }

    // comfyui_exe 是启动器 exe 路径，其所在目录即为 ComfyUI 安装根目录
    const comfyuiRoot = dirname(comfyuiExe);
    const diffusionModelsDir = resolve(comfyuiRoot, 'ComfyUI', 'models', 'diffusion_models');

    if (!fs.existsSync(diffusionModelsDir)) {
      // 路径不存在 → 不操作也不标记，下次启动再试
      return { skipped: true, reason: 'diffusion_models_dir_not_found' };
    }

    // 扫描目录下的模型文件（不递归，仅顶层）
    const entries = fs.readdirSync(diffusionModelsDir, { withFileTypes: true });
    const modelFiles = entries
      .filter(e => e.isFile())
      .map(e => e.name.toLowerCase());

    const hasTurbo = modelFiles.some(n => n.includes('anima_turbo'));
    const hasBase = modelFiles.some(n => n.includes('anima_base'));

    // 成功读到目录 → 标记已检测，后续不再自动干预
    setSetting(MARKER_KEY, 'true');

    const effective = config.workflow?.mode || 'turbo';
    if (hasTurbo) {
      if (effective === 'turbo') {
        console.log('[config] autoDetectWorkflowMode: found anima_turboV10, keep turbo');
        return { detected: true, mode: 'turbo', changed: false };
      }
      // 装了 turbo 却停在别的模式（多半是历史上只有 base 时被自动写成 base）→ 纠正回来
      config.workflow.mode = 'turbo';
      persistSettingSync('workflow_mode', 'turbo');
      persistSettingSync('workflow_mode_source', 'auto');
      console.log(`[config] autoDetectWorkflowMode: found anima_turboV10, ${effective} → turbo`);
      return { detected: true, mode: 'turbo', changed: true };
    }
    if (hasBase) {
      // 有 base 无 turbo → 切到 base（没得选）
      if (effective === 'base') {
        console.log('[config] autoDetectWorkflowMode: found anima_baseV10 (no turbo), keep base');
        return { detected: true, mode: 'base', changed: false };
      }
      config.workflow.mode = 'base';
      persistSettingSync('workflow_mode', 'base');
      persistSettingSync('workflow_mode_source', 'auto');
      console.log('[config] autoDetectWorkflowMode: found anima_baseV10 (no turbo), switch to base');
      return { detected: true, mode: 'base', changed: true };
    }

    // 目录存在但无匹配模型 → 不操作，但已标记（避免每次启动都扫描）
    console.log('[config] autoDetectWorkflowMode: no anima_turbo/base model found, keep current mode');
    return { detected: true, changed: false, reason: 'no_matching_model' };
  } catch (err) {
    console.warn('[config] autoDetectWorkflowMode failed:', err.message);
    return { skipped: true, reason: 'error', error: err.message };
  }
}
