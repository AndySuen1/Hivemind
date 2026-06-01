// 对话记忆仓（L2/L3）：conversation_state 的读写。沿用 observ-repo 的「行映射 + 仓对象」范式，
// 但写入在这里（摘要是对话连续性，不属于可观测性 recorder 的「唯一观测写入口」范畴）。
// 全部 best-effort 包裹：DB 故障只 console.error，绝不抛进 Discord 回复热路径。

import { getDb } from './db.js';

export interface ConversationState {
  sessionId: string;
  botId: string;
  summary: string;
  summarizedThroughMsgId?: string;
  turnCount: number;
  consolidatedAt: number;
  updatedAt: number;
}

interface ConvRow {
  session_id: string;
  bot_id: string;
  summary: string;
  summarized_through_msg_id: string | null;
  turn_count: number;
  consolidated_at: number;
  updated_at: number;
}

const rowToState = (r: ConvRow): ConversationState => ({
  sessionId: r.session_id,
  botId: r.bot_id,
  summary: r.summary,
  summarizedThroughMsgId: r.summarized_through_msg_id ?? undefined,
  turnCount: r.turn_count,
  consolidatedAt: r.consolidated_at,
  updatedAt: r.updated_at,
});

/** L3 空闲整理候选：某会话的 sessionId + 当前摘要（供整理读取）。 */
export interface ConsolidationCandidate {
  sessionId: string;
  summary: string;
}

export const conversationRepo = {
  /** 取某会话的对话状态（摘要 + 元信息）。无则 null。失败→null（best-effort）。 */
  getState(sessionId: string): ConversationState | null {
    try {
      const row = getDb()
        .prepare('SELECT * FROM conversation_state WHERE session_id = ?')
        .get(sessionId) as ConvRow | undefined;
      return row ? rowToState(row) : null;
    } catch (e) {
      console.error('[conv-repo] getState 失败（已忽略）', e);
      return null;
    }
  },

  /** 仅取摘要文本（注入 system prompt 用）。无/失败→''。 */
  getSummary(sessionId: string): string {
    return this.getState(sessionId)?.summary ?? '';
  },

  /**
   * upsert 摘要（保留/可选更新 summarized_through_msg_id；不动 turn_count，留给 L3）。
   * INSERT ... ON CONFLICT(session_id) DO UPDATE。失败→只 console.error（best-effort）。
   */
  upsertSummary(sessionId: string, botId: string, summary: string, throughMsgId?: string): void {
    try {
      getDb()
        .prepare(
          `INSERT INTO conversation_state (session_id, bot_id, summary, summarized_through_msg_id, turn_count, updated_at)
           VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             summary = excluded.summary,
             summarized_through_msg_id = COALESCE(excluded.summarized_through_msg_id, conversation_state.summarized_through_msg_id),
             updated_at = excluded.updated_at`
        )
        .run(sessionId, botId, summary, throughMsgId ?? null, Date.now());
    } catch (e) {
      console.error('[conv-repo] upsertSummary 失败（已忽略）', e);
    }
  },

  /** 标记某会话已整理（固化）到长期记忆，供空闲整理 loop 去重判定。失败→只 console.error。 */
  markConsolidated(sessionId: string, ts: number = Date.now()): void {
    try {
      getDb()
        .prepare('UPDATE conversation_state SET consolidated_at = ? WHERE session_id = ?')
        .run(ts, sessionId);
    } catch (e) {
      console.error('[conv-repo] markConsolidated 失败（已忽略）', e);
    }
  },

  /**
   * L3 空闲整理候选：某 bot 下「有摘要、已空闲（last_active_at ≤ idleBeforeTs）、且自上次整理后有新活动
   * （consolidated_at < last_active_at）」的会话。失败→[]。
   */
  listIdleForConsolidation(botId: string, idleBeforeTs: number): ConsolidationCandidate[] {
    try {
      const rows = getDb()
        .prepare(
          `SELECT cs.session_id AS sid, cs.summary AS summary
             FROM conversation_state cs
             JOIN sessions s ON s.id = cs.session_id
            WHERE cs.bot_id = ?
              AND cs.summary <> ''
              AND s.last_active_at <= ?
              AND cs.consolidated_at < s.last_active_at`
        )
        .all(botId, idleBeforeTs) as { sid: string; summary: string }[];
      return rows.map((r) => ({ sessionId: r.sid, summary: r.summary }));
    } catch (e) {
      console.error('[conv-repo] listIdleForConsolidation 失败（已忽略）', e);
      return [];
    }
  },
};
