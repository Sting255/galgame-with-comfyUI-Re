/**
 * ComfyUI 本机安装目录的推导（唯一入口）。
 *
 * 为什么要有这个文件：同一件事（「启动器里填的 comfyui_exe 到底指向哪」）原来在三个地方
 * 各写了一遍，而且**项目根算错了一级**：
 *   · `services/imageSkill.js` 读 `<项目根>/../launcher_config.json`（退过头了，永远读不到）
 *   · `config.js` 读 `<项目根>/launcher_config.json`（对）
 *   · `routes/config.js` 读 `<项目根>/launcher_config.json`（对）
 * 结果就是用 python 直启 ComfyUI 的人会一直看到「姿势控制资产暂未安装：没找到 ComfyUI 路径」，
 * 明明启动器里早就填好了（2026-11-06 真机）。
 *
 * 这里同时兼容两种填法与两种包结构：
 *   填法：绘世启动器 exe（ComfyUI 在子目录）/ python 的 main.py / 直接填 ComfyUI 目录
 *   结构：launcher_config.json 在项目根（现行交付包）/ 在项目根上一级（历史包）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // agent-core/src/utils
const AGENT_CORE = path.resolve(HERE, '..', '..');
const PROJECT_ROOT = path.resolve(AGENT_CORE, '..');

/** 依次尝试的 launcher_config.json 位置（现行包 → 历史包） */
function launcherConfigCandidates() {
  return [
    path.join(PROJECT_ROOT, 'launcher_config.json'),
    path.resolve(PROJECT_ROOT, '..', 'launcher_config.json'),
  ];
}

/**
 * 读启动器配置。
 * @returns {{path: string, config: object}|null}
 */
export function readLauncherConfig() {
  for (const file of launcherConfigCandidates()) {
    try {
      return { path: file, config: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      // 文件不存在或内容坏了：试下一个
    }
  }
  return null;
}

/**
 * 推导 ComfyUI 安装根目录（即包含 models/ 的那一层）。
 *
 * 依次尝试三种布局，命中即用：
 *   ① `<exe 所在目录>/ComfyUI`（绘世整合包）
 *   ② `<exe 所在目录>`        （填了 main.py 或 ComfyUI 目录本身）
 *   ③ `<exe 所在目录>/..`      （填的是 ComfyUI 内部子目录）
 *
 * @returns {string|null} 绝对路径；推导不出来返回 null
 */
export function resolveComfyRoot() {
  const cfg = readLauncherConfig();
  const raw = String(cfg?.config?.comfyui_exe || '').trim();
  if (!raw) return null;

  const baseDirs = [];
  try {
    const stat = fs.statSync(raw);
    baseDirs.push(stat.isDirectory() ? raw : path.dirname(raw));
  } catch {
    // 路径不存在、或填的是 http 地址：仍按父目录试一次，交给 existsSync 判掉
    if (!/^[a-z]+:\/\//i.test(raw)) baseDirs.push(path.dirname(raw));
  }

  for (const base of baseDirs) {
    for (const candidate of [path.join(base, 'ComfyUI'), base, path.resolve(base, '..')]) {
      try {
        if (fs.statSync(path.join(candidate, 'models')).isDirectory()) return candidate;
      } catch {
        // 该候选不成立
      }
    }
  }
  return null;
}

/**
 * ComfyUI 内的某个子目录（如 models/loras、models/diffusion_models）。
 * @param {...string} segments
 * @returns {string|null} 目录存在返回绝对路径，否则 null
 */
export function resolveComfySubdir(...segments) {
  const root = resolveComfyRoot();
  if (!root) return null;
  const target = path.join(root, ...segments);
  try {
    return fs.statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

/** 诊断用：列出推导时试过的路径与配置来源（日志里能直接看出为什么失败） */
export function describeComfyPathFailure() {
  const cfg = readLauncherConfig();
  if (!cfg) return 'launcher_config.json 不存在（试过项目根与其上一级）';
  const raw = String(cfg.config?.comfyui_exe || '').trim();
  if (!raw) return `${cfg.path} 里的 comfyui_exe 为空`;
  return `comfyui_exe=${raw}（配置来源 ${cfg.path}），在其附近没找到含 models/ 的 ComfyUI 目录`;
}
