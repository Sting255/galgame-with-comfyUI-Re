import { getDb, getSystemRules, getWorldSetting, stmt } from '../../db/index.js';
import { chatSync } from '../../llm/llm-client.js';
import { createSoftState } from '../softStateStore.js';

// ── 回复猜想冷却：每个 conversation 生成一次后进入 20s 冷却，用户新消息到达时重置 ──
// 2026-10-15 软状态落库：原来 `new Map()` 是纯进程内的，重启即丢 ⇒ 冷却失效（重启后立刻又能生成一次）。
// `createSoftState` 的 get/set/delete 与 Map **完全兼容**，所以下面所有既有读写点一行都不用改；
// 只多两件事：懒加载读库 + 写入去抖落库（默认 1s）。接口里没有别的 Map 独有 API（无 .size/forEach）。
export const guessCooldowns = createSoftState('chat_guess_cooldowns');

/**
 * 预测结果的**口吻护栏**（2026-10-02 用户：「对话预测时不时会变成猜测角色的想法而不是玩家的想法」）。
 *
 * 提示词里已经写了"绝对不要预测 assistant"，但模型偶尔还是会写成角色的话 / 她的心理活动。
 * 这里做**输出侧兜底**：像"角色在说话"的一律判定不通过；两条里只要有一条不通过就整体放弃
 * （宁可这次不显示建议，也不要给玩家两条"她自己说的话"）。
 *
 * 判据（都是真机上出现过的形态）：
 *   · **演讲式冒号**：`名字：……` —— 那才是"角色自己在说话"
 *     ⚠️ 这里**曾经**写成"出现角色名就丢"，结果玩家喊一句「刻晴你别这样」（最正常的说话方式之一）
 *     两条建议全被丢掉 ⇒ 2026-10-02 收窄：**玩家喊名字属于玩家口吻，必须放行** ✗→✓
 *   · 括号里的心理或神态：「（她想：…）」「（脸红）」
 *   · 旁白/第三人称词：心想、暗自、默默地、旁白、她低声…
 *   · **动作描写**：**轻轻叹气** 这种
 */
// ── 供 characters.js 调用的清理函数（上游 v4.3.0 保留的空实现）──
export function clearImageJudgeCounter(charId) {
}

export function sanitizeReplyGuesses(guesses, character) {
  if (!guesses) return null;
  const name = String(character?.display_name || '').trim();
  // 名字要进正则 ⇒ 先转义（角色名里可能有 . * + ? ( ) [ ] 这类字符）
  const nameColon = name ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]`) : null;
  const looksLikeCharacter = (text) => {
    // ⚠️ 缺失/非字符串也算"不合格"：否则 String(undefined) === 'undefined' 会被当成合法建议放行
    //    （单测 ⑥ 抓到的：只给了 a、没给 b 时，返回里会冒出字符串 "undefined"）
    if (typeof text !== 'string' || !text.trim()) return true;
    const s = text.trim();
    if (nameColon && nameColon.test(s)) return true;
    if (/^(她|他|她们|他们|角色|assistant)\b/i.test(s)) return true;
    if (/[（(][^）)]{0,14}(想|心|暗自|默默|脸红|微笑|叹气|低头|咬|点头|摇头|皱眉)/.test(s)) return true;
    if (/(心想|心里想|暗自|默默地|旁白|她的声音|她低声|她轻轻|她缓缓)/.test(s)) return true;
    if (/\*\*[^*\n]{1,24}\*\*/.test(s)) return true;
    if (/^[\u4e00-\u9fff]{2,6}[：:]/.test(s)) return true;   // 「纳西妲：…」
    return false;
  };
  const badA = looksLikeCharacter(guesses.a);
  const badB = looksLikeCharacter(guesses.b);
  if (badA || badB) {
    console.warn('[chat] 预测结果像角色在说话，已丢弃本次建议:', JSON.stringify({
      a: String(guesses.a || '').slice(0, 40), badA, b: String(guesses.b || '').slice(0, 40), badB,
    }));
    return null;
  }
  return { a: String(guesses.a).trim(), b: String(guesses.b).trim() };
}

/**
 * 回复猜想：根据最近对话预测用户接下来最可能回复的两句话
 * 独立轻量 LLM 调用（~200 tokens），不影响主回复质量
 */
export async function generateReplyGuesses(conversationId, character) {  const db = getDb();

  // 取最近 1 轮（2 条 raw_messages）作为上下文
  const history = stmt(`
    SELECT role, content FROM raw_messages
    WHERE conversation_id = ?
    ORDER BY id DESC LIMIT 2
  `).all(conversationId).reverse();

  if (history.length === 0) return null;

  // 角色人设（short_prompt 已裁剪并替换过 "你"→"assistant"）
  const personalityBrief = character?.short_prompt || '';

  // msgs[0] — 舞台：破限词 + 世界观（不含 roleplay，避免预测助手站错角色）
  const jailbreak = getSystemRules({ roleplay: false });
  let worldSetting = getWorldSetting();
  if (worldSetting && worldSetting.length > 500) {
    worldSetting = worldSetting.slice(0, 500);
  }
  const stageContent = [jailbreak, worldSetting].filter(Boolean).join('\n\n');

  // msgs[1] — 任务：预测指令（先定义任务） + 角色背景（后补充上下文）
  const taskParts = [];
  taskParts.push(`你是一个对话预测助手。你的任务是预测**用户（user）**接下来最可能回复的两句话。

