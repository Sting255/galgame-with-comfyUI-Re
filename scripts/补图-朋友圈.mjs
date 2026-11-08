/**
 * 批量补朋友圈配图（2026-11-08）
 *
 * 为什么要有它：2026-11-08 那次 `promptWithIdentity is not defined` 让一批朋友圈帖子
 * 一张图都没生成出来。代码修好只对「之后」的发帖生效，已经落库的帖子不会自己补 ——
 * 界面上每张没图的卡片有「重新生成图片」，点八次太麻烦，这里一次补完。
 *
 * 前提（缺一个都跑不动）：
 *   1. 应用已经用修好的代码启动（旧代码的补图请求本身就会崩，见上面那个 ReferenceError）
 *   2. ComfyUI 开着（默认端口 8199，与 agent-core 的 COMFYUI_URL 一致）
 *
 * 用法（在仓库根目录）：
 *   runtime/nodejs/node.exe scripts/补图-朋友圈.mjs                 # 最近 1000 条里没图的全补
 *   runtime/nodejs/node.exe scripts/补图-朋友圈.mjs --ids 189,190   # 只补这几条
 *   runtime/nodejs/node.exe scripts/补图-朋友圈.mjs --limit 30 --dry-run
 *   runtime/nodejs/node.exe scripts/补图-朋友圈.mjs --base http://127.0.0.1:3199
 *
 * 参数：
 *   --base <url>    后端地址，默认 http://127.0.0.1:3099
 *   --ids <a,b,c>   只处理指定帖子 id
 *   --limit <n>     只看最近 n 条，默认 1000（与 /api/moments 上限一致）
 *   --delay <ms>    两次补图之间的间隔，默认 800
 *   --dry-run       只列出会补哪些，不发请求
 *
 * 退出码：0 全部成功；1 有失败（明细会逐条打印）
 */

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : fallback;
};
const BASE = String(getArg('base', process.env.API_BASE || 'http://127.0.0.1:3099')).replace(/\/+$/, '');
const ONLY_IDS = String(getArg('ids', ''))
  .split(',')
  .map(v => Number(String(v).trim()))
  .filter(v => Number.isFinite(v) && v > 0);
const LIMIT = Math.max(1, Math.min(Number(getArg('limit', '1000')) || 1000, 1000));
const DELAY = Math.max(0, Number(getArg('delay', '800')) || 0);
const DRY_RUN = args.includes('--dry-run');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function imagesOf(post) {
  const raw = post?.images;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const detail = body?.error || body?.message || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body;
}

const main = async () => {
  let posts;
  try {
    const list = await fetchJson(`${BASE}/api/moments?limit=${LIMIT}`);
    posts = Array.isArray(list?.posts) ? list.posts : [];
  } catch (err) {
    console.error(`✗ 连不上后端 ${BASE}：${err.message}`);
    console.error('  先把邻舍启动起来（用修好的代码），再跑这个脚本。');
    process.exit(1);
  }

  const candidates = (ONLY_IDS.length
    ? posts.filter(p => ONLY_IDS.includes(Number(p.id)))
    : posts.filter(p => imagesOf(p).length === 0))
    .sort((a, b) => Number(a.id) - Number(b.id));

  if (!candidates.length) {
    console.log(`没有需要补图的帖子（扫了 ${posts.length} 条${ONLY_IDS.length ? `，指定 id 里没找到` : ''}）`);
    return 0;
  }

  console.log(`待补 ${candidates.length} 条：${candidates.map(p => p.id).join(', ')}`);
  if (DRY_RUN) {
    for (const p of candidates) {
      console.log(`  · #${p.id} ${String(p.created_at || '').slice(0, 16)} 作者=${p.character_id ?? `npc:${p.npc_id}`}`);
    }
    console.log('（--dry-run：什么都没发）');
    return 0;
  }

  let ok = 0;
  const failed = [];
  for (const [index, post] of candidates.entries()) {
    const at = `[${index + 1}/${candidates.length}] #${post.id}`;
    const startedAt = Date.now();
    try {
      const res = await fetchJson(`${BASE}/api/moments/${post.id}/regenerate-image`, { method: 'POST' });
      const count = Array.isArray(res?.images) ? res.images.length : 0;
      ok += 1;
      console.log(`✓ ${at} 出图 ${count} 张，${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    } catch (err) {
      failed.push({ id: post.id, error: err.message });
      console.log(`✗ ${at} ${err.message}`);
    }
    if (index < candidates.length - 1 && DELAY) await sleep(DELAY);
  }

  console.log(`\n完成：成功 ${ok} 条，失败 ${failed.length} 条`);
  if (failed.length) {
    for (const item of failed) console.log(`  · #${item.id} ${item.error}`);
    console.log('  失败多与 ComfyUI 没开 / 模型没加载完有关：先把 ComfyUI 起起来再重跑。');
    return 1;
  }
  return 0;
};

main().then(code => process.exit(code)).catch(err => {
  console.error('✗ 脚本异常：', err?.message || err);
  process.exit(1);
});
