/**
 * 图像生成 Skill
 *
 * 流程:
 *   1. 接收 {"prompt":"..."} 中的中文画面描述
 *   2. 按条件注入参数（画师串/质量提示词/画面描述/宽/高/lora）
 *   3. 提交 ComfyUI → 轮询 → 下载 base64
 *   4. 兜底: 本地 output/bot/ 文件夹
 *
 * Lora 加载方式:
 *   不再使用 Lora Loader (LoraManager) 节点 + <lora:xxx:1> 标签
 *   改为动态注入 ComfyUI 官方 LoraLoaderModelOnly 节点
 *   多个 lora 通过堆叠多个 LoraLoaderModelOnly 节点实现
 *   链路: UNETLoader → Lora1 → Lora2 → ... → KSampler
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { submitWorkflow, apiToGui } from './comfyClient.js';
import { POSE_LORA_FILE } from './poseControl.js';
import { config, getNovelaiApiKey } from '../config.js';
import { generateNovelaiImage } from './novelaiClient.js';
import { acquireSlot, releaseSlot } from './llmConcurrency.js';
import { prepareImagePrompt } from './imagePromptPreparer.js';
import { createSoftState } from './softStateStore.js';
import { stripImagePromptRuleEcho } from '../utils/groupImagePrompt.js';
import { getIdentityAnchorForPrompt, applyIdentityAnchorToPrompt } from './identityAnchor.js';
import { resolveComfySubdir } from '../utils/comfyPaths.js';

const _limitEnabled = () => config.features.serializeBackgroundLLM;
import { ACTIVE_WORKFLOW, PRO_WORKFLOW, checkWorkflowHealth, resolveCustomWorkflowPath } from './workflowTemplates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(__dirname, '..', '..', '..', 'workflow');
const BASE_WORKFLOW_PATH = path.join(WORKFLOW_DIR, ACTIVE_WORKFLOW);
const PRO_WORKFLOW_PATH = path.join(WORKFLOW_DIR, PRO_WORKFLOW);

let lastUsedWorkflowMode = (config.workflow?.mode === 'base') ? 'base' : 'turbo';

function pathToMode(wfPath) {
  const name = path.basename(wfPath);
  if (name === PRO_WORKFLOW) return 'base';
  if (name === ACTIVE_WORKFLOW) return 'turbo';
  // 自定义工作流：以文件名本身作为标识，供 image_tasks.workflow_template 记录、HiresFix 继承
  return name;
}

export function getLastWorkflowMode() {
  return lastUsedWorkflowMode;
}

/** Freeze the configurable inputs for a multi-image batch without changing global settings. */
export function captureImageGenerationConfig(scene, workflowScene = null) {
  return {
    customWorkflow: path.basename(resolveWorkflowPath(workflowScene)),
    globalLoraSnapshot: structuredClone(filterGlobalLoras(config.comfyui.globalLora || [], scene)),
    qualityPrompt: config.comfyui.qualityPrompt || '',
    negativePrompt: config.comfyui.negativePrompt || '',
  };
}

export { checkWorkflowHealth };

/**
 * 根据全局模式和场景选择工作流文件
 * @param {'chat'|'group'|'portrait'|'moments'|'events'|'schedule'|'mailbox'|'sticker'} [scene]
 * @returns {string} 工作流文件路径
 */
function resolveWorkflowPath(scene) {
  const mode = config.workflow?.mode || 'turbo';
  if (mode === 'turbo') return BASE_WORKFLOW_PATH;
  if (mode === 'base') return PRO_WORKFLOW_PATH;

  // custom: 全局自定义工作流（workflow/ 下的文件）；模板被删/改名时回退 turbo，生图不中断
  if (mode === 'custom') {
    const custom = resolveCustomWorkflowPath(config.workflow?.customTemplate);
    if (custom) return custom;
    console.warn(`[imageSkill] 自定义工作流 "${config.workflow?.customTemplate || ''}" 不存在，回退 turbo`);
    return BASE_WORKFLOW_PATH;
  }

  // hybrid: 根据场景选择
  if (mode === 'hybrid' && scene) {
    const scenePref = config.workflow.scene?.[scene] || 'turbo';
    return scenePref === 'base' ? PRO_WORKFLOW_PATH : BASE_WORKFLOW_PATH;
  }
  // hybrid + 无 scene: 沿用上一次实际使用的模式
  return lastUsedWorkflowMode === 'base' ? PRO_WORKFLOW_PATH : BASE_WORKFLOW_PATH;
}

const PROMPT_PLACEHOLDER = '请输入画面描述';

/**
 * 角色级负面提示词的长度上限（字符）。负面词过长会挤占 CLIP 的 77-token 窗口，
 * 把真正该排除的特征挤掉，等于越写越差；200 字符足够写 15~20 个 tag。
 */
const MAX_CHARACTER_NEGATIVE = 200;

/**
 * 合并最终负面提示词：角色级在前，全局在后。
 * 顺序有意义 —— 靠前的 tag 更容易被模型当主体约束读到；角色级更具体，理应优先。
 * 两者都空时返回空串（调用方据此不覆盖工作流里的默认负面词，保持旧行为）。
 * @param {string} characterNegative 角色级负面词
 * @param {string} globalNegative 全局负面词
 * @returns {string}
 */
export function composeNegativePrompt(characterNegative, globalNegative) {
  const role = typeof characterNegative === 'string'
    ? characterNegative.trim().slice(0, MAX_CHARACTER_NEGATIVE)
    : '';
  const base = typeof globalNegative === 'string' ? globalNegative.trim() : '';
  return [role, base].filter(Boolean).join(', ');
}

