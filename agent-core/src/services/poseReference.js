/**
 * poseReference.js — 姿势参考图的落盘与清理
 *
 * ComfyUI 的 LoadImage 只认它自己 input/ 目录里的文件，所以用户上传的参考图
 * 必须先写成文件，再按**文件名**传给工作流。这个模块只管这一件事：
 *   ① 解析 input 目录（显式配置优先，配不上就报人话错误，不静默降级）
 *   ② data URL → png 落盘（固定前缀 + 短哈希命名）
 *   ③ 只保留最近 N 张，避免无限堆积
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { config } from '../config.js';

export const POSE_REF_PREFIX = 'linshe_pose_';
const MAX_KEEP = 8;

/** 当前生效的 ComfyUI input 目录；未配置返回空串（调用方据此报错）。 */
export function resolvePoseInputDir() {
  const configured = String(config.comfyui?.inputDir || '').trim();
  if (configured) return configured;
  // 没配置就不猜：ComfyUI 可能在另一台机器上，猜错只会得到一个「出图没姿势」的静默失败
  return '';
}

/** data URL 里允许的图片类型 → 扩展名 */
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * 只读文件头拿宽高（PNG 的 IHDR / JPEG 的 SOFn / WebP 的 VP8*）。
 * 姿势控制需要知道参考图的宽高比：横图会把竖构图骨架压扁，模型就不跟随了。
 * @returns {{ width: number, height: number } | null}
 */
export function readImageSize(buffer) {
  try {
    // PNG：8 字节签名 + 4 长度 + 4 类型，IHDR 里 16..24
    if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    // JPEG：扫 SOFn（C0-CF，排除 C4/C8/CC）
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) { i++; continue; }
        const marker = buffer[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
        }
        const len = buffer.readUInt16BE(i + 2);
        i += 2 + len;
      }
    }
    // WebP（VP8X / VP8 / VP8L）
    if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buffer.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      if (fmt === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const b = buffer.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch { /* 解析失败就当未知 */ }
  return null;
}

/**
 * 把姿势参考图存进 ComfyUI 的 input 目录，返回可直接交给 LoadImage 的文件名。
 * @param {string} dataUrl `data:image/png;base64,...`
 * @returns {{ name: string }}
 */
export function savePoseReference(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw Object.assign(new Error('姿势参考图必须是图片（PNG / JPG / WEBP）'), { status: 400 });
  }
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) throw Object.assign(new Error('姿势参考图格式不支持'), { status: 400 });

  const dir = resolvePoseInputDir();
  if (!dir) {
    throw Object.assign(new Error('未配置 ComfyUI 的 input 目录（设置 → 生图 → 姿势参考），无法保存参考图'), { status: 400 });
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < 512) throw Object.assign(new Error('姿势参考图内容为空'), { status: 400 });
  if (buffer.length > 12 * 1024 * 1024) throw Object.assign(new Error('姿势参考图不能超过 12MB'), { status: 400 });

  const ext = MIME_EXT[match[1]] || 'png';
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 12);
  const name = `${POSE_REF_PREFIX}${hash}.${ext}`;
  const full = path.join(dir, name);
  if (!existsSync(full)) writeFileSync(full, buffer);

  prunePoseReferences(dir, name);
  const size = readImageSize(buffer);
  return { name, width: size?.width || 0, height: size?.height || 0 };
}

/** 只保留最近 MAX_KEEP 张姿势参考图（含刚存的那张），其余删掉。 */
export function prunePoseReferences(dir, keepName) {
  let entries;
  try {
    entries = readdirSync(dir).filter(f => f.startsWith(POSE_REF_PREFIX));
  } catch {
    return;
  }
  if (entries.length <= MAX_KEEP) return;
  const sorted = entries
    .map(f => {
      let mtime = 0;
      try { mtime = statSync(path.join(dir, f)).mtimeMs; } catch { /* 忽略 */ }
      return { f, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of sorted.slice(MAX_KEEP)) {
    if (f === keepName) continue;
    try { unlinkSync(path.join(dir, f)); } catch { /* 忽略 */ }
  }
}
