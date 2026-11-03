/**
 * 外观服装面板：三态 + 场景 key + 一键整套（源码契约测试）
 *
 * 为什么用"读源码 + 断言"而不是挂载 SFC：与 `llmSettings.test.js` / `momentsPagination.test.js`
 * 同一套口径 —— 这个仓库不引 @vue/test-utils，靠契约把行为钉死。
 *
 * 钉住的四件事（2026-10-20 修「一直加载中」时定下）：
 *   ① 接口失败必须落到 `sceneOutfitsError`，不能只清空数组（否则模板永远渲染「加载中…」）
 *   ② 错误态要能重试（`retryLoadSceneOutfits`）
 *   ③ tab 用**场景 key**，不用数组索引（索引在数组变化后会指错项/落空）
 *   ④ 批量按钮叫「一键生成整套系列」，且不再被 `length > 1` 挡住
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/components/ResidentCharacterDetailModal.vue', import.meta.url), 'utf8')

test('外观加载失败要落到错误态，而不是只清空数组', () => {
  assert.match(SRC, /detail\.sceneOutfitsError\s*=\s*err\?\.message/, 'catch 里必须写入错误原因')
  assert.match(SRC, /finally\s*\{[\s\S]{0,120}detail\.sceneOutfitsLoading\s*=\s*false/, 'loading 要在 finally 复位')
  // 不允许再出现"catch 里只有 console.error + 清空"的老写法
  const catchBlock = SRC.slice(SRC.indexOf("console.error('loadSceneOutfits failed:'"))
  assert.ok(!/catch \(err\) \{\s*console\.error\('loadSceneOutfits failed:', err\)\s*detail\.sceneOutfits = \[\]\s*\}/.test(catchBlock),
    'catch 不能停在「清空数组」上')
})

test('错误态提供重试入口', () => {
  assert.match(SRC, /async function retryLoadSceneOutfits\(\)/, '要有重试函数')
  assert.match(SRC, /@click="retryLoadSceneOutfits"/, '模板要接上重试按钮')
  assert.match(SRC, /外观加载失败：\{\{ detail\.sceneOutfitsError \}\}/, '要把原因显示给用户')
  assert.match(SRC, /\.scene-edit-empty\.is-error/, '错误态要有独立样式')
})

test('tab 用场景 key，不用数组索引', () => {
  assert.match(SRC, /sceneTab:\s*'work'/, '默认停在 work，而不是索引 0')
  assert.match(SRC, /detail\.sceneOutfits\.find\(o => o\.scene === detail\.sceneTab\)/, 'activeSceneOutfit 要按 key 查')
  assert.match(SRC, /value: outfit\.scene,/, 'tab 选项的 value 必须是 scene key')
  assert.doesNotMatch(SRC, /value: index,/, '不能再拿 index 当 value')
})

test('一键生成整套系列：入口不被 length>1 挡住，且能兜底场景', () => {
  assert.match(SRC, /一键生成整套系列/, '按钮文案')
  assert.match(SRC, /v-if="detail\.sceneOutfits\.length \|\| detail\.sceneOutfitsError"/, '加载失败时按钮也要在')
  assert.match(SRC, /FALLBACK_SCENE_KEYS/, '场景列表空时用固定四套 key 兜底')
  assert.match(SRC, /await loadSceneOutfits\(c\.id, detail\.originalAppearance\)/, '生成后要自动重拉面板')
})

test('兜底场景 key 必须与后端 outfitScene.js 一致（casual/home/sleep）', () => {
  const scenes = readFileSync(new URL('../../agent-core/src/services/outfitScene.js', import.meta.url), 'utf8')
  const keys = [...scenes.matchAll(/\{\s*key:\s*'([a-z]+)'/g)].map(m => m[1])
  assert.ok(keys.length >= 4, '后端应导出多个场景')
  const fallback = SRC.match(/FALLBACK_SCENE_KEYS\s*=\s*\[([^\]]+)\]/)
  assert.ok(fallback, '要有 FALLBACK_SCENE_KEYS')
  const used = [...fallback[1].matchAll(/'([a-z]+)'/g)].map(m => m[1])
  assert.ok(used.length > 0, '兜底 key 不能为空')
  for (const key of used) assert.ok(keys.includes(key), `兜底 key「${key}」在后端场景表里不存在`)
})

test('打开角色卡必须真的去拉场景服装（否则面板永远停在「加载中…」）', () => {
  const initStart = SRC.indexOf('function init(c)')
  assert.ok(initStart > 0, '要能找到 init(c)')
  const initBody = SRC.slice(initStart, initStart + 2000)
  assert.match(initBody, /loadSceneOutfits\(c\.id/, 'init 里要触发加载')
  assert.match(SRC, /function splitPersona\(/, '要有整卡拆分函数')
  assert.match(initBody, /splitPersona\(c\.base_prompt/, 'init 要用 splitPersona 拆整卡')
  assert.match(initBody, /detail\.editPersona\s*=\s*split\.persona/, '人设框要拿到拆分后的人设')
  assert.match(initBody, /detail\.originalAppearance\s*=\s*split\.appearance/, '要记住原外观做兜底')
  assert.match(initBody, /detail\.appearanceTail\s*=\s*split\.tail/, '尾部要保留，否则保存会丢掉外观段之后的内容')
  // 声明缺失会让模板在 init 之前求值成 undefined，框子空着
  assert.match(SRC, /editPersona:\s*''/, 'editPersona 要有初始值')
  assert.match(SRC, /appearanceTail:\s*''/, 'appearanceTail 要有初始值')
})

test('场景服装默认值：居家有鞋履口径，睡衣赤脚', () => {
  const scenes = readFileSync(new URL('../../agent-core/src/services/outfitScene.js', import.meta.url), 'utf8')
  assert.match(scenes, /key: 'home'[\s\S]{0,200}slippers/, '居家要交代室内拖鞋/赤脚')
  assert.match(scenes, /key: 'sleep'[\s\S]{0,200}赤脚/, '睡衣必须赤脚')
})
