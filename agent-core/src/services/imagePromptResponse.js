import { containsExplicitAdultContent } from '../db/imagePromptKnowledgePolicy.js';
import { isRefusal } from './refusalDetector.js';

export function extractImagePromptResponse(content) {
  const text = typeof content === 'string'
    ? content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    : '';

  if (!text) return null;

  const jsonMatch = text.match(/\{[\u201c\u201d"]?prompt[\u201c\u201d"]?\s*:\s*[\u201c\u201d"]([^]*?)[\u201c\u201d"]?\s*\}/i);
  if (jsonMatch?.[1]?.trim()) {
    const value = jsonMatch[1].trim();
    return isRefusal(value) ? null : value;
  }

  // 拒答不能当画面描述（2026-10-22）：中文拒答会被下游「画面描述里没有英文」拦下，
  // 但英文拒答（`I'm sorry, but I can't…`）能一路进 CLIP、写进 image_tasks.prompt_original，
  // 还会被下一轮生图 prompt 当历史参考。这里直接判 null，交由调用方的
  // 「空 → 重试一次 → generate_error」处理。
  if (isRefusal(text)) return null;

  return text.length >= 5 ? text : null;
}

export async function requestNonEmptyImagePrompt(request, { emptyRetries = 1, onEmpty } = {}) {
  for (let attempt = 0; attempt <= emptyRetries; attempt++) {
    const response = await request(attempt);
    const content = typeof response === 'string' ? response : '';
    if (content.trim()) return content;
    if (attempt < emptyRetries) onEmpty?.(attempt + 1, emptyRetries);
  }
  return '';
}

/**
 * 画面描述「被写含蓄」的判定（2026-10-21）。
 *
 * 背景（用户口径）：「聊天出图还是有审查限制，该露骨的地方变成擦边。」
 * `buildImagePromptMessages` 的【当前任务】早就要求直写解剖词、不许用「亲密」这类委婉说法，
 * 但模型有时仍会把正在发生的性行为改写成氛围、表情或半截话。
 *
 * 判据（零 LLM、零新词表，复用项目现成的 `containsExplicitAdultContent`）：
 *   ① 最后一轮对话**本身就露骨**（命中词表）；
 *   ② 交回来的英文画面描述**一个露骨词都没有**；
 * 两条同时成立 ⇒ 判定为「被软化」，调用方据此追加一次重写要求（只重写一次，不阻断出图）。
 *
 * 刻意不做的事：对话不露骨时不判定（日常照片本来就不该有露骨词）；
 * prompt 为空时不判定（空返回由 `requestNonEmptyImagePrompt` 的重试负责）。
 */
export function needsExplicitImageRewrite(dialogue, prompt) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (!containsExplicitAdultContent(dialogue)) return false;
  return !containsExplicitAdultContent(text);
}

/**
 * 重写要求：作为**追加的 user 消息**发在原始消息列表之后（不改原始 msgs 的那几条 system）。
 *
 * 写法口径：
 *   · 先指名"上一次不合格在哪"，否则模型会以为只是再要一版、接着软化；
 *   · 输出语言/格式要求与前一条 system 保持一致（纯英文一段、≤800 字符、无解释无代码块）；
 *   · 只要求"直写"，不引入新的世界观或人物设定，避免把画面主体带偏。
 */
export const EXPLICIT_REWRITE_INSTRUCTION = {
  role: 'user',
  content: `【重写要求·上一次输出不合格】
你上一次的画面描述把正在发生的性行为写成了回避式表达：用氛围、表情、呼吸或「亲密」「那个地方」「尽兴」「更进一步」这类委婉说法代替了动作本身，或者写到一半就收住、只暗示没有直述。这是不合格的。
现在重写整段画面描述，规则如下：
- 直写动作本身：谁的哪个部位在对哪个部位做什么（手、手指、嘴、舌、腰胯、阴茎、小穴、肛门、乳房），进入到什么程度。
- 直写可见状态：勃起、湿润与湿在哪里、润滑、体液、汗水、唾液、泛红、痕迹、颤抖、绷紧的肌肉、挺立的乳头、被撩起的裙摆与褪到何处。
- 直写姿势与几何：站立/跪着/趴着/躺着、臀部抬起或后送、双腿张开或被人分开、膝盖抬起、双手抓在哪里、重心落在何处。
- 必须使用具体解剖词（cock, pussy, anus, breasts, cum, wetness, penetration …），不要委婉说法、不要暗示、不要遮挡式描写、不要用表情或氛围代替动作。
输出要求：只输出**一段英文**画面描述，不超过 800 字符；不要中文、不要解释、不要标题、不要代码块；只描述【最后一轮对话】/【回复规划的画面需求】对应的这一张图。`,
};