// 按节点 title 注入参数（而非硬编码节点 ID）
export const NODE_TITLES = {
  artist: '画师串',
  quality: '质量提示词',
  negative: '负面提示词',
  width:  '图片的宽',
  height: '图片的长',
  prompt: '画面描述',
  loraTrigger: 'lora触发词',
};

/** 顺着 KSampler negative 输入找到源头 CLIPTextEncode 节点（跳过 Reroute），用于无 title 的工作流兜底 */
export function findNegativeEncodeNode(wf) {
  const sampler = wf.nodes.find(n => n.type === 'KSampler' || n.type === 'KSamplerAdvanced');
  if (!sampler) return null;
  const negInp = (sampler.inputs || []).find(i => i.name === 'negative');
  let linkId = negInp?.link;
  for (let hop = 0; linkId != null && hop < 10; hop++) {
    const link = (wf.links || []).find(l => l[0] === linkId);
    if (!link) return null;
    const src = wf.nodes.find(n => n.id === link[1]);
    if (!src) return null;
    if (src.type === 'Reroute') { linkId = src.inputs?.[0]?.link; continue; }
    return src.type === 'CLIPTextEncode' ? src : null;
  }
  return null;
}

async function submitNovelaiImage(promptText, { onProgress } = {}) {
  const novelaiArtist = String(config.comfyui.novelaiArtist || '').trim();
  const qualityPrompt = String(config.comfyui.novelaiQualityPrompt || '').trim();
  const finalPrompt = [qualityPrompt, novelaiArtist, finalizeCountTags(String(promptText || '').trim())]
    .filter(Boolean)
    .join(', ');
  if (!finalPrompt) throw new Error('画面描述为空');
  onProgress?.({ stage: 'submitting' });
  onProgress?.({ phase: 'submitted' });
  onProgress?.({ phase: 'started' });
  const settings = config.comfyui;
  const payload = await generateNovelaiImage(finalPrompt, {
    apiFormat: settings.novelaiApiFormat, url: settings.novelaiUrl,
    apiKey: getNovelaiApiKey(), proxyUrl: settings.novelaiProxyUrl,
    model: settings.novelaiModel, width: settings.novelaiWidth, height: settings.novelaiHeight,
    steps: settings.novelaiSteps, sampler: settings.novelaiSampler,
    noiseSchedule: settings.novelaiNoiseSchedule, scale: settings.novelaiGuidance,
    negativePrompt: settings.novelaiNegativePrompt || '',
  });
  const { images } = payload;
  onProgress?.({ phase: 'executed' });
  onProgress?.({ phase: 'done', imageCount: images.length, progress: 1 });
  return {
    success: true,
    images,
    source: 'novelai',
    promptId: payload.created || `novelai_${Date.now()}`,
    wfMode: 'novelai',
  };
}

/**
 * 按场景过滤全局 LoRA。
 * scenes 缺失或空数组 = 所有场景生效；currentScene 为空 = 不过滤。
 * @param {Array} loras - config.comfyui.globalLora
 * @param {string} [currentScene]
 * @returns {Array} 已归一化 path 的生效 LoRA
 */
export function filterGlobalLoras(loras, currentScene) {
  return (loras || [])
    .map(l => ({ ...l, path: normalizeLoraValue(l.path) }))
    .filter(l => {
      if (!l.path || typeof l.path !== 'string') return false;
      if (l.enabled === false) return false;
      if (!currentScene) return true;
      if (!Array.isArray(l.scenes) || l.scenes.length === 0) return true;
      return l.scenes.includes(currentScene);
    });
}

/**
 * 构建注入参数后的 workflow 副本
 *
 * @param {string}   promptText  - 优化后的画面描述
 * @param {object}   [overrides]
 * @param {string}   [overrides.artist]
 * @param {number}   [overrides.width]
 * @param {number}   [overrides.height]
 * @param {Array}    [overrides.loras]  - [{path, weight, triggerWord}]
 * @param {string}   [overrides.customWorkflow] - 自定义工作流文件名（单人时替代基础工作流）
 * @param {string}   [overrides.scene] - 全局 LoRA 的场景过滤；未指定 workflowScene 时也用于选择工作流
 * @param {string|null} [overrides.workflowScene] - hybrid 模式下单独用于选择工作流；
 *        显式传 null 表示不按场景选择（沿用上次模式），与 scene 解耦
 */
// ── 同场景种子（2026-11-06）──
// 真机问题：同一次亲密 / 同一轮群聊连出三张图，人物像换了个人。
// 扩散模型的随机性有一半来自 seed，固定它能让"同一个场景的连续几张图"保持同一张脸与同一套光影；
// 每张 +1 而不是完全相同，避免构图完全重复。
const SCENE_SEED_WINDOW_MS = 30 * 60 * 1000;
const sceneSeedState = new Map();   // sceneKey -> { base, used, at }

/**
 * 取同一个场景窗口内的稳定种子。
 * 连续的出图会滑动续期：只要间隔不超过 30 分钟，就一直沿用同一个 base。
 * @param {string} sceneKey 场景标识（如 `intimate:12:345`、`group:2:678`）；空值返回 null（保持原随机行为）
 * @returns {number|null}
 */
