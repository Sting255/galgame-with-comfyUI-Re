import { parseJson } from './repository.js';

/**
 * 神说自己的「失败/上限」提示语，不是天使说过的话，绝不能进下一轮上下文。
 *
 * 2026-11-07 起写入时就标 status='failed'，history 天然过滤掉；但**更早的行写成了 done**，
 * 而 contextHistory 会把该会话的全部历史读进来 —— 真机 2026-11-08 18:16 的一次请求里
 * 「吾神，我暂时没能完成这次回应」重复出现 3 份，整段会话累计 75 处。
 * 越失败越脏、越脏越容易再失败，所以在读取这一侧再挡一道（按内容前缀，与状态无关）。
 */
const SYSTEM_NOTICE_PREFIXES = [
  '吾神，我暂时没能完成这次回应',
  '吾神，这次需要处理的事情有些多',
];

function isSystemNotice(content) {
  const text = String(content || '').trimStart();
  if (!text) return false;
  return SYSTEM_NOTICE_PREFIXES.some(prefix => text.startsWith(prefix));
}

// 只读取当前会话原始历史，不生成摘要或检索其他会话。
export function createGodHistory(repo) {
  const { db } = repo;
  async function contextHistory(sessionId, { includeIds = false } = {}) {
    // 当前会话完整累积；忽略旧版压缩游标，从原始记录恢复本会话全部历史。
    const rows = db.prepare('SELECT * FROM god_messages WHERE session_id=? ORDER BY id').all(sessionId);
    const toolIds = new Set(rows.filter(m => m.role === 'tool' && m.status === 'done').map(m => `${m.run_id}:${m.tool_call_id}`));
    const acceptedToolIds = new Set();
    const messages = [];
    const messageIds = [];
    for (const row of rows) {
      if (row.status !== 'done') continue;
      // 旧版写进库里的失败提示（status 还是 done）在这里按内容挡掉，见文件头的说明
      if (row.role === 'assistant' && isSystemNotice(row.content)) continue;
      const calls = parseJson(row.tool_calls, []);
      if (calls.some(c => !toolIds.has(`${row.run_id}:${c.id}`))) continue;
      for (const call of calls) acceptedToolIds.add(`${row.run_id}:${call.id}`);
      if (row.role === 'tool' && !acceptedToolIds.has(`${row.run_id}:${row.tool_call_id}`)) continue;
      const provider = parseJson(row.provider_json, {});
      messages.push({ role: row.role, content: row.content,
        ...(row.role === 'assistant' ? provider : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(row.role === 'tool' ? { tool_call_id: row.tool_call_id } : {}),
      });
      messageIds.push(row.id);
    }
    return { messages, ...(includeIds ? { messageIds } : {}) };
  }
  return { contextHistory };
}
