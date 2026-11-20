import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, closeDb } from '../src/db/index.js';
import { getSceneOutfitForNow } from '../src/services/outfitScene.js';
import { getProgramDateKey } from '../src/services/programTime.js';

test('旧日程的服装名、数字 id 与新场景键使用同一套衣服，主睡眠强制睡衣', t => {
  const db = getDb();
  t.after(closeDb);
  const id = db.prepare("INSERT INTO characters(name,display_name,base_prompt) VALUES('衣服样本','衣服样本','## 你的外观\nblack hair, amber eyes')").run().lastInsertRowid;
  const insert = db.prepare('INSERT INTO character_outfits(character_id,name,description,scene,body) VALUES(?,?,?,?,?)');
  const travelId = Number(insert.run(id, '旅行披肩', 'red linen cape', 'custom_travel', 'black hair').lastInsertRowid);
  insert.run(id, '睡衣', 'cotton pajamas, barefoot', 'sleep', 'black hair');
  insert.run(id, '裸体', '', 'nude', 'black hair');
  const noon = new Date(2026, 10, 20, 12, 0);
  const save = db.prepare('INSERT OR REPLACE INTO daily_schedules(character_id,schedule_date,schedule_json) VALUES(?,?,?)');
  for (const marker of ['旅行披肩', travelId, String(travelId), 'custom_travel']) {
    const activities = [
      { startTime: '08:00', endTime: '11:00', activity: '出门旅行', outfit: marker },
      { startTime: '11:00', endTime: '21:00', activity: '在城里漫步' },
      { startTime: '22:00', endTime: '07:00', activity: '睡觉', replyDelay: -1, outfit: 'nude' },
    ];
    // 两种历史 JSON 外壳都能读取；稀疏标记沿用白天服装。
    save.run(id, getProgramDateKey(noon), JSON.stringify(typeof marker === 'number' ? { activities } : activities));
    const day = getSceneOutfitForNow(id, noon);
    assert.equal(day.outfit.id, travelId, `旧标记 ${marker}`);
    assert.equal(day.source, 'schedule');
    assert.equal(getSceneOutfitForNow(id, new Date(2026, 10, 20, 23, 0)).scene, 'sleep');
  }
});
