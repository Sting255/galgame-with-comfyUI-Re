/**
 * 生图描述「被写含蓄」的兜底重写（2026-10-21）
 *
 * 用户口径：「聊天出图还是有审查限制，该露骨的地方变成擦边。」
 * 现象：`buildImagePromptMessages` 的【当前任务】早就要求直写解剖词，但模型仍会把性行为
 * 改写成氛围 / 表情 / 「亲密」这类委婉说法，或者写到一半就收住。
 *
 * 修法（本文件钉住）：
 *   ① 判定 `needsExplicitImageRewrite(dialogue, prompt)`：对话露骨 + 英文描述一个露骨词都没有；
 *   ② 命中就追加 `EXPLICIT_REWRITE_INSTRUCTION` 再要一次（**只重写一次**，不阻断出图）；
 *   ③ 源码守卫：chat.js 的两条生图描述链（planner 预生成 / needImage 二次请求）都必须走
 *      同一个入口 `requestImagePromptText`，不许各自手写一份（历史教训：口径分裂）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  needsExplicitImageRewrite,
  EXPLICIT_REWRITE_INSTRUCTION,
  extractImagePromptResponse,
} from '../src/services/imagePromptResponse.js';

const CHAT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/chat.js');

test('对话露骨 + 描述含蓄 ⇒ 需要重写', () => {
  assert.equal(
    needsExplicitImageRewrite('她趴在桌上，你从后面插进来', 'a girl leaning on a desk, warm afternoon light'),
    true,
  );
  assert.equal(
    needsExplicitImageRewrite('我下面已经湿了', 'she sits by the window with a shy smile'),
    true,
  );
});

test('对话露骨 + 描述已露骨 ⇒ 不重写（别白烧一次调用）', () => {
  assert.equal(
    needsExplicitImageRewrite('你从后面插进来', '1girl, doggystyle, penis inside her pussy, cum on her thigh'),
    false,
  );
});

test('对话本身不露骨 ⇒ 不重写（日常照片本来就不该有露骨词）', () => {
  assert.equal(
    needsExplicitImageRewrite('今天天气不错，去公园吧', 'a girl in a white dress walking in a park'),
    false,
  );
});

test('空描述不判定（空返回交给 requestNonEmptyImagePrompt 的重试）', () => {
  assert.equal(needsExplicitImageRewrite('你从后面插进来', ''), false);
  assert.equal(needsExplicitImageRewrite('你从后面插进来', '   '), false);
  assert.equal(needsExplicitImageRewrite('', ''), false);
});

test('重写要求本身是一段可追加的 user 消息，且要求纯英文输出', () => {
  assert.equal(EXPLICIT_REWRITE_INSTRUCTION.role, 'user');
  assert.match(EXPLICIT_REWRITE_INSTRUCTION.content, /重写/);
  assert.match(EXPLICIT_REWRITE_INSTRUCTION.content, /英文/);
  assert.match(EXPLICIT_REWRITE_INSTRUCTION.content, /800/);
});

test('长胶段落：extractImagePromptResponse 拿到的正文直接参与判定', () => {
  const raw = '```\n{"prompt":"a girl lying on a bed, soft lamp light"}\n```';
  const prompt = extractImagePromptResponse(raw);
  assert.equal(prompt, 'a girl lying on a bed, soft lamp light');
  assert.equal(needsExplicitImageRewrite('你从后面插进来，我受不了了', prompt), true);
});

test('源码守卫：两条生图描述链都走同一个入口，且带重写要求', () => {
  const src = fs.readFileSync(CHAT_SRC, 'utf8');
  assert.equal(src.includes('needsExplicitImageRewrite'), true, 'chat.js 必须接上含蓄判定');
  assert.equal(src.includes('EXPLICIT_REWRITE_INSTRUCTION'), true, 'chat.js 必须带重写要求');
  const calls = src.match(/requestImagePromptText\(/g) || [];
  // 1 处定义 + 2 处调用
  assert.equal(calls.length, 3, `requestImagePromptText 应为 1 定义 + 2 调用，实测 ${calls.length}`);
});