⚠️ 最重要的一条：你写的是**玩家本人会打进输入框的字**，不是角色的台词、不是角色的想法、不是旁白。
对话最后一条是角色（assistant）说的，你要写的是"玩家看到这句之后会怎么回"。

禁止（出现任意一条就算答错）：
- 出现角色的名字，或写成「角色名：……」
- 写角色的心理活动 / 神态 / 动作描写：例如「（她想：他怎么这样）」「她脸红了」「*轻轻叹气*」
- 用第三人称叙述（「她觉得……」「他笑了……」）
- 接着角色的话往下说（那是 assistant 的活，不是玩家的回复）

规则：
1. A 和 B 必须是不同方向的回复——不能是同一个意思的两种说法。例如：A 延续当前话题深入，B 切换视角或融入世界观表达不同态度
2. 每条 5~25 个汉字，像网友聊天一样自然口语化，思维跳脱但又合理，不要过于书面化或公式化
3. 第一人称/直接对她说的话，不要加任何括号里的动作或神态
4. 直接输出 JSON，不要任何解释

输出格式：
{"a":"<猜想A>","b":"<猜想B>"}

示例：
对话中assistant说"走吧，我们出门吃晚饭？"
输出：{"a":"好耶，我想吃火锅！","b":"不了吧，我们点外卖吃吃就好"}

反例（**绝对不要**这样输出）：
{"a":"（她低头笑了笑）好啊。","b":"纳西妲：那我们快走吧"}`);

  if (personalityBrief) {
    taskParts.push(`【仅供了解对话背景，你要预测的是用户（user）会怎么回应这个角色，不要模仿这个角色的语气说话】\n对话中assistant的角色设定：${personalityBrief}`);
  }

  // 过滤掉 assistant 消息中的生图 prompt JSON（可能在开头/中间/末尾），避免干扰预测
  const cleanedHistory = history.map(msg => {
    if (msg.role === 'assistant') {
      return {
        ...msg,
        content: msg.content.replace(/\s*\{["']prompt["']:\s*"(?:[^"\\]|\\.)*"\s*\}/gs, '')
      };
    }
    return msg;
  });

  const msgs = [];
  if (stageContent) msgs.push({ role: 'system', content: stageContent });
  msgs.push({ role: 'system', content: taskParts.join('\n\n') });
  msgs.push(...cleanedHistory);

  msgs.push({ role: 'user', content: '请根据以上对话，预测user接下来最可能回复的两句话。只输出 JSON：' });

  try {
    const result = await chatSync(msgs, { temperature: 0.7, max_tokens: 128, response_format: { type: 'json_object' }, label: '预测' });
    console.log(`[chat] generateReplyGuesses raw response: ${result.slice(0, 120)}`);

    // 尝试提取 JSON 对象
    const jsonMatch = result.match(/\{\s*"a"\s*:\s*"([^"]*)"\s*,\s*"b"\s*:\s*"([^"]*)"\s*\}/);
    if (jsonMatch) {
      return sanitizeReplyGuesses({ a: jsonMatch[1], b: jsonMatch[2] }, character);
    }
    // 回退：尝试直接 parse
    try {
      const parsed = JSON.parse(result.trim());
      if (parsed.a && parsed.b) return sanitizeReplyGuesses({ a: parsed.a, b: parsed.b }, character);
    } catch {}
    return null;
  } catch (err) {
    console.error('[chat] generateReplyGuesses error:', err.message);
    return null;
  }
}
