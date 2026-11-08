import { getSystemRulesWithWorld, getWorldSetting } from '../db/worldRepository.js';
import { getWorldIntegrationRule } from '../builtinRules.js';
import { chatSync } from './lorebook/runtime.js';

// 从 seedMedia 的刊社人格 / 核心规则 / 多样性 / 写作要求提炼；固定前缀不含本次需求。
export const MEDIA_OUTLET_DESIGN_PROMPT = `你是一位媒体栏目策划师。根据用户想法，设计一家可以持续产出内容的媒体，生成供设置表单使用的草稿，不生成某一期文章。
参考现有媒体的设计方法，而非照抄它们的名字和世界专属名词：
- 访谈周刊：有鲜明编辑部人格、自称与口头禅；抓人的标题；不同嘉宾互动的问答、榜单、读者跟帖；明确署名规则。
- 八卦小报：用反差与抓拍选题、短促旁白和辨识度强的标题；每期有新话题，不能只换人物重复同一件事。
- 社交论坛：不同身份、职业、阶层的用户独立发帖；求助、经验、吐槽、讨论等动机多样，评论有不同观点。

编辑风格 prompt 必须是可直接复用的中文指令，包含【身份与读者】【语气与署名】【选题与板块】【多样性】【写作规则】。
要具体说明谁在发声、对谁说话、关注什么、怎么起标题、如何组织正文与互动。结合当前世界观；未提供世界观时不要擅自套用现有媒体的专有名词。
所有板块须有独立定位，prompt 中说明各板块的内容职责。避免重复旧内容、同批选题雷同、模板化开头、全围着主角转；只谈当前已知信息，不预告未来事件。
用户指定数字报刊（portal）时：适配每期恰好四个栏目，先产标题/导语/配图描述，按需展开栏目正文；不要强制单张海报、固定排版或一次输出整期长文。
用户指定社交平台（feed）时：模拟不同用户发布独立帖子及评论，板块用于分类。
prompt 只写长期有效的编辑规则，不含今天日期、期号、某一期具体事件、JSON/XML 输出协议；实际内容输出格式由系统另行注入。

【长度与安全（2026-11-08 真机）】
- prompt 整体控制在 400~900 字。**不要写具体情节示例、不要复述世界观原文里的露骨段落。**
- 需要举例时用中性说法（例如「涉及着装检查的场景」「涉及道具使用的场景」），不要展开细节描写。
- 你的输出会被服务商做内容审核：写长段露骨示例会导致整段输出被掐断，草稿直接作废。规则写得清楚比举例写得多更重要。

严格按以下完整 JSON 示例格式输出，不要输出解释、Markdown 围栏或 JSON 以外的文字：
{
  "name": "街角观察报（2至24字，独特中文名称，不照搬已有媒体）",
  "icon": "📰",
  "tagline": "记录街巷里的小事与新鲜见闻（1至60字的一句话定位）",
  "prompt": "你是《街角观察报》的编辑部。\\n【身份与读者】……\\n【语气与署名】……\\n【选题与板块】……\\n【多样性】……\\n【写作规则】……（整体 400~900 字，只写可执行的规则，不写情节示例，不展开露骨细节）",
  "boards": [
    { "name": "街头新鲜事", "desc": "记录普通居民的新鲜日常（名称1至16字；定位1至60字）" },
    { "name": "人物访谈", "desc": "采访不同职业的人，呈现独立视角（与其他板块不重复）" },
    { "name": "生活榜单", "desc": "比较本地生活体验，提供有依据的榜单（具体说明题材）" },
    { "name": "读者来信", "desc": "呈现求助与不同意见的交流（具体说明互动方式）" }
  ]
}
icon 为一个适合主题的 emoji，最多8字符；boards 必须恰好4项，名称各不相同；每个示例值里的括号说明是约束，不要原样输出。`;

