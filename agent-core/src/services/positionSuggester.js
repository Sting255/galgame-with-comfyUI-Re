/**
 * positionSuggester.js — 「让她自己决定」体位
 *
 * 为什么要有它：体位词表越铺越宽（精选 17 → 全量 84），手动挑反而变成负担 ——
 * 用户原话「太多了我不好选啊」。这里让模型根据**角色性格 + 此刻状态**挑一个，
 * 玩家只点一次「让她决定」，由她自己的性子来选。
 *
 * 约束：
 *   · 只能从**面板真实给出的候选**里选（candidates 由 listPositionOptions 提供），
 *     选到候选外的 key 一律回退 —— 否则又是一个「点得动但服务端解析不出来」的死按钮。
 *   · LLM 失败 / 输出不是 JSON / key 非法：回退到「随机一个合法候选」，不抛给前端。
 */
import { chatSync } from '../llm/llm-client.js';
import { buildCharacterPersona } from './characterPersona.js';

/** 可注入的 LLM 调用（测试用；传非函数即恢复真实 chatSync） */
let llmCallImpl = chatSync;
export function __setSuggestLlm(fn) {
  llmCallImpl = typeof fn === 'function' ? fn : chatSync;
}

/** 从模型输出里抠出 { key, reason }，容忍代码块、前后缀、额外字段 */
export function parseSuggestion(raw, candidateKeys) {
  if (!raw || typeof raw !== 'string') return null;
  const clean = raw.replace(/```(?:json)?/gi, '').trim();
  const tryParse = (text) => {
    try {
      const obj = JSON.parse(text);
      const key = typeof obj?.key === 'string' ? obj.key.trim() : '';
      if (!key || !candidateKeys.has(key)) return null;
      const reason = typeof obj?.reason === 'string' ? obj.reason.trim().slice(0, 60) : '';
      return { key, reason };
    } catch { return null; }
  };
  const direct = tryParse(clean);
  if (direct) return direct;
  const block = clean.match(/\{[\s\S]*\}/);
  if (block) return tryParse(block[0]);
  return null;
}

function fallbackPick(candidates) {
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { key: pick.key, reason: '', fallback: true };
}

/**
 * 让模型替她挑一个体位。
 * @param {object} opts
 * @param {object} opts.character 角色行（要有 id / display_name / base_prompt）
 * @param {object} [opts.state]  面板状态快照（取 position / pace / accumulation / sensitivity）
 * @param {Array<{key:string,label:string,actKey?:string,penetrative?:boolean}>} opts.candidates
 * @returns {Promise<{key:string,label:string,reason:string,fallback?:boolean}>}
 */
export async function suggestPosition({ character, state, candidates }) {
  if (!character) throw new Error('缺少角色');
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('没有可选的体位');

  const keySet = new Set(candidates.map(c => c.key));
  const byKey = new Map(candidates.map(c => [c.key, c]));
  const persona = buildCharacterPersona(character, { variant: 'short' }).slice(0, 1500);

  const cur = state?.position?.label || '还没定';
  const pace = state?.pace?.label || state?.pace?.key || '未定';
  const load = Number.isFinite(Number(state?.accumulation)) ? Number(state.accumulation) : 0;
  const sens = state?.sensitivity?.tierLabel ? `${state.sensitivity.tierLabel}（${state.sensitivity.value ?? ''}）` : '未知';

  const lines = candidates
    .map(c => `- ${c.key} | ${c.label}${c.penetrative ? ' | 插入式' : ''}${c.actKey ? ` | ${c.actKey}` : ''}`)
    .join('\n');

  const instruction = `你是「${character.display_name}」在床上的体位决策器。请**站在她的性格与当下状态**出发，从候选里挑一个最合适的体位。

【她此刻的状态】
当前体位：${cur}
节奏：${pace}
累积程度：${load}
敏感度：${sens}

【候选体位】（格式：key | 中文名 | 补充）
${lines}

要求：
1. 只输出一个 JSON 对象，不要解释、不要代码块。
2. key 必须**逐字符**等于候选里的某一个 key，不许自创。
3. reason 用一句中文写她为什么选这个（≤30 字，第三人称，写她的心思，不要写成旁白解说）。
4. 结合她的性格与体能：冷淡/骄傲的角色不会主动选过于示弱的姿势；已经累积很高时优先能让她喘口气的姿势；体力弱的不适合太费力的。

输出格式（严格按此）：
{"key":"候选里的 key","reason":"一句中文理由"}`;

  let raw = '';
  try {
    raw = await llmCallImpl(
      [{ role: 'system', content: persona }, { role: 'user', content: instruction }],
      { temperature: 0.8, max_tokens: 200, response_format: { type: 'json_object' }, label: '体位决策' },
    );
  } catch (err) {
    console.warn('[poseSuggest] LLM 调用失败，回退随机合法体位：', err.message);
    const fb = fallbackPick(candidates);
    return { ...fb, label: byKey.get(fb.key)?.label || fb.key };
  }

  const parsed = parseSuggestion(raw, keySet);
  if (!parsed) {
    console.warn('[poseSuggest] 模型没给出合法体位，回退随机：', String(raw).slice(0, 120));
    const fb = fallbackPick(candidates);
    return { ...fb, label: byKey.get(fb.key)?.label || fb.key };
  }
  return { key: parsed.key, label: byKey.get(parsed.key)?.label || parsed.key, reason: parsed.reason };
}
