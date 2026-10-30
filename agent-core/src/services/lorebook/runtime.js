import { createLorebookRepository } from '../../db/lorebookRepository.js';
import { estimateTokens, hash, normalizeSettings } from './engine.js';
import { runLorebookTask } from './workerClient.js';
import { classifyCacheEntry } from './cachePolicy.js';
import * as builtinRules from '../../builtinRules.js';

/** Only explicitly opted-in creative call sites use this adapter. Extraction/classification keep their original client. */
export async function prepareLorebook(messages, options = {}) {
  const withoutBook = () => ({ messages, reapply: nextMessages => nextMessages, commit() {} });
  if (options === false) return withoutBook();
  const { getDb } = await import('../../db/index.js');
  const { getActiveWorldSetting, isWorldSettingHidden, getSystemRules } = await import('../../db/worldRepository.js');
  const { config } = await import('../../config.js');
  const db = getDb(); const repo = createLorebookRepository(db);
  const world = options.worldId ? db.prepare('SELECT * FROM world_settings WHERE id=?').get(options.worldId) : getActiveWorldSetting();
  // An explicitly selected empty world is still allowed to own a lorebook. Disturb hideWorld suppresses both.
  if (!world || (!options.worldId && isWorldSettingHidden())) return withoutBook();
  const savedBook = options.book || repo.get(world.id);
  if (!savedBook?.enabled) return withoutBook();
  const book = { ...savedBook, settings: normalizeSettings(savedBook.settings) };
  const text = m => typeof m.content === 'string' ? m.content : (m.content || []).filter(p=>p.type==='text').map(p=>p.text).join('\n');
  // Match actual saved persona text, not display names guessed from prose. This
  // also supplies character filters/macros to generic creative integrations.
  const characters = db.prepare('SELECT id,name,display_name,base_prompt,short_prompt FROM characters').all();
  const present = characters.filter(c => [c.base_prompt,c.short_prompt].some(p => p?.length >= 16 && messages.some(m => text(m).includes(p))));
  const personaTexts = options.personaTexts || [options.characterDescription, ...present.flatMap(c => [c.base_prompt,c.short_prompt]).filter(p=>p?.length>=16)].filter(Boolean);
  const worldText = world.content?.trim() ? `<world_setting>\n${world.content}\n</world_setting>` : '';
  const staticTexts = [getSystemRules(),getSystemRules({roleplay:false}),worldText,
    ...Object.values(builtinRules).flatMap(value => typeof value === 'string' ? [value] : value?.rule_content ? [value.rule_content] : []),
    ...messages.flatMap(m => [...text(m).matchAll(/<world_integration\b[^>]*>[\s\S]*?<\/world_integration>/g)].map(match=>match[0])),
    ...(options.staticTexts || [])];
  const layoutOptions = { ...options, personaTexts, worldText, staticTexts };
  const history = options.history || messages.filter(m=>m.role!=='system').map(m=>({ role:m.role, name:m.name, content:text(m) }));
  const context = {
    group: options.scope?.startsWith('group_') || !!options.transcriptSegments,
    history, userName: config.user.nickname || '用户', characterName: options.characterName || present[0]?.display_name || '角色',
    characterNames: present.flatMap(c=>[c.name,c.display_name]).filter(Boolean),
    characterDescription: options.characterDescription || personaTexts.join('\n'), characterPersonality:present.map(c=>c.short_prompt).filter(Boolean).join('\n'), personaDescription: config.user.persona || '',
    characterDepthPrompt: world.content || '', creatorNotes:world.content || '',
    scenario: options.scenario || world.content || '', trigger: options.trigger || 'normal', step: options.step ?? history.length,
    ...options,
  };
  const scope = options.scope; const turnKey = options.turnKey;
  const previous = scope ? repo.previous(book.worldId,scope,context.step,book.revision) : {};
  const failed = error => {
    const warning = `世界书未注入：${error.message}`;
    console.warn('[lorebook]', warning);
    return { ...withoutBook(), activation: { entries:[], trace:[], warnings:[warning], tokens:0, budget:0, nextState:previous },
      report: { worldId:book.worldId, name:book.name, revision:book.revision, placements:[], trace:[], warnings:[warning], tokens:0, budget:0 } };
  };
  let activation = scope && turnKey ? repo.snapshot(book.worldId,scope,turnKey,book.revision) : null;
  if (!activation) {
    if (book.settings.vectorAll || Object.values(book.document.entries).some(e=>e.vectorized && !e.disable)) {
      try {
        const { recallLorebook } = await import('./vectors.js');
        context.vectorIds = await recallLorebook(book, history.slice(-book.settings.vectorQueryMessages).map(m=>m.content).join('\n'));
      } catch (error) { context.vectorError = `向量召回不可用：${error.message}`; }
    }
    // 这里只为回复预留上下文空间，不作为 API 的输出上限发送。
    const availableTokens = Math.max(0, (options.contextTokens || book.settings.contextTokens) - (options.maxOutputTokens || 4096) - (Math.max(0, Number(options.reservedTokens) || 0)) - messages.reduce((n,m)=>n+estimateTokens(text(m))+4,0));
    try { activation = await runLorebookTask('evaluate', [book.document, book.settings, { ...context, availableTokens }, previous]); }
    catch (error) { return failed(error); }
    if (context.vectorError) activation.warnings.push(context.vectorError);
  }
  // Old snapshots contain rendered content, which can hide time/random macros.
  // Always classify against the saved source document, without rerolling activation.
  activation = { ...activation, entries: activation.entries.map(entry => ({ ...entry, cacheProfile: classifyCacheEntry(book.document.entries[String(entry.uid)] || { ...entry, constant:false }) })) };
  const apply = original => runLorebookTask('layout', [original,activation,{ ...layoutOptions, userName:context.userName, characterName:context.characterName, cachePlacement:book.settings.positionPolicy !== 'anchors', regexRules:book.settings.regexRules || [] }]);
  let injected;
  try { injected = activation.entries.some(entry => entry.content.trim()) ? await apply(messages) : {messages, placements:[], warnings:activation.warnings}; }
  catch (error) { return failed(error); }
  const report = { worldId:book.worldId, name:book.name, revision:book.revision, fingerprint:activation.fingerprint, budget:activation.budget, tokens:activation.tokens, trace:activation.trace, placements:injected.placements, warnings:injected.warnings, stablePrefixHash:injected.stablePrefixHash, stableLoreHash:injected.stableLoreHash };
  let valid = true;
  return { messages:injected.messages, report, activation, async reapply(nextMessages) {
    if (!activation.entries.some(entry => entry.content.trim())) return nextMessages;
    try { return (await apply(nextMessages)).messages; }
    catch (error) { valid = false; report.warnings.push(`世界书重新注入失败：${error.message}`); console.warn('[lorebook]', report.warnings.at(-1)); return nextMessages; }
  }, commit() { if (valid && !options.dryRun && scope && turnKey) repo.commit(book,scope,turnKey,context.step,activation); } };
}

export async function chatSync(messages, opts = {}) {
  const prepared = await prepareLorebook(messages, opts.lorebook === false ? false : (opts.lorebook || {}));
  const client = await import('../../llm/llm-client.js');
  const result = await client.chatSync(prepared.messages, opts);
  prepared.commit(); return result;
}

export async function* chatStream(messages, opts = {}) {
  const prepared = await prepareLorebook(messages, opts.lorebook === false ? false : (opts.lorebook || {}));
  const client = await import('../../llm/llm-client.js');
  yield* client.chatStream(prepared.messages, opts); prepared.commit();
}

export { hash };
