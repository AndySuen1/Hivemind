// P7 数据保留与清理：①孤儿 running 回合恢复（启动时）②按保留天数定时/手动清理 ③手动删会话/某 bot 全部历史。
//
// 设计要点：
//  · 删除全靠 migration 0005 的 ON DELETE CASCADE（session → run → event/message）：只删 sessions，
//    子表（runs/messages/events）自动连带清空。故本模块只 DELETE FROM sessions / UPDATE runs。
//  · 与 recorder.ts（热路径单条写入，含 seq 计数器/脱敏/广播）分离：这里是低频的批量/管理写入，
//    不走 seq 计数器、不广播——清理的多是早已不活跃的旧数据，无在线观看者；手动删后前端会重新拉取/重挂以反映。
//  · 后台/启动调用（recoverInterruptedRuns / purgeByRetention / sweep）整体 try/catch 不外抛，绝不阻断启动或拖垮定时器；
//    API 直调的 deleteSession/deleteBotHistory 让异常上抛给 Fastify 错误处理（返回 500 + 信息），便于排查。

import { getDb } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 读非负整数 env；缺省/非法 → def。 */
function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/** 保留天数：last_active_at 早于「now - 天数」的会话会被清理。0 = 关闭自动清理（仍可手动）。默认 30 天。 */
export const RETENTION_DAYS = intEnv('OBSERV_RETENTION_DAYS', 30);
/** 日志（logs 表）保留天数：早于「now - 天数」的日志行会被清理。比会话短（日志量大、价值衰减快）。0 = 关闭。默认 7 天。 */
export const LOG_RETENTION_DAYS = intEnv('LOG_RETENTION_DAYS', 7);
/** 后台清理间隔（小时）。<=0 视为默认。默认 6 小时。 */
export const RETENTION_INTERVAL_HOURS = (() => {
  const h = intEnv('OBSERV_RETENTION_INTERVAL_HOURS', 6);
  return h > 0 ? h : 6;
})();

/**
 * 把上次进程残留的 status='running' 回合标记为 aborted（补 ended_at / finish_reason / error）。
 * 触发场景：orchestrator 崩溃或 tsx watch 热重载导致 endRun 未执行，否则这些回合永远「进行中」，
 * 持续污染 Live「进行中」计数。**应在 initDb 之后、开始处理新消息（syncFromDb）之前调用一次**
 * ——此刻 DB 里任何 running 都必来自上个进程。返回被恢复的回合数。
 */
export function recoverInterruptedRuns(): number {
  try {
    const db = getDb();
    const res = db
      .prepare(
        `UPDATE runs
            SET status = 'aborted',
                finish_reason = COALESCE(finish_reason, 'interrupted'),
                error = COALESCE(error, 'orchestrator 重启/崩溃，回合中断'),
                ended_at = COALESCE(ended_at, ?)
          WHERE status = 'running'`
      )
      .run(Date.now());
    return res.changes;
  } catch (e) {
    console.error('[retention] recoverInterruptedRuns 失败（已忽略，不影响启动）:', e);
    return 0;
  }
}

/**
 * 按保留天数清理的核心（**会抛错**）：删除 last_active_at 早于 (now - floor(days)*天) 的会话
 * （CASCADE 连带清回合/消息/事件）。days 先向下取整——挡住 0.x 之类把 cutoff 推到几乎当下、
 * 从而误删几乎全部会话的取值；floor(days)<=0 关闭清理（返回 0）。
 * 防御：跳过仍有 running 回合的会话（活跃回合的 last_active_at 必近期，实际几乎不会命中，纯兜底）。
 * 供 API 直调：异常上抛给 Fastify→500，与 deleteSession/deleteBotHistory 一致，避免「失败伪装成清理 0 个」。
 */
export function purgeByRetentionStrict(days: number = RETENTION_DAYS): { sessions: number } {
  const d = Math.floor(days);
  if (!d || d <= 0) return { sessions: 0 };
  const db = getDb();
  const cutoff = Date.now() - d * DAY_MS;
  const res = db
    .prepare(
      `DELETE FROM sessions
        WHERE last_active_at < ?
          AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.session_id = sessions.id AND runs.status = 'running')`
    )
    .run(cutoff);
  return { sessions: res.changes };
}

