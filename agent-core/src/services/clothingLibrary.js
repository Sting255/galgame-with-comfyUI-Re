// 纯文本衣服库：词条只包含中英文服装信息，不读取或引入图片。
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../../resources/clothing-library.json', import.meta.url), 'utf8'));
const byTag = new Map(catalog.entries.map(entry => [entry.tag, entry]));
export function getClothingLibrary() { return catalog; }

// 材质与配色词条单独存，跟单品库分开维护（2026-11-07）
const fabricCatalog = JSON.parse(readFileSync(new URL('../../resources/fabric-library.json', import.meta.url), 'utf8'));
export function getFabricLibrary() { return fabricCatalog; }

/** 按种子做确定性洗牌：同一次生成可复现，不同角色抽到的组合不同。 */
/**
 * 按 seed 打乱一份列表（确定性：同一 seed 永远同一结果）。
 *
 * 2026-11-09 修：原实现是
 *   `j = Math.abs(seed * 31 + salt * 17 + i * 7) % (i + 1)`
 * seed 在循环里是**常量**，j 几乎只随 i 变化，Fisher-Yates 退化成近线性模式 ——
 * 实测 400 个 seed 下，材质池前 5 个（正好是 sheer / see through / translucent /
 * mesh / fishnet 这些透视系）被选中 130/124/123/125/106 次（均匀应约 46），
 * 而池子末尾 8 个（knit / sequins / tulle …）**一次都没被选中过**。
 *
 * 这正是用户看到「每个角色的衣服都像同一类」的底层原因：材质永远从那几个里抽。
 *
 * 现在换成 mulberry32：把 seed 与 salt 真正混进每一步，分布均匀、仍然确定可复现。
 */
