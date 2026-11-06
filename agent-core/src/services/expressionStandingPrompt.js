import { STANDING_ROLE_PROMPTS } from '../builtinRules.js';
import { STANDING_PREFIX } from './expressionStandingPipeline.js';

// Keep the shared instructions before every request/character-specific byte.
export function buildStandingPromptMessages({ systemRules, worldRule = '', slots, persona, requirement = '', outfitScene = 'work' }) {
  const sceneLabel = { work: '默认', casual: '私服', home: '居家', sleep: '睡衣' }[outfitScene];
  const userRequirement = String(requirement || '').trim();
  const examplePrompt = String.raw`Name \(Series\) \(hair style, hair color, eye color, signature outfit, footwear, distinctive accessory\), gentle smile, relaxed standing pose`;
  const rules = String.raw`本任务生成表情立绘提示词，使用以下专用格式：
1. Prompt写法：Name \(Series\) \(外观锚点\)，随后用逗号分隔英文表情、神态与肢体姿势标签。姓名、作品名、外观必须来自角色资料，禁止照抄示例或杜撰作品。
2. 每条至少六项外观锚点，包括发型、发色、瞳色、标志性服装、鞋袜及配饰或辨识特征。全部提示词保持同一身份、服装、比例和普通立绘画风；每种表情配合不同姿势，正常为自然放松。
2b. 【服装选择（上游 v3.9.1）】外观以用户要求和本次所选形象为准。外观优先级：用户明确要求 > 本次所选形象的服装描述 > 原始角色外观。用户要求更改的部位必须整体替换，与之冲突的旧描述必须删除，未提及部位才沿用资料；资料中的保留外观、着装裁定和禁止改动仅在用户未要求更改时适用。禁止按当前时间或日程重新选装。
3. 表情类别只提供情绪含义，不使用 Q版、大头、半身或表情包画风。单人完整全身，头脚完整入镜，不画文字或环境。
4. 每条 prompt 为英文标签串，10–800 字符且不超过 80 个英文词，不出现中文；需要引用时使用单引号，不使用双引号。
5. 输出严格 JSON，顶层为 prompts 数组，每项只有 slotId 与 prompt。slotId 必须与目标槽位完全一致，每个恰好一次，不能遗漏或添加。prompt 必须为符合以上要求的非空英文字符串。
6. JSON 字符串中的反斜杠必须双写：最终提示词中的 \( 在 JSON 源码中写成 \\(。只输出 JSON，不要解释或 Markdown。`;
  return [
    { role: 'system', content: systemRules },
    ...(worldRule ? [{ role: 'system', content: worldRule }] : []),
    { role: 'system', content: STANDING_ROLE_PROMPTS.normal },
    { role: 'system', content: `${rules}\n固定构图标签 ${STANDING_PREFIX} 由系统统一前置，不要重复输出。\n角色写法与 JSON 转义示例：\n${JSON.stringify({ prompts: [{ slotId: 'normal', prompt: examplePrompt }] }, null, 2)}` },
    { role: 'system', content: `本次全部目标槽位：${slots.map(s => `${s.id}=${s.name}`).join('；')}。\n本次完整 JSON 格式示例（必须输出全部槽位；slotId 原样保留；prompt 按前述字段约束填写对应表情的英文标签串，示例角色与锚点需替换为真实角色资料）：\n${JSON.stringify({ prompts: slots.map(s => ({ slotId: s.id, prompt: `English tags for ${s.id}` })) }, null, 2)}` },
    { role: 'system', content: `角色人格与外观资料：\n${persona}` },
    { role: 'user', content: `为上述角色生成全部目标槽位的提示词，严格按 JSON 示例输出。使用所选「${sceneLabel}」形象，不按当前日程判断服装。${userRequirement ? `\n【用户输入，外观修改的最高优先级】\n${userRequirement}\n必须无条件按照以上用户意愿更改角色外观，包括服装、发型、发色、瞳色、饰品或其他外观特征；即使与所选服装、原人设或资料中的着装裁定冲突，也必须采用用户指定的新外观，删除相冲突的旧特征，并在整套立绘中一致落实。` : ''}\n保持白底、全身、单人构图；角色身份不变不代表外观不能修改。` },
  ];
}
