import { config } from '../config.js';
import { getSystemRules, getSystemRulesWithWorld, getWorldSetting } from '../db/index.js';
import { getWorldIntegrationRule } from '../builtinRules.js';
import { buildCharacterPersona } from './characterPersona.js';
import { charArtistOverride } from './characterImageOpts.js';
import { chatSync } from './lorebook/runtime.js';
import { generateImageRaw } from './imageSkill.js';

const BACKGROUND_DESIGNER = `你是视觉小说的背景美术设计师，为下面的角色设计一张用于人物立绘后方的场景背景。
只画环境，不画人物、身体部位、人形剪影、文字、字幕、界面或水印。角色资料仅用于决定居所、场所、时代与氛围，不要把角色外貌或服装写进画面。
构图为横向宽幅，平视镜头，有清晰景深；中央为立绘保留视觉空间，下方为对话框保留较安静的区域，避免近景大物体遮挡中央。
遵循世界观和用户指定场景；用户未指定时选择适合该角色日常交流的场所。使用细致的动漫视觉小说背景画风。
只输出一段 80 至 180 个英文单词的生图提示词，说明环境、空间布局、材质、时间、光线和色调；必须包含 scenery, no humans, visual novel background, wide shot。
直接输出英文提示词正文，不输出解释、JSON、代码围栏或标题。`;

/** 静态世界观/设计要求在前，人格变量靠后，用户要求始终收尾。 */
export function buildDialogueBackgroundMessages({ systemRules, worldRule, persona, requirement = '' }) {
  return [
    { role: 'system', content: systemRules },
    ...(worldRule ? [{ role: 'system', content: worldRule }] : []),
    { role: 'system', content: BACKGROUND_DESIGNER },
    { role: 'system', content: `【角色背景资料，仅用于环境设计】\n${persona}` },
    { role: 'user', content: requirement ? `请设计沉浸对话背景，额外要求：${requirement}。按要求输出英文提示词。` : '请为该角色设计沉浸对话背景，输出英文提示词。' },
  ];
}

export async function generateDialogueBackground(character, requirement) {
  const world = getWorldSetting();
  const messages = buildDialogueBackgroundMessages({
    systemRules: world ? getSystemRulesWithWorld({ roleplay: false }) : getSystemRules({ roleplay: false }),
    worldRule: world ? getWorldIntegrationRule('town_asset') : '',
    persona: buildCharacterPersona(character, { variant: 'full', person: character.display_name, outfits: null }),
    requirement,
  });
  const response = await chatSync(messages, { temperature: 0.7, label: '沉浸背景设计' });
  const prompt = String(response || '').trim().replace(/^```(?:\w+)?\s*|\s*```$/g, '').trim();
  if (prompt.length < 20) throw new Error('背景提示词不完整，请重试');
  const result = await generateImageRaw(`scenery, no humans, visual novel background, wide shot, ${prompt}`, {
    scene: 'chat', workflowScene: null, priority: 'high', disableRAG: true, skipOptimization: true,
    artist: charArtistOverride(character) ?? config.comfyui.artist,
    width: 1280, height: 720,
    // 不带角色 LoRA，避免纯场景被角色特征污染；全局画风仍沿用聊天范围。
    negativePrompt: [config.comfyui.negativePrompt, 'people, person, character, human, face, body, text, watermark, interface'].filter(Boolean).join(', '),
  });
  if (!result.success || !result.images?.[0]?.base64) throw new Error(result.error || '背景图片生成失败');
  return { base64: result.images[0].base64, prompt, promptRefined: result.promptRefined || prompt, workflow: result.wfMode || null };
}
