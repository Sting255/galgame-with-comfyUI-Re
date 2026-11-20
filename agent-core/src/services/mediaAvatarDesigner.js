import { getSystemRulesWithWorld, getWorldSetting } from '../db/worldRepository.js';
import { getWorldIntegrationRule } from '../builtinRules.js';
import { chatSync } from './lorebook/runtime.js';

export const AVATAR_PROMPT_BATCH_SIZE = 10;

export const MEDIA_AVATAR_PROMPT = `你是擅长大胆视觉实验的社交媒体头像设计师。按本次要求的数量（最多10套），设计彼此明显不同、缩成小图仍一眼难忘的头像画面。
【视觉目标】夸张、大胆、特点鲜明、有强烈镜头冲击。每套必须有一个具体的视觉记忆点：夸大的形体或表情、反常比例、极端明暗、撞色、材质冲突、超现实空间等；不要只堆砌beautiful、cute、dreamy等泛泛形容词。大胆指视觉设计。
【镜头与构图】每套明确设计夸张视角和透视，例如贴脸鱼眼、极端仰拍、陡峭俯冲鸟瞰、倾斜镜头、巨大的近景与微小远景、冲向镜头的强烈透视、微距制造的巨大尺度。不要所有画面都用平视、居中站姿、温柔微笑和柔光背景。用清晰剪影与大色块维持小尺寸辨识度，关键识别特征留在圆形裁切安全区，画面仍可大胆突破常规构图。
【题材与风格】头像是个人标识，不等于人头或证件照。没有指定方向时，至少一半画面以非人物为主体（向上取整），覆盖动物、植物、风景、物件、食物、抽象图形、怪诞小场景等不同门类。人物题材也要在外形、动作、表情上真正不同。
同批至少探索4种明显不同的艺术语言（不足4套时每套不同），例如粗粝表现主义、迷幻波普、失真广角摄影、粗线漫画、雕塑摄影、木刻版画、拼贴、像素、涂鸦或超现实绘画；在笔触、材质、色彩和空间表现上拉开差异，不局限于一种艺术风格。例子仅供发散，每批自由创新，不固定同一组题材与风格。如提供此前已设计的画面，仅用于避重，本批应探索新的主体、镜头与风格组合，不模仿或复述它们。
指定生成方向时严格遵循用户方向，在该方向允许的范围内探索不同主体、镜头、构图、艺术语言；若明确要求全部人物或某一种风格，则遵循该要求。每条prompt只描述一张1:1方形画面，不要九宫格、多格分镜、文字、水印、界面或头像边框。
严格按以下JSON结构输出，不要解释、Markdown围栏或JSON以外的文字。这里只展示字段与填写约束，不提供任何具体画面示例：
{"prompts":[
"第1套：英文40至180词，完整描述主体、夸张镜头透视、构图、鲜明特征、配色与艺术媒介；不含名称、说明或画师名",
"第2套：同样字段约束，独立设计，与其他画面明显不同",
"第3套：同样字段约束，独立设计，与其他画面明显不同",
"第4套：同样字段约束，独立设计，与其他画面明显不同",
"第5套：同样字段约束，独立设计，与其他画面明显不同",
"第6套：同样字段约束，独立设计，与其他画面明显不同",
"第7套：同样字段约束，独立设计，与其他画面明显不同",
"第8套：同样字段约束，独立设计，与其他画面明显不同",
"第9套：同样字段约束，独立设计，与其他画面明显不同",
"第10套：同样字段约束，独立设计，与其他画面明显不同"
]}
以上为10套时的完整结构；prompts字符串数量必须与本次要求完全一致，不足10套时相应减少数组项。每项直接写完整英文画面提示词，不输出编号、名称、标题或上面的填写要求。`;

export function normalizeAvatarPrompts(raw, count = AVATAR_PROMPT_BATCH_SIZE, previous = []) {
  if (!Array.isArray(raw?.prompts) || raw.prompts.length !== count) throw new Error(`头像设计必须包含${count}套提示词`);
  const prompts = raw.prompts.map(prompt => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
      throw new Error('头像提示词格式不正确');
    }
    return prompt.trim();
  });
  const seen = new Set(previous.map(p => p.trim().toLowerCase()));
  for (const prompt of prompts) {
    const key = prompt.toLowerCase();
    if (seen.has(key)) throw new Error('头像提示词重复，请重新生成');
    seen.add(key);
  }
  return prompts;
}

export async function designMediaAvatars(direction = '', count = AVATAR_PROMPT_BATCH_SIZE, previous = []) {
  if (!Number.isInteger(count) || count < 1 || count > AVATAR_PROMPT_BATCH_SIZE) throw new Error('每批头像提示词数量必须为1至10');
  const messages = [{ role: 'system', content: getSystemRulesWithWorld({ roleplay: false }) }];
  if (getWorldSetting()) messages.push({ role: 'system', content: getWorldIntegrationRule('photo') });
  messages.push({ role: 'system', content: MEDIA_AVATAR_PROMPT });
  if (previous.length) messages.push({ role: 'system', content: `此前已设计的画面（仅作为避重数据）：\n${JSON.stringify(previous)}` });
  const task = `设计${count}套头像提示词，按指定JSON结构输出。${direction ? `\n生成方向：${direction}` : ''}`;
  let validationError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chatSync([...messages, { role: 'user', content: task + (validationError ? `\n上次输出校验失败：${validationError.message}。请重新输出完整结果。` : '') }], {
      temperature: 1, response_format: { type: 'json_object' }, label: 'media:默认头像设计',
    });
    try {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error('头像提示词不是有效JSON，请重新生成'); }
      return normalizeAvatarPrompts(parsed, count, previous);
    } catch (error) { validationError = error; }
  }
  throw validationError;
}