/**
 * 后台/启动安全版：包住 purgeByRetentionStrict 吞异常只 console.error（定时器/启动路径不能因 DB 故障崩）。
 * 手动 API 路径请改用 purgeByRetentionStrict，让失败可感知。返回被删会话数（失败时 0）。
 */
export function purgeByRetention(days: number = RETENTION_DAYS): { sessions: number } {
  try {
    return purgeByRetentionStrict(days);
  } catch (e) {
    console.error('[retention] purgeByRetention 失败（已忽略）:', e);
    return { sessions: 0 };
  }
}

/**
 * 清理 logs 表里早于「now - LOG_RETENTION_DAYS 天」的日志行（无 CASCADE，直接按 ts 删）。
 * 后台 sweep 调用；整体 try/catch 不外抛（定时器路径不能因 DB 故障崩）。LOG_RETENTION_DAYS=0 关闭。返回被删行数。
 */
export function purgeLogsByRetention(days: number = LOG_RETENTION_DAYS): { logs: number } {
  const d = Math.floor(days);
  if (!d || d <= 0) return { logs: 0 };
  try {
    const cutoff = Date.now() - d * DAY_MS;
    const res = getDb().prepare('DELETE FROM logs WHERE ts < ?').run(cutoff);
    return { logs: res.changes };
  } catch (e) {
    console.error('[retention] purgeLogsByRetention 失败（已忽略）:', e);
    return { logs: 0 };
  }
}

/** 删除单个会话（CASCADE 连带清其回合/消息/事件）。返回是否删到（false=不存在）。 */
export function deleteSession(sessionId: string): boolean {
  if (!sessionId) return false;
  const res = getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  return res.changes > 0;
}

/** 删除某 bot 的全部会话（CASCADE 连带清所有子表）。返回被删会话数。 */
export function deleteBotHistory(botId: string): { sessions: number } {
  if (!botId) return { sessions: 0 };
  const res = getDb().prepare('DELETE FROM sessions WHERE bot_id = ?').run(botId);
  return { sessions: res.changes };
}

/**
 * 启动后台保留清理：立即跑一次（不必等一个周期）+ 每 RETENTION_INTERVAL_HOURS 跑一次。
 * 返回停止函数（供 shutdown 调用清掉定时器）。RETENTION_DAYS=0 时不启动定时器（仍可手动清理）。
 */
export function startRetentionLoop(): () => void {
  if (RETENTION_DAYS <= 0 && LOG_RETENTION_DAYS <= 0) {
    console.log('[retention] 会话与日志自动清理均已关闭（仍可手动清理）');
    return () => {};
  }
  const sweep = (): void => {
    const { sessions } = purgeByRetention();
    if (sessions > 0) console.log(`[retention] 清理 ${sessions} 个过期会话（保留 ${RETENTION_DAYS} 天）`);
    const { logs } = purgeLogsByRetention();
    if (logs > 0) console.log(`[retention] 清理 ${logs} 条过期日志（保留 ${LOG_RETENTION_DAYS} 天）`);
  };
  sweep();
  // setInterval 延迟是 32 位有符号整数（上限 2^31-1 ms ≈ 24.8 天 ≈ 596h），超限会被 Node 静默退化为 1ms
  // → 每毫秒触发一次 sweep（CPU 空转 + 频繁全表 DELETE）。钳到上限防误配（如 OBSERV_RETENTION_INTERVAL_HOURS=720）。
  const intervalMs = Math.min(RETENTION_INTERVAL_HOURS * 60 * 60 * 1000, 2_147_483_647);
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.(); // 清理定时器不应阻止进程退出
  console.log(`[retention] 自动清理已启动：保留 ${RETENTION_DAYS} 天，每 ${RETENTION_INTERVAL_HOURS}h 一次`);
  return () => clearInterval(timer);
}
