/**
 * akashaMcp.js — 虚空终端（Story MCP）检索客户端
 *
 * ── 它是什么 ────────────────────────────────────────────────────
 * https://agent.zlb.ink/api/mcp/ 提供的只读知识检索服务，覆盖原神 / 崩坏：星穹铁道 /
 * 绝区零 / 崩坏3 / 华夏古籍 / 千星奇域的**游戏原文、萌娘百科角色页、米游社攻略**。
 *
 * 真机实测（2026-11-07）：`akasha_search {world:"hsr", keyword:"克拉拉"}` 1.7 秒返回，
 * 同时命中萌娘「克拉拉(星穹铁道)」330 行、游戏内路人对话、过场提示、活动任务台词，
 * 且每条都带行号与片段。比单抓萌娘 HTML 稳得多——后者被 Cloudflare 拦（403）。
 *
 * ── 协议 ────────────────────────────────────────────────────────
 * MCP over HTTP，**无状态**：响应是纯 application/json，不带 Mcp-Session-Id，
 * 所以不需要实现 initialize / session 管理，直接 POST tools/call 即可。
 * 不引入 MCP SDK——就一个 fetch，加一层工具调用的封装。
 *
 * ── 边界 ────────────────────────────────────────────────────────
 * · API Key 可选：不填也能用（额度低），填了额度高。走 env `AKASHA_API_KEY`。
 * · 只做检索与读取，不写任何远端状态。
 * · 任何失败都返回 null / 空，由调用方决定降级，不向上抛。
 */

const MCP_URL = 'https://agent.zlb.ink/api/mcp/';
const DEFAULT_TIMEOUT_MS = 12000;

/** 作品上下文 → 虚空终端的 world 标识 */
const WORLD_PATTERNS = [
  [/崩坏\s*[：:]\s*星穹铁道|星穹铁道|星铁|honkai[:\s]*star\s*rail/i, 'hsr'],
  [/原神|genshin/i, 'gi'],
  [/绝区零|zenless/i, 'zzz'],
  [/崩坏\s*3|honkai\s*impact\s*3/i, 'bh3'],
  [/华夏古籍|古籍|论语|诗经|史记|千星奇域/i, 'guji'],
];

/** 从作品上下文推断 world；认不出返回 null（调用方据此跳过） */
export function worldFromContext(context) {
  const text = String(context || '');
  if (!text) return null;
  for (const [pattern, world] of WORLD_PATTERNS) {
    if (pattern.test(text)) return world;
  }
  return null;
}

/**
 * 调一个 MCP 工具，返回它拼好的文本。
 * @returns {Promise<string>} 空串表示服务端没给内容
 */
async function callTool(name, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Accept': 'application/json, text/event-stream',
  };
  const apiKey = String(process.env.AKASHA_API_KEY || '').trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`akasha HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'akasha error');
  return (data.result?.content || [])
    .map(part => part?.text)
    .filter(Boolean)
    .join('\n');
}

/**
 * 从 akasha_search 的文本输出里挑出最值得读的那份文档。
 *
 * 输出形如：
 *   书名 3
 *   - 克拉拉 | doc_xxx | 56行 | 文件目录=ingame_zh/07-路人对话/...
 *   内容 3
 *   - 克拉拉(星穹铁道) | doc_49544a14c261 | 330行 | 文件目录=moegirl/百科学习笔记
 *
 * 选法：优先萌娘百科的角色页（就是角色资料本体），否则取行数最多的那份。
 */
function pickBestDoc(text) {
  const docs = [];
  const lineRe = /^-\s*([^|]+?)\s*\|\s*(doc_[0-9a-f]+)\s*\|\s*(\d+)\s*行\s*(?:\|\s*文件目录=(.+))?$/gim;
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    docs.push({
      title: m[1].trim(),
      pathHash: m[2],
      lines: Number(m[3]) || 0,
      folder: (m[4] || '').trim(),
    });
  }
  if (!docs.length) return null;
  const isMoegirl = d => /moegirl|百科/i.test(d.folder) || /\(.+\)$/.test(d.title);
  const best = docs.find(isMoegirl) || docs.slice().sort((a, b) => b.lines - a.lines)[0];
  return best;
}

/**
 * 检索一个关键词并读取命中量最大的那份文档。
 *
 * @param {string} keyword 角色名/地名/任务名等实体词
 * @param {string} context 作品名（用于确定 world）
 * @param {object} [options]
 * @param {number} [options.maxResults] 检索返回的候选文档数
 * @param {number} [options.readLines] 读取正文的最大行数
 * @returns {Promise<{title:string, content:string, source:string}|null>}
 */
export async function searchAkasha(keyword, context, { maxResults = 4, readLines = 120 } = {}) {
  const world = worldFromContext(context);
  if (!world || !keyword) return null;

  try {
    const searchText = await callTool('akasha_search', { world, keyword, maxResults });
    const best = pickBestDoc(searchText);
    if (!best) {
      console.log(`[akasha] ${world}/${keyword}: 没有命中文档`);
      return null;
    }

    let body = '';
    try {
      body = await callTool('akasha_read', { world, pathHash: best.pathHash, offset: 1, limit: readLines });
    } catch (err) {
      console.warn(`[akasha] 读取 ${best.title} 失败: ${err.message}`);
    }

    // 读取失败就退回搜索片段本身（至少还有带行号的命中内容）
    const content = (body || searchText).trim();
    if (content.length < 80) return null;

    console.log(`[akasha] ${world}/${keyword} → 「${best.title}」${best.lines} 行，取回 ${content.length} 字符`);
    return {
      title: best.title,
      content: content.slice(0, 8000),
      source: `虚空终端·${world}·${best.folder || best.title}`,
    };
  } catch (err) {
    console.warn(`[akasha] 检索失败（不影响其它源）: ${err.message}`);
    return null;
  }
}
