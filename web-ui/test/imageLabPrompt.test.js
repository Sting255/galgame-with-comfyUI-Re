import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { effectScope, nextTick, ref, watch } from 'vue'

// 执行页面实际使用的实验室状态与请求入口；只替换生图 API，避免调用外部服务。
const source = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')
const stateCode = source.slice(source.indexOf("const testMode = ref('chat')"), source.indexOf('const hireTesting = ref(false)'))
const actionCode = source.slice(source.indexOf('async function executeStyleTest('), source.indexOf('async function runHiresTest('))

function fixture(t, respond) {
  const requests = []
  const scope = effectScope()
  t.after(() => scope.stop())
  const state = scope.run(() => new Function('ref', 'watch', 'nextTick', 'testStyle', `
    const form = ref({ artist: 'chat artist', width: 512, height: 768,
      momentsArtist: 'moments artist', momentsWidth: 1024, momentsHeight: 768,
      eventArtist: 'event artist', eventWidth: 768, eventHeight: 1024 })
    const imageProvider = ref('comfyui')
    const testPrompts = ref({ chat: 'chat default', moments: 'moments default', event: 'event default' })
    ${stateCode}
    ${actionCode}
    return { testMode, generatedPrompt, freeSceneDesc, promptEditing, styleTesting, styleStage, styleImages, styleError,
      runStyleTest, runFreeSceneTest, runGeneratedPromptTest }
  `)(ref, watch, nextTick, async (payload, callbacks) => {
    requests.push(payload)
    if (respond) return respond(payload, callbacks)
    return { success: true, images: [{ base64: 'test image' }],
      generatedPrompt: payload.sceneDesc ? 'scene prompt' : payload.prompt }
  }))
  return { ...state, requests }
}

test('自由描述为空时，按钮连续生成仍使用中间手动修改的提示词', async t => {
  const lab = fixture(t)
  await lab.runStyleTest()
  lab.generatedPrompt.value = 'edited prompt'
  await lab.runStyleTest()
  await lab.runStyleTest()
  assert.deepEqual(lab.requests.map(request => request.prompt), ['chat default', 'edited prompt', 'edited prompt'])
  assert.equal(lab.requests[1].alreadyPrepared, true)
  assert.equal(lab.requests[1].sceneDesc, '')
})

test('按钮和编辑框回车提交相同的最终提示词与复用选项', async t => {
  const lab = fixture(t)
  lab.freeSceneDesc.value = 'a cafe'
  await lab.runFreeSceneTest()
  lab.generatedPrompt.value = 'edited scene prompt'
  await lab.runStyleTest()
  await lab.runGeneratedPromptTest()
  assert.deepEqual(lab.requests[1], lab.requests[2])
  assert.equal(lab.requests[1].alreadyPrepared, true)
  assert.equal(lab.requests[1].reuseSceneLoras, true)
})

test('切换参数后清除旧提示词和编辑态，使用新模式的默认提示词和参数', async t => {
  const lab = fixture(t)
  for (const mode of ['moments', 'event', 'chat']) {
    lab.generatedPrompt.value = 'old edited prompt'
    lab.promptEditing.value = true
    lab.testMode.value = mode
    await nextTick()
    assert.equal(lab.generatedPrompt.value, '')
    assert.equal(lab.promptEditing.value, false)
    await lab.runStyleTest()
    const request = lab.requests.at(-1)
    assert.equal(request.prompt, `${mode} default`)
    assert.equal(request.artist, `${mode} artist`)
    assert.equal(request.mode, mode)
    assert.equal(request.alreadyPrepared, false)
    assert.equal(request.reuseSceneLoras, false)
  }
})

test('提示词只有空白时回退默认值，生成期间不重复提交', async t => {
  const lab = fixture(t)
  lab.generatedPrompt.value = ' \n '
  await lab.runStyleTest()
  assert.equal(lab.requests[0].prompt, 'chat default')
  lab.styleTesting.value = true
  await lab.runStyleTest()
  assert.equal(lab.requests.length, 1)
})

for (const success of [true, false]) {
  test(`图片返回前显示两阶段提示词，图片${success ? '成功' : '失败'}后仍保留`, async t => {
    let callbacks, complete;
    const lab = fixture(t, (_, handlers) => {
      callbacks = handlers;
      return new Promise(resolve => { complete = resolve; });
    });
    lab.freeSceneDesc.value = '咖啡馆';
    const pending = lab.runFreeSceneTest();
    assert.equal(lab.styleStage.value, 'prompt');
    callbacks.onPrompt({ generatedPrompt: 'first prompt', stage: 'preparing' });
    await nextTick();
    assert.equal(lab.generatedPrompt.value, 'first prompt');
    assert.equal(lab.styleTesting.value, true);
    assert.deepEqual(lab.styleImages.value, []);
    callbacks.onPrompt({ generatedPrompt: 'final prompt', stage: 'generating' });
    await nextTick();
    assert.equal(lab.generatedPrompt.value, 'final prompt');
    assert.equal(lab.styleStage.value, 'generating');
    assert.equal(lab.styleTesting.value, true);
    complete({ success, images: success ? [{ base64: 'image' }] : [], error: success ? undefined : 'failed' });
    await pending;
    assert.equal(lab.generatedPrompt.value, 'final prompt');
    assert.equal(lab.styleTesting.value, false);
    assert.equal(lab.styleImages.value.length, success ? 1 : 0);
    assert.equal(lab.styleError.value, success ? '' : 'failed');
  });
}

test('提示词完善失败后重试，仍执行完善步骤', async t => {
  const lab = fixture(t, (_, callbacks) => {
    callbacks.onPrompt({ generatedPrompt: 'unprepared prompt', stage: 'preparing' });
    throw new Error('preparation failed');
  });
  lab.freeSceneDesc.value = '咖啡馆';
  await lab.runFreeSceneTest();
  await lab.runGeneratedPromptTest();
  assert.equal(lab.requests[1].alreadyPrepared, false);
});
