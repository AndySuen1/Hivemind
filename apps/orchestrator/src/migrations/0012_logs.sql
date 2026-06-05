-- 可视化日志系统（与 observability 正交的「原始运行日志」采集通道）：单表 logs。
-- 唯一写入入口是 log-collector.ts（patch process.stdout/stderr → 脱敏 redactText → 截断 → 批量落盘 → EventEmitter 广播）。
--
-- 设计要点：
--  · 与 sessions/runs/messages/events 不同：日志不隶属任何会话，**不建外键、无 CASCADE**。
--    清理由 observ-retention.ts 的 sweep() 追加 purgeLogsByRetention（按 ts 删旧，LOG_RETENTION_DAYS 默认 7）。
--  · message 写入前已脱敏 + 截断（同 recorder 的 8KB 约束），本表只存最终文本。
--  · seq 为来源进程内全局单调自增；launcher 转发（ingest）的会在 orchestrator 端重分配本地 seq。
--    不加唯一约束（跨进程/重启会重号，靠 id 主键去重；seq 仅辅助稳定排序）。
--  · 索引覆盖三种查询面：纯时间倒序翻页、按 level 过滤、按 source 过滤。
CREATE TABLE IF NOT EXISTS logs (
  id      TEXT PRIMARY KEY,
  seq     INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  source  TEXT NOT NULL,
  level   TEXT NOT NULL,
  tag     TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level_ts ON logs (level, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_source_ts ON logs (source, ts DESC);