export function resolveSceneSeed(sceneKey) {
  const key = String(sceneKey || '').trim();
  if (!key) return null;
  const now = Date.now();
  let entry = sceneSeedState.get(key);
  if (!entry || now - entry.at > SCENE_SEED_WINDOW_MS) {
    entry = { base: Math.floor(Math.random() * 1_000_000_000), used: 0, at: now };
    sceneSeedState.set(key, entry);
    if (sceneSeedState.size > 300) {
      for (const [k, v] of sceneSeedState) if (now - v.at > SCENE_SEED_WINDOW_MS) sceneSeedState.delete(k);
    }
  }
  entry.at = now;   // 续期：场景还在继续
  const seed = entry.base + entry.used;
  entry.used += 1;
  return seed;
}

function buildWorkflow(promptText, overrides = {}) {
  // 用 undefined 区分"没传"与"显式不按场景选工作流"：后者传 null
  const workflowScene = overrides.workflowScene !== undefined ? overrides.workflowScene : overrides.scene;
  let wfPath = overrides.customWorkflow
    ? (fs.existsSync(path.join(WORKFLOW_DIR, overrides.customWorkflow))
        ? path.join(WORKFLOW_DIR, overrides.customWorkflow)
        : resolveWorkflowPath(workflowScene))
    : resolveWorkflowPath(workflowScene);
  // 全局 LoRA 前置 + 角色 LoRA，按 path 去重（全局优先），关闭的 LoRA 跳过
  const globalLoras = overrides.globalLoraSnapshot ?? filterGlobalLoras(config.comfyui.globalLora || [], overrides.scene);
  const providedLoras = (overrides.loras || [])
    .map(l => ({ ...l, path: normalizeLoraValue(l.path) }))
    .filter(l => l.path && typeof l.path === 'string');
  const seen = new Set();
  const loras = [...globalLoras, ...providedLoras].filter(l => {
    if (seen.has(l.path)) return false;
    seen.add(l.path);
    return true;
  });
  const hasLoras = loras.length > 0;

  if (overrides.customWorkflow) {
    const customPath = path.join(WORKFLOW_DIR, overrides.customWorkflow);
    if (fs.existsSync(customPath)) {
      wfPath = customPath;
      console.log(`[imageSkill] Using custom workflow: ${overrides.customWorkflow}`);
    } else {
      console.warn(`[imageSkill] Custom workflow not found: ${overrides.customWorkflow}, using base workflow`);
    }
  }

  if (!fs.existsSync(wfPath)) {
    throw new Error(`Workflow not found: ${wfPath}`);
  }

  const workflow = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  let wf = apiToGui(workflow);
  if (!Array.isArray(wf.nodes)) {
    throw new Error(`Workflow "${path.basename(wfPath)}" is invalid: missing "nodes" array and could not be parsed as an API-format workflow. Please use ComfyUI's regular "Save" (not "Export (API)") to export the workflow.`);
  }
  wf = JSON.parse(JSON.stringify(wf));

  const defaults = {
    [NODE_TITLES.artist]: overrides.artist ?? config.comfyui.artist,
    [NODE_TITLES.width]:  overrides.width  ?? config.comfyui.width,
    [NODE_TITLES.height]: overrides.height ?? config.comfyui.height,
  };
  // 质量提示词：非空才覆盖工作流节点里的默认值，留空不注入
  const qualityValue = overrides.qualityPrompt ?? config.comfyui.qualityPrompt;
  const qualityPrompt = typeof qualityValue === 'string' ? qualityValue.trim() : '';
  if (qualityPrompt) defaults[NODE_TITLES.quality] = qualityPrompt;
  // 负面提示词：非空才覆盖工作流节点里的默认值，留空不注入
  const negativeValue = overrides.negativePrompt ?? config.comfyui.negativePrompt;
  const negativePrompt = composeNegativePrompt(overrides.characterNegative, negativeValue);
  if (negativePrompt) defaults[NODE_TITLES.negative] = negativePrompt;

  for (const node of wf.nodes || []) {
    if (!Array.isArray(node.widgets_values)) continue;

    // KSampler seed：同一场景窗口用稳定种子（sceneSeed），否则维持随机
    if (node.type === 'KSampler' && node.widgets_values.length > 1 && node.widgets_values[1] === 'randomize') {
      node.widgets_values[0] = Number.isSafeInteger(overrides.sceneSeed)
        ? overrides.sceneSeed
        : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }

    // lora触发词节点：注入所有 lora 的 triggerWord 拼接
    if (node.title === NODE_TITLES.loraTrigger && hasLoras) {
      const triggerWords = loras.map(l => l.triggerWord || '').filter(Boolean).join(', ');
      if (triggerWords) {
        node.widgets_values[0] = triggerWords;
      }
      continue;
    }

    // 画面描述节点：替换占位符，无占位符则写入第一个 widget
    if (node.title === NODE_TITLES.prompt) {
      const idx = node.widgets_values.findIndex(
        v => typeof v === 'string' && v.includes(PROMPT_PLACEHOLDER)
      );
      if (idx >= 0) {
        node.widgets_values[idx] = promptText;
      } else if (node.widgets_values.length > 0) {
        node.widgets_values[0] = promptText;
      }
      continue;
    }

    // 画师串 / 宽 / 高 / 质量提示词 / 负面提示词：替换第一个 widget
    const val = defaults[node.title];
    if (val !== undefined && node.widgets_values.length > 0) {
      node.widgets_values[0] = val;
    }
  }

  // 负面提示词兜底：存量工作流文件的负面 CLIPTextEncode 节点没有「负面提示词」title，
  // 顺着 KSampler negative 输入找到它并注入
  if (negativePrompt && !wf.nodes.some(n => n.title === NODE_TITLES.negative)) {
    const negNode = findNegativeEncodeNode(wf);
    if (negNode && Array.isArray(negNode.widgets_values) && negNode.widgets_values.length > 0) {
      negNode.widgets_values[0] = negativePrompt;
    }
  }

  // 动态注入 LoraLoaderModelOnly 节点链
  if (hasLoras) {
    injectLoraNodes(wf, loras);
  }

  console.log(`[imageSkill] Workflow built: ${path.basename(wfPath)} (${pathToMode(wfPath)})${hasLoras ? ` (${loras.length} lora(s))` : ''}`);
  lastUsedWorkflowMode = pathToMode(wfPath);
  return { wf, wfPath, wfMode: lastUsedWorkflowMode };
}

