// 纯文本衣服库：词条只包含中英文服装信息，不读取或引入图片。
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../../resources/clothing-library.json', import.meta.url), 'utf8'));
const byTag = new Map(catalog.entries.map(entry => [entry.tag, entry]));
export function getClothingLibrary() { return catalog; }

/**
 * 按一段自然语言找候选 tag（2026-11-07：用户要「在自定义衣服那边指定穿什么 + 自动找 tag」）。
 *
 * 打分由强到弱：tag / 中文名 / 别名精确命中 > 子串命中 > 字符覆盖率（容忍错别字与语序）。
 * 只返回 kind === 'outfit' 的词条，动作/场景标签对静态外观没意义。
 *
 * @param {string} query 用户输入，如「白色蕾丝连衣裙配黑丝」
 * @param {{limit?: number}} [opts]
 * @returns {Array<{tag: string, label: string, description: string, score: number, matched: string}>}
 */
export function searchClothingTags(query, { limit = 40 } = {}) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return [];
  const terms = raw.split(/[\s,，、;；]+/).filter(Boolean);
  const compact = raw.replace(/[\s,，、;；]/g, '');

  const scored = [];
  for (const entry of catalog.entries) {
    if (entry.kind !== 'outfit') continue;
    const label = String(entry.label || '').toLowerCase();
    const tag = String(entry.tag || '').toLowerCase().replace(/_/g, ' ');
    const aliases = (entry.aliases || []).map(a => String(a).toLowerCase());
    const desc = String(entry.description || '').toLowerCase();
    const hay = `${tag} ${label} ${aliases.join(' ')} ${desc}`;

    let score = 0;
    let matched = '';
    // ① 精确命中（整词等于 tag / 中文名 / 别名）
    if (terms.some(t => t === tag || t === label || aliases.includes(t)) || compact === label || compact === tag) {
      score = 100; matched = label;
    }
    // ② 反向包含：词条的名字/别名出现在用户整句里（「黑丝配高跟鞋」→ 命中 黑丝、高跟鞋）
    //    这是整句输入最有效的匹配方式，正向 includes 反而几乎命中不了。
    else if (label.length >= 2 && compact.includes(label)) {
      score = 90; matched = label;
    } else if (aliases.some(a => a.length >= 2 && compact.includes(a))) {
      score = 88; matched = label;
    }
    // ③ 正向包含：用户分段后，某个词出现在词条里
    else if (compact && (label.includes(compact) || tag.includes(compact))) {
      score = 80; matched = label;
    } else if (terms.some(t => t.length >= 2 && (label.includes(t) || tag.includes(t) || aliases.some(a => a.includes(t))))) {
      score = 60; matched = label;
    }
    // ④ 片段滑窗：中文没有空格，「蕾丝连衣裙」整词撞不上任何词条（库里叫「蕾丝裙」），
    //    但拆成「蕾丝」「连衣裙」就都命中。取最长命中片段定分：2 字 55 / 3 字 65 / 4 字以上 75。
    //    这一段专治复合词，代价是短词条会多些低分命中，靠排序和 limit 兜住。
    if (!score && compact.length >= 4) {
      let best = 0;
      let matchedFrag = '';
      for (let len = Math.min(5, compact.length); len >= 2 && !best; len--) {
        for (let i = 0; i + len <= compact.length; i++) {
          const frag = compact.slice(i, i + len);
          if (label.includes(frag) || frag.includes(label) || aliases.some(a => a.includes(frag) || frag.includes(a))) {
            best = len >= 4 ? 75 : len === 3 ? 65 : 55;
            matchedFrag = frag;
            break;
          }
        }
      }
      if (best) { score = best; matched = matchedFrag || label; }
    }
    // ⑤ 字符覆盖率兜底：容忍错别字（「百色蕾丝裙」也能撞上）
    if (!score && compact.length >= 2) {
      const chars = [...new Set(compact)];
      const hit = chars.filter(c => hay.includes(c)).length;
      const ratio = hit / chars.length;
      if (ratio >= 0.7) { score = Math.round(ratio * 50); matched = label; }
    }
    if (!score) continue;
    // 鞋子/袜子这类配饰在整句里被提到时略加权，避免被大量裙装淹没
    if (/(鞋|袜|靴|高跟鞋|丝袜|拖鞋)/.test(raw) && (entry.categories || []).some(c => ['鞋子', '袜子'].includes(c))) score += 5;
    scored.push({ tag: entry.tag, label: entry.label, description: entry.description, score, matched });
  }
  scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  // 按「命中片段」配额取样：不然「黑色蕾丝连衣裙」会把二十多种连衣裙变体
  // （连帽/乳胶/百褶/罗纹…）排满整个候选，真正要用的「蕾丝裙」被挤到第 83 名。
  // 同一片段最多占 4 个名额；≥70 分是整词真命中，不受配额限制。
  const perBucket = new Map();
  const picked = [];
  for (const item of scored) {
    const key = item.matched || item.tag;
    const used = perBucket.get(key) || 0;
    if (used >= 4 && item.score < 70) continue;
    perBucket.set(key, used + 1);
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * 同族形制扩展（2026-11-07 真机：「情趣内衣」这种类目词，所有角色都只出同一套）。
 *
 * 原因：brief 写的是**类目词**，它只精确撞上 lingere/「情趣内衣」这一条泛称，
 * 模型于是只拿到「lingerie」一个主体，四个角色全是「黑色蕾丝连体衣」。
 * 裤子里明明还有 teddy / babydoll / negligee / chemise / corset / bunny_suit 等十几种形制，
 * 它们的中文名不含「内衣」二字，字面检索永远召回不到。
 *
 * 做法：命中条目所属大类（且该类条目数有限）里的其它词条按形制补进候选，模型才有得挑。
 * 大类太宽的不扩（裙子 226 条、袜子 128 条，一扩就把候选淹了）。
 */
const FAMILY_EXPAND_MAX_CATEGORY_SIZE = 40;
const categorySizes = (() => {
  const sizes = new Map();
  for (const entry of catalog.entries) {
    for (const category of entry.categories || []) sizes.set(category, (sizes.get(category) || 0) + 1);
  }
  return sizes;
})();
export function expandOutfitFamilyCandidates(candidates, { limit = 14 } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const hitTags = new Set(candidates.map(c => c.tag));
  // 只从命中条目的前三个里取大类：后面的多是「内衣」这种字面擦到的泛词，
  // 带上它们会把裙子、套装一起拖进扩展。
  const categories = new Set();
  for (const candidate of candidates.slice(0, 3)) {
    for (const category of byTag.get(candidate.tag)?.categories || []) categories.add(category);
  }
  // 大类太宽的（裙子 226 条、袜子 128 条）不扩，一扩就把候选淹了
  const narrow = [...categories].filter(category => (categorySizes.get(category) || 0) <= FAMILY_EXPAND_MAX_CATEGORY_SIZE);
  if (!narrow.length) return [];
  return catalog.entries
    .filter(entry => entry.kind === 'outfit' && !hitTags.has(entry.tag)
      && (entry.categories || []).some(category => narrow.includes(category)))
    .slice(0, limit)
    .map(entry => ({ tag: entry.tag, label: entry.label, description: entry.description }));
}

/**
 * 「别的角色已经在穿这些形制」（2026-11-07 真机）：
 * 同一句要求逐个角色配，模型每次都会收敛到同一两族（teddy / babydoll），真机上就是「所有角色一套」。
 * 这里从其它角色同类服装的描述里抽出已用的形制，交给提示词明确避开。
 * 形制词表直接取本次候选 + 同族形制，不另建白名单，避免口径分叉。
 */
function containsForm(hay, needle) {
  // 英文按词边界判，避免 slip 命中 slippers、bra 命中 bracelet 这类误判
  if (!/^[a-z0-9 _-]+$/i.test(needle)) return hay.includes(needle);
  return new RegExp(`(^|[^a-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i').test(hay);
}
export function collectUsedOutfitForms(descriptions, { candidates = [], families = [] } = {}) {
  const forms = [...candidates, ...families];
  const used = new Map();
  for (const text of descriptions) {
    const hay = String(text || '').toLowerCase();
    if (!hay) continue;
    for (const form of forms) {
      if (used.has(form.tag)) continue;
      const needles = [String(form.tag).toLowerCase(), String(form.tag).toLowerCase().replace(/_/g, ' '), String(form.label || '').toLowerCase()]
        .filter(needle => needle.length >= 3);
      if (needles.some(needle => containsForm(hay, needle))) used.set(form.tag, { tag: form.tag, label: form.label });
    }
  }
  return [...used.values()].slice(0, 6);
}

export function resolveClothingTags(tags, scene = 'work') {
  // 2026-11-07：私服 / 居家已从枚举移除；角色自定义类型（custom_*）同样允许用衣服库配 tag，
  // 否则新加的「婚纱」「泳装」一点生成就报「服装场景无效」。
  const isCustom = String(scene || '').startsWith('custom_');
  if (!isCustom && !['work', 'sleep'].includes(scene)) throw new Error('服装场景无效');
  if (!Array.isArray(tags) || !tags.length || tags.length > 32 || tags.some(tag => typeof tag !== 'string')) throw new Error('请选择 1–32 个服装 tag');
  return [...new Set(tags)].map(tag => {
    const entry = byTag.get(tag);
    if (!entry) throw new Error(`衣服库中不存在 tag：${tag}`);
    if (entry.kind !== 'outfit') throw new Error(`「${entry.label}」是动作或场景标签，不能用于静态外观`);
    if (scene === 'sleep' && entry.categories.some(category => ['鞋子', '袜子'].includes(category))) throw new Error('睡衣必须赤脚，请移除鞋袜标签');
    return entry;
  });
}

const CLOTHING_PROMPT = `你是角色服装提示词设计师。将后续角色资料与用户选取的服装 tag 编写成完整英文静态外观描述。
【服装规则】
- 角色身份、脸部、瞳色、发型、发色、肤色、体型和标志性身体特征沿用默认外观，不遗漏已有身体特征，不臆造缺失特征。服装按选取的 tag 与其中文含义重新设计。
- 所有选取的 tag 都是硬性要求，逐项体现。识别服装、材质、颜色、长度、装饰和穿法，遵循词条含义，尤其 dress 是连衣裙，skirt 是半身裙。
- 同一单品的大类和细分类合并成一件（shirt + white_shirt 是一件白衬衫）；兼容的衣服可合理叠穿；不要把默认服装中与新要求冲突的旧单品、旧颜色混进来。
- 如果标签彼此无法同时满足（同一件衣服相反颜色、互斥长度或款式），返回 conflict 说明冲突，不擅自丢弃任何标签。可以合理叠穿的单品不视为冲突。
- 用户补充只补全标签没规定的细节，不能覆盖已选标签。不要写动作、表情、姿势、场景、光线、画质、镜头或示例图人物身份。
- 睡衣必须适合睡眠，赤脚，明确写 barefoot，不写鞋袜或旁边摆放的鞋袜；其他场景按场合搭配。
【输出 JSON 示例与字段约束】
{"appearance":"Yoimiya (Genshin Impact) has blonde hair in a high ponytail and amber eyes, wearing a white collared shirt and a pleated skirt.（此处填至少 30 字符的一整段英文；以本次角色英文名及作品名开头，原创角色只写英文名；完整保留默认身体特征并准确描述每个所选 tag，不能照搬示例人物；不附加标签列表、解释或 Markdown。存在冲突时此字段为空字符串。）","conflict":"（无冲突时为空字符串；有无法兼容的标签时用简短中文说明具体冲突，并请用户调整选择，appearance 留空。）"}
严格按示例的两个字段输出合法 JSON，不输出任何 JSON 以外的文字。`;

const OUTFIT_FROM_BRIEF_PROMPT = `你是角色服装设计助手。用户会用一句中文说他想要这套衣服是什么样，你要先挑出对应的服装 tag，再写成完整的英文外观描述。

【世界观优先（最高）】
- 这套衣服必须属于<world_setting>描述的着装体系。先看那个世界的人穿什么（制服、校服、礼服、随身装备、束缚具…），再决定挑什么 tag。
- 后面的「候选 tag」**只是一份词汇表**，不是必选项：符合世界观的照抄，不符合的**不要用**。宁可少挑几个、全靠描述写，也不要塞一个现代便装 tag 进去。
- 用户要求与世界观冲突时，把用户的意图落到世界观允许的形制上（比如用户说「泳装」，而那个世界只有「浸礼用薄纱罩袍」，就做后者）；实在落不下，以世界观为准。
- 候选全是现代便装（西装、卫衣、牛仔裤之类）而世界观里根本不存在这些东西时，直接放弃候选，自己按世界观造词。

【挑 tag 的规则】
- 优先从后面给出的「候选 tag」里挑，它们都是本库真实存在的词条，直接照抄 tag 字段的英文名。
- 候选里确实没有的再自己补，但必须是 Danbooru 风格、真实存在的服装 tag（小写、下划线分词，如 black_thighhighs）。
- 只挑用户提到或明显必需的：衣服本体优先，其次鞋袜、配饰；不要为了凑数堆砌。
- 用户说的是颜色/材质/长度时，用颜色类 tag 或直接写进描述，不要硬塞一个不相关的 tag。

【形制优先：类目词只是方向，不是成品】
- 用户给的常常是**类目词**（情趣内衣、泳装、礼服、睡衣、制服…）。类目词只规定方向，不规定形制：主体必须落到一个**具体形制**上，而不是把类目泛称当成品。
- 同一个类目下面的形制差异很大，例如内衣可以是：连体式（teddy / bodysuit / bunny_suit）、短摆裙式（babydoll / see-through_babydoll）、睡袍裹身式（negligee / chemise）、束身式（corset / underbust_corset / waist_cincher）、两件式（bralette + thong / panties）、吊带长裙式（slip）。「同族形制」里给出的都可以当主体用。
- 泛称类目 tag（lingerie、dress、skirt、swimsuit 这类）只在用户明确只要它、且库里没有更具体的形制可用时才作为主体。
- **形制由角色决定，不由 brief 决定**：按她的身材、气质和世界观着装规范挑。丰满的用束身/连体显曲线，纤细娇小的用短摆或两件式，高挑的用吊带长裙或裹身袍；清冷气质配素色薄纱，活泼配浅色褶边，明艳配深色缎面与绑带。同一句要求给不同角色，应当落到**不同形制**上，单品组合和颜色也不要照抄最通用的那套。
- 连体式 teddy 是最省事的默认答案，也是最容易让所有角色长成一套的答案：只有当她的身材气质和世界观都更适合连体式时才用它，否则换族。落笔前按顺序过一遍：①世界观着装规范允许什么（细肩带、前扣、绑带、束缚具这些硬规则先满足）；②她的身材适合哪一族；③她的气质配什么材质与配色。
- 描述里要给出**只有这套才有的具体结构**（束身衣的鱼骨走线、短摆的荷叶边下摆、背部交叉绑带、胯侧系带结），不要用 deep plunging neckline、thin adjustable shoulder straps、high-cut leg opening 这种套在任何一套上都成立的通用句。
- 反例（不要这样写）：wearing a black lace lingerie set with thin straps —— 这就是「任何角色都一样的黑蕾丝连体衣」，没有形制判断。

【写描述的规则】
- 一整段英文，逗号分隔的短语或流畅句子都可以，最终会直接喂给生图模型。
- 角色身份、脸部、瞳色、发型、发色、肤色、体型和标志性身体特征沿用默认外观，不遗漏已有身体特征，不臆造缺失特征。
- 默认外观里那串原始 tag 只用来认人：**原服装、姿势、动作、镜头、画质词全部丢掉**。出现 standing / holding … / looking at viewer / pose / official art / masterpiece / best quality / highres / transparent background 这类词就是照抄，必须重写。
- 用户的要求是硬性要求，逐项体现；没提到的细节由你按角色人设与世界观合理补全。
- 不要写动作、表情、姿势、场景、光线、画质、镜头，也不要用中文。
- 睡衣必须适合睡眠且赤脚（barefoot），不写任何鞋袜。

【输出格式（严格照此 JSON，不要任何解释或代码块）】
{"design_note":"一句话中文，写清她的身材气质与本类目最典型形象差在哪、据此选了这个形制；不能写成套话","tags":["teddy","black_lace"],"appearance":"一整段英文外观描述，至少 30 个字符，tags 第一个必须是本次采用的具体形制（如 teddy / babydoll / corset），不要只给 lingerie 这类泛称"}
先写 design_note 再写 appearance，形制与配色以 design_note 的判断为准，不要让 appearance 回落到最通用的那套。`;

/**
 * 组「按一句要求生成服装」的消息（2026-11-07）。
 * 候选 tag 由 searchClothingTags 先做本地筛选，模型只在这一小撮里挑，准确率与 token 都更可控。
 */
export function buildOutfitFromBriefMessages({ systemRules, worldRule = '', persona, sceneLabel = '', brief, candidates = [], families = [], usedForms = [] }) {
  const candText = candidates.length
    ? candidates.map(c => `${c.tag}（${c.label}）`).join('、')
    : '（本次没有筛选出候选，请自行判断）';
  // 同族形制只给名字和中文，不给描述：它们的作用是「让模型知道还有哪些形制可选」，
  // 不是让它照抄释义。
  const familyText = families.length
    ? `\n【同族形制（同一大类下的其它可选形制，挑一个当主体）】${families.map(f => `${f.tag}（${f.label}）`).join('、')}`
    : '';
  const usedText = usedForms.length
    ? `\n【这些形制已经被其它角色穿走，本次不得再用】${usedForms.map(f => `${f.tag}（${f.label}）`).join('、')}：从剩下的形制里挑最合适的那一族，不要以「更贴合气质」为由复用。`
    : '';
  return [
    { role: 'system', content: systemRules },
    ...(worldRule ? [{ role: 'system', content: worldRule }] : []),
    { role: 'system', content: OUTFIT_FROM_BRIEF_PROMPT },
    { role: 'system', content: `【角色人设与默认外观】\n${persona}` },
    { role: 'system', content: `【服装类型】${sceneLabel || '常服'}\n【候选 tag】${candText}${familyText}${usedText}` },
    { role: 'user', content: `我想要这套衣服：${brief}\n请挑 tag 并输出英文外观描述，严格按示例 JSON。` },
  ];
}

export function parseOutfitFromBrief(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('生成结果不是有效 JSON，请重试'); }
  const appearance = String(result?.appearance || '').trim().replace(/\s+/g, ' ');
  if (appearance.length < 30) throw new Error('生成的描述太短，请重试');
  if (/\p{Script=Han}/u.test(appearance)) throw new Error('描述必须是英文，请重试');
  const tags = Array.isArray(result?.tags)
    ? result.tags.map(t => String(t || '').trim()).filter(t => /^[a-z0-9_()]+$/i.test(t)).slice(0, 12)
    : [];
  // design_note 是模型「先判断形制再落笔」的那句中文理由（见 OUTFIT_FROM_BRIEF_PROMPT），
  // 不参与出图，只回给前端让用户知道这套为什么这么设计。
  const designNote = String(result?.design_note || '').trim().slice(0, 200);
  return { appearance, tags, designNote };
}

export function buildClothingAppearanceMessages({ systemRules, worldRule = '', persona, scene, sceneLabel = '', entries, brief = '' }) {
  // 自定义类型的 key 是 custom_<时间戳>，模型看不懂；有类型名（如「婚纱」）就用名字喂它
  const sceneText = String(sceneLabel || '').trim() || scene;
  return [
    { role: 'system', content: systemRules },
    ...(worldRule ? [{ role: 'system', content: worldRule }] : []),
    { role: 'system', content: CLOTHING_PROMPT },
    { role: 'system', content: `【角色人设与默认外观】\n${persona}` },
    { role: 'system', content: `【本次服装场景】${sceneText}\n【所选服装词条】\n${entries.map(entry => `${entry.tag} — ${entry.label}：${entry.description}`).join('\n')}` },
    { role: 'user', content: `请生成这套外观，严格按示例 JSON 输出。${brief ? `\n补充要求：${brief}` : ''}` },
  ];
}

export function parseClothingAppearance(raw, entries, scene = 'work') {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('服装生成结果不是有效 JSON，请重试'); }
  if (typeof result?.appearance !== 'string' || typeof result?.conflict !== 'string') throw new Error('服装生成结果字段不完整，请重试');
  if (result.conflict.trim()) throw new Error(result.conflict.trim());
  const appearance = result.appearance.trim().replace(/\s+/g, ' ');
  if (appearance.length < 30) throw new Error('服装生成结果太短，请重试');
  if (/\p{Script=Han}/u.test(appearance) || /```/.test(appearance)) throw new Error('服装生成结果必须是一段英文外观描述，请重试');
  if (scene === 'sleep' && (!/\bbarefoot\b/i.test(appearance) || /\b(?:shoes?|boots?|slippers?|heels?|socks?|stockings?|footwear|legwear|pantyhose|thighhighs)\b/i.test(appearance))) throw new Error('生成的睡衣不符合赤脚规则，请重新生成');
  // 精确保留库中的 tag，不依赖模型翻译/重写标签；与正文一起进入现有外观保存及生图链路。
  return `${appearance}\nOutfit tags: ${entries.map(entry => entry.tag).join(', ')}.`;
}