function shuffleBySeed(list, seed, salt = 0) {
  const array = [...list];
  let a = (Math.round(seed) * 2654435761 + salt * 40503) >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * 抽材质与配色（2026-11-07 用户：材质也得让模型能画出来）。
 *
 * 只抽小批：材质多了模型会把几种质感糊成一片，颜色多了整件衣服变脏。
 * 场景相关：内衣/睡衣不给牛仔、针织这类厚重料，常服不给硬纱。
 */
export function pickFabricAndColors({ seed = 0, materials = 3, colors = 3, candidates = [], sceneKind = '' } = {}) {
  const intimate = sceneKind === 'intimate' || (!sceneKind && candidates.slice(0, 3).some(c => (byTag.get(c.tag)?.categories || []).some(category => ['内衣', '睡衣', '泳装'].includes(category))));
  const materialPool = fabricCatalog.materials.filter(item => {
    if (intimate) return (item.scenes || []).some(scene => ['内衣', '睡衣', '泳装', '礼服'].includes(scene));
    return !/tulle|sequins/i.test(item.tag);
  });
  // 稳定材质优先：部位-材质绑定要 2~3 种料子，先从不飘的那些里取，不够才补 velvet / knit
  // （实测这两种在 Anima 上会被画成亮面漆皮或直接长出一件外衣）。
  const stable = materialPool.filter(item => item.stability !== 'low');
  const shaky = materialPool.filter(item => item.stability === 'low');
  const pickedMaterials = shuffleBySeed(stable, seed, 3).slice(0, materials);
  if (pickedMaterials.length < materials) {
    pickedMaterials.push(...shuffleBySeed(shaky, seed, 3).slice(0, materials - pickedMaterials.length));
  }
  return {
    materials: pickedMaterials,
    colors: shuffleBySeed(fabricCatalog.colors, seed, 11).slice(0, colors),
    parts: fabricCatalog.parts || [],
  };
}

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

const CLOTHING_PROMPT = `你是服装提示词设计师：按角色默认外观与本次标签，写一段可直接生图的静态英文衣着描述。
规则：保留身份、脸、眼睛、发肤、体型和已有标志特征，不补造；丢弃默认外观中旧衣服及姿势、动作、镜头、场景、光线、画质词。所有所选 tag 都是硬约束，逐项体现其含义（dress 是连衣裙，skirt 是半身裙）；同一单品的大类与细类合并，兼容单品可叠穿。用户补充逐项保留，包括明确的穿着、半穿或脱衣状态；只填标签未规定的细节。标签与用户明确补充不能共存时，填 conflict 并说明，不擅自丢弃要求；可叠穿的不算冲突。睡衣适合睡眠并明确写 barefoot，不出现鞋袜。
材质写在实际单品前（a satin dress, a leather belt），用 2~3 种分别表现于衣服已有的不同部位；每处一种并说明可见质感，不得为用材质虚构部件。避免不稳定的 velvet/knit，除非标签或用户明确指定；主色 1 种、辅色最多 1 种，金银色仅点缀，除非用户明确指定。英文小写，用空格不用下划线 tag。

【输出 JSON 格式及约束】
{"appearance":"（无冲突时：至少 30 字符的单段英文；以本角色英文名及作品名开头，原创角色只用其英文名；保留默认身体特征并体现全部所选标签和用户要求；不写示例人物、tag 清单或其他画面内容。有冲突时必须为空字符串。）","conflict":"（无冲突时为空字符串；有冲突时用简短中文指出互斥要求并请用户调整。）"}
严格输出且只输出包含这两个字符串字段的合法 JSON，不加解释或 Markdown。`;

const OUTFIT_FROM_BRIEF_PROMPT = `你是服装设计师：根据角色资料、世界设定和用户要求，为指定服装类型设计具体的一套衣服，并选择对应 tag。

【设计优先级】
- 世界设定的硬约束优先；尽量逐项保留用户明确的款式、穿着状态（包括半穿、移位、脱下及裸露部位）、颜色、材质和细节，只补全未指定之处。与世界设定冲突时，选择最接近且说得通的世界内实现，让用户意图仍然可辨，不要改成无关服装。
- 服装类型（包括自定义类型名）决定衣服类别，不能因职业或候选池换成别的类型。主体选具体形制；人设决定剪裁、配色、材质与细节，不要不同角色都套通用 teddy 或黑蕾丝款。给出可辨认的结构，如鱼骨走线、荷叶边下摆或交叉绑带。
- 优先照抄候选池中适用的真实 tag；不适用的候选可舍弃，缺少时只补真实、简短的 Danbooru 风格 tag。tag 只覆盖用户要求或必要单品，不堆清单。主体之外优先从搭配池选至少两类合适单品（整套 2~5 件），把位置、结构写进描述；与用户要求、世界设定或场合冲突时不要硬塞。
- 默认外观只供身份参考：保留身体特征，不复制旧衣服、姿势、动作、镜头、画质 tag。描述只含服装及穿戴物，不写动作、表情或画面场景。睡衣适合睡眠且必须 barefoot，不含鞋袜。

【材质与描述】
- 如提供了材质池，从中选 2~3 种分配给衣服本来具有的不同部位；材质写在单品前，每个部位只用一种，并描述可见质感。不得为材料虚构衣服部件。一般让 knit 配针织物、denim 配裤/裙、fur 作滚边、tulle 作蓬裙层；除非用户明确要求，否则避免不稳定的 velvet/knit。颜色用 1 个主色、至多 1 个辅色，金银只作小面积装饰，除非用户明确要求。
- 服装描述为一段英文、至少 30 字符，准确体现用户要求与所选形制，英文小写、空格分词；不复制角色卡原服装或 tag 清单。

【输出 JSON 格式及字段约束】
{"design_note":"（一句简体中文：说明角色特点如何影响本次形制选择，不写套话。）","tags":["corset","lace","ribbon"],"appearance":"（至少 30 字符的单段英文衣着描述；首个 tag 是具体主体形制，tags 为 3~6 个小写英文词条、含主体及搭配单品；准确体现用户要求与角色差异，不写身体或画面内容。）"}
严格按示例字段与顺序输出合法 JSON，仅输出 JSON，不附解释或代码块。`;

/**
 * 组「按一句要求生成服装」的消息（2026-11-07）。
 * 候选 tag 由 searchClothingTags 先做本地筛选，模型只在这一小撮里挑，准确率与 token 都更可控。
 */
/**
 * 可自由搭配的单品池（2026-11-07 用户：「有这么多呢，自由组合啊」）。
 *
 * 只给同族形制，角色能选的永远只有那几套内衣本体；库里 1078 条词条中，
 * 袜子 / 鞋 / 配饰 / 头饰 / 手部 / 腰饰 / 外罩各有几十条，组合空间才是真正撑开差异的地方。
 * 按角色 id 做确定性轮换取样：不同角色拿到不同的配饰与鞋袜池，同一条要求也组合不出同一套。
 */
// 贴身类（内衣、睡衣、泳装）只要轻装饰，外套军装这类厚重单品进来只会变成噪音；
// 常服才需要外罩维度。prefer 是「这一类里更贴题的词」，够数就用它，不够再退回整池。
const COMBINATION_DIMENSIONS = {
  intimate: [
    { subcategories: ['袜子种类'], take: 3, prefer: /lace|fishnet|thighhigh|stocking|garter|pantyhose/i },
    { subcategories: ['高跟结构', '凉鞋与开放鞋', '靴子'], take: 2, prefer: /heel|stiletto|lace-up|cross-laced|corset/i },
    { subcategories: ['颈部', '胸饰', '项链'], take: 2, prefer: /choker|collar|ribbon|necklace|pendant|chain|cross/i },
    { subcategories: ['手部', '腰饰', '耳饰'], take: 2, prefer: /glove|bracelet|armband|garter|chain|belt|ring/i },
    { subcategories: ['头饰', '头部'], take: 2, prefer: /hair|ribbon|ornament|flower|pin|veil|headband|horn/i },
  ],
  general: [
    { subcategories: ['袜子种类'], take: 3, prefer: /lace|fishnet|thighhigh|stocking|garter|pantyhose/i },
    { subcategories: ['靴子', '运动鞋', '高跟结构', '凉鞋与开放鞋', '拖鞋与舞鞋'], take: 3 },
    { subcategories: ['颈部', '胸饰', '项链'], take: 3 },
    { subcategories: ['手部', '腰饰', '耳饰', '头饰', '头部'], take: 3 },
    { subcategories: ['大衣 / 披肩外套', '夹克 / 西装外套'], take: 2 },
  ],
};
export function pickCombinationTags({ seed = 0, limit = 15, candidates = [] } = {}) {
  // 候选命中的是内衣 / 睡衣 / 泳装时按贴身类给池子
  const intimate = candidates.slice(0, 3).some(c => (byTag.get(c.tag)?.categories || []).some(category => ['内衣', '睡衣', '泳装'].includes(category)));
  const picked = [];
  const usedTags = new Set();
  let round = 0;
  for (const dimension of (intimate ? COMBINATION_DIMENSIONS.intimate : COMBINATION_DIMENSIONS.general)) {
    const all = catalog.entries.filter(entry => entry.kind === 'outfit'
      && (entry.subcategories || []).some(sub => dimension.subcategories.includes(sub)));
    const preferred = dimension.prefer
      ? all.filter(entry => dimension.prefer.test(`${entry.tag} ${entry.label || ''} ${entry.description || ''}`))
      : [];
    const pool = preferred.length ? preferred : all;
    if (!pool.length) continue;
    // 用 seed 做确定性洗牌：池子只有几条（袜子 8 条、颈部 7 条）时，
    // 取连续切片会让不同角色拿到几乎相同的几条，打散后才有区分度。
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.abs(seed * 31 + round * 17 + i * 7) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (let i = 0; i < Math.min(dimension.take, shuffled.length); i++) {
      const entry = shuffled[i];
      if (usedTags.has(entry.tag)) continue;
      usedTags.add(entry.tag);
      picked.push({ tag: entry.tag, label: entry.label, dimension: dimension.subcategories[0] });
      if (picked.length >= limit) return picked;
    }
    round++;
  }
  return picked;
}

export function buildOutfitFromBriefMessages({ systemRules, worldRule = '', persona, sceneLabel = '', brief, candidates = [], families = [], usedForms = [], combinations = [], fabrics = null }) {
  // 展示给模型一律用空格形式（Anima 官方要求），下划线只留在库里当主键
  const showTag = tag => String(tag).replace(/_/g, ' ');
  const candText = candidates.length
    ? candidates.map(c => `${showTag(c.tag)}（${c.label}）`).join('、')
    : '（本次没有筛选出候选，请自行判断）';
  // 同族形制只给名字和中文，不给描述：它们的作用是「让模型知道还有哪些形制可选」，
  // 不是让它照抄释义。
  const familyText = families.length
    ? `\n【同族形制（同一大类下的其它可选形制，挑一个当主体）】${families.map(f => `${showTag(f.tag)}（${f.label}）`).join('、')}`
    : '';
  const usedText = usedForms.length
    ? `\n【这些形制已经被其它角色穿走，本次不得再用】${usedForms.map(f => `${showTag(f.tag)}（${f.label}）`).join('、')}：从剩下的形制里挑最合适的那一族，不要以「更贴合气质」为由复用。`
    : '';
  // 组合池按维度分组给，模型才知道哪些能叠在一起
  const comboText = combinations.length
    ? `\n【可自由搭配的单品（按角色不同而不同，挑得上就组合进来）】${combinations.map(c => `${c.dimension}：${showTag(c.tag)}（${c.label}）`).join('；')}`
    : '';
  // 材质只给 2 个、配色 3 个：给多了模型会把几种质感糊成一片、颜色调脏
  const fabricText = fabrics && (fabrics.materials?.length || fabrics.colors?.length)
    ? `\n【可用材质】${(fabrics.materials || []).map(m => `${m.tag}（${m.label}：${m.hint}）`).join('；')}`
      + `\n【可用颜色】${(fabrics.colors || []).map(c => `${c.tag}（${c.label}）`).join('、')}`
      + (fabrics.parts?.length ? `\n【可用部位】${fabrics.parts.map(p => `${p.tag}（${p.label}）`).join('、')}` : '')
    : '';
  return [
    { role: 'system', content: systemRules },
    ...(worldRule ? [{ role: 'system', content: worldRule }] : []),
    { role: 'system', content: OUTFIT_FROM_BRIEF_PROMPT },
    { role: 'system', content: `【角色人设与默认外观】\n${persona}` },
    { role: 'system', content: `【服装类型】${sceneLabel || '常服'}\n【候选 tag】${candText}${familyText}${comboText}${fabricText}${usedText}` },
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
    ? result.tags.map(t => String(t || '').trim().replace(/_/g, ' ')).filter(t => /^[a-z0-9() ]+$/i.test(t)).slice(0, 12)
    : [];
  // design_note 是模型「先判断形制再落笔」的那句中文理由（见 OUTFIT_FROM_BRIEF_PROMPT），
  // 不参与出图，只回给前端让用户知道这套为什么这么设计。
  const designNote = String(result?.design_note || '').trim().slice(0, 200);
  return { appearance, tags, designNote };
}

export function buildClothingAppearanceMessages({ systemRules, worldRule = '', persona, scene, sceneLabel = '', entries, brief = '', fabrics = null }) {
  // 自定义类型的 key 是 custom_<时间戳>，模型看不懂；有类型名（如「婚纱」）就用名字喂它
  const sceneText = String(sceneLabel || '').trim() || scene;
  const fabricText = fabrics && (fabrics.materials?.length || fabrics.colors?.length)
    ? `\n\n【可用材质】${(fabrics.materials || []).map(m => `${m.tag}（${m.label}：${m.hint}）`).join('；')}`
      + `\n【可用颜色】${(fabrics.colors || []).map(c => `${c.tag}（${c.label}）`).join('、')}`
      + (fabrics.parts?.length ? `\n【可用部位】${fabrics.parts.map(p => `${p.tag}（${p.label}）`).join('、')}` : '')
    : '';
  return [
    { role: 'system', content: systemRules },
    ...(worldRule ? [{ role: 'system', content: worldRule }] : []),
    { role: 'system', content: CLOTHING_PROMPT },
    { role: 'system', content: `【角色人设与默认外观】\n${persona}` },
    { role: 'system', content: `【本次服装场景】${sceneText}\n【所选服装词条】\n${entries.map(entry => `${entry.tag} — ${entry.label}：${entry.description}`).join('\n')}${fabricText}` },
    { role: 'user', content: `请生成这套外观，严格按示例 JSON 输出。${brief ? `\n补充要求：${brief}` : ''}` },
  ];
}

/** 衣服库的实际人设层只作语义锚点；默认外观及本次候选不认证为稳定前缀。 */
export function buildClothingLorebook(messages) {
  const personaIndex = messages.findIndex(message => message.role === 'system'
    && message.content.startsWith('【角色人设与默认外观】\n'));
  if (personaIndex < 1) throw new Error('衣服库请求缺少可定位的角色资料层');
  const stableIndex = personaIndex - 1;
  return {
    personaTexts: [messages[personaIndex].content],
    staticTexts: messages.slice(0, personaIndex).map(message => message.content),
    cacheBoundary: { index: stableIndex, offset: messages[stableIndex].content.length },
    history: messages.slice(personaIndex + 1),
  };
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