/**
 * 在工作流中动态插入 LoraLoaderModelOnly 节点
 * 链路: UNETLoader → Lora1 → Lora2 → ... → 原始下游节点
 * 自动适配：无论 UNETLoader 直连 KSampler 还是中间有用户插入的节点，都正确链入。
 * （放大细化 imageRefine.js 复用同一注入逻辑）
 */
export function injectLoraNodes(wf, loras) {
  const unetNode = wf.nodes.find(n => n.type === 'UNETLoader');
  const samplerNode = wf.nodes.find(n => n.type === 'KSampler' || n.type === 'UltimateSDUpscaleNoUpscale');

  if (!unetNode || !samplerNode) {
    console.warn('[imageSkill] Cannot inject lora nodes: UNETLoader or KSampler not found in workflow');
    return;
  }

  // 查找 UNETLoader MODEL 输出当前连到的节点
  const unetModelOutput = unetNode.outputs.find(o => o.name === 'MODEL');
  const oldLinkId = unetModelOutput?.links?.[0];

  if (!oldLinkId) {
    console.warn('[imageSkill] Cannot inject lora nodes: no MODEL link from UNETLoader');
    return;
  }

  // 从 links 中定位完整的 link 条目，获取原始下游节点
  const oldLink = wf.links.find(l => l[0] === oldLinkId);
  const downstreamNodeId = oldLink ? oldLink[3] : null;
  const downstreamNode = downstreamNodeId ? wf.nodes.find(n => n.id === downstreamNodeId) : null;

  if (!downstreamNode) {
    console.warn('[imageSkill] Cannot inject lora nodes: downstream node not found for link #' + oldLinkId);
    return;
  }

  const isDirectToSampler = downstreamNodeId === samplerNode.id;
  if (!isDirectToSampler) {
    console.log(`[imageSkill] UNETLoader MODEL has intermediate nodes before ${downstreamNode.type}#${downstreamNodeId}, lora chain will be inserted before them`);
  }

  // 删除 UNETLoader → 下游节点的旧 link
  wf.links = wf.links.filter(l => l[0] !== oldLinkId);

  // 清除下游节点的 model 输入 link
  const downstreamModelInput = downstreamNode.inputs.find(inp => inp.name === 'model');
  if (downstreamModelInput) downstreamModelInput.link = null;

  // 生成新 ID（确保不冲突）
  let maxNodeId = Math.max(wf.last_node_id || 0, ...(wf.nodes || []).map(n => n.id));
  let maxLinkId = Math.max(wf.last_link_id || 0, ...(wf.links || []).map(l => l[0]));

  const loraNodeIds = [];
  const outputLinkIds = [];

  for (let i = 0; i < loras.length; i++) {
    const lora = loras[i];
    const nodeId = ++maxNodeId;
    loraNodeIds.push(nodeId);

    const inputLinkId = ++maxLinkId;
    const outputLinkId = ++maxLinkId;
    outputLinkIds.push(outputLinkId);

    const loraNode = {
      id: nodeId,
      type: 'LoraLoaderModelOnly',
      pos: [-2680 + (i * 360), -960],
      size: [280, 100],
      flags: {},
      order: 14 + i,
      mode: 0,
      inputs: [
        { localized_name: '模型', name: 'model', type: 'MODEL', link: inputLinkId },
        { localized_name: 'LoRA名称', name: 'lora_name', type: 'COMBO', widget: { name: 'lora_name' }, link: null },
        { localized_name: '模型强度', name: 'strength_model', type: 'FLOAT', widget: { name: 'strength_model' }, link: null },
      ],
      outputs: [
        { localized_name: '模型', name: 'MODEL', type: 'MODEL', links: [outputLinkId] },
      ],
      title: `lora${i + 1}`,
      properties: {
        cnr_id: 'comfy-core',
        ver: '0.24.0',
        'Node name for S&R': 'LoraLoaderModelOnly',
      },
      widgets_values: [lora.path, lora.weight ?? 0.6],
    };

    wf.nodes.push(loraNode);

    // 上游来源：UNETLoader(第一个lora) 或 上一个 lora 节点
    const sourceNodeId = i === 0 ? unetNode.id : loraNodeIds[i - 1];
    wf.links.push([inputLinkId, sourceNodeId, 0, nodeId, 0, 'MODEL']);
    // GUI socket 元数据必须与 links 一致，否则导出回 ComfyUI 后 LoRA 链会显示断线。
    if (i === 0) {
      unetModelOutput.links = unetModelOutput.links.map(id => id === oldLinkId ? inputLinkId : id);
    } else {
      wf.nodes.find(n => n.id === sourceNodeId).outputs[0].links = [inputLinkId];
    }
  }

  // 最后一个 lora → 原始下游节点（保留用户中间链路）
  const finalLinkId = outputLinkIds[outputLinkIds.length - 1];
  const finalLoraNodeId = loraNodeIds[loras.length - 1];
  const targetSlot = downstreamNode.inputs.findIndex(inp => inp.name === 'model');

  if (targetSlot >= 0) {
    downstreamNode.inputs[targetSlot].link = finalLinkId;
  }
  wf.links.push([finalLinkId, finalLoraNodeId, 0, downstreamNode.id, targetSlot >= 0 ? targetSlot : 0, 'MODEL']);

  // 更新 workflow 元数据
  wf.last_node_id = maxNodeId;
  wf.last_link_id = maxLinkId;
}

