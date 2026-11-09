// 相册缓存（独立服务，避免每次请求都 readdir + stat 阻塞事件循环）。
// 生图/删图等操作通过 invalidateGalleryCache() 失效缓存；
// 服务层与路由层都从这里导入，不再出现 service → route 的反向依赖。
//
// ── 2026-11-09（方案 B09）补的三件事 ──────────────────────────────
//
// 1. **共享刷新 Promise**：原来并发 10 个首屏请求会各跑一遍全目录扫描
//    （readdir + 每文件 stat），磁盘和事件循环都被白烧 10 次。
//    现在同时只有一个扫描在跑，其余请求 await 同一个 Promise。
//
// 2. **失效 generation**：扫描开始记下当时的 generation，扫描结束若 generation 变了
//    （期间有图被写入/删除），这一批结果就是过期的 —— 不写进缓存，让下一次请求重扫。
//    没有这道判断时，「扫描到一半删了张图」会把已删的图重新写回缓存，最长骗 30 秒。
//
// 3. **失败不毁旧快照**：目录读取失败时保留上一次的可用数据并记录错误，
//    而不是把整个相册变成空的。单文件 stat 失败只跳过该文件。
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { getAllImageDirs } from './imagePaths.js';

export const galleryCache = {
  data: null,       // { images: [...], total: number }
  mtime: 0,         // 缓存创建时间
  ttl: 30_000,      // 30 秒 TTL（生图不频繁，短缓存已足够）
  generation: 0,    // 每次失效 +1；扫描用它判断结果是否已过期
  lastError: null,  // 最近一次扫描的失败原因（成功时清空）
};

/** 正在进行的扫描。并发请求共用它，不各扫一遍。 */
let refreshing = null;

/** 扫描单个目录，返回带 folder 标记的图片列表 */
async function scanDirectory(dirPath, category, urlPrefix) {
  let files;
  try {
    files = await readdir(dirPath);
  } catch (err) {
    // 目录不存在是正常情况（该类别还没出过图），不算错误；
    // 其它错误（权限、磁盘）要记下来，但**不要**因此丢掉整个相册。
    if (err?.code !== 'ENOENT') {
      console.warn(`[gallery] 扫描目录失败 ${dirPath}: ${err.message}`);
      galleryCache.lastError = err.message;
    }
    return [];
  }

  const imageFiles = files.filter(f => /\.(png|jpg|jpeg|webp|gif|avif)$/i.test(f));
  if (imageFiles.length === 0) return [];

  const BATCH_SIZE = 64;
  const results = [];
  for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
    const batch = imageFiles.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (name) => {
        try {
          const s = await stat(join(dirPath, name));
          return { name, size: s.size, mtime: s.mtimeMs, folder: category, url: `${urlPrefix}/${name}` };
        } catch {
          // 扫描过程中这个文件被删了 / 被改名了：跳过它，不影响其它文件
          return null;
        }
      })
    );
    for (const r of batchResults) if (r) results.push(r);
  }
  return results;
}

/** 刷新相册缓存：扫描所有子目录 + 历史平铺目录，批量 stat */
// 相册里不出现的目录：道具是背包图标等游戏素材，不是「留影」。
// 注意只在相册层排除：图片压缩等其它调用方仍然要处理它们。
const GALLERY_EXCLUDED_CATEGORIES = new Set(['items']);

/**
 * 刷新相册缓存。
 *
 * 并发调用共用同一次扫描（`refreshing`）；扫描期间若有失效发生，
 * 本次结果不写缓存 —— 那批数据已经不代表磁盘现状了。
 */
export function refreshGalleryCache() {
  if (refreshing) return refreshing;
  refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh() {
  const generationAtStart = galleryCache.generation;
  const dirs = getAllImageDirs();
  const allResults = [];

  for (const { category, dir, urlPrefix } of dirs) {
    if (GALLERY_EXCLUDED_CATEGORIES.has(category)) continue;
    const results = await scanDirectory(dir, category, urlPrefix);
    allResults.push(...results);
  }

  allResults.sort((a, b) => b.mtime - a.mtime);

  // 扫描期间有图写入/删除 → 这批结果已经过期，不写缓存（下次请求重扫）。
  // 不写缓存也不会让调用方拿不到数据：本次结果照样返回给它用，
  // 只是不进共享快照，避免把已删的图又写回缓存骗 30 秒。
  const stale = galleryCache.generation !== generationAtStart;

  if (!stale) {
    galleryCache.data = { images: allResults, total: allResults.length };
    galleryCache.mtime = Date.now();
    galleryCache.lastError = null;
  } else {
    console.log('[gallery] 扫描期间有图片变动，本批结果不写入缓存');
  }

  return { images: allResults, total: allResults.length, stale };
}

/** 当新图片生成/删除后调用，使缓存失效 */
export function invalidateGalleryCache() {
  galleryCache.data = null;
  galleryCache.mtime = 0;
  galleryCache.generation++;
}

/**
 * 取图库快照：缓存有效就直接用，否则刷新。
 * 路由层统一走这里，别再自己判 mtime + 调 refresh。
 */
export async function getGallerySnapshot() {
  if (galleryCache.data && Date.now() - galleryCache.mtime <= galleryCache.ttl) {
    return galleryCache.data;
  }
  const result = await refreshGalleryCache();
  // 过期批次也要能返回给当前请求（它比什么都没有更接近现状）
  return { images: result.images, total: result.total };
}
