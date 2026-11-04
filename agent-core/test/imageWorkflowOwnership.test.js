import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.DB_PATH = ':memory:';
const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-workflow-owner-'));
process.env.IMAGES_DIR = imageDir;
const imageModule = new URL('../src/services/imageSkill.js', import.meta.url).href;
let mode = 'turbo';
globalThis.__workflowOwnerGenerate = async () => ({ success: true, wfMode: mode,
  promptRefined: `refined ${mode}`, images: [{ filename: `${mode}.png`,
    base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' }] });
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url === imageModule) return { format: 'module', shortCircuit: true,
    source: `export * from ${JSON.stringify(`${imageModule}?actual`)};
      export const generateImage = (...args) => globalThis.__workflowOwnerGenerate(...args);
      export const generateImageRaw = generateImage;
      export const getLastWorkflowMode = () => 'unrelated-latest-workflow';` };
  return nextLoad(url, context);
} });
const { getDb, closeDb } = await import('../src/db/index.js');
const router = (await import('../src/routes/characters.js')).default;
const { getEditTask, applyEditTask } = await import('../src/services/imageEditTasks.js');
const app = express(); app.use(express.json()); app.use('/characters', router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve)); server.unref();
after(() => { server.closeAllConnections(); server.close(); hooks.deregister(); closeDb();
  delete globalThis.__workflowOwnerGenerate; fs.rmSync(imageDir, { recursive: true, force: true }); });
async function post(route, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/characters${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
async function ready(id) {
  for (let i = 0; i < 100; i++) {
    const task = getEditTask(id);
    if (task.status === 'pending_confirm') return task;
    if (task.status === 'failed') assert.fail(task.error);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('standing task did not finish');
}
const prompt = 'A person standing in a sunlit garden.';
test('延后确认默认与场景立绘时，使用各任务的工作流而非其它图片的模式', async () => {
  const db = getDb();
  const id = db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)').run('owner', '测试角色', prompt).lastInsertRowid;
  mode = 'turbo';
  const a = await ready((await post(`/${id}/generate-standing-task`, { prompt })).task_id);
  mode = 'base';
  await post(`/${id}/standings/generate`, { scene: 'casual', prompt });
  await applyEditTask(a.id, a.token);
  assert.equal(db.prepare('SELECT workflow_template FROM image_tasks WHERE conversation_id = ?').get(`char_${id}_standing`).workflow_template, 'turbo');
  assert.equal(db.prepare('SELECT workflow_template FROM image_tasks WHERE conversation_id = ?').get(`char_${id}_scene_standing_casual`).workflow_template, 'base');
  mode = 'turbo';
  const b = await ready((await post(`/${id}/standings/generate`, { scene: 'casual', prompt })).task_id);
  mode = 'base';
  await post(`/${id}/generate-standing-image`, { prompt });
  await applyEditTask(b.id, b.token);
  const saved = db.prepare('SELECT workflow_template, prompt_refined FROM image_tasks WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(`char_${id}_scene_standing_casual`);
  assert.equal(saved.workflow_template, 'turbo');
  assert.equal(saved.prompt_refined, 'refined turbo');
});
