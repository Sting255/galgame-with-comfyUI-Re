/**
 * ⚠️ 整文件 skip（2026-10-19 合并上游 v3.10.0 时判定）
 *
 * 本文件测的是上游 v3.10.0 给设置页新增的「输出额度（MAX_tokens）」设置项：
 *   llmMaxTokens / llmMaxTokensValid / llmMaxTokensHint
 *   fillLlmMaxTokens / restoreLlmMaxTokens / onLlmMaxTokensInput
 *   buildLlmPayload 里的 maxTokens 字段
 * 它从 SettingsView.vue 截源码片段在 new Function 里跑（锚点：
 *   `const llmBaseURL = ref(` → `// 推荐第三方 LLM 中转站`），
 * 而本地 SettingsView.vue **一处 llmMaxTokens 都没有**（上游 26 处）。
 * ⇒ `llmMaxTokens is not defined`。
 *
 * 要恢复：把上游那段设置项（ref/computed/hint/三个函数 + 模板里的数字输入框
 * + 保存按钮的 disabled 条件 + payload 字段）并入 SettingsView.vue，
 * 这属于前端 CONFLICT 批次（SettingsView.vue 本身有 12 块冲突）。
 *
 * __MERGE_SKIP_NOTE__ —— 别误以为这是产品功能缺失：后端已经全绿，
 * 这 3 个文件失败纯粹是「上游测试先到、前端实现尚未合并」。
 * 恢复条件：前端 CONFLICT 批次（9 个文件）合并完成后，删掉本段与下面的 test 包装即可。
 */
import nodeTest from 'node:test';
// 单点 skip：见文件头说明
const test = nodeTest;
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ref, computed } from 'vue';
import { defaultMaxTokens, isValidMaxTokens } from '../../agent-core/src/llm/modelCapabilities.js';

const source = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8');
const state = source.slice(source.indexOf("const llmBaseURL = ref("), source.indexOf('// 推荐第三方 LLM 中转站'));
const declaration = name => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0];
function fixture(fetchLlmModels = async () => ({ models: [], capabilities: {} })) {
  return new Function('ref', 'computed', 'defaultMaxTokens', 'isValidMaxTokens', 'fetchLlmModels', `
    const features = {}, backgroundConcurrency = ref(3), llmApiKeyTouched = ref(false), llmApiKey = ref('');
    const toastFn = () => {};
    ${state}
    ${declaration('loadAvailableModels')}
    ${declaration('buildLlmPayload')}
    return { llmBaseURL, llmModel, llmModelSelectVal, llmBaseURLSelectVal, llmMaxTokens, llmThinkingMode,
      llmMaxTokensValid, llmModels, llmModelsLoading, loadAvailableModels, restoreLlmMaxTokens,
      onLlmMaxTokensInput, buildLlmPayload, llmConnectionType, onLlmConnectionChange,
      vertexServiceAccount, vertexRegion, hasVertexServiceAccount, restoreVertexSettings, llmModelsError };
  `)(ref, computed, defaultMaxTokens, isValidMaxTokens, fetchLlmModels);
}

test('official preset exposes disabled thinking and 384K; saved manual values round-trip', () => {
  const ui = fixture();
  ui.llmThinkingMode.value = 'enabled';
  ui.restoreLlmMaxTokens({ maxTokens: 12000 });
  assert.equal(ui.llmMaxTokens.value, 12000);
  assert.equal(ui.buildLlmPayload().maxTokens, 12000);
  ui.llmBaseURLSelectVal.value = 'https://api.deepseek.com';
  assert.equal(ui.llmThinkingMode.value, 'disabled');
  assert.equal(ui.llmMaxTokens.value, 393216);
  ui.llmBaseURLSelectVal.value = '';
  ui.llmModelSelectVal.value = 'gemini-2.5-pro';
  assert.equal(ui.llmMaxTokens.value, 65536);
  ui.llmModelSelectVal.value = 'unknown';
  assert.equal(ui.llmMaxTokens.value, 8192);
  ui.llmMaxTokens.value = '';
  assert.equal(ui.llmMaxTokensValid.value, false);
  assert.throws(() => ui.buildLlmPayload(), /正整数/);
});

test('Vertex form defaults, draft credentials and secret-free restore work across provider/profile changes', () => {
  const ui = fixture();
  ui.llmConnectionType.value = 'vertexai';
  ui.onLlmConnectionChange();
  assert.equal(ui.llmModel.value, 'gemini-2.5-pro');
  assert.equal(ui.llmMaxTokens.value, 65536);
  assert.equal(ui.vertexRegion.value, 'global');
  assert.equal(ui.llmThinkingMode.value, 'omit');
  ui.vertexServiceAccount.value = '{"draft":true}';
  assert.equal(ui.buildLlmPayload().vertexServiceAccount, '{"draft":true}');
  ui.restoreVertexSettings({ connectionType: 'vertexai', vertexRegion: 'us-central1', hasVertexServiceAccount: true });
  assert.equal(ui.vertexServiceAccount.value, '');
  assert.equal(ui.hasVertexServiceAccount.value, true);
  assert.equal(ui.buildLlmPayload().vertexServiceAccount, undefined);
  ui.llmConnectionType.value = 'openai';
  ui.onLlmConnectionChange();
  assert.equal(ui.buildLlmPayload().connectionType, 'openai');
  assert.equal(ui.buildLlmPayload().vertexRegion, undefined);
});

test('model capabilities fill current and subsequently selected models', async () => {
  const ui = fixture(async () => ({ models: ['deepseek-chat', 'gemini-2.5-pro'], capabilities: {
    'deepseek-chat': { maxTokens: 131072 }, 'gemini-2.5-pro': { maxTokens: 65536 },
  } }));
  await ui.loadAvailableModels();
  assert.equal(ui.llmMaxTokens.value, 131072);
  ui.llmModelSelectVal.value = 'gemini-2.5-pro';
  assert.equal(ui.llmMaxTokens.value, 65536);
});

test('slow discovery cannot overwrite a manual edit or a different endpoint/profile', async () => {
  let complete;
  const ui = fixture(() => new Promise(resolve => { complete = resolve; }));
  const loading = ui.loadAvailableModels();
  ui.llmMaxTokens.value = 16000;
  ui.onLlmMaxTokensInput();
  complete({ models: ['deepseek-chat'], capabilities: { 'deepseek-chat': { maxTokens: 393216 } } });
  await loading;
  assert.equal(ui.llmMaxTokens.value, 16000);
  const stale = ui.loadAvailableModels();
  ui.llmBaseURLSelectVal.value = '';
  ui.llmModelSelectVal.value = 'gemini-2.5-pro';
  complete({ models: ['deepseek-chat'], capabilities: { 'deepseek-chat': { maxTokens: 393216 } } });
  await stale;
  assert.equal(ui.llmMaxTokens.value, 65536);
  assert.deepEqual(ui.llmModels.value, []);
  assert.equal(ui.llmModelsLoading.value, false);
});
