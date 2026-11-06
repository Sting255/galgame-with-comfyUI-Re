/**
 * positionKnowledgeData.js — 84 条体位 → 生图知识库条目（PR#24 融合方案 §2 的落点）
 *
 * ── 为什么单独一个文件，不塞进 YAML 体系 ─────────────────────────────
 * `imagePromptTagKnowledgeData.js` 是从 `data/imagePromptTags.yaml` **生成**的（带 sha256 指纹、
 * 用 `containsExplicitAdultContent` + 未成年词表做过滤、按 20 条 chunk 拆）。那套 policy 是给
 * 「通用标签库」用的；体位是**结构化的、逐条自带中文定格 + 英文模板**，走 YAML 只会被拆散。
 *
 * ── 用户裁定（2026-10-21）：不过滤 ───────────────────────────────────
 * 这 84 条**不过** `containsExplicitAdultContent` / `MINOR_PATTERN` / scene 白名单：
 *   · `scenes` 直接给全场景（`ALL_SCENES`），出图任何入口都能检索到；
 *   · 内容原样保留（定格描写 + 英文模板 + 负向标签），不裁词、不改写。
 * 这属于「本地单人成人向作品库」的既定口径，与上面那套通用标签库的过滤规则**互不影响**。
 *
 * knowledgeId 前缀固定 `pose.pr24.`（PR#24 硬约束），由 `positionLibrary` 统一生成。
 */

import { POSITIONS } from '../services/positionLibrary.js';

/** 与生图知识库其它条目一致：全场景可用（这里显式全开，不做 scene 白名单） */
const ALL_SCENES = ['chat', 'moments', 'events', 'schedule', 'mailbox', 'avatar', 'gift', 'proactive', 'standalone'];

/**
 * 检索面里要剔除的「无区分度词」。
 *
 * 84 条的 `core` 几乎都以 `1girl` / `2girls` / `solo` 开头，还有 `girl on top`、`standing` 这类
 * 通用词，而 `tokenize` 会按**词**匹配英文 query —— 一句普通的
 * `girl standing in a classroom, sunlight through window` 曾命中 **31/50** 条体位
 * （2026-10-21 实测），把日常配图污染成体位图。
 * 剔掉它们不是"过滤体位"，而是去掉"任何女性角色图都会命中"的噪声；
 * 真正的体位词（doggystyle / missionary / 后入 / 跪趴 …）照旧保留。
 *
 * 注意是**按词**剔（`girl on top` → `on top`），不是整条 tag 剔：否则 `girl` 仍会漏进索引。
 */
const NOISE_WORD_RE = /^(?:\d+(?:girl|boy)s?|girls?|boys?|solo|multiple|female|male|hetero|yuri|yaoi|man|woman|men|women)$/i;

function searchableTags(pos) {
  const words = [...pos.core, ...pos.male, ...pos.female]
    .flatMap(t => String(t).toLowerCase().split(/[^a-z0-9_-]+/))
    .filter(w => w && w.length >= 3 && !NOISE_WORD_RE.test(w));
  return [...new Set(words)];
}

/**
 * 一条体位 → 一条知识。
 *
 * content 结构（三段，模型能直接读）：
 *   【定格】中文——这一格画面定在哪一瞬（源文件原话，不删改）
 *   【画面标签】英文模板（`[a / b]` 是变体组，出图时每组随机取一个）
 *   【负向】该体位专属负向标签
 */
function toKnowledge(pos) {
  const lines = [];
  if (pos.frozen) lines.push(`【定格】${pos.frozen}`);
  if (pos.prompt) lines.push(`【画面标签】${pos.prompt}`);
  if (pos.negative.length) lines.push(`【负向】${pos.negative.join(', ')}`);
  if (pos.conflicts) lines.push(`【不可组合】${pos.conflicts}`);
  return {
    knowledgeId: pos.knowledgeId,
    category: 'adult_pose_vocabulary',
    title: `${pos.no} ${pos.name}`,
    searchTerms: [
      pos.name, pos.no, pos.actKey, '体位', '姿势', 'pose', 'position',
      // 中文定格也进检索面：`frozen` 是唯一覆盖「跪 / 趴 / 张腿 / 按住腰」这类中文口语的字段，
      // 否则中文 query 只能靠名字命中（实测「双腿张开跪趴着被按住腰」召回 0 条）。
      // 英文 query 不受影响 —— 英文走 token 全等匹配，中文串不会误命中。
      pos.frozen,
      ...searchableTags(pos),
    ].join(' '),
    scenes: ALL_SCENES,
    content: lines.join('\n'),
    executableTags: [...pos.core],
    isDefault: false,
    // 低于框架层（90~110）：体位是"具体画面"，不该压过互斥/细节预算这些硬规则
    priority: 70,
  };
}

export const POSITION_KNOWLEDGE = Object.freeze(POSITIONS.map(toKnowledge));

/** 独立版本号：改 84 条数据时 +1，旧版本行会被置 is_active=0（不动 ipk.* 那批） */
export const POSITION_KNOWLEDGE_VERSION = 'pose.pr24.20261021.4';
