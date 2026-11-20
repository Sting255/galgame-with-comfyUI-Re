import { getDb, repairFtsIndex, stmt } from '../../db/index.js';
import { deleteByConversation } from '../../services/vectorClient.js';
import { clearConversationMemories, rollbackMemoriesFromRawId } from '../../services/memory/memoryRepository.js';
import { clearIntimateData, rollbackIntimateByRawId, rollbackIntimateByRawIdRange } from '../../services/intimateService.js';
import { readDialogueTranscript } from '../../services/dialogueTranscript.js';
import { convId, toISODate } from '../../services/chat/shared.js';
import { Router } from 'express';

const router = Router();

// DELETE /api/characters/:id/messages — 清空角色对话记录
router.delete('/characters/:id/messages', (req, res, next) => {
  const db = getDb();
  // 入口即校验：id 必须是正整数，conversationId 由校验后的数字构造（不直接拼接原始输入）
  const charId = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(charId) || charId <= 0) {
    return res.status(400).json({ error: 'invalid character id' });
  }
  const conversationId = `char_${charId}`;

  const doDelete = () => {
    // 先统一清理聊天长期记忆及其版本、checkpoint、审计和独立向量索引
    clearConversationMemories(conversationId);
    // 亲密看板：会话清空时一并清掉行为流水（保留身体档案）。
    // 必须跟着记忆在同一处清理，否则看板会残留"已经被删掉的对话"里的计数
    clearIntimateData(charId);
    stmt('DELETE FROM emotion_snapshots WHERE conversation_id = ?').run(conversationId);
    stmt('DELETE FROM rolling_summaries WHERE conversation_id = ?').run(conversationId);

    stmt('DELETE FROM user_portraits WHERE character_id = ?').run(charId);
    // 删除奇遇数据
    stmt('DELETE FROM character_events WHERE character_id = ?').run(charId);
    stmt('DELETE FROM event_history WHERE character_id = ?').run(charId);
    // 重置好感度到默认值
    stmt('UPDATE user_relationships SET affinity = 50 WHERE character_id = ?').run(charId);
    // 重置主动聊天连胜计数
    stmt('UPDATE characters SET proactive_streak = 0 WHERE id = ?').run(charId);
    // 主表
    stmt('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    stmt('DELETE FROM raw_messages WHERE conversation_id = ?').run(conversationId);
    // 清理 ChromaDB 中该 conversation 的向量
    deleteByConversation(conversationId).then(
      n => { if (n > 0) console.log(`[chat] chroma deleted ${n} vectors for ${conversationId}`); },
      err => console.error(`[chat] chroma cleanup failed for ${conversationId}:`, err.message)
    );
  };

  try {
    doDelete();
  } catch (err) {
    // FTS5 虚拟表损坏时 DELETE 触发器（messages_ad）写入 messages_fts 会失败，
    // 重建 FTS 后重试即可。主表和 raw_messages 的数据不受影响。
    if (err.code === 'SQLITE_CORRUPT_VTAB') {
      console.warn('[chat] FTS5 corrupted during message delete, repairing...');
      try {
        repairFtsIndex();
        doDelete();
        console.log('[chat] retry after FTS repair succeeded');
      } catch (retryErr) {
        console.error('[chat] retry after FTS repair failed:', retryErr.message);
        return next(retryErr);
      }
    } else {
      return next(err);
    }
  }

  res.json({ ok: true });
});

