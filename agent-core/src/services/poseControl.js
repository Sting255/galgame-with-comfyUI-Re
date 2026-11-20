/**
 * poseControl.js — 把 Anima 姿态控制（Anima Control Pose）接进 ComfyUI 生图链路
 *
 * 为什么在 **API 格式**上注入，而不是另做一份工作流 json：
 *   · 现有工作流是 GUI 格式（nodes + links），手工往里插节点要同时维护 inputs/outputs/link id，
 *     任何一处对不上就静默出错；而 guiToApi 之后的结构就是 { id: { class_type, inputs } }，
 *     插节点 + 改一条连线即可，出问题能一眼看出来。
 *   · 开关关掉时这本模块完全不被调用，原有链路逐字节不变。
 *
 * 实测（2026-11-03，turbo 768×1024）：带姿势 14.4s / 不带 8.5s，姿势跟随准确。
 *
 * 节点链：
 *   UNETLoader → LoraLoaderModelOnly(姿态适配器) → AnimaControlApply → KSampler.model
 *   LoadImage → AnimaPoseControl → ImageScale → VAEEncode → AnimaControlApply.control_latent
 *
 * 2026-11-03 补：支持**直接喂骨架 JSON**（`applyPoseControlFromJson`）。
 *   AnimaPoseControl 的 detect() 写死只取第一个人（kp_all[0]），双人参考图检出的是残缺骨架，
 *   出图完全不跟随；改成跳过检测、直接喂 133 点坐标后精准跟随。所以体位推进走 JSON 这一支：
 *   节点链与上图一致，只是 AnimaPoseControl 吃 `{ pose_json, redetect: false }`、不建 LoadImage。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getComfyLorasRoot } from './imageSkill.js';

export const POSE_LORA_FILE = 'anima_pose_preview2.safetensors';
/** 体位骨架强制竖构图时的尺寸（实测能出完整双人构图的那一档） */
export const POSITION_POSE_PORTRAIT_WIDTH = 768;
export const POSITION_POSE_PORTRAIT_HEIGHT = 1024;

/**
 * 姿态适配器 LoRA 装没装。**定位不到 ComfyUI 根目录时一律当作装了**：
 * 异地 / 网络 ComfyUI 的 loras 目录本机看不见，误判成缺失会把骨架全禁掉。
 */
function loraGate() {
  const root = getComfyLorasRoot();
  if (!root) return null;
  try {
    const installed = fs.readdirSync(root, { recursive: true })
      .some(f => path.basename(String(f)) === POSE_LORA_FILE);
    if (installed) return null;
  } catch {
    return null;
  }
  console.warn(`[poseControl] 没找到姿态适配器 ${POSE_LORA_FILE}，跳过骨架注入，按无姿势出图`);
  return { applied: false, reason: 'pose-lora-missing' };
}

/** 节点 id 前缀：重复注入时先删旧的，保证幂等 */
const PREFIX = 'pose_ctl_';

function pickNode(apiPrompt, classType) {
  return Object.entries(apiPrompt).find(([, n]) => n && n.class_type === classType) || null;
}

/** 取一个输入的实际数值：数字直接用，连线则顺着找到上游 PrimitiveInt 之类节点的值。 */
function resolveNumberInput(apiPrompt, inputs, key) {
  const raw = inputs?.[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw) && raw.length === 2) {
    const src = apiPrompt[raw[0]];
    const candidate = src?.inputs?.value ?? src?.inputs?.int ?? src?.inputs?.number ?? src?.inputs?.Width ?? src?.inputs?.Height;
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function removePreviousInjection(apiPrompt) {
  for (const key of Object.keys(apiPrompt)) {
    if (key.startsWith(PREFIX)) delete apiPrompt[key];
  }
}

/**
 * 解析骨架 JSON：`{ canvas, points: [[x, y, score] × 133] }`。
 * 解析失败直接抛错（调用方兜底成「不注入姿势」，绝不带着坏 JSON 提交工作流）。
 * @returns {{ json: string, canvas: number }}
 */
function parsePoseJson(poseJson) {
  const raw = typeof poseJson === 'string' ? poseJson.trim() : poseJson;
  if (!raw || (typeof raw !== 'string' && typeof raw !== 'object')) {
    throw new Error('缺少姿势骨架 JSON');
  }
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`姿势骨架 JSON 解析失败：${err.message}`);
    }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.points)) {
    throw new Error('姿势骨架 JSON 缺少 points 数组');
  }
  const canvas = Number(data.canvas);
  return {
    // 原样透传给节点（字符串保持字符串，避免一进一出把坐标精度改掉）
    json: typeof raw === 'string' ? raw : JSON.stringify(data),
    canvas: Number.isFinite(canvas) && canvas > 0 ? canvas : 1024,
  };
}

