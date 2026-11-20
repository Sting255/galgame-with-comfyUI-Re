/** Use persisted logical messages, never the temporary prompt's message count.
 * Background replies share the same scope as ordinary private chat. The last
 * raw id identifies retries; a successfully saved reply advances the next key.
 */
export function buildConversationLorebookContext(db, { conversationId, character, kind, userName = '用户', throughId, turnKey }) {
  const lastId = throughId ?? db.prepare('SELECT MAX(id) AS id FROM raw_messages WHERE conversation_id=?').get(conversationId).id ?? 0;
  const history = db.prepare(`SELECT id,role,content FROM
    (SELECT id,role,content FROM raw_messages WHERE conversation_id=? AND id<=? ORDER BY id DESC LIMIT 1000)
    ORDER BY id`).all(conversationId, lastId).map(message => ({
      ...message, name: message.role === 'user' ? userName : character.display_name,
    }));
  const step = db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id=? AND id<=?').get(conversationId, lastId).n;
  return {
    scope: conversationId, turnKey: turnKey ?? `${kind}:${lastId}`, step, history, userName,
    characterName: character.display_name,
    characterNames: [character.name, character.display_name].filter(Boolean),
    characterDescription: character.base_prompt || '', characterPersonality: character.short_prompt || '',
    personaTexts: [character.base_prompt].filter(Boolean),
  };
}