/**
 * 最终阀门：统计 prompt 中所有 "数字+单词" 样式标签，汇总后拼到最前面
 *
 * 2026-11-07：原来的 `\b\d+\s*[a-z]{3,}s?\b` 会把**比例写法里的后半截**当成数量标签。
 * 真机日志（backend-2026-11-07.log）里反复出现的正是这个：
 *   "centered in a 1:2 vertical frame"  → 前缀多出 `2verticals`，正文残缺成 `1:frame`
 *   "suit the 1:2 vertical frame"       → `1:frame`
 *   "a full-body 1:2 composition"       → `1:composition`
 * 成因：`1:2 vertical` 里的 `2 vertical` 完全符合「数字+单词」，被摘走汇总成 `2verticals`。
 * 处置：两处正则都加负向后顾 `(?<![\d:.])`，数字前面是冒号/小数点/数字时不认作数量标签。
 * 注意 `\b` 挡不住这个——`:` 是非单词字符，`\b2` 在 `1:2` 里照样成立。
 */
function finalizeCountTags(prompt) {
  const tagRe = /(?<![\d:.])\b(\d+)\s*([a-z]{3,})s?\b/gi;
  const counts = new Map();

  let m;
  while ((m = tagRe.exec(prompt)) !== null) {
    const num = parseInt(m[1], 10) || 1;
    const word = m[2].toLowerCase();
    const stem = word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word;
    counts.set(stem, (counts.get(stem) || 0) + num);
  }

  if (counts.size === 0) return prompt;

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stem, count]) => count === 1 ? `1${stem}` : `${count}${stem}s`);

  let cleaned = prompt.replace(/(?<![\d:.])\b\d+\s*[a-z]{3,}s?\b\s*,?\s*/gi, '');
  cleaned = cleaned.replace(/^,\s*/, '').replace(/,\s*$/, '').trim();

  return parts.join(', ') + (cleaned ? ', ' + cleaned : '');
}

// 导出仅供诊断/回归验证使用（项目已移除自动化测试，这里保留可复现入口）
export { finalizeCountTags };

// ComfyUI 提交最大重试次数
const MAX_SUBMIT_RETRIES = 2;

/**
 * 提交 ComfyUI 生图（含 workflow 构建、重试循环）
 *
 * @param {string}   rawPrompt               - 画面描述
 * @param {object}   [opts]
 * @param {Array}    [opts.loras]              - [{path, weight, triggerWord}]
 * @param {string}   [opts.customWorkflow]       - 自定义工作流文件名（单人兼容）
 * @param {string}   [opts.characterNegative]    - 角色级负面提示词（排在全局负面词前，截 200 字符）
 * @param {string}   [opts.scene]                - 全局 LoRA 的场景过滤；默认也用于工作流选择
 * @param {string}   [opts.workflowScene]        - hybrid 模式下单独用于工作流选择
 * @param {string}   [opts.artist]
 * @param {number}   [opts.width]
 * @param {number}   [opts.height]
 * @param {function} [opts.onProgress]
 * @param {number}   [opts.submitRetries=2]
 * @param {string|object} [opts.poseJson]        - 体位骨架 JSON（{canvas, points}）；传了就跳过姿势检测直接喂坐标
 * @returns {Promise<{success, images, source, promptId}>}
 */
