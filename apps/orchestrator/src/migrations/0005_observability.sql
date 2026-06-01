-- 可观测性数据底座（方案 v6 Phase 4 提前为本期 P0）：sessions / runs / messages / events 四表。
-- 唯一写入入口是 recorder.ts（脱敏 → 截断 8KB → 写库 → EventEmitter 广播）。
--
-- 设计要点：
--  · 表间外键用 ON DELETE CASCADE（session → run → event/message），便于 P7 清理时「删 session 连带清空」。
--  · 不对 bots 建外键：bot_id 存纯文本 + 索引。删 bot 不应级联清掉历史，也不该让历史拖住删除
--    （保留取证价值），并避免改动现有 botRepo.delete 语义（别碰坏 Phase 1/2）。
--  · 一切外部内容（聊天/工具入参出参）写入前已脱敏 + 截断，本表只存最终文本，input/output 为 JSON 字符串。

-- 会话：某 bot 在某频道的持续对话，(bot_id, channel_id) 唯一。recorder.ensureSession 做 upsert。
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  bot_id         TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  channel_type   TEXT,
  channel_name   TEXT,
  guild_id       TEXT,
  title          TEXT,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  UNIQUE (bot_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_bot ON sessions (bot_id, last_active_at DESC);

-- 回合：一条用户消息触发的一次处理 = 执行追踪基本单位。
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  bot_id          TEXT NOT NULL,
  requester_id    TEXT,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error', 'aborted')),
  user_message_id TEXT,
  finish_reason   TEXT,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  usage_json      TEXT,
  error           TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_bot ON runs (bot_id, started_at DESC);

-- 聊天消息（user / assistant）。content 已脱敏 + 截断；truncated 标记是否被截。
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs (id) ON DELETE CASCADE,
  bot_id      TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  author_id   TEXT,
  author_name TEXT,
  content     TEXT NOT NULL,
  truncated   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages (run_id);

-- 统一时间线事件。seq 在回合内单调递增；唯一索引 (run_id, seq) 既保序又防重。
-- type 不加 CHECK：取值会随 P3 委派埋点增长，而 SQLite 改 CHECK 需重建表；改由 TS 的
-- ObservEventType 枚举 + recorder 单一写入入口在编译期/写入期守护。runs.status 取值稳定故加了 CHECK。
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  bot_id          TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  type            TEXT NOT NULL,
  tool_name       TEXT,
  label           TEXT,
  status          TEXT,
  input_json      TEXT,
  output_json     TEXT,
  duration_ms     INTEGER,
  parent_event_id TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_run_seq ON events (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, created_at);