// DELETE /api/characters/:id/messages/last-round — 撤回上一轮对话（仅删 messages + raw_messages）
router.delete('/characters/:id/messages/last-round', (req, res, next) => {
  const db = getDb();
  const conversationId = convId(req.params.id);

  const doDelete = () => {
    // 1. 找到最后一轮对话的起点（最后一条 user 消息的 raw_id）
    const lastUserRaw = stmt(`
      SELECT id FROM raw_messages
      WHERE conversation_id = ? AND role = 'user'
      ORDER BY id DESC LIMIT 1
    `).get(conversationId);

    if (!lastUserRaw) {
      // 没有 user 消息 → 全部是主动聊天等 agent 消息，每次撤回最后一条 agent 消息
      const lastAssistantRaw = stmt(`
        SELECT id FROM raw_messages
        WHERE conversation_id = ? AND role = 'assistant'
        ORDER BY id DESC LIMIT 1
      `).get(conversationId);
      if (!lastAssistantRaw) {
        return res.json({ ok: true, deleted: 0, message: '没有可撤回的对话' });
      }
      const lastRawId = lastAssistantRaw.id;
      const msgCount = stmt(`SELECT COUNT(*) AS c FROM messages WHERE raw_id = ?`).get(lastRawId).c;
      rollbackMemoriesFromRawId(conversationId, lastRawId);
      // 亲密看板：与记忆同步回滚（同一 raw_id 锚点），撤回后统计要能回落
      rollbackIntimateByRawId(lastRawId);
      db.pragma('foreign_keys = OFF');
      try {
        stmt(`DELETE FROM messages WHERE raw_id = ?`).run(lastRawId);
        stmt(`DELETE FROM rolling_summaries WHERE conversation_id = ? AND end_msg_id >= ?`).run(conversationId, lastRawId);
        stmt(`DELETE FROM raw_messages WHERE id = ?`).run(lastRawId);
      } finally {
        db.pragma('foreign_keys = ON');
      }
      console.log(`[chat] undo last round (proactive only): raw=${lastRawId}, ${msgCount} msgs deleted for ${conversationId}`);
      return res.json({ ok: true, deleted: 1 + msgCount });
    }

    const lastUserRawId = lastUserRaw.id;

    // 2. 统计即将删除的数量
    const rawCount = stmt(`
      SELECT COUNT(*) AS c FROM raw_messages
      WHERE conversation_id = ? AND id >= ?
    `).get(conversationId, lastUserRawId).c;

    const msgCount = stmt(`
      SELECT COUNT(*) AS c FROM messages
      WHERE conversation_id = ? AND raw_id >= ?
    `).get(conversationId, lastUserRawId).c;

    // 3. 先回滚来源覆盖该轮的记忆版本，再删除原始消息
    rollbackMemoriesFromRawId(conversationId, lastUserRawId);
    // 亲密看板：这里必须按**区间**回滚，且带 conversationId 收敛，不能用等值删。
    //   原因（真实 bug，由 task-6 对抗式验收复现）：自动记账的锚点是**本轮 assistant raw**
    //   （recordIntimateFromTail 取会话尾部带 prompt 的 assistant raw），它大于 lastUserRawId；
    //   而下面那段删除是按 id >= lastUserRawId 整段删的。若只按 lastUserRawId 等值回滚，
    //   会"命中 0 行 + raw 照删"→ 流水变孤儿（raw_id 指向已删 raw）、totalActs 不回落。
    //   （复现：user raw=55 / assistant raw=56，撤回后残留 raw_id=56 的流水行。）
    //   区间 + conversationId 是 task-15 的语义：raw id 全库自增、不同会话区间会互相穿插，
    //   不传 conversationId 的裸 BETWEEN 会误删别的会话流水；raw_id=0 的无锚点行
    //   （人工补录 / 事件流水）不受影响（min<1 直接 no-op）。
    const maxRawId = stmt('SELECT MAX(id) AS id FROM raw_messages WHERE conversation_id = ?')
      .get(conversationId)?.id || lastUserRawId;
    rollbackIntimateByRawIdRange(lastUserRawId, maxRawId, { conversationId });
    db.pragma('foreign_keys = OFF');
    try {
      stmt(`DELETE FROM rolling_summaries WHERE conversation_id = ? AND end_msg_id >= ?`)
        .run(conversationId, lastUserRawId);
      stmt(`DELETE FROM messages WHERE conversation_id = ? AND raw_id >= ?`)
        .run(conversationId, lastUserRawId);

      stmt(`DELETE FROM raw_messages WHERE conversation_id = ? AND id >= ?`)
        .run(conversationId, lastUserRawId);
    } finally {
      db.pragma('foreign_keys = ON');
    }

    console.log(`[chat] undo last round: ${rawCount} raw + ${msgCount} msgs deleted for ${conversationId}`);
    res.json({ ok: true, deleted: rawCount + msgCount });
  };

  try {
    doDelete();
  } catch (err) {
    if (err.code === 'SQLITE_CORRUPT_VTAB') {
      console.warn('[chat] FTS5 corrupted during undo last round, repairing...');
      try {
        repairFtsIndex();
        doDelete();
        console.log('[chat] undo last round retry after FTS repair succeeded');
      } catch (retryErr) {
        console.error('[chat] undo last round retry failed:', retryErr.message);
        return next(retryErr);
      }
    } else {
      return next(err);
    }
  }
});