async function submitWithRetry(rawPrompt, {
  artist, width, height, onProgress, submitRetries = MAX_SUBMIT_RETRIES,
  loras, customWorkflow, scene, workflowScene, globalLoraSnapshot, qualityPrompt, negativePrompt,
  characterNegative, poseJson, sceneKey,
} = {}) {
  if (config.comfyui.imageProvider === 'novelai') {
    // NovelAI receives the same prepared scene description and artist tags as ComfyUI,
    // but does not use either character or global LoRA data.
    return submitNovelaiImage(rawPrompt, { artist, onProgress });
  }

  // 1. 最终阀门
  let finalPrompt = finalizeCountTags(rawPrompt);
  console.log(`[imageSkill] Final prompt: ${finalPrompt}`);

  // 2. 构建 workflow
  const { wf, wfMode } = buildWorkflow(finalPrompt, {
    artist, width, height, loras, customWorkflow, scene, workflowScene, globalLoraSnapshot, qualityPrompt, negativePrompt,
    characterNegative,
    // 同场景稳定种子：调用方传 sceneKey 时，连续几张图共用一套 base（每张 +1）
    // ⚠️ 2026-11-06 修：这一行第一版写成了 opts.sceneKey，但本函数是解构参数、没有 opts
    // ⇒ 所有生图入口（聊天/群聊/朋友圈/事件/触摸/玩具/独立生图）全部 `opts is not defined`。
    sceneSeed: resolveSceneSeed(sceneKey),
  });
  if (onProgress) onProgress({ stage: 'submitting' });

  // 3. 提交 ComfyUI，带重试循环
  //
  // 2026-10-01 修（现场：logs/backend-2026-10-01.log:156-167）：
  //   `[error] [imageSkill] ComfyUI attempt 1/2/3 failed: fetch failed`
  //   → `All ComfyUI submit attempts exhausted, generation failed`
  //   三次各隔 2s / 3s，**总共约 5 秒**就放弃。用户「邻舍先起、ComfyUI 后起（还在加载模型）」
  //   时必然全灭，而且日志里只有一行 fetch failed，看不出是「没启动」还是「这段 prompt 被拒」。
  // 现在分两类对待：
  //   · 连不上（fetch failed / ECONNREFUSED / 超时）⇒ ComfyUI 正在启动也说不定，多给几次机会、拉长间隔；
  //   · 其它（节点/模型缺失、prompt 校验失败）⇒ 等再久也没用，维持快速失败。
  let lastResult = null;
  const baseRetries = submitRetries;
  const unreachableRetries = Math.max(submitRetries, 3);
  let warnedUnreachable = false;
  // 服务端没有姿态适配器时会校验失败（错误文本里带文件名）：此时去掉骨架再提一次，
  // 保证「没装骨架也能出图」，而不是整条配图跟着失败。
  let activePoseJson = poseJson;

  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      console.log(`[imageSkill] ComfyUI submit retry ${attempt} — re-randomizing seed`);
      for (const node of wf.nodes || []) {
        if (node.type === 'KSampler' && node.widgets_values.length > 1 && node.widgets_values[1] === 'randomize') {
          node.widgets_values[0] = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        }
      }
      if (onProgress) onProgress({ stage: 'retrying', attempt, maxRetries: unreachableRetries });
    }

    try {
      const result = await submitWorkflow(wf, (p) => {
        if (onProgress) onProgress({ stage: 'generating', ...p });
      }, { poseJson: activePoseJson });
      if (result.images.length > 0) {
        console.log(`\n🎨 [imageSkill] 图片生成完成: ${result.images.length} 张 (workflow: ${wfMode}, promptId: ${result.promptId})`);
        return { success: true, images: result.images, source: 'api', promptId: result.promptId, wfMode };
      }
      lastResult = result;
    } catch (err) {
      console.error(`[imageSkill] ComfyUI attempt ${attempt + 1} failed:`, err.message);
      lastResult = { success: false, images: [], source: null, error: err.message };
      if (activePoseJson && String(err.message).includes(POSE_LORA_FILE)) {
        console.warn(`[imageSkill] ComfyUI 没有姿态适配器 ${POSE_LORA_FILE}，去掉体位骨架重试`);
        activePoseJson = undefined;
      }
      // 2026-11-03 第二道保底：目标机器没装 AnimaPoseControl 自定义节点时，
      // ComfyUI 会回 `missing_node_type: Node 'AnimaPoseControl' not found`。
      // 正常情况下 comfyClient 会先查节点清单跳过注入；这条兜住"清单还没取到就提交"的窗口期，
      // 保证**任何情况下都不会因为姿势增强而生不出图**。
      if (activePoseJson && /missing_node_type|AnimaPoseControl|AnimaControlApply/i.test(String(err.message))) {
        console.warn('[imageSkill] 目标 ComfyUI 没有姿势控制节点，去掉体位骨架重试（出图不受影响）');
        activePoseJson = undefined;
      }
    }

    const unreachable = isComfyUnreachable(lastResult?.error);
    // 生成超时：ComfyUI 没在时限内画完，重试只是再堵一个完整时限 —— 直接放弃这一张
    if (!unreachable && /execution timeout/i.test(String(lastResult?.error || ''))) {
      console.warn('[imageSkill] 生成超时（ComfyUI 未在时限内返回），本张标记失败、不再重试');
      break;
    }
    if (unreachable && !warnedUnreachable) {
      warnedUnreachable = true;
      console.warn('[imageSkill] ComfyUI 连不上（多半是还没启动 / 正在加载模型）—— 本次会多等几轮再放弃');
    }
    const budget = unreachable ? unreachableRetries : baseRetries;
    if (attempt >= budget) break;

    const waitMs = unreachable ? 3000 + attempt * 6000 : 2000 + attempt * 1000;
    console.log(`[imageSkill] Waiting ${waitMs}ms before retry...`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  const errText = lastResult?.error || 'All ComfyUI attempts exhausted';
  const unreachable = isComfyUnreachable(errText);
  console.log(`[imageSkill] All ComfyUI submit attempts exhausted, generation failed${unreachable ? '（ComfyUI 不可达）' : ''}`);
  return {
    success: false, images: [], source: null, wfMode,
    // 给调用方/界面一句能看懂的原因：连不上 vs 被拒（后者通常是缺节点或缺模型）
    error: unreachable ? `ComfyUI 连不上（没启动或还在加载），最后一次错误：${errText}` : errText,
  };
}

/**
 * 「ComfyUI 根本连不上」类错误的判定（对比「它收到了但拒绝了」）。
 * 只有这一类才值得拉长重试；节点/模型缺失、prompt 校验失败等重试再多次也一样。
 * 导出给单测（test/imagePromptRuleEcho.test.js）用。
 */
export function isComfyUnreachable(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  // 2026-11-06：**生成超时**不算"连不上"。ComfyUI 收到了请求但没在时限内画完，
  // 重试只会再堵一个完整时限（120s × 重试次数），比不重试更糟。
  if (/execution timeout/.test(text)) return false;
  return /fetch failed|econnrefused|econnreset|econnaborted|etimedout|socket hang up|network error|timed? ?out|aborted/.test(text);
}