export function normalizeMediaOutletDraft(raw) {
  const text = (value, max, field) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      throw new Error(`栏目草稿的${field}缺失或过长，请重新生成`);
    }
    return value.trim();
  };
  const draft = {
    name: text(raw?.name, 24, '名称'), icon: text(raw?.icon, 8, '图标'),
    tagline: text(raw?.tagline, 60, '介绍'), prompt: text(raw?.prompt, 8000, '编辑风格'),
  };
  // 2026-11-08 真机：原来硬要求「恰好 4 个板块」，规划 6 家时模型有一家写成 3 个，
  // 整批被判失败（用户看到的是「规划失败」而没有任何产出）。改成 1~12 个都收，
  // 只剔除明显不合格的单条；板块数由用户在界面上自己增删。
  if (!Array.isArray(raw?.boards) || raw.boards.length < 1 || raw.boards.length > 12) {
    throw new Error('栏目草稿的板块缺失或过多，请重新生成');
  }
  draft.boards = raw.boards
    .map(b => {
      try {
        return { name: text(b?.name, 16, '板块名称'), desc: typeof b?.desc === 'string' ? b.desc.trim().slice(0, 60) : '' };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!draft.boards.length) throw new Error('栏目草稿没有可用的板块，请重新生成');
  // 同名板块留第一个（规划时模型偶尔会重复）
  const seen = new Set();
  draft.boards = draft.boards.filter(b => (seen.has(b.name) ? false : seen.add(b.name)));
  return draft;
}

/** 服务商在输出被审核时的回填收尾语（不是模型正文，不能当成内容） */
const REFUSAL_TAIL_RE = /(sorry,?\s*i can'?t|i cannot (help|assist|respond|comply)|i can'?t (help|assist|respond|comply)|unable to (help|assist|comply)|作为(一个)?(人工智能|AI)|无法(协助|回答|提供)|我不能(协助|回答|提供))/i;

/**
 * 从半截文本里抢救「已经完整」的 JSON 对象（2026-11-08）。
 *
 * 用途：规划一批媒体时输出很长，尾部被截断会让整批作废。这里按花括号配平把完整的对象
 * 逐个抠出来，能救回几家就先给用户几家，剩下的它会再点一次重试。
 * 只处理顶层 `{...}`（数组元素就是顶层对象），坏对象直接跳过。
 */
export function salvageJsonObjects(text) {
  const src = String(text || '');
  const out = [];
  const stack = [];
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { stack.push(i); continue; }
    if (ch === '}') {
      const start = stack.pop();
      if (start == null) continue;
      // 任意深度都试一次：外层对象完整时会连它一起收下，由调用方按字段过滤掉
      try {
        const obj = JSON.parse(src.slice(start, i + 1));
        if (obj && typeof obj === 'object') out.push(obj);
      } catch { /* 这个对象不完整，继续往外找 */ }
    }
  }
  return out;
}

/**
 * 媒体草稿的统一请求入口（2026-11-08 真机事故后重做）。
 *
 * 事故现场：按世界观重写一家媒体，模型把 `prompt` 字段写到一半被服务商输出审核掐断，
 * 末尾回填「Sorry, I can't respond to this question.」，整段不是合法 JSON，
 * 用户看到的是笼统的「重写结果格式不正确，请重新生成」——既没说原因，也没有重试。
 *
 * 现在：一次调用 + 一次自动重试，并把三种失败区分开（审核拦截 / 长度截断 / 单纯写坏），
 * 抛出的错误带上可操作建议；两次都失败时把原始文本挂在 `err.rawContent` 上，
 * 调用方可以抢救已完整的部分（planMediaLineup 就是这么做的）。
 */
async function requestMediaDraft({ messages, label, temperature = 0.8, maxTokens = 3000, retryHint = '' }) {
  const call = (extra = []) => chatSync(extra.length ? [...messages, ...extra] : messages, {
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    returnMeta: true,
    label,
  });
  const attempt = (meta) => {
    const content = String(meta?.content || '');
    const finish = String(meta?.finishReason || '');
    try { return { ok: true, data: JSON.parse(content) }; }
    catch {
      return {
        ok: false,
        content,
        finish,
        refused: finish === 'content_filter' || REFUSAL_TAIL_RE.test(content),
        truncated: finish === 'length',
      };
    }
  };

  const first = attempt(await call());
  if (first.ok) return first.data;

  console.warn(`[media] 草稿首次生成失败（label=${label}, finish=${first.finish || 'unknown'}`
    + `${first.refused ? ', 疑似内容审核' : ''}${first.truncated ? ', 被截断' : ''}），自动重试一次`);
  const second = attempt(await call([{
    role: 'user',
    content: `上一次输出没有形成合法 JSON（${first.refused ? '被内容审核中断' : first.truncated ? '被长度上限截断' : '格式不完整'}）。
这一次只输出一个合法 JSON 对象，不要解释、不要代码围栏；prompt 字段只写可执行的编辑规则，控制在 400~700 字，
**不要写任何情节示例，不要复述世界观原文里的露骨描写**。${retryHint}`,
  }]));
  if (second.ok) return second.data;

  if (second.refused || first.refused) {
    throw Object.assign(
      new Error('模型输出被服务商内容审核中断了（世界观里的极端描写容易触发）。可以把世界观里最露骨的那几段改短、或换成暗示性说法，再点重试。'),
      { statusCode: 422, rawContent: second.content || first.content },
    );
  }
  if (second.truncated || first.truncated) {
    throw Object.assign(
      new Error('模型输出被长度上限截断了。请重试；连续出现的话，把世界观里过长的段落压缩一下。'),
      { statusCode: 422, rawContent: second.content || first.content },
    );
  }
  throw Object.assign(
    new Error('模型返回的不是合法 JSON，已自动重试一次仍未成功，请再点一次重试'),
    { statusCode: 502, rawContent: second.content || first.content },
  );
}

