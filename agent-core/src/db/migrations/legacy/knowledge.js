import { IMAGE_PROMPT_KNOWLEDGE, IMAGE_PROMPT_KNOWLEDGE_VERSION } from '../../imagePromptKnowledgeData.js';
import { POSITION_KNOWLEDGE, POSITION_KNOWLEDGE_VERSION } from '../../positionKnowledgeData.js';


export function seedImagePromptKnowledge(db) {
  // 两套知识**各自独立版本号**（2026-10-21）：
  //   · ipk.*  = YAML 生成的通用标签库（带过滤，版本随 sha256 变）
  //   · pose.pr24.* = 84 条体位（用户裁定**不过滤**，全场景，版本独立）
  // 早退条件必须"两套都已完成"才 return，否则会出现"只更新了一半知识库"的半吊子状态。
  const currentVersion = db.prepare(
    `SELECT setting_value FROM system_settings WHERE setting_key = 'image_prompt_knowledge_version'`
  ).pluck().get();
  const currentPoseVersion = db.prepare(
    `SELECT setting_value FROM system_settings WHERE setting_key = 'image_prompt_knowledge_pose_version'`
  ).pluck().get();
  const ipkDone = currentVersion === IMAGE_PROMPT_KNOWLEDGE_VERSION;
  const poseDone = currentPoseVersion === POSITION_KNOWLEDGE_VERSION;
  if (ipkDone && poseDone) return;

  const upsert = db.prepare(`
    INSERT INTO image_prompt_knowledge (
      knowledge_id, category, title, search_terms, content, executable_tags, scenes,
      is_default, priority, version, is_active, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(knowledge_id) DO UPDATE SET
      category = excluded.category,
      title = excluded.title,
      search_terms = excluded.search_terms,
      content = excluded.content,
      executable_tags = excluded.executable_tags,
      scenes = excluded.scenes,
      is_default = excluded.is_default,
      priority = excluded.priority,
      version = excluded.version,
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
  `);
  const setVersion = db.prepare(`
    INSERT INTO system_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `);

  const seed = db.transaction(() => {
    if (!ipkDone) {
      for (const item of IMAGE_PROMPT_KNOWLEDGE) {
        upsert.run(
          item.knowledgeId,
          item.category,
          item.title,
          item.searchTerms,
          item.content,
          JSON.stringify(item.executableTags || []),
          JSON.stringify(item.scenes),
          item.isDefault ? 1 : 0,
          item.priority,
          IMAGE_PROMPT_KNOWLEDGE_VERSION,
        );
      }
      db.prepare(`
        UPDATE image_prompt_knowledge
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE knowledge_id LIKE 'ipk.lib.%' AND version <> ?
      `).run(IMAGE_PROMPT_KNOWLEDGE_VERSION);
      setVersion.run('image_prompt_knowledge_version', IMAGE_PROMPT_KNOWLEDGE_VERSION);
    }

    if (!poseDone) {
      // 84 条体位：不过滤、全场景（见 db/positionKnowledgeData.js 顶部裁定说明）
      for (const item of POSITION_KNOWLEDGE) {
        upsert.run(
          item.knowledgeId,
          item.category,
          item.title,
          item.searchTerms,
          item.content,
          JSON.stringify(item.executableTags || []),
          JSON.stringify(item.scenes),
          item.isDefault ? 1 : 0,
          item.priority,
          POSITION_KNOWLEDGE_VERSION,
        );
      }
      // 只下线"旧版体位"，绝不碰 ipk.*（两套版本号互不干扰）
      db.prepare(`
        UPDATE image_prompt_knowledge
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE knowledge_id LIKE 'pose.pr24.%' AND version <> ?
      `).run(POSITION_KNOWLEDGE_VERSION);
      setVersion.run('image_prompt_knowledge_pose_version', POSITION_KNOWLEDGE_VERSION);
    }
  });
  seed();
  if (!ipkDone) console.log(`[db] image prompt knowledge seeded: ${IMAGE_PROMPT_KNOWLEDGE.length} items, version=${IMAGE_PROMPT_KNOWLEDGE_VERSION}`);
  if (!poseDone) console.log(`[db] pose knowledge seeded: ${POSITION_KNOWLEDGE.length} items, version=${POSITION_KNOWLEDGE_VERSION}`);
}


export function migrateImagePromptKnowledgeSchema(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(image_prompt_knowledge)`).all();
    if (!cols.some(column => column.name === 'executable_tags')) {
      db.exec(`ALTER TABLE image_prompt_knowledge ADD COLUMN executable_tags TEXT NOT NULL DEFAULT '[]'`);
      console.log('[db] Added image_prompt_knowledge.executable_tags column');
    }
  } catch (err) {
    console.log('[db] migrateImagePromptKnowledgeSchema error:', err.message);
  }
}


/**
 * M0 相遇结算：town_encounters 加 outcome_json（规则结算的结构化结果）与
 * polished_summary（LLM 润色，仅表现）。可重复执行；旧库旧行两列为空即走兼容路径。
 */
export function dropImagePromptPreparations(db) {
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_prompt_preparations'").get();
    if (!exists) return;
    const before = db.prepare('SELECT count(*) n FROM image_prompt_preparations').get().n;
    db.exec('DROP TABLE image_prompt_preparations');
    console.log(`[db] 已删除 image_prompt_preparations（${before} 行诊断留档，无读者）`);
  } catch (err) {
    console.log('[db] dropImagePromptPreparations skipped:', err.message);
  }
}