/** 定位并校验关键节点；返回 ok=false 表示「这个模型不支持姿态控制」，不改工作流 */
function pickControlNodes(apiPrompt) {
  const unet = pickNode(apiPrompt, 'UNETLoader');
  const vae = pickNode(apiPrompt, 'VAELoader');
  const ks = pickNode(apiPrompt, 'KSampler');
  if (!unet || !vae || !ks) {
    throw new Error('工作流缺少 UNETLoader / VAELoader / KSampler，无法接入姿势控制');
  }
  // 姿态适配器只对 Anima 系主干有效，换别的模型必须明确拒绝，不能静默出一张没受控的图
  const unetName = String(unet[1].inputs?.unet_name || '');
  if (unetName && !/anima/i.test(unetName)) {
    return { ok: false, reason: `当前模型是 ${unetName}，姿态控制只支持 Anima 系模型` };
  }
  return { ok: true, unet, vae, ks };
}

/**
 * Scale → VAEEncode → 姿态适配器 LoRA → AnimaControlApply，并把 KSampler.model 换过去。
 * 参考图路径与骨架 JSON 路径共用这一段，改连线口径只改这里。
 */
function attachControlTail(apiPrompt, { unetKey, vaeKey, ks, width, height, strength }) {
  // 骨架直接拉伸到目标尺寸（与 latent 完全对齐）。
  // ⚠ 不要改成「等比缩放 + 补黑边」：实测补完黑边骨架在画面里变小一圈，模型基本不跟随；
  //   直接铺满画面（哪怕轻微变形）跟随效果明显更好。
  apiPrompt[`${PREFIX}scale`] = {
    class_type: 'ImageScale',
    inputs: { image: [`${PREFIX}detect`, 0], upscale_method: 'lanczos', width, height, crop: 'disabled' },
  };
  apiPrompt[`${PREFIX}vae`] = {
    class_type: 'VAEEncode',
    inputs: { pixels: [`${PREFIX}scale`, 0], vae: [vaeKey, 0] },
  };
  apiPrompt[`${PREFIX}lora`] = {
    class_type: 'LoraLoaderModelOnly',
    inputs: { model: [unetKey, 0], lora_name: POSE_LORA_FILE, strength_model: 1 },
  };
  apiPrompt[`${PREFIX}apply`] = {
    class_type: 'AnimaControlApply',
    inputs: {
      model: [`${PREFIX}lora`, 0],
      control_latent: [`${PREFIX}vae`, 0],
      control_embedder_path: POSE_LORA_FILE,
      strength: Math.min(2, Math.max(0, Number(strength) || 1)),
    },
  };
  // 把采样器的主模型换成「带姿态控制」的那一支
  ks[1].inputs.model = [`${PREFIX}apply`, 0];
}

/**
 * 直接用骨架 JSON 注入姿势控制（跳过图片检测）。
 *
 * 为什么必须走这条路：AnimaPoseControl 的 detect() 写死取 kp_all[0]，只认单个人 ——
 * 双人参考图检出来是残缺骨架，模型完全不理；而直接喂 133 点坐标（redetect=false）实测精准跟随。
 *
 * @param {object} apiPrompt guiToApi 的结果（会被就地修改）
 * @param {{ poseJson: string|object, strength?: number }} opts
 * @returns {{ applied: boolean, reason?: string, resolution?: number, width?: number, height?: number }}
 */
