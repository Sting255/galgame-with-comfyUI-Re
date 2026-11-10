import { getSystemRules, getSystemRulesWithWorld, getWorldSetting } from '../db/index.js';
import { getWorldIntegrationRule } from '../builtinRules.js';
import { chatSync } from './lorebook/runtime.js';
import { config } from '../config.js';
import { intervals, fitSharedActivity } from './cohabitationSchedule.js';
import { isCompleteJsonText, stripJsonFence } from '../llm/llm-client.js';

export const COHABITATION_RULES = `你是共同生活日程编排助手。为下方居室成员规划本轮作息中自然发生的共同活动，供稍后各角色编排完整日程时遵守。
根据世界观、居室成员的简短人格及关系原文决定活动。关系有方向：分别保留双方的关系认知；友好、疏远、竞争、敌对、依赖、单方面关系都按原文应用。敌对或竞争可以体现对峙、争执、谈判、有理由的暂时合作等，不能将原关系直接改写成友好关系。
可以是部分成员组队，或成员与所提供的室外关系对象行动。每件共同活动总人数必须为2～3人（包含室外对象），最多3人一起行动；居室超过3人时分组安排，不生成超过3人的全员活动。每件活动至少有一名本居室成员和另一位角色参加。允许独处，独处留给个人日程，不在这里占一条共同活动。
正常情况下：1～3名成员目标3件，4～5名目标4件，更多成员目标5件；可用时间不足、没有合适活动时可以少于目标甚至0件，最多5件。不要安排睡眠。每件活动建议15～120分钟，最长180分钟，避开已有约定并留下足够的工作、生活和睡眠时间。
所有参与者都必须在候选名单中。已确认活动不可删除、移动、重复输出；只输出新增活动。检查参与者（包括室外对象）的全部已占用时段；同一个人不能在同一时段参加两件事。时间以每天重复的24小时制HH:MM表示，允许跨午夜，不可起止相同。
活动描述用中文第三人称，26～52字，写清在场角色的姓名和正在做的事情，不包含外观。不编造候选名单之外的人物。
严格按以下完整JSON格式输出，不能输出解释、Markdown或JSON以外的文字。
示例中的全部值都只是格式占位，必须替换成输入中的真实时间、场所、ID、姓名与动作：
{"activities":[{"startTime":"18:10","endTime":"19:20","activity":"一起整理书架并准备晚餐","location":"共同居室的厨房与客厅","participantIds":[1001,1002],"description":"角色甲把散落的书按主题放回书架，角色乙在厨房准备两人的晚餐，两人隔着客厅商量今晚的安排。"}]}
字段约束：startTime/endTime为合法HH:MM时间，endTime必须晚于startTime或按明确跨午夜规则填写；activity为1～60字且能说明具体共同动作；location为1～60字真实场所；participantIds为2～3个不同的候选角色数字ID，最多3个，示例1001/1002必须替换成输入中的真实ID；description为26～52字、第三人称，必须写出角色姓名、具体动作与互动，且不写外观。无合适活动时输出{"activities":[]}。`;

export function buildCohabitationRequest({ room, characters, relationships, events, fixed = [], direction = '', batchId, eligibleCharacterIds }) {
  const members = characters.filter(c => room.memberIds.includes(c.id));
  const relations = relationships.filter(r => room.memberIds.includes(r.from_character_id) || room.memberIds.includes(r.to_character_id));
  const candidateIds = new Set([...room.memberIds, ...relations.flatMap(r => [r.from_character_id, r.to_character_id])]);
  const eligible = new Set(eligibleCharacterIds || characters.map(c => c.id));
  const candidates = characters.filter(c => candidateIds.has(c.id) && eligible.has(c.id));
  const candidateSet = new Set(candidates.map(c => c.id));
  const occupancy = [...events, ...fixed].filter(e => e.participantIds.some(id => candidateSet.has(id)));
  const messages = [{ role: 'system', content: getWorldSetting() ? getSystemRulesWithWorld({ roleplay: false }) : getSystemRules({ roleplay: false }) }];
  if (getWorldSetting()) messages.push({ role: 'system', content: getWorldIntegrationRule('schedule') });
  messages.push({ role: 'system', content: COHABITATION_RULES });
  const personaTexts = members.map(c => `【${c.display_name} · ID ${c.id}】\n${String(c.short_prompt || '').trim() || '未提供简短人格。'}`);
  for (const content of personaTexts) messages.push({ role: 'system', content });
  const boundary = { index: messages.length - 1, offset: messages.at(-1).content.length };
  const names = new Map(characters.map(c => [c.id, c.display_name || c.name || `角色${c.id}`]));
  // 与朋友圈“对方是你的……”保持同一方向，第三人称明确关系归属，不推断反向关系。
  const relationshipText = relations.filter(r => String(r.relationship_text || '').trim()).map(r =>
    `- ${names.get(r.to_character_id) || `角色${r.to_character_id}`}是${names.get(r.from_character_id) || `角色${r.from_character_id}`}的${r.relationship_text}`
  ).join('\n') || '未提供关系。';
  const dynamic = JSON.stringify({ room: { id: room.id, name: room.name, memberIds: members.map(c => c.id) },
    candidates: candidates.map(c => ({ id: c.id, name: c.display_name })),
    unavailableMemberIds: members.filter(c => !eligible.has(c.id)).map(c => c.id),
    occupied: occupancy.map(e => ({ sharedEventId: e.sharedEventId, startTime: e.startTime, endTime: e.endTime, participantIds: e.participantIds, activity: e.activity, location: e.location })),
  }) + `\n\n【人物关系】\n${relationshipText}`;
  messages.push({ role: 'system', content: `【本次共同生活资料】\n${dynamic}` });
  const user = `为${room.name}安排当天的非睡眠共同活动。${direction ? `\n本轮用户要求：${direction}` : ''}`;
  messages.push({ role: 'user', content: user });
  return { messages, candidateIds: candidateSet, occupancy, lorebook: {
    personaTexts, staticTexts: [COHABITATION_RULES], cacheBoundary: boundary,
    characterNames: members.map(c => c.display_name), characterName: members[0]?.display_name,
    history: [{ role: 'user', content: `${dynamic}\n${user}` }], scope: `cohabitation:${room.id}`, turnKey: batchId, step: 1,
  } };
}

