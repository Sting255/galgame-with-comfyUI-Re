// 纯文本衣服库：词条只包含中英文服装信息，不读取或引入图片。
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../../resources/clothing-library.json', import.meta.url), 'utf8'));
const byTag = new Map(catalog.entries.map(entry => [entry.tag, entry]));
export function getClothingLibrary() { return catalog; }

export function resolveClothingTags(tags, scene = 'work') {
  if (!['work', 'casual', 'home', 'sleep'].includes(scene)) throw new Error('服装场景无效');
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

export function buildClothingAppearanceMessages({ systemRules, worldRule = '', persona, scene, entries, brief = '' }) {
  return [
    { role: 'system', content: systemRules },
    ...(worldRule ? [{ role: 'system', content: worldRule }] : []),
    { role: 'system', content: CLOTHING_PROMPT },
    { role: 'system', content: `【角色人设与默认外观】\n${persona}` },
    { role: 'system', content: `【本次服装场景】${scene}\n【所选服装词条】\n${entries.map(entry => `${entry.tag} — ${entry.label}：${entry.description}`).join('\n')}` },
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
