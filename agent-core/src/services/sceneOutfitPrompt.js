/**
 * sceneOutfitPrompt.js — 场景换装的提示词构建与输出解析。
 *
 * 2026-10-13 移植 PR #24 的两步升级：
 *   ① 五态（nude/常服/私服/居家/睡衣）+ 身体与服装分层
 *      —— 每套输出 `body`（五套完全一致）+ `description`（只写这套的衣服）；
 *   ② 反推锚点（seeds）—— 「按已填分项反推未填」，替代固定「按工装推其余三套」。
 *
 * 上游 v3.9.0 的 4 态实现只要求「名字 has 身体, wearing 衣服」的**整段**格式；
 * 本文件在它基础上把这两半**分开输出**，并把 nude 那一套固定成裸体声明。
 */

/** 可设计的场景（不含 work —— 常服是角色的招牌/默认形象，不许重新生成） */
export const GENERATED_OUTFIT_SCENES = ['nude', 'work', 'casual', 'home', 'sleep'];

const NUDE_DECLARATION = 'completely nude, wearing no clothing at all, bare skin visible';

const DESIGN_RULES = `你是角色外观设计助手。你为角色设计**自包含的外观描述**：一套 = 身体 + 服装。

【身体与服装分开输出】
每个 scene 都要输出两个字段：
- \`body\`：这个角色的**身体特征**（全身）：发色、发型、瞳色、肤色、体型/身高等。
  **同一角色的所有 scene，body 必须完全一致**（是同一个人）。
- \`description\`：**只写这一套的服装**（衣服、鞋袜、配饰），不要重复身体特征。

【输出语言】
一律用**英文生图提示词风格**（逗号分隔的短语），因为这两个字段最终会直接喂给生图模型。
不要中文、不要完整句子、不要「她穿着一件」这类叙述。

【五套场景定义（scene 字段照抄英文 key；本次具体要哪几套以用户消息为准，别多给）】
- nude（裸体）：**不穿任何衣物**的私密状态（洗浴、在自己家里/酒店客房这类私密空间里的性场景）。
  这一套的 \`description\` 固定写 \`${NUDE_DECLARATION}\`；
  \`body\` 要写得比平时**更完整**（既然是裸体，身体就是画面主体）：
  除发型瞳色外，补上肤色、体型、胸/腰/腿的形态、以及显著身体特征（痣、伤痕、纹身、兽耳兽尾等）。
- work（常服）：这个角色在**其职业/身份场合**日常穿的那身。制式职业（警察、护士、学生等）
  就是对应制服；自由职业者则是工作时常穿的那身。
- casual（私服）：休息日上街、见朋友、逛街时穿的便装。
- home（居家）：在家里做家务、放松、看书时穿的宽松舒适衣物。
  **脚下穿室内拖鞋（slippers）或赤脚**：description 里要交代 slippers / barefoot 之一，
  不要写皮鞋、靴子、运动鞋这类能穿出门的鞋（生图模型会照着画）。
- sleep（睡衣）：**睡觉时穿的睡衣或内衣**（睡裙 / 睡衣睡裤 / 吊带内衣 + 短裤 / 内裤等），
  不要设计成能穿出门的服装。
  **★ 必须赤脚**：description 里必须明确写出 barefoot。
  **画面里不要出现任何鞋类** —— shoes / boots / slippers / heels / sandals / socks / stockings /
  pantyhose / tights 一律不写，**连「床边摆着一双没穿的拖鞋」这种也不要写**
  （生图模型看到 slippers 就会把它画出来）。只交代脚本身是裸的。

【要求】
1. 各套服装必须**彼此区分明显** —— 一眼能看出是上班、出门、在家还是睡觉。
2. 必须**贴合这个角色的人设与世界观**：颜色、风格、职业特征要呼应 ta 的身份。
3. 只输出 JSON，不要解释、不要 Markdown 代码块。

## 输出格式
{"outfits":[{"scene":"nude","name":"裸体","body":"...","description":"${NUDE_DECLARATION}"},{"scene":"work","name":"...","body":"...","description":"..."}]}`;

