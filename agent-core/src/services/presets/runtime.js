import { createPresetRepository } from '../../db/presetRepository.js';
import { compilePreset, injectPreset, messageText } from './engine.js';

// 由创作提示词组装流程显式调用，底层请求客户端不调用此入口。
async function activePreset() {
  const { getDb } = await import('../../db/index.js');
  return createPresetRepository(getDb()).active();
}

async function requestContext(messages, opts) {
  const { getDb } = await import('../../db/index.js');
  const db = getDb();
  const { config } = await import('../../config.js');
  const metadata = opts.lorebook || {};
  const texts = messages.map(messageText);
  const character = db.prepare('SELECT name,display_name,base_prompt,short_prompt FROM characters').all().find(c => [c.base_prompt,c.short_prompt].some(p => p?.length >= 16 && texts.some(t => t.includes(p))));
  const history = metadata.history || messages.filter(m => m.role !== 'system');
  return {
    userName:config.user.nickname || '用户', personaDescription:config.user.persona || '',
    characterName:character?.display_name || character?.name || '角色', characterDescription:character?.base_prompt || '', characterPersonality:character?.short_prompt || '',
    ...metadata, ...(opts.presetContext || {}),
    lastUserMessage:opts.presetContext?.lastUserMessage ?? messageText(history.findLast(m => m.role === 'user')),
    lastCharMessage:opts.presetContext?.lastCharMessage ?? messageText(history.findLast(m => m.role === 'assistant')),
    lastMessage:opts.presetContext?.lastMessage ?? messageText(history.at(-1)),
  };
}

export function createPresetRuntime({ getActivePreset = activePreset, getContext = requestContext } = {}) {
  async function prepare(messages, opts = {}) {
    const preset = opts.preset === false ? null : await getActivePreset();
    const report = preset ? {
      ...compilePreset(preset.document, await getContext(messages, opts), preset.orderId),
      presetId:preset.id, name:preset.name, revision:preset.revision,
    } : null;
    // 此闭包属于同一次业务生成，包括重试和记忆续接。
    // 后续的新生成请求会重新编译当时启用的预设。
    const apply = nextMessages => injectPreset(nextMessages, report);
    return { messages:apply(messages), report, apply };
  }
  return { prepare };
}
export const preparePreset = createPresetRuntime().prepare;
