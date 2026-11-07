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

严格按以下完整 JSON 示例格式输出，不要输出解释、Markdown 围栏或 JSON 以外的文字：
{
  "name": "街角观察报（2至24字，独特中文名称，不照搬已有媒体）",
  "icon": "📰",
  "tagline": "记录街巷里的小事与新鲜见闻（1至60字的一句话定位）",
  "prompt": "你是《街角观察报》的编辑部。\\n【身份与读者】……\\n【语气与署名】……\\n【选题与板块】……\\n【多样性】……\\n【写作规则】……（整体400至2000字，具体可执行，替换省略号为完整规则）",
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

export async function generateMediaOutletDraft({ brief, layout = 'portal' } = {}) {
  if (typeof brief !== 'string' || !brief.trim() || brief.length > 2000) {
    throw Object.assign(new Error('请填写1至2000字的栏目想法'), { statusCode: 400 });
  }
  if (!['portal', 'feed'].includes(layout)) throw Object.assign(new Error('媒体类型无效'), { statusCode: 400 });
  const messages = [{ role: 'system', content: getSystemRulesWithWorld({ roleplay: false }) }];
  if (getWorldSetting()) messages.push({ role: 'system', content: getWorldIntegrationRule('moments') });
  messages.push({ role: 'system', content: MEDIA_OUTLET_DESIGN_PROMPT });
  messages.push({ role: 'user', content: `设计一个${layout === 'portal' ? '数字报刊（portal）' : '社交平台（feed）'}栏目，按示例 JSON 返回草稿。\n我的想法：${brief.trim()}` });
  const raw = await chatSync(messages, {
    temperature: 0.8, response_format: { type: 'json_object' }, label: 'media:栏目生成助手',
  });
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('栏目草稿格式不正确，请重新生成'); }
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

输出 JSON：{"outlets":[{ "name":"…", "icon":"📰", "tagline":"…", "layout":"portal 或 feed", "prompt":"…（400~2000 字，五段式）", "boards":[{"name":"…","desc":"…"}] }]}，outlets 恰好 ${total} 项，不要解释或 Markdown。` });
  const raw = await chatSync(messages, {
    temperature: 0.85, response_format: { type: 'json_object' }, max_tokens: 6000, label: 'media:按世界观规划阵容',
  });
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('规划结果格式不正确，请重新生成'); }
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
- 编辑风格仍按【身份与读者】【语气与署名】【选题与板块】【多样性】【写作规则】五段写，400 至 2000 字。
- 板块给 4 个，各有独立定位，不要与现有板块简单照抄。
- 名称与介绍也要跟着世界观走，不能只是把旧名字换个字。`,
  });
  const raw = await chatSync(messages, {
    temperature: 0.8, response_format: { type: 'json_object' }, label: 'media:按世界观重写',
  });
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('重写结果格式不正确，请重新生成'); }
  return { ...normalizeMediaOutletDraft(parsed), layout };
}
