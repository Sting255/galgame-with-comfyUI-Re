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
 * · 安装是**幂等**的：目标已存在就保留，绝不覆盖用户自己装的版本。
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

function copyIfMissing(from, to, label, report) {
  if (fs.existsSync(to)) return;
  if (!fs.existsSync(from)) { report.skipped.push(`${label}（包里没有该资产）`); return; }
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // 2026-11-04：检查后另一个进程也可能写入，排他复制守住不覆盖的边界。
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    report.copied.push(label);
  } catch (err) {
    if (err.code === 'EEXIST') return;
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
      else if (entry.isFile()) {
        try { fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL); files += 1; }
        catch (err) { if (err.code !== 'EEXIST') throw err; }
      }
    }
  }
  report.copied.push(`${label}（${files} 个文件）`);
}

function copyDirIfMissing(from, to, label, report) {
  if (fs.existsSync(path.join(to, 'node.py'))) return; // 已经装过
  if (!fs.existsSync(from)) { report.skipped.push(`${label}（包里没有该资产）`); return; }
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
    report.skipped.push('没找到 ComfyUI 的 loras 目录：启动器里「ComfyUI 启动器路径」要填本机路径（绘世 exe / main.py / ComfyUI 目录都可以），不能填访问地址');
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

  report.ok = report.failed.length === 0 && report.skipped.length === 0;
  return report;
}

/**
 * 资产是否已经在目标 ComfyUI 里（把「没装」和「装了但 ComfyUI 还没重启」区分开）。
 *
 * 真机 2026-11-06：日志明明打了「已补装随包的姿势控制资产…（重启 ComfyUI 后生效）」，
 * 而运行状态面板还显示「未装 ComfyUI-anima-pose-control」—— 因为 ComfyUI 只在启动时
 * 加载自定义节点，资产到位 ≠ 节点可用。用户看到"未装"只会以为自动安装没做好。
 */
export function inspectPoseAssetPlacement() {
  const comfyRoot = resolveComfyRoot();
  if (!comfyRoot) return { placed: false, comfyRoot: null, nodeDir: '', reason: 'no-comfy-root' };
  const nodeDir = path.join(comfyRoot, 'custom_nodes', 'ComfyUI-anima-pose-control');
  let placed = false;
  try { placed = fs.existsSync(nodeDir); } catch { placed = false; }
  return { placed, comfyRoot, nodeDir, reason: placed ? 'installed-need-restart' : 'not-installed' };
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

// ── 分时重试（2026-11-06）──
// 真机现场：用户在另一台机器上启动时 ComfyUI 还没开（或启动器还没配 comfyui_exe），
// 启动那一次安装直接 skipped，之后**再也不会重试** —— 于是永远"没有 AnimaPoseControl 节点"，
// 姿势玩法整晚静默失效。资产其实就在包里（387MB），只是没人再去看一眼。
// 处理：每 30 分钟复查一次（已装时只是几次 existsSync，成本可忽略），装了就打一行日志提示重启 ComfyUI。
let watchTimer = null;
let lastReportKey = '';

export function startPoseControlAssetWatch({ intervalMs = 30 * 60 * 1000 } = {}) {
  if (watchTimer) return;
  const tick = () => {
    try {
      const r = ensurePoseControlAssets();
      const key = JSON.stringify([r.copied, r.failed, r.skipped]);
      if (key === lastReportKey) return;   // 状态没变就不刷屏
      lastReportKey = key;
      if (r.copied.length) {
        console.log(`[poseControl] 已补装随包的姿势控制资产：${r.copied.join('、')}`
          + '（重启 ComfyUI 后 AnimaPoseControl 才会被加载）');
      } else if (r.failed.length) {
        console.warn('[poseControl] 姿势控制资产补装失败（不影响出图）：', r.failed.join('；'));
      } else if (r.skipped.length) {
        console.log('[poseControl] 姿势控制资产暂未安装：', r.skipped.join('；'), '（30 分钟后再试）');
      }
    } catch (err) {
      console.warn('[poseControl] 资产复查跳过：', err?.message || err);
    }
  };
  tick();
  watchTimer = setInterval(tick, Math.max(60_000, Number(intervalMs) || 30 * 60 * 1000));
  watchTimer.unref?.();   // 后台复查不应吊住进程退出
}

export function stopPoseControlAssetWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}
