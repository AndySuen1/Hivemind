// Claude 帖直通绑定仓：thread_sessions / thread_session_resets 的读写（migration 0013）。
// 沿用 conversation-repo 的「行映射 + 仓对象 + best-effort try/catch」范式——
// 这是「帖子↔Claude session」运行时绑定的事实源，与 recorder 的 sessions 表（可观测性）正交。
// 全部 best-effort 包裹：DB 故障只 console.error / 返回 null，绝不抛进 Discord 消息热路径。

import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

export type ThreadSessionStatus = 'active' | 'closed';

/** 一个帖子 ↔ Claude session 的绑定（面向运行时的 camelCase 视图）。 */
export interface ThreadSession {
  threadId: string;
  botId: string;
  forumChannelId: string;
  claudeSessionId?: string; // 建帖瞬间为空；首条 query 的 system/init 后写入
  cwd: string;
  requesterId?: string;
  status: ThreadSessionStatus;
  resetCount: number;
  title?: string;
  createdAt: number;
  lastActiveAt: number;
}

interface ThreadSessionRow {
  thread_id: string;
  bot_id: string;
  forum_channel_id: string;
  claude_session_id: string | null;
  cwd: string;
  requester_id: string | null;
  status: ThreadSessionStatus;
  reset_count: number;
  title: string | null;
  created_at: number;
  last_active_at: number;
}

const rowToThreadSession = (r: ThreadSessionRow): ThreadSession => ({
  threadId: r.thread_id,
  botId: r.bot_id,
  forumChannelId: r.forum_channel_id,
  claudeSessionId: r.claude_session_id ?? undefined,
  cwd: r.cwd,
  requesterId: r.requester_id ?? undefined,
  status: r.status,
  resetCount: r.reset_count,
  title: r.title ?? undefined,
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
});

export interface CreateThreadSessionInput {
  threadId: string;
  botId: string;
  forumChannelId: string;
  cwd: string;
  requesterId?: string;
  title?: string;
}

export const threadSessionRepo = {
  /**
   * 取某帖子的绑定。命中且 bot_id 匹配才返回（非本 bot 的帖子当未命中，防抢别人帖子）。
   * 失败 / 不匹配 → null（退化为「非绑定帖」，走原 DeepSeek 流）。
   */
  getByThread(botId: string, threadId: string): ThreadSession | null {
    try {
      const row = getDb()
        .prepare('SELECT * FROM thread_sessions WHERE thread_id = ?')
        .get(threadId) as ThreadSessionRow | undefined;
      if (!row || row.bot_id !== botId) return null;
      return rowToThreadSession(row);
    } catch (e) {
      console.error('[thread-repo] getByThread 失败（已忽略）', e);
      return null;
    }
  },

  /** 建帖时插入一条 active 绑定（claude_session_id 暂空）。失败抛出（建帖是用户可见操作，调用方需感知）。 */
  create(input: CreateThreadSessionInput): ThreadSession {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO thread_sessions
           (thread_id, bot_id, forum_channel_id, claude_session_id, cwd, requester_id, status, reset_count, title, created_at, last_active_at)
         VALUES (?, ?, ?, NULL, ?, ?, 'active', 0, ?, ?, ?)`
      )
      .run(
        input.threadId,
        input.botId,
        input.forumChannelId,
        input.cwd,
        input.requesterId ?? null,
        input.title ?? null,
        now,
        now
      );
    return this.getByThread(input.botId, input.threadId)!;
  },

  /** 每回合 query 后刷新 session_id + last_active_at（resume 会 fork 出新 id，必须覆盖）。失败→console.error。 */
  updateSession(threadId: string, claudeSessionId: string): void {
    try {
      getDb()
        .prepare('UPDATE thread_sessions SET claude_session_id = ?, last_active_at = ? WHERE thread_id = ?')
        .run(claudeSessionId, Date.now(), threadId);
    } catch (e) {
      console.error('[thread-repo] updateSession 失败（已忽略）', e);
    }
  },

  /** 仅刷活跃时间（收到消息但还没拿到新 session_id 时）。失败→console.error。 */
  touch(threadId: string): void {
    try {
      getDb()
        .prepare('UPDATE thread_sessions SET last_active_at = ? WHERE thread_id = ?')
        .run(Date.now(), threadId);
    } catch (e) {
      console.error('[thread-repo] touch 失败（已忽略）', e);
    }
  },

  /**
   * 重开 session：把新 session_id 写回主表、reset_count++，并在 reset 链表追加一行历史。
   * 事务内完成。失败→console.error（不阻断 reset，新 session 已在 Claude 侧建立）。
   */
  recordReset(args: {
    threadId: string;
    oldSession?: string;
    newSession?: string;
    handoffDoc?: string;
    openingLine?: string;
  }): void {
    try {
      const db = getDb();
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          'UPDATE thread_sessions SET claude_session_id = ?, reset_count = reset_count + 1, last_active_at = ? WHERE thread_id = ?'
        ).run(args.newSession ?? null, now, args.threadId);
        db.prepare(
          `INSERT INTO thread_session_resets (id, thread_id, old_session, new_session, handoff_doc, opening_line, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          args.threadId,
          args.oldSession ?? null,
          args.newSession ?? null,
          args.handoffDoc ?? null,
          args.openingLine ?? null,
          now
        );
      })();
    } catch (e) {
      console.error('[thread-repo] recordReset 失败（已忽略）', e);
    }
  },

  /** 关闭绑定（帖归档/显式关闭）。失败→console.error。 */
  close(threadId: string): void {
    try {
      getDb()
        .prepare("UPDATE thread_sessions SET status = 'closed', last_active_at = ? WHERE thread_id = ?")
        .run(Date.now(), threadId);
    } catch (e) {
      console.error('[thread-repo] close 失败（已忽略）', e);
    }
  },

  /** 某 bot 的所有 active 绑定（重启后认领用，best-effort）。失败→[]。 */
  listActive(botId: string): ThreadSession[] {
    try {
      const rows = getDb()
        .prepare("SELECT * FROM thread_sessions WHERE bot_id = ? AND status = 'active' ORDER BY last_active_at DESC")
        .all(botId) as ThreadSessionRow[];
      return rows.map(rowToThreadSession);
    } catch (e) {
      console.error('[thread-repo] listActive 失败（已忽略）', e);
      return [];
    }
  },
};