function readCompleteCohabitationJson(raw) {
  if (raw && typeof raw === 'object') return { complete: true, value: raw };
  if (!isCompleteJsonText(raw)) return { complete: false, value: undefined };
  try {
    return { complete: true, value: JSON.parse(stripJsonFence(raw)) };
  } catch {
    return { complete: false, value: undefined };
  }
}

function validateParsedCohabitationResult(parsed, { room, candidateIds, occupancy, batchId }) {
  if (!Array.isArray(parsed?.activities) || parsed.activities.length > 5) throw new Error('共同活动需要0～5件');
  const events = [];
  for (const [i, a] of parsed.activities.entries()) {
    if (!Array.isArray(a.participantIds) || a.participantIds.some(id => !Number.isSafeInteger(id))) throw new Error('参与者ID格式错误');
    const participantIds = [...new Set(a.participantIds)].sort((x, y) => x - y);
    if (participantIds.length > 3) throw new Error('每件共同活动最多3人，包含本居室成员和室外对象，请减少参与者或分组安排');
    if (participantIds.length < 2 || participantIds.some(id => !candidateIds.has(id)) || !participantIds.some(id => room.memberIds.includes(id))) throw new Error('参与者不在候选名单或没有本居室成员');
    const ranges = intervals(a), duration = ranges.reduce((n, [s, e]) => n + e - s, 0);
    if (!ranges.length || duration < 5 || duration > 180) throw new Error('共同活动时间不合法或超过三小时');
    if (['activity', 'location', 'description'].some(key => typeof a[key] !== 'string' || !a[key].trim())) throw new Error('活动名称、地点和描述不能为空');
    if (/睡觉|睡眠|入睡|就寝|午睡|补觉/.test(a.activity) || a.replyDelay === -1) throw new Error('共同活动不包含睡眠');
    const event = { startTime: a.startTime, endTime: a.endTime, activity: a.activity.trim().slice(0, 60), location: a.location.trim().slice(0, 60),
      description: a.description.trim(), participantIds, replyDelay: 0, tags: ['共同生活'],
      sharedEventId: `${batchId}:${room.id}:${i}`, cohabitationBatchId: batchId, sharedStartTime: a.startTime, sharedEndTime: a.endTime };
    // 模型有时把已确认的约定原样再列一遍：视为引用，保留最初版本，不重复预约也不浪费一次重试。
    if ([...occupancy, ...events].some(b => b.sharedEventId && b.startTime === event.startTime && b.endTime === event.endTime
      && b.location === event.location && JSON.stringify([...b.participantIds].sort((x, y) => x - y)) === JSON.stringify(participantIds))) continue;
    const fitted = fitSharedActivity(event, [...occupancy, ...events]);
    if (!fitted) console.info(`[cohabitation] 省略无共同空档的提案 ${event.sharedEventId} ${event.startTime}-${event.endTime}`);
    else if (fitted.startTime !== event.startTime) console.info(`[cohabitation] 提案改期 ${event.sharedEventId} ${event.startTime}-${event.endTime} -> ${fitted.startTime}-${fitted.endTime}`);
    if (fitted) events.push(fitted);
  }
  return events;
}

export function validateCohabitationResult(raw, input) {
  const parsed = readCompleteCohabitationJson(raw);
  if (!parsed.complete) throw new Error('共同生活输出不是完整合法 JSON');
  return validateParsedCohabitationResult(parsed.value, input);
}

export async function planResidence(input, { chat = chatSync } = {}) {
  if (input.characters.filter(c => input.room.memberIds.includes(c.id)).length < 2) return [];
  const request = buildCohabitationRequest(input);
  if (request.candidateIds.size < 2) return [];
  let domainError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = request.messages.map(m => ({ ...m }));
    if (attempt > 0) {
      messages.at(-1).content += `\n上次输出是完整合法 JSON，但未通过共同生活领域校验：${domainError}。`
        + '请修正这些领域问题，并严格按前述完整 JSON 示例重新输出全部字段；不要解释或输出 JSON 以外的文字。';
    }

    // 网络、截断、审核中断与 JSON 续写由公共 chatSync 收口；这里不重复整轮请求。
    const raw = await chat(messages, { temperature: attempt === 0 ? 0.6 : 0.55, response_format: { type: 'json_object' },
      ...(config.features.scheduleDisableThinking ? { thinking: { type: 'disabled' }, forceDisableThinking: true } : {}),
      label: `cohabitation-plan:${input.room.name}${attempt > 0 ? ':domain-retry' : ''}`, lorebook: request.lorebook });
    const parsed = readCompleteCohabitationJson(raw);
    if (!parsed.complete) {
      throw new Error(`共同生活输出经公共续写后仍不是完整合法 JSON（共 ${String(raw || '').length} 字符）`);
    }
    try {
      return validateParsedCohabitationResult(parsed.value, { ...request, ...input });
    } catch (err) {
      domainError = err?.message || '共同活动字段或时间不符合要求';
      if (attempt === 0) {
        console.warn(`[cohabitation] ${input.room.name} 首次领域校验失败，允许一次领域修正：${domainError}`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`共同生活规划在 1 次领域修正后仍失败：${domainError}`);
}