/**
 * 逻辑消息组（轮）边界 —— 2026-11-09 方案 B04。
 *
 * ⚠️ **不是**按 `raw_id` 分组：一轮对话在库里是「user 一条 raw + assistant 若干条 raw（逐句）」，
 * 按 raw_id 分组会把同一轮切成两半，翻页时用户会看到「自己发的话在、她的回复不在」——
 * 那比不分页更糟。
 *
 * 这里按**轮**分组：一条消息归属于「在它之前（含自己）的最后一条 user 原文」。
 * 一轮里的 user 与全部 assistant 分句因此共用同一个 turn key。
 * 开场白（第一条 user 之前的内容）没有归属，退回自己的 raw_id 自成一组；
 * 无 raw_id 的独立消息用 -id。
 *
 * 依赖 `raw_messages.id` 单调递增（AUTOINCREMENT），同一轮里 user raw 先于 assistant raw 写入。
 */
const TURN_KEY_SQL = (alias = 'm') => `
  COALESCE(
    (SELECT MAX(turn_u.id) FROM raw_messages turn_u
     WHERE turn_u.conversation_id = ${alias}.conversation_id
       AND turn_u.role = 'user'
       AND turn_u.id <= ${alias}.raw_id),
    ${alias}.raw_id,
    -${alias}.id
  )`;

