/**
 * poseControlInstall.js — 体位骨架所需的 ComfyUI 侧资产**随包自带、启动时自动安装**
 *
 * ## 为什么要有这个模块（2026-11-03 用户口径）
 * 「别的机器没有指定的文件或者的节点 你就直接包含在里面 用的时候调用就行了 这样多方便
 *   还不用单独再写一份文件」
 *
 * 姿势控制不是纯后端能力：它依赖 ComfyUI 那一侧的三样东西 ——
 *   ① 自定义节点 `ComfyUI-anima-pose-control`（提供 AnimaPoseControl / AnimaControlApply 两个节点）
 *   ② 姿态适配器 LoRA `anima_pose_preview2.safetensors`
 *   ③ rtmlib 的两个 ONNX 检测模型（yolox 检测人 + rtmw 提 133 关键点）
 * 少任何一样，要么注入后 ComfyUI 直接 400 `missing_node_type`（整张图生不出来），
 * 要么节点在但检测器下载失败。用户在另一台机器上就撞过第一种。
 *
 * ## 设计取舍
 * · 资产放仓库 `assets/pose-control/`（**不进 git**，405MB 二进制；但会随交付包同步过去）。
 * · 安装是**幂等**的：目标已存在且大小一致就跳过，绝不覆盖用户自己装的版本。
 * · 找不到 ComfyUI 路径就**什么都不做**（不能猜路径乱写人家磁盘）。
 * · 任何失败只 warn：装不上只意味着"没有体位姿势"，绝不能影响出图主链路。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getComfyLorasRoot } from './imageSkill.js';
import { POSE_LORA_FILE } from './poseControl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（agent-core/src/services → 上三级） */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
/** 随包自带的资产目录 */
export const BUNDLED_ASSETS_DIR = path.join(REPO_ROOT, 'assets', 'pose-control');

/** rtmlib 的模型缓存目录（与 ComfyUI-anima-pose-control/detect.py 的口径一致） */
function rtmlibCheckpointDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'rtmlib', 'hub', 'checkpoints');
}

/**
 * 从启动器配置推断 ComfyUI 根目录（`models/loras` 的上一级）。
 * 复用 imageSkill.getComfyLorasRoot 的定位口径，避免两套猜测逻辑。
 * @returns {string|null}
 */
export function resolveComfyRoot() {
  const loras = getComfyLorasRoot();
  if (!loras) return null;
  return path.resolve(loras, '..', '..');
}

function sameSize(a, b) {
  try { return fs.statSync(a).size === fs.statSync(b).size; } catch { return false; }
}

function copyIfMissing(from, to, label, report) {
  if (!fs.existsSync(from)) { report.skipped.push(`${label}（包里没有该资产）`); return; }
  if (sameSize(from, to)) return; // 已装好
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    report.copied.push(label);
  } catch (err) {
    report.failed.push(`${label}：${err.message}`);
  }
}

/**
 * 手写递归复制。
 *
 * ⚠️ 2026-11-03 真机踩到：`fs.cpSync` 在本机（Windows + 中文路径 + Node 22）会**静默终止进程**
 * —— 连 try/catch 都拦不住、没有任何报错，`console.log` 之后的代码一行都不执行。
 * 交付包要在别人机器上跑，不能赌这个 API，所以自己走 readdir + copyFileSync。
 */
function copyTree(from, to, report, label) {
  const stack = [[from, to]];
  let files = 0;
  while (stack.length) {
    const [src, dst] = stack.pop();
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) stack.push([s, d]);
      else if (entry.isFile()) { fs.copyFileSync(s, d); files += 1; }
    }
  }
  report.copied.push(`${label}（${files} 个文件）`);
}

function copyDirIfMissing(from, to, label, report) {
  if (!fs.existsSync(from)) { report.skipped.push(`${label}（包里没有该资产）`); return; }
  if (fs.existsSync(path.join(to, 'node.py'))) return; // 已经装过
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    copyTree(from, to, report, label);
  } catch (err) {
    report.failed.push(`${label}：${err.message}`);
  }
}

/**
 * 把随包资产装进目标 ComfyUI（幂等）。
 *
 * @param {{comfyRoot?: string|null, bundledDir?: string, rtmlibDir?: string, dryRun?: boolean}} [opts]
 * @returns {{ok:boolean, comfyRoot:string|null, copied:string[], skipped:string[], failed:string[]}}
 */
export function ensurePoseControlAssets({ comfyRoot, bundledDir, rtmlibDir, dryRun = false } = {}) {
  const root = comfyRoot === undefined ? resolveComfyRoot() : comfyRoot;
  const src = bundledDir || BUNDLED_ASSETS_DIR;
  const report = { ok: true, comfyRoot: root || null, copied: [], skipped: [], failed: [] };

  if (!root) {
    report.ok = false;
    report.skipped.push('没找到 ComfyUI 路径（启动器里没配 comfyui_exe）');
    return report;
  }
  if (!fs.existsSync(src)) {
    report.ok = false;
    report.skipped.push('包里没有 assets/pose-control（轻量分发包可能不带）');
    return report;
  }
  if (dryRun) return report;

  // ① 自定义节点
  copyDirIfMissing(
    path.join(src, 'custom_nodes', 'ComfyUI-anima-pose-control'),
    path.join(root, 'custom_nodes', 'ComfyUI-anima-pose-control'),
    '自定义节点 ComfyUI-anima-pose-control',
    report,
  );
  // ② 姿态 LoRA
  copyIfMissing(
    path.join(src, 'models', 'loras', POSE_LORA_FILE),
    path.join(root, 'models', 'loras', POSE_LORA_FILE),
    `姿态适配器 ${POSE_LORA_FILE}`,
    report,
  );
  // ③ rtmlib 检测模型（节点首次运行时要从这里读，否则会去联网下载）
  const ckptDir = rtmlibDir || rtmlibCheckpointDir();
  const detectorDir = path.join(src, 'detectors');
  if (fs.existsSync(detectorDir)) {
    for (const name of fs.readdirSync(detectorDir)) {
      if (!name.endsWith('.onnx')) continue;
      copyIfMissing(path.join(detectorDir, name), path.join(ckptDir, name), `检测模型 ${name}`, report);
    }
  }

  report.ok = report.failed.length === 0;
  return report;
}

/** 启动时调用：只做一次、只打一行日志、绝不影响启动 */
export function ensurePoseControlAssetsOnBoot() {
  try {
    const r = ensurePoseControlAssets();
    if (r.copied.length) {
      console.log(`[poseControl] 已把随包的姿势控制资产装进 ComfyUI：${r.copied.join('、')}`
        + '（首次生效需要重启 ComfyUI 让自定义节点被加载）');
    } else if (r.failed.length) {
      console.warn('[poseControl] 姿势控制资产安装失败（不影响出图）：', r.failed.join('；'));
    }
    return r;
  } catch (err) {
    console.warn('[poseControl] 姿势控制资产检查跳过：', err?.message || err);
    return { ok: false, comfyRoot: null, copied: [], skipped: [], failed: [String(err?.message || err)] };
  }
}