export async function generateMediaOutletDraft({ brief, layout = 'portal' } = {}) {
  if (typeof brief !== 'string' || !brief.trim() || brief.length > 2000) {
    throw Object.assign(new Error('请填写1至2000字的栏目想法'), { statusCode: 400 });
  }
  if (!['portal', 'feed'].includes(layout)) throw Object.assign(new Error('媒体类型无效'), { statusCode: 400 });
  const messages = [{ role: 'system', content: getSystemRulesWithWorld({ roleplay: false }) }];
  if (getWorldSetting()) messages.push({ role: 'system', content: getWorldIntegrationRule('moments') });
  messages.push({ role: 'system', content: MEDIA_OUTLET_DESIGN_PROMPT });
  messages.push({ role: 'user', content: `设计一个${layout === 'portal' ? '数字报刊（portal）' : '社交平台（feed）'}栏目，按示例 JSON 返回草稿。\n我的想法：${brief.trim()}` });
  const parsed = await requestMediaDraft({
    messages,
    label: 'media:栏目生成助手',
    temperature: 0.8,
    maxTokens: 3000,
    retryHint: '内容源的功能定位保持不变，只把世界细节换成当前世界观里成立的东西。',
  });
  return { ...normalizeMediaOutletDraft(parsed), layout };
}

/**
 * 按当前世界观**规划一整批媒体**（2026-11-08 用户：自动按照世界观规划新媒体，还可以替换旧媒体）。
 *
 * 与 redesignMediaOutlet 的区别：那个是「保留这家的定位、把世界细节换掉」；
 * 这个是「重新排一套阵容」——媒体数量、定位、板块都可以变，并避开已有媒体的重复定位。
 * 只返回草稿，不落库：用户在界面上勾选、看过、点应用才创建。
 */
export async function planMediaLineup({ count = 4, existing = [] } = {}) {
  // 上限压到 5：模型一次写 6~8 家时输出太长，尾部容易被截断，整批反而失败
  const total = Math.min(Math.max(Number(count) || 4, 1), 5);
  const existingText = (Array.isArray(existing) ? existing : [])
    .filter(item => item?.name)
    .map(item => `- ${item.name}${item.tagline ? `：${item.tagline}` : ''}`)
    .join('\n') || '（目前没有任何媒体）';
  const messages = [{ role: 'system', content: getSystemRulesWithWorld({ roleplay: false }) }];
  if (getWorldSetting()) messages.push({ role: 'system', content: getWorldIntegrationRule('moments') });
  messages.push({ role: 'system', content: MEDIA_OUTLET_DESIGN_PROMPT });
  messages.push({ role: 'user', content: `按当前世界观规划 ${total} 家媒体，作为一个完整的内容阵容：报刊、小报、论坛、电台、社区公告等类型自行搭配，彼此定位不能重复，也不要照抄现有媒体。

【现有媒体（命名与定位都要避开）】
${existingText}

【硬要求】
- 每家都要落到这个世界里真实存在的信息渠道（谁办的、写给谁看、用什么路子拿消息）。
- 至少包含一家严肃信息源与一家八卦/闲谈源，其余自行判断。
- 板块各 3~4 个，彼此不重复。
- 名称、介绍、编辑风格里都不许出现现实世界的地名、机构、网络梗。

输出 JSON：{"outlets":[{ "name":"…", "icon":"📰", "tagline":"…", "layout":"portal 或 feed", "prompt":"…（400~900 字，五段式，只写规则不写情节示例）", "boards":[{"name":"…","desc":"…"}] }]}，outlets 恰好 ${total} 项，不要解释或 Markdown。` });
  let parsed;
  try {
    parsed = await requestMediaDraft({
      messages,
      label: 'media:按世界观规划阵容',
      temperature: 0.85,
      maxTokens: 6000,
      retryHint: '每家媒体的功能定位都不同，不要照抄现有媒体。',
    });
  } catch (err) {
    // 一次输出 5 家时尾部容易被截断：从失败的原始文本里抢救已经完整的家数，
    // 能救回几家就先给用户几家（用户看到的是可选项，不是一条「规划失败」）。
    const salvaged = salvageJsonObjects(err?.rawContent || '')
      .filter(item => item && typeof item === 'object' && item.name && item.prompt);
    if (!salvaged.length) throw err;
    console.warn(`[media] 规划输出不完整，从截断文本里救回 ${salvaged.length} 家`);
    parsed = { outlets: salvaged };
  }
  const list = Array.isArray(parsed?.outlets) ? parsed.outlets : [];
  if (!list.length) throw new Error('规划结果为空，请重新生成');
  const normalized = [];
  for (const item of list.slice(0, total)) {
    try {
      const draft = normalizeMediaOutletDraft(item);
      normalized.push({ ...draft, layout: item?.layout === 'feed' ? 'feed' : 'portal' });
    } catch { /* 单家不合格就跳过，不整体失败 */ }
  }
  if (!normalized.length) throw new Error('规划结果都不完整，请重新生成');
  return { outlets: normalized };
}