// ── 优先级队列 ──
let activeTaskCount = 0;
let lowQueue = [];           // { rawPrompt, opts, resolve, reject, enqueuedAt }
let processingLow = false;
// 2026-10-15 软状态落库：`lastHighTime` 原来是纯进程内变量（重启归零 ⇒ 静默期判定被绕过）。
// 现在挂一份 `softStateStore`（懒加载、写入去抖 1s、读失败回空），语义与纯内存版完全一致。
const lastHighState = createSoftState('image_skill_last_high');
function readLastHighTime() {
  const v = Number(lastHighState.get('lastHighTime'));
  return Number.isFinite(v) ? v : 0;
}
function markLastHighTime() {
  lastHighState.set('lastHighTime', Date.now());
}
let lowRetryTimer = null;
const QUIET = 180_000;        // 高优任务后 180s 内不派发低优
/**
 * 低优任务的**防饿死上限**（2026-10-01，用户真机日志里那场 52 分钟冻结）。
 *
 * 日志实证：朋友圈配文 5 秒就写好了，但它的**配图**任务在同一时刻被排进低优队列，
 * 直到 **52 分钟后**才被派发 —— 这 52 分钟里用户一直在聊/摸（高优任务不断刷新 `lastHighTime`），
 * 而低优只在「距上一个高优 ≥180s」时才开始 ⇒ **只要用户在玩，后台图永远排不上**。
 * 受害的不只是那张图：朋友圈 / 奇遇 / 主动聊天三个调度器都在 `await` 它，
 * 于是三个玩法**同时卡死**（日志里 05:05–05:47 三个调度器连续跳过 5~8 个 tick）。
 *
 * 现在：低优任务最多等 `LOW_QUEUE_MAX_WAIT`，超过就不再遵守静默期（**仍然只在没有任务在跑时**派发，
 * 不去抢正在生成的那一张），并打一条 warn 让这件事在日志里可见。
 */
const LOW_QUEUE_MAX_WAIT = 60_000;   // 2026-11-06 真机日志：10 次低优派发里 8 次等满上限（180s）才放行，
                                     // 说明 3 分钟是「用户在玩时的常态等待」，不是罕见兜底。降到 1 分钟。
                                     // 低优仍然只在**没有任务在跑**的空闲窗口派发，不抢正在生成的那张。

/**
 * 是否该派发队首的低优任务。抽成**纯函数**是为了能单测这条策略：
 * 静默期没到 + 还没等够 → 继续等；静默期没到但已经等太久 → 放行（防饿死）；静默期到了 → 放行。
 *
 * @param {number} now
 * @param {number} lastHigh      上次高优任务时刻
 * @param {number} enqueuedAt    队首任务入队时刻
 * @param {number} [quietMs]
 * @param {number} [maxWaitMs]
 * @returns {{dispatch: boolean, waitMs: number, starved: boolean}}
 */
export function decideLowDispatch(now, lastHigh, enqueuedAt, quietMs = QUIET, maxWaitMs = LOW_QUEUE_MAX_WAIT) {
  const remaining = quietMs - (now - Number(lastHigh || 0));
  if (remaining <= 0) return { dispatch: true, waitMs: 0, starved: false };
  const waited = now - Number(enqueuedAt || now);
  if (waited >= maxWaitMs) return { dispatch: true, waitMs: 0, starved: true };
  return { dispatch: false, waitMs: remaining + 100, starved: false };
}

/** 排一次复查。**必须能重复排**：以前 `activeTaskCount>0` 时直接 return 且不排复查，
 *  若此后没有高优任务再触发 `processLowQueue`，低优队列就永久停摆了。 */
function scheduleLowRetry(ms) {
  if (lowRetryTimer) return;
  lowRetryTimer = setTimeout(() => { lowRetryTimer = null; processLowQueue(); }, Math.max(500, ms));
  if (typeof lowRetryTimer.unref === 'function') lowRetryTimer.unref();
}

