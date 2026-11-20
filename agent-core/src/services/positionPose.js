/**
 * positionPose.js — 体位 → 骨架 JSON（纯函数层：无 DB、无 config、无副作用）
 *
 * 上层入口在 `intimateActionService.buildPositionPoseJson(characterId)`（那里才知道"她此刻是什么体位"），
 * 这里只负责"体位对象 → 形态大类 → 骨架坐标 → AnimaPoseControl 吃的 JSON"。
 *
 * 为什么要按大类而不是按每一条体位单独做骨架：
 *   POSTURE_GROUPS 的 11 类已经把 142 条体位按姿势形态归好（骑乘/后入/仰躺/站立/跪姿/坐位/口部/乳交/手交/俯卧/其他），
 *   同一类里"女方姿态"本来就一样（18 条骑乘都是跨坐）。按类给骨架 = 11 套覆盖全量，
 *   既不用维护 142 套坐标，也不会出现"某条体位没有骨架"的空洞。
 */

import {
  POSTURE_SKELETONS, SKELETON_CANVAS,
} from '../data/positionPoseSkeletons.js';
import {
  getPosition, postureOf, postureOfText, resolvePositionKey,
} from './positionLibrary.js';

/** 骨架点总数（COCO-WholeBody 133）：身体 0-16 / 脚 17-22 / 脸 23-90 / 手 91-132 */
export const POSE_POINT_COUNT = 133;

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * 精选表（`intimateActionService.PREFERRED_POSITION_KEYS`，17 条英文打包串）→ 形态大类。
 *
 * 为什么要这张显式表：精选 key 是**打包串**（`'mating press, sex, penis, vaginal, ...'`、
 * `'anal insertion'`），与词库 `pr24.<no>.<slug>` 是两套命名空间；单靠关键词正则判类会漏
 * （`anal insertion` 没有任何姿态词、`69` 曾经因规则里混进退格字符而永不匹配）。
 * 这张表只服务"拿骨架"，与面板选项、词库解析无关，改错了也只是骨架选得不够准。
 */
const PREFERRED_KEY_GROUPS = Object.freeze({
  'missionary': 'onback',
  'doggystyle': 'frombehind',
  'cowgirl position': 'riding',
  'reverse cowgirl': 'riding',
  'mating press, sex, penis, vaginal, testicles, ass, on back': 'onback',
  'prone bone, sex from behind': 'onstomach',
  'arms grab, sex from behind': 'frombehind',
  'standing sex, doggystyle': 'standing',
  'leg lock/upright straddle': 'riding',
  'kneeling, blowjob': 'oral',
  'deepthroat': 'oral',
  'cunnilingus': 'oral',
  'paizuri': 'paizuri',
  'handjob': 'hand',
  '69': 'oral',
  // 未说明姿态的肛交：取最常见的后入构图（否则落到 other 的四足支撑，更不准）
  'anal insertion': 'frombehind',
  'anal doggy, anus gape': 'frombehind',
});

/**
 * 把归一化骨架展开成 `AnimaPoseControl.pose_json` 的格式。
 * 未使用的点一律 score=0（渲染时会被跳过，不会凭空长出手指/五官）。
 * @param {{points: Record<string,[number,number]>}} skeleton
 * @returns {{canvas:number, points:number[][]}}
 */
export function buildPoseJson(skeleton) {
  const points = Array.from({ length: POSE_POINT_COUNT }, () => [0, 0, 0]);
  for (const [rawIdx, xy] of Object.entries(skeleton?.points || {})) {
    const idx = Number(rawIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= POSE_POINT_COUNT) continue;
    if (!Array.isArray(xy) || xy.length < 2) continue;
    points[idx] = [
      Math.round(clamp01(xy[0]) * SKELETON_CANVAS),
      Math.round(clamp01(xy[1]) * SKELETON_CANVAS),
      1,
    ];
  }
  return { canvas: SKELETON_CANVAS, points };
}

/** 形态大类 → 骨架（未知大类回落到 other） */
export function skeletonOf(groupKey) {
  return POSTURE_SKELETONS[groupKey] || POSTURE_SKELETONS.other;
}

/**
 * 体位 key（`pr24.gP061.vaginal` / 词表 key / 中文名）→ 骨架 JSON。
 *
 * @param {string} positionKey
 * @returns {{json:string, group:string, groupLabel:string, view:string, note:string}|null}
 *          认不出的体位返回 null（调用方据此"不注入骨架"，绝不猜一个姿势画上去）
 */
export function poseJsonForPositionKey(positionKey) {
  const key = String(positionKey || '').trim();
  if (!key) return null;
  const resolved = resolvePositionKey(key) || key;
  const pos = getPosition(resolved) || getPosition(key);
  if (pos) return poseJsonForPositionObject(pos);
  // 词库查不到时先查精选表（精确映射），再按**文本**判大类兜底：
  // 老数据里还留着精选表的英文打包 key（与 pr24 命名空间互不相认），
  // 它们本身就是形态描述，判类后总比"没有骨架、放任模型自由发挥"强。
  const group = PREFERRED_KEY_GROUPS[key] || postureOfText(key);
  if (group === 'other') return null;
  const skeleton = skeletonOf(group);
  return {
    json: JSON.stringify(buildPoseJson(skeleton)),
    group,
    groupLabel: skeleton.label,
    view: skeleton.view,
    note: skeleton.note,
  };
}

/**
 * 体位对象 → 骨架 JSON（已拿到对象时用这个，少查一次表）。
 * @param {object} pos positionLibrary 里的体位对象（含 core/male/female/name）
 */
export function poseJsonForPositionObject(pos) {
  if (!pos || typeof pos !== 'object' || Array.isArray(pos)) return null;
  // 残缺对象（`{}` / 只有无关字段）**不猜姿势**：空体位按 other 画一个四足支撑，
  // 上层会以为"骨架注入成功"，比不注入更难查。宁可不注入。
  const hasContent = [...(pos.core || []), ...(pos.male || []), ...(pos.female || [])].some(t => String(t || '').trim())
    || String(pos.name || '').trim();
  if (!hasContent) return null;
  const group = postureOf(pos);
  const skeleton = skeletonOf(group);
  return {
    json: JSON.stringify(buildPoseJson(skeleton)),
    group,
    groupLabel: skeleton.label,
    view: skeleton.view,
    note: skeleton.note,
  };
}

/** 调试/面板用：所有大类的骨架（归一化坐标），不参与生图链路 */
export function listSkeletons() {
  return Object.entries(POSTURE_SKELETONS).map(([key, s]) => ({
    key,
    label: s.label,
    view: s.view,
    note: s.note,
    joints: Object.keys(s.points).length,
  }));
}
