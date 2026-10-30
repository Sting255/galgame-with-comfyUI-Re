import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('network forbidden in standing outfit tests'); };
const { getDb } = await import('../src/db/index.js');
const { startStandingBatch, startAllStandingBatches, controlStandingBatch } = await import('../src/services/expressionStandingService.js');
const db = getDb();
db.prepare('DELETE FROM characters').run();
after(() => db.close());

function fixture(name) {
  const id = Number(db.prepare('INSERT INTO characters(name,display_name,base_prompt) VALUES(?,?,?)').run(name, name, '你是测试角色。\n## 你的外观\n银发蓝瞳，白色制服').lastInsertRowid);
  db.prepare('INSERT INTO character_outfits(character_id,name,description,scene) VALUES(?,?,?,?)').run(id, '便装', '红色便装', 'casual');
  db.prepare('INSERT INTO character_outfits(character_id,name,description,scene) VALUES(?,?,?,?)').run(id, '睡衣', '蓝色睡裙', 'sleep');
  return id;
}
async function finished(jobId) {
  for (let i = 0; i < 200; i++) {
    const job = db.prepare('SELECT * FROM expression_standing_jobs WHERE id=?').get(jobId);
    if (['done', 'failed', 'partial_failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('standing job did not finish');
}
const noImages = {
  imageGenerator: async () => { throw new Error('fixture: no image generation'); },
  touchLinesGenerator: async () => { throw new Error('fixture: no touch generation'); },
};

test('queued generation freezes selected outfit; restart before prompts restores that snapshot', async () => {
  const id = fixture('snapshot');
  let received;
  const capture = async (char, slots, requirement, persona, scene) => {
    received = { id: char.id, requirement, persona, scene };
    throw new Error('fixture: interrupt before prompts');
  };
  const first = startStandingBatch(id, { slotIds: ['normal'], outfitScene: 'casual', requirement: '黑发绿瞳' }, { ...noImages, promptGenerator: capture });
  // Edit the outfit while the job is queued: the submitted task must keep the old description.
  db.prepare("UPDATE character_outfits SET description='黄色便装' WHERE character_id=? AND scene='casual'").run(id);
  assert.equal((await finished(first.jobId)).status, 'failed');
  assert.equal(received.scene, 'casual');
  assert.match(received.persona, /红色便装/);
  assert.doesNotMatch(received.persona, /黄色便装|蓝色睡裙/);
  const saved = JSON.parse(db.prepare('SELECT request_json FROM expression_standing_jobs WHERE id=?').get(first.jobId).request_json);
  assert.equal(saved.persona, received.persona);
  assert.equal(saved.outfitScene, 'casual');
  db.prepare('UPDATE expression_standing_jobs SET error=? WHERE id=?').run('服务重启导致生成中断，请重试', first.jobId);
  const resumed = controlStandingBatch(id, first.jobId, 'resume', { ...noImages, promptGenerator: capture });
  await finished(resumed.jobId);
  assert.equal(received.persona, saved.persona);
  assert.equal(received.requirement, '黑发绿瞳');
  assert.equal(received.scene, 'casual');
});

test('batch and fill-missing forward the chosen outfit for every character and persist it after prompts', async () => {
  fixture('batch');
  for (const mode of ['all', 'missing']) {
    const calls = [];
    const result = startAllStandingBatches({ mode, outfitScene: 'sleep', requirement: '换成短发' }, {
      ...noImages,
      promptGenerator: async (char, slots, requirement, persona, scene) => {
        calls.push({ id: char.id, scene, requirement, persona });
        return new Map(slots.map(slot => [slot.id, 'A character in blue pajamas.']));
      },
    });
    assert.equal(result.started.length, 2);
    for (const { jobId } of result.started) {
      const saved = JSON.parse((await finished(jobId)).request_json);
      assert.equal(saved.outfitScene, 'sleep');
      assert.equal(saved.promptsReady, true);
      assert.match(saved.persona, /蓝色睡裙/);
    }
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.scene, 'sleep');
      assert.equal(call.requirement, '换成短发');
      assert.match(call.persona, /蓝色睡裙/);
      assert.doesNotMatch(call.persona, /红色便装|黄色便装/);
    }
  }
});
