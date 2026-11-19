import { getDb } from '../db/index.js';
import { matchAll } from './characterSearch.js';
import { buildCharacterPersona, buildImageCrossRefInfo, captureCharacterOutfitSnapshot } from './characterPersona.js';
import { charArtistOverrideWithFallback } from './characterImageOpts.js';
import { getProgramNow, parseDateKey, parseHhmm } from './programTime.js';

/** Resolve the wall-clock instant represented by a selected daily schedule item. */
export function scheduleActivityTargetDate(activity, { explicitActivity = false, programDateKey = null, now = getProgramNow() } = {}) {
  if (!explicitActivity) {
    const current = new Date(now);
    if (!programDateKey) return current;
    const parsed = parseDateKey(programDateKey);
    if (!parsed) return null;
    parsed.setHours(current.getHours(), current.getMinutes(), current.getSeconds(), current.getMilliseconds());
    return parsed;
  }

  if (programDateKey) {
    const parsed = parseDateKey(programDateKey);
    if (!parsed) return null;
    now = parsed;
  }

  const minute = parseHhmm(activity?.startTime);
  if (minute === null) return new Date(now);
  const target = new Date(now);
  target.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return target;
}

/** 新日程以ID为准；旧日程复用画风测试的姓名检测，不扫描角色人格和关系全文。 */
export function resolveScheduleParticipants(characterId, activity, { db = getDb(), detect = matchAll } = {}) {
  if (!activity) return [];
  const explicit = Array.isArray(activity.participantIds);
  const ids = explicit ? activity.participantIds : detect([activity.activity, activity.location, activity.description].filter(Boolean).join('\n'), Number(characterId)).map(c => c.id);
  return [...new Set(ids.map(Number))].filter(id => Number.isSafeInteger(id) && id !== Number(characterId))
    .map(id => db.prepare("SELECT * FROM characters WHERE id=?").get(id)).filter(Boolean);
}

export function scheduleMomentCompanions(characterId, activity, options = {}) {
  const db = options.db || getDb();
  return resolveScheduleParticipants(characterId, activity, { ...options, db }).map(other => {
    const outgoing = db.prepare('SELECT relationship_text FROM character_relationships WHERE from_character_id=? AND to_character_id=?').get(characterId, other.id)?.relationship_text;
    const incoming = db.prepare('SELECT relationship_text FROM character_relationships WHERE from_character_id=? AND to_character_id=?').get(other.id, characterId)?.relationship_text;
    const outfitSnapshot = options.outfitScene === 'none'
      ? null
      : options.outfitSnapshots?.[other.id] || captureCharacterOutfitSnapshot(other, {
        outfitScene: options.outfitScene || 'current', date: options.date,
        ignoreOverride: options.ignoreOverride === true,
      });
    return { otherId: other.id, otherName: other.display_name,
      otherPersona: buildCharacterPersona(other, { variant: 'short', person: other.display_name,
        ...(options.outfitScene === 'none' ? { outfitScene: 'none' } : { outfitSnapshot }) }),
      outfitSnapshot,
      relDesc: [outgoing && `你对${other.display_name}的关系：${outgoing}`, incoming && `${other.display_name}对你的关系：${incoming}`].filter(Boolean).join('；') || `${other.display_name}正在与你共同活动` };
  });
}

export function parseCharacterLoras(value) {
  try { const data = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(data) ? data.filter(l => l && typeof l === 'object') : []; }
  catch { return []; }
}

export function scheduleImageContext(character, activity, options = {}) {
  const others = resolveScheduleParticipants(character.id, activity, options);
  const outfitScene = options.outfitScene || 'current';
  const includeOutfitSnapshots = options.includeOutfitSnapshots !== false && outfitScene !== 'none';
  const outfitSnapshot = !includeOutfitSnapshots
    ? null
    : options.outfitSnapshot || captureCharacterOutfitSnapshot(character, {
      outfitScene, date: options.date, ignoreOverride: options.ignoreOverride === true,
    });
  const outfitSnapshots = !includeOutfitSnapshots ? {} : Object.fromEntries(others.map(other => [other.id,
    options.outfitSnapshots?.[other.id] || captureCharacterOutfitSnapshot(other, {
      outfitScene, date: options.date, ignoreOverride: options.ignoreOverride === true,
    })
  ]));
  const loras = [...new Map([character, ...others].flatMap(c => parseCharacterLoras(c.loras)).map(l => [l.name || l.filename || JSON.stringify(l), l])).values()];
  const artist = charArtistOverrideWithFallback(character, others);
  return {
    others, participantIds: [Number(character.id), ...others.map(c => c.id)],
    outfitSnapshot,
    outfitSnapshots,
    crossReference: others.length ? `【此刻实际在场的同行者】\n${others.map(c => `[${c.display_name}]\n${buildImageCrossRefInfo(c,
      includeOutfitSnapshots ? { outfitSnapshot: outfitSnapshots[c.id] } : { outfitScene: 'none' })}`).join('\n\n')}\n画面包含主角与以上同行者，分别描述每个人的外观与动作，人数准确。` : '',
    imageOptions: { ...(loras.length ? { loras } : {}), ...(artist !== null ? { artist } : {}),
      ...(others.length ? { customWorkflow: null } : character.custom_workflow ? { customWorkflow: character.custom_workflow } : {}) },
  };
}