/**
 * 反推层：把「已填好的分项」交给模型，让它**据此反推未填的分项**。
 *
 * ── 设计意图（2026-10-13 移植 PR #24，替代原先固定「按工装推其余三套」）──
 * 用户可能只填了一两项（比如手工填了常服、或从一张图反推了裸体），
 * 其余项不该从人设凭空重画 —— 那会让「同一个人」的身体漂移。
 * 正确做法：**以已填项为锚**，身体取自锚点、只补该套的服装。
 *
 * 锚点优先级 bodySource：**nude → work/casual → 角色卡外观段**。
 * 优先 nude 是因为它"只有身体、没有衣服"，是身体描述最纯的来源。
 */
function buildDeriveLayer(seeds, bodySource, scenes) {
  const labels = scenes.map(s => SCENE_LABELS[s] || s).join('、');
  const seedText = seeds.map(s => {
    const scene = s.scene ? `【${SCENE_LABELS[s.scene] || s.scene}】` : '';
    return `${scene}${s.name ? ` ${s.name}` : ''}\n  body: ${s.body || '（无）'}\n  description: ${s.description || '（无）'}`;
  }).join('\n');

  const sleepNote = scenes.includes('sleep')
    ? '\n5. **睡衣那一套要赤脚**：不要写任何鞋袜（shoes / slippers / socks 等），只交代 barefoot。'
    : '';

  return `【已确定的基准（最高优先级，必须原样沿用）】
以下是这个角色**已经确定好**的外观，请把它们当作事实基准：

${seedText}

${bodySource ? `【身体描述的唯一真源 —— 逐字照抄，一个字都不要改】
${bodySource}

` : ''}本次要补的（${labels}）和上面是**同一个人**。因此：
1. **body 字段必须逐字照抄上面的「身体真源」**（含 nude 那一套在内，五套身体必须完全一致）——
   发色、发型、瞳色、肤色、体型、身高等一个字都不要改写、不要重新描述。
2. **只设计 description**（这一套的服装），不要动身体。
3. 服装要与已确定那套处在**同一套审美体系**里（相近的配色偏好、材质与气质），
   看得出是同一个人换了衣服，而不是换了一个人。
4. 不要把已确定的那套衣服原样再写一遍 —— 新补的几套必须和它明显不同。${sleepNote}`;
}

/** 场景 key → 中文标签（本文件自含一份，避免与 outfitScene 循环依赖） */
const SCENE_LABELS = { nude: '裸体', work: '常服', casual: '私服', home: '居家', sleep: '睡衣' };

export function normalizeDesignScenes(scenes = GENERATED_OUTFIT_SCENES) {
  if (!Array.isArray(scenes) || !scenes.length || scenes.some(scene => !GENERATED_OUTFIT_SCENES.includes(scene))) {
    throw new Error('只支持设计裸体、常服、私服、居家、睡衣');
  }
  return [...new Set(scenes)];
}

/**
 * 拼「生成/补全场景外观」的消息分层。
 * @param {object} o
 * @param {string} o.systemRules 系统规则（静态）
 * @param {string} o.persona 角色人设（去掉外观段）
 * @param {string} [o.shortPrompt] 角色简述
 * @param {string} o.displayName 角色名
 * @param {string} [o.baseAppearance] 角色卡外观段（没有任何 seed 时的身体来源兜底）
 * @param {string[]} o.scenes 本次要设计的场景
 * @param {Array<{scene,name,body,description}>} [o.seeds] 已填分项（反推锚点）
 * @param {string} [o.bodySource] 身体真源（由调用方按锚点优先级挑好）
 */
