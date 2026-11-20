/**
 * smoke-image.mjs —— 生图链路冒烟（2026-11-06）
 *
 * 为什么需要：第 69 轮包曾经把一个"语法检查全过、接口全活、但每张图都抛
 * `opts is not defined`"的回归打出去过 —— 因为所有验证都停在"服务能起来"，
 * 没有一步真的生成一张图。这个脚本补的就是那一步。
 *
 * 它做的事：直接 import 生图模块，在内存库里真生成一张最便宜的图，按结果给退出码。
 * 不打后端、不占端口，跑完就退。
 *
 * 用法（必须在 agent-core 目录下）：
 *   DB_PATH=":memory:" ../runtime/nodejs/node.exe ../scripts/smoke-image.mjs
 *
 * 退出码：
 *   0 = 出图成功
 *   2 = ComfyUI 不在线（环境问题，不算代码缺陷；CI/无卡机器上应视为跳过）
 *   1 = 代码链路有错（这才是要修的东西）
 */
import { generateImage } from '../agent-core/src/services/imageSkill.js';

const PROMPT = 'a quiet bookstore counter with an open book and a cup of tea, warm afternoon light';
const TIMEOUT_MS = 180_000;

const started = Date.now();
let result;
try {
  result = await generateImage(PROMPT, { scene: 'standalone', promptScene: 'standalone' });
} catch (err) {
  console.log(`FAIL 生图调用抛异常：${err?.message || err}`);
  process.exit(1);
}

const elapsed = Math.round((Date.now() - started) / 1000);

if (result?.success && Array.isArray(result.images) && result.images.length > 0) {
  console.log(`PASS 生图成功：${result.images.length} 张，用时 ${elapsed}s，workflow=${result.wfMode || '?'}`);
  process.exit(0);
}

const message = String(result?.error || '没有任何图片返回');
const envIssue = /ECONNREFUSED|fetch failed|connect|unavailable|ComfyUI/i.test(message);
if (envIssue) {
  console.log(`SKIP ComfyUI 不在线或未配置（不算代码问题）：${message.slice(0, 160)}`);
  process.exit(2);
}

console.log(`FAIL 生图链路失败：${message.slice(0, 300)}`);
process.exit(1);
