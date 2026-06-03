// 6/15 政策防护：清掉 ANTHROPIC_API_KEY，避免误扣 API 费
delete process.env.ANTHROPIC_API_KEY;

import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, closeDb } from './db.js';
import { botManager, startConsolidationLoop } from './bot-manager.js';
import { buildApi } from './api.js';
import { recoverInterruptedRuns, startRetentionLoop } from './observ-retention.js';
import { scheduler } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', '..', '..', 'data', 'app.db');
const API_PORT = Number(process.env.API_PORT ?? 3001);

// 保留清理 / 记忆整理定时器的停止句柄（shutdown 时清掉）。
let stopRetention: (() => void) | null = null;
let stopConsolidation: (() => void) | null = null;

async function main(): Promise<void> {
  console.log(`[boot] DB: ${DB_PATH}`);
  initDb(DB_PATH);

  // 此刻 DB 里任何 status='running' 必来自上个进程（崩溃/热重载），先恢复为 aborted 再开始处理新消息。
  const recovered = recoverInterruptedRuns();
  if (recovered > 0) console.log(`[boot] 恢复 ${recovered} 个上次中断的回合（标记为 aborted）`);

  console.log('[boot] 加载已启用 bot...');
  await botManager.syncFromDb();

  // P7 数据保留：启动即清一次 + 周期清理（OBSERV_RETENTION_DAYS / _INTERVAL_HOURS）。
  stopRetention = startRetentionLoop();

  // L3 记忆整理：后台周期把空闲会话的摘要固化进长期记忆（CONV_CONSOLIDATE_*）。
  stopConsolidation = startConsolidationLoop();

  const app = buildApi();
  await app.listen({ port: API_PORT, host: '127.0.0.1' });
  console.log(`[boot] API 监听 http://127.0.0.1:${API_PORT}`);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[shutdown] ${signal}`);
  stopRetention?.();
  stopConsolidation?.();
  await botManager.stopAll();
  scheduler.stopAll(); // 兜底清掉所有 cron 定时器（防阻止进程退出）
  closeDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