/**
 * 按当前世界观重写一家已有媒体（2026-11-07 用户：「媒体完全独立在世界观外面，要一键修改」）。
 *
 * 为什么需要：老媒体是在别的世界观下标定的，编辑风格里写着自己的专有名词（周刊登场人物、
 * 固定地名、上个世界的梗）。生成内容时虽然会把世界设定塞进 system，模型仍会跟着编辑风格走，
 * 于是这家媒体怎么换世界观都还是老样子。
 *
 * 只返回草稿，不落库：用户在表单里看过、改过、点保存才生效。
 */
export async function redesignMediaOutlet({ outlet, boards = [], layout = 'portal' } = {}) {
  if (!outlet || typeof outlet !== 'object') throw Object.assign(new Error('媒体不存在'), { statusCode: 404 });
  const type = layout === 'feed' ? '社交平台（feed）' : '数字报刊（portal）';
  const boardText = (Array.isArray(boards) ? boards : [])
    .filter(board => board?.name)
    .map(board => `- ${board.name}${board.desc ? `：${board.desc}` : ''}`)
    .join('\n') || '（暂无板块）';
  const messages = [{ role: 'system', content: getSystemRulesWithWorld({ roleplay: false }) }];
  if (getWorldSetting()) messages.push({ role: 'system', content: getWorldIntegrationRule('moments') });
  messages.push({ role: 'system', content: MEDIA_OUTLET_DESIGN_PROMPT });
  messages.push({
    role: 'user',
    content: `按当前世界观重写这家${type}栏目，输出完整的新草稿（不要保留与世界设定冲突的专有名词、时代感、旧题材）。

【现有设定】
名称：${outlet.name || '（无）'}
介绍：${outlet.tagline || '（无）'}
编辑风格：
${String(outlet.prompt || '（无）').slice(0, 4000)}

现有板块：
${boardText}

【重写要求】
- 保留它作为一个内容源的功能定位（例如访谈周刊、八卦小报、社区论坛），但人物、地名、机构、时代细节全部换成当前世界观里成立的东西。
- 编辑风格仍按【身份与读者】【语气与署名】【选题与板块】【多样性】【写作规则】五段写，400 至 900 字。
  只写可执行的规则，**不要写情节示例、不要复述世界观原文里的露骨段落**；需要举例时用中性说法。
- 板块给 4 个，各有独立定位，不要与现有板块简单照抄。
- 名称与介绍也要跟着世界观走，不能只是把旧名字换个字。`,
  });
  const parsed = await requestMediaDraft({
    messages,
    label: 'media:按世界观重写',
    temperature: 0.8,
    maxTokens: 3000,
    retryHint: '保留这家媒体的功能定位与栏目结构，只把人物、地名、机构、时代细节换成本世界观里成立的。',
  });
  return { ...normalizeMediaOutletDraft(parsed), layout };
}