async function _execute(rawPrompt, opts) {
  activeTaskCount++;
  let slotAcquired = false;
  try {
    // 0. 送进 CLIP 之前先剥掉模型回显的生图规范原文（2026-10-01 修，见 groupImagePrompt.js 长注释）。
    //    放在这里而不是各调用点，是为了让 event / newspaper / moments / schedule / group / chat /
    //    touch / toy / portrait / standalone / maibot **所有**生图入口一次生效。
    //    规范特征词都没有时是零开销快路径。
    const sanitized = stripImagePromptRuleEcho(rawPrompt);
    if (sanitized.changed) {
      console.log(`[imageSkill] 画面描述剥离规范回显：${String(rawPrompt).length} → ${sanitized.prompt.length} 字`);
    }
    if (sanitized.isEmpty) {
      // 整条都是规范原文 ⇒ 送进去只会得到一张和剧情毫无关系的图，不如明确失败。
      throw Object.assign(new Error('画面描述里只有生图规范原文，没有可用的场景内容'), { code: 'image_prompt_rule_echo_only' });
    }
    let prompt = sanitized.prompt;

    // 0a. 身份锚点前置（2026-11-08）：调用方传了 `opts.identity`（角色行，或多角色时传数组）时，
    //     把「Name (Series) + 身体特征」锚点补在 prompt 最前。放在这里而不是各调用点，
    //     是为了让 chat / touch(亲密) / 立绘 / 头像 / 梦话 / 事件 / 朋友圈 **所有**入口一次生效。
    //     不传 identity 与改动前逐字节一致（场景图、道具图、路人图都不受影响）。
    //     幂等：prompt 里已有同名身份 tag 时不重复前置。
    //     数组 = 多人同框：每个实际入画角色各自用自己的锚点，不能只锚说话那个人。
    if (opts.identity) {
      // 逐个应用：每个角色独立判幂等，prompt 里已有的那个不会被重复前置
      for (const char of (Array.isArray(opts.identity) ? opts.identity : [opts.identity])) {
        prompt = applyIdentityAnchorToPrompt(prompt, getIdentityAnchorForPrompt(char));
      }
      // identity 只服务这一层，别让它跟着 opts 流进工作流构造
      delete opts.identity;
    }

    // 0b. 连一个英文字母都没有 ⇒ 这是「模型把中文要求当成了画面描述」那类退化
    //     （全仓有多处 `text.length >= 5` 的弱校验：schedule.js / proactiveChatScheduler.js /
    //      characters.js / imagePromptResponse.js）。中文喂给 CLIP 只会得到一张与剧情无关的图，
    //     与其出一张错的，不如明确失败。**例外**：标准生图页（`promptScene: 'standalone'`）是
    //     用户自己在输入框里写什么就画什么，不拦。
    if (!/[A-Za-z]/.test(prompt) && opts.promptScene !== 'standalone') {
      throw Object.assign(new Error('画面描述里没有任何英文内容（多半是模型把中文写作要求当成了画面描述）'), { code: 'image_prompt_not_english' });
    }

    const preparation = await prepareImagePrompt(prompt, {
      ragQuery: opts.ragQuery,
      disableRAG: opts.disableRAG === true,
      scene: opts.promptScene || opts.scene || 'chat',
      alreadyPrepared: opts.alreadyPrepared === true,
      skipOptimization: opts.skipOptimization === true,
      ragTimeoutMs: opts.ragTimeoutMs,
    });
    if (_limitEnabled()) {
      slotAcquired = await acquireSlot();
    }
    const result = await submitWithRetry(preparation.promptRefined, opts);
    return {
      ...result,
      promptOriginal: preparation.promptOriginal,
      promptRagQuery: preparation.ragQuery,
      promptRefined: preparation.promptRefined,
      promptKnowledgeIds: preparation.retrieval.knowledgeIds,
      promptKnowledgeVersion: preparation.retrieval.knowledgeVersion,
      promptRetrievalMode: preparation.retrieval.mode,
      promptOptimizationStatus: preparation.status,
    };
  } finally {
    activeTaskCount--;
    if (activeTaskCount === 0) processLowQueue();
    releaseSlot(slotAcquired);
  }
}

function processLowQueue() {
  if (processingLow || lowQueue.length === 0) return;
  // 有任务在跑：不插队，但**一定要排复查**（否则没有后续高优任务时队列永久停摆）
  if (activeTaskCount > 0) { scheduleLowRetry(5_000); return; }

  const head = lowQueue[0];
  const verdict = decideLowDispatch(Date.now(), readLastHighTime(), head.enqueuedAt);
  if (!verdict.dispatch) { scheduleLowRetry(verdict.waitMs); return; }
  if (verdict.starved) {
    console.warn(`[imageSkill] 低优生图已等 ${Math.round((Date.now() - Number(head.enqueuedAt || Date.now())) / 1000)}s`
      + `（上限 ${Math.round(LOW_QUEUE_MAX_WAIT / 1000)}s），跳过静默期直接派发，避免后台玩法被饿死；队列还剩 ${lowQueue.length} 张`);
  }

  processingLow = true;
  const { rawPrompt, opts, resolve, reject } = lowQueue.shift();
  _execute(rawPrompt, opts).then(resolve, reject).finally(() => {
    processingLow = false;
    if (lowQueue.length > 0) processLowQueue();
  });
}

export function isUserQuiet(quietMs = QUIET) {
  return Date.now() - readLastHighTime() >= quietMs;
}

/**
 * 生图队列水位（设置页「运行状态」用）。
 * active = 正在生成；low = 低优队列里排队的张数；waitingMs = 队首已等多久。
 */
export function getImageQueueStatus() {
  const head = lowQueue[0];
  return {
    active: activeTaskCount,
    low: lowQueue.length,
    headWaitedMs: head ? Date.now() - Number(head.enqueuedAt || Date.now()) : 0,
    quietMs: QUIET,
    lowMaxWaitMs: LOW_QUEUE_MAX_WAIT,
  };
}

export async function generateImage(rawPrompt, opts = {}) {
  if (opts.priority === 'low') {
    return new Promise((resolve, reject) => {
      lowQueue.push({ rawPrompt, opts, resolve, reject, enqueuedAt: Date.now() });
      processLowQueue();
    });
  }
  markLastHighTime();
  return _execute(rawPrompt, opts);
}

export async function generateImageRaw(rawPrompt, opts = {}) {
  if (opts.priority === 'low') {
    return new Promise((resolve, reject) => {
      lowQueue.push({ rawPrompt, opts, resolve, reject, enqueuedAt: Date.now() });
      processLowQueue();
    });
  }
  markLastHighTime();
  return _execute(rawPrompt, opts);
}
export function getComfyLorasRoot() {
  // 路径推导统一走 utils/comfyPaths.js（原来这里读的 launcher_config.json 比项目根多退了一级，
  // 于是永远返回 null —— 用户明明在启动器里填了 ComfyUI 路径，姿势控制资产却一直装不上）
  return resolveComfySubdir('models', 'loras');
}

// 兼容历史数据：ComfyUI 只接受模型根目录相对名，不接受本机绝对路径。
function normalizeLoraValue(value) {
  const raw = String(value || '').trim();
  if (!raw || !path.isAbsolute(raw)) return raw;

  const lorasRoot = getComfyLorasRoot();
  if (lorasRoot) {
    const rel = path.relative(lorasRoot, raw);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }

  const marker = /[\\/]models[\\/]loras[\\/]/i.exec(raw);
  return marker ? raw.slice(marker.index + marker[0].length) : raw;
}