export function buildSceneOutfitMessages({ systemRules, persona, shortPrompt, displayName, baseAppearance, scenes, seeds = [], bodySource = '' }) {
  const targets = normalizeDesignScenes(scenes);
  const summary = String(shortPrompt || '').trim();
  const seedList = (Array.isArray(seeds) ? seeds : []).filter(s => s?.body || s?.description);
  // 默认外观是**必需**的（见上方参数说明）：它是"没有任何 seed 时的身体来源兜底"。
  // 2026-10-15 补上这条校验 —— 以前只写进注释、没真的拦：
  // 空外观会一路走到 LLM，模型只能凭空编身体，五套之间必然漂移。
  // 报错信息保留「缺少默认外观」这个可检索口径（上游 v3.9.0 的同名测试也钉它）。
  if (!baseAppearance?.trim()) {
    throw new Error('缺少默认外观（baseAppearance）：没有身体基准就无法保证五套是同一个人');
  }
  const msgs = [
    { role: 'system', content: systemRules },
    { role: 'system', content: DESIGN_RULES },
    { role: 'system', content: `【本次角色人设】\n角色名：${displayName}\n${persona}`
      + (summary ? `\n\n【角色简述（short_prompt）】\n${summary}` : '') },
    { role: 'system', content: `【默认外观：只读设计基准】\n${baseAppearance}` },
  ];
  // 反推层放在人设之后、user 之前：它是本次生成的锚点，权重比人设更直接
  if (seedList.length || bodySource) {
    msgs.push({ role: 'system', content: buildDeriveLayer(seedList, bodySource, targets) });
  }
  msgs.push({
    role: 'user',
    content: `请设计 ${targets.join('、')}，严格按规定 JSON 输出，仅包含这些场景。`
      + (bodySource ? '\n\n⚠ 每套的 body 字段都必须逐字照抄「身体描述的唯一真源」，不得改写。' : ''),
  });
  return msgs;
}

/** 模型漏给某场景时的兜底（尽量中性，避免画不出来） */
export const FALLBACK_OUTFITS = {
  nude: { name: '裸体', description: NUDE_DECLARATION },
  work: { name: '日常装', description: 'a simple practical daily outfit, neat and comfortable, suitable for everyday life' },
  casual: { name: '便装', description: 'casual everyday clothes, a simple top with matching bottoms, relaxed style' },
  home: { name: '居家服', description: 'comfortable loose loungewear, soft fabric, relaxed fit for staying at home' },
  sleep: { name: '睡衣', description: 'a soft cotton nightdress or pajama set, loose and comfortable, barefoot' },
};

/**
 * 解析模型返回的 JSON，规范化成 [{scene,name,body,description}]。
 *
 * ⚠ body 一律以 **bodySource（真源）** 为准，即使模型自作主张改写也丢掉
 *   —— 五套身体必须完全一致，这是"分层"的整个目的。
 * nude 那套必须显式声明裸体，否则生图模型会沿用基础外观里的默认服装。
 * @param {string} raw 模型原文
 * @param {string[]} scenes 本次要求的场景
 * @param {{bodySource?: string}} [opts]
 */
export function parseSceneOutfitDesign(raw, scenes, opts = {}) {
  const targets = normalizeDesignScenes(scenes);
  const bodySource = String(opts?.bodySource || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(String(raw || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
  } catch {
    throw new Error('服装设计返回的不是合法 JSON，请重试');
  }
  if (!Array.isArray(parsed?.outfits)) throw new Error('服装设计缺少 outfits 数组');

  const out = [];
  for (const scene of targets) {
    const matches = parsed.outfits.filter(o => o?.scene === scene);
    if (matches.length !== 1) throw new Error(`服装设计不完整或重复：${scene}，请重试`);
    const hit = matches[0];
    if (typeof hit?.name !== 'string' || !hit.name.trim()) {
      throw new Error(`服装设计缺少名称：${scene}，请重试`);
    }
    // 身体一律以真源为准（模型可能仍自作主张改写），保证五套完全一致
    const body = bodySource || String(hit.body || '').trim().slice(0, 2000);
    let description = String(hit.description || '').trim().slice(0, 1200);
    // nude 那套必须显式声明裸体
    if (scene === 'nude' && !/nude|no clothing|bare skin/i.test(description)) {
      description = FALLBACK_OUTFITS.nude.description;
    }
    // 非裸体套必须有衣服描述；裸体套允许就是那串声明
    if (!description && scene !== 'nude') {
      out.push({ scene, name: String(hit.name).trim().slice(0, 10), description: FALLBACK_OUTFITS[scene]?.description || '', body });
      continue;
    }
    out.push({
      scene,
      name: String(hit.name).trim().slice(0, 10),
      description: description.replace(/\s+/g, ' '),
      body,
    });
  }
  return out;
}