export function applyPoseControlFromJson(apiPrompt, { poseJson, strength = 1, portrait = false } = {}) {
  if (!apiPrompt || typeof apiPrompt !== 'object') throw new Error('工作流为空，无法接入姿势控制');
  // 先解析再动工作流：JSON 坏了就一个字节都不改，交给上层当作「无姿势」继续出图
  const parsed = parsePoseJson(poseJson);

  const gate = loraGate();
  if (gate) return gate;

  removePreviousInjection(apiPrompt);

  const nodes = pickControlNodes(apiPrompt);
  if (!nodes.ok) return { applied: false, reason: nodes.reason };
  const { unet, vae, ks } = nodes;

  // 宽高解析口径与参考图路径一致（本仓工作流的宽高是 PrimitiveInt 连线接进来的）
  const latent = pickNode(apiPrompt, 'EmptyLatentImage');
  let width = resolveNumberInput(apiPrompt, latent?.[1]?.inputs, 'width') ?? 768;
  let height = resolveNumberInput(apiPrompt, latent?.[1]?.inputs, 'height') ?? 1024;

  // 竖构图（2026-11-03 实测）：骨架是**铺满画布**的，横图会把身体横向舒展的体位（趴跪、侧卧）
  // 画成近景特写，竖图 768×1024 才是完整双人构图 —— 用户挑中的样张正是这个尺寸。
  // 只改这一张图的 latent（不动用户配置），横图才改，本来就是竖图的不动。
  if (portrait && width > height) {
    width = POSITION_POSE_PORTRAIT_WIDTH;
    height = POSITION_POSE_PORTRAIT_HEIGHT;
    if (latent) {
      latent[1].inputs.width = width;
      latent[1].inputs.height = height;
    }
  }

  // 骨架 JSON 自带坐标系，没有「参考图宽高比」这回事，不做尺寸校正
  const detectRes = parsed.canvas;

  apiPrompt[`${PREFIX}detect`] = {
    class_type: 'AnimaPoseControl',
    inputs: {
      style: 'R0_thin',
      hands: true,
      face: true,
      feet: true,
      redetect: false,          // 关键：喂坐标就必须关掉检测，否则节点会去读不存在的 image
      resolution: detectRes,
      pose_json: parsed.json,
    },
  };
  attachControlTail(apiPrompt, {
    unetKey: unet[0], vaeKey: vae[0], ks, width, height, strength,
  });

  return { applied: true, resolution: detectRes, width, height };
}

/**
 * 按当前设置决定要不要注入；注入失败不让生图整体失败，只记日志（否则聊天里配图会整条报错）。
 *
 * 优先级：调用方传来的骨架 JSON（体位推进）> 设置里的固定参考图。
 * 体位骨架是独立开关：传了 poseJson 就只看 `comfyui.poseFromPosition`，
 * 不受「固定参考图」的 poseControlEnabled / poseControlImage 影响。
 *
 * @param {object} apiPrompt
 * @param {{ poseJson?: string|object }} [opts]
 * @returns {{ applied: boolean, reason?: string }}
 */
export function maybeApplyPoseControl(apiPrompt, { poseJson } = {}) {
  const c = config.comfyui || {};

  const hasPoseJson = typeof poseJson === 'string'
    ? poseJson.trim().length > 0
    : !!(poseJson && typeof poseJson === 'object');

  if (hasPoseJson) {
    if (c.poseFromPosition === false) return { applied: false, reason: 'pose-from-position-disabled' };
    try {
      const r = applyPoseControlFromJson(apiPrompt, {
        poseJson,
        strength: c.poseControlStrength,
        portrait: c.poseFromPositionPortrait !== false,
      });
      if (r.applied) {
        console.log(`[poseControl] 已注入体位骨架（canvas ${r.resolution}，生成 ${r.width}x${r.height}）`);
      } else {
        console.warn(`[poseControl] 跳过体位骨架：${r.reason}`);
      }
      return r;
    } catch (err) {
      console.warn('[poseControl] 体位骨架注入失败，按无姿势出图：', err.message);
      return { applied: false, reason: err.message };
    }
  }

  // 2026-11-15 用户裁定：上传固定参考图那条路整块移除。
  // 原因是他实测「有参考也不绑定，根本没用」，而它的副作用很硬 —— 只要开关是开的，
  // 所有没带体位骨架的生图（聊天 / 朋友圈 / 事件 / 立绘）都会被套成同一张参考图的姿势。
  // 现在姿势控制只剩一种来源：亲密场景按当前体位现算骨架。
  return { applied: false, reason: 'no-position' };
}