// GET /api/characters/:id/messages — 获取角色对话消息
//
// 2026-11-09（方案 B04）：新增 `limit` / `before` 分页。
// **不传参数时行为与改动前逐字节一致**（返回全部消息），既有调用方零改动。
//
// 分页以「轮」为边界：一轮 = 一条 user + 她的全部分句，先选轮再取整轮，
// 绝不把一轮切在两页。游标是该轮内首条消息的 id（服务端稳定标识），
// 不让前端猜 created_at 或拿简单 messages.id 当顺序依据。
router.get('/characters/:id/messages', (req, res) => {
  const db = getDb();
  const conversationId = convId(req.params.id);

  const rawLimit = req.query.limit;
  const limit = rawLimit !== undefined ? Math.max(1, Math.min(200, parseInt(rawLimit, 10) || 0)) : null;
  const beforeId = req.query.before !== undefined ? (parseInt(req.query.before, 10) || 0) : null;

  // 组排序键：同一轮所有消息共享同一个 key，用它排序与游标比较
  const groupOrder = `COALESCE((SELECT MIN(part.id) FROM messages part WHERE part.raw_id=m.raw_id),m.id)`;
  const turnKey = TURN_KEY_SQL('m');

  let selectClause;
  let params;
  let page = null;
  let hasMoreOlder = false;

  if (limit === null) {
    // 兼容路径：不分页，返回全部（默认行为，调用方不变）
    selectClause = `
      SELECT m.id, m.conversation_id, m.raw_id, m.role, m.content, m.images, m.created_at, m.event_id, r.client_msg_id
      FROM messages m
      LEFT JOIN raw_messages r ON r.id = m.raw_id
      WHERE m.conversation_id = ?
      ORDER BY ${groupOrder}, m.seq, m.id`;
    params = [conversationId];
  } else {
    // 分页路径：先按「轮」倒序取 limit+1 轮，多取一轮用来判断是否还有更早内容
    const turnRows = db.prepare(`
      SELECT ${turnKey} AS turn_key
      FROM messages m
      WHERE m.conversation_id = ?
        ${beforeId !== null ? `AND ${turnKey} < ?` : ''}
      GROUP BY ${turnKey}
      ORDER BY turn_key DESC
      LIMIT ?
    `).all(...(beforeId !== null ? [conversationId, beforeId] : [conversationId]), limit + 1);

    hasMoreOlder = turnRows.length > limit;
    const pageTurns = hasMoreOlder ? turnRows.slice(0, limit) : turnRows;
    const turnKeys = pageTurns.map(t => t.turn_key);

    if (turnKeys.length === 0) {
      selectClause = null;
      params = [];
    } else {
      const placeholders = turnKeys.map(() => '?').join(',');
      selectClause = `
        SELECT m.id, m.conversation_id, m.raw_id, m.role, m.content, m.images, m.created_at, m.event_id, r.client_msg_id
        FROM messages m
        LEFT JOIN raw_messages r ON r.id = m.raw_id
        WHERE m.conversation_id = ?
          AND COALESCE(${turnKey}, 0) IN (${placeholders})
        ORDER BY ${groupOrder}, m.seq, m.id`;
      params = [conversationId, ...turnKeys];
    }
    // beforeCursor = 本页最早那轮的 key；前端下次带上它取更早的一页
    page = {
      hasMoreOlder,
      beforeCursor: pageTurns.length > 0 ? pageTurns[pageTurns.length - 1].turn_key : null,
      limit,
    };
  }

  // 上游 v4.2.0：深度思考链路下线，消息不再带思考原文；改带 client_msg_id 供前端幂等对齐
  const messages = (selectClause ? stmt(selectClause).all(...params) : []).map(m => ({
    ...m,
    created_at: toISODate(m.created_at),
  }));

  // 附带最新好感度快照（切角色后恢复用）
  const lastSnapshot = stmt(`
    SELECT affinity, affinity_delta, reason FROM emotion_snapshots
    WHERE conversation_id = ? AND affinity IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(conversationId);

  // 恢复对账（B01）：前端错过 dialogue_saved / 配图事件时，靠这两个字段清本地恢复记录与补配图等待态。
  // 只回最近 20 轮用户消息窗口内的结果，不为清一条失败记录吐出全部历史。
  const RECENT_TURNS = 20;
  const recentUserRaws = stmt(`
    SELECT id FROM raw_messages WHERE conversation_id = ? AND role = 'user'
    ORDER BY id DESC LIMIT ?
  `).all(conversationId, RECENT_TURNS);
  const minRecentRawId = recentUserRaws.at(-1)?.id ?? 0;

  // 已完成 = 该轮用户消息之后有带正文的 assistant 原文（配图占位原文是空串，不算完成），
  // 或该轮配图任务已出图（纯图无文字的轮次同样算落定）。
  const completedClientMsgIds = stmt(`
    SELECT r.client_msg_id FROM raw_messages r
    WHERE r.conversation_id = ? AND r.role = 'user' AND r.client_msg_id IS NOT NULL AND r.id >= ?
      AND (EXISTS (SELECT 1 FROM raw_messages a
             WHERE a.conversation_id = r.conversation_id AND a.role = 'assistant'
               AND a.id > r.id AND TRIM(a.content) <> '')
        OR EXISTS (SELECT 1 FROM private_chat_image_turns p JOIN image_tasks t ON t.id = p.task_id
             WHERE p.user_raw_id = r.id AND t.status = 'done'))
    ORDER BY r.id DESC LIMIT ?
  `).all(conversationId, minRecentRawId, RECENT_TURNS).map(r => r.client_msg_id);

  // 只回未落定的配图任务：done 的图已挂在 messages 行上，随 messages 一起返回，重复下发只会多一个空壳气泡
  const imageTasks = stmt(`
    SELECT t.id, t.status, t.error_message, t.created_at, p.message_id, p.user_raw_id, r.client_msg_id
    FROM private_chat_image_turns p JOIN image_tasks t ON t.id = p.task_id
    LEFT JOIN raw_messages r ON r.id = p.user_raw_id
    WHERE p.conversation_id = ? AND p.user_raw_id >= ? AND t.status IN ('pending','running','failed')
    ORDER BY p.user_raw_id DESC LIMIT 10
  `).all(conversationId, minRecentRawId).map(t => ({
    id: t.id, status: t.status, error_message: t.error_message, created_at: toISODate(t.created_at),
    message_id: t.message_id, user_raw_id: t.user_raw_id, clientMsgId: t.client_msg_id,
  }));

  res.json({
    messages,
    affinity: lastSnapshot ? {
      value: lastSnapshot.affinity,
      delta: lastSnapshot.affinity_delta ?? 0,
      reason: lastSnapshot.reason || '',
    } : null,
    completedClientMsgIds,
    imageTasks,
    // 分页信息（B04）：不分页时为 null，保持旧响应形状不变
    page: page,
  });
});

// Galgame 模式（上游 v3.9.0 合并）读的是完整源消息，不是分句气泡表。
router.get('/characters/:id/dialogue', (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM characters WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '角色不存在' });
  res.json(readDialogueTranscript(db, req.params.id, req.query));
});

// GET /api/messages/:id — 单条消息查询（送礼图片轮询用）
router.get('/messages/:id', (req, res) => {
  const db = getDb();
  const msg = stmt(
    'SELECT id, role, content, images, created_at FROM messages WHERE id = ?'
  ).get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'not found' });
  res.json({ ...msg, created_at: toISODate(msg.created_at) });
});

export default router;
