-- Claude 帖直通（论坛帖子 ↔ 本地 Claude Code session）：帖子↔session 的 1:1 绑定 + reset 链历史。
-- 写入经 thread-session-repo.ts（与 recorder 的 sessions 表正交：那是可观测性，这是运行时绑定的事实源）。
--
-- 设计要点：
--  · thread_id 作主键（一个 Discord 帖子全局只绑一个 session；跨 bot 不冲突）。
--  · 无硬外键、无 CASCADE（同 0005/0008 风格）：删 bot/项目不级联清绑定，避免悬挂引用拖垮主流程。
--  · claude_session_id 建帖瞬间可空（首条 query 的 system/init 才拿到），之后每回合 query 后刷新（resume 会 fork 出新 id）。
--  · cwd 落库且固定：resume 依赖 Claude SDK 的 session 落在 ~/.claude/projects/<cwd-hash> 下，cwd 一变 hash 就对不上。
--  · status：active 进行中 / closed 帖归档或显式关闭。
CREATE TABLE IF NOT EXISTS thread_sessions (
  thread_id          TEXT PRIMARY KEY,        -- Discord 帖子(thread) id（= channel.id）
  bot_id             TEXT NOT NULL,
  forum_channel_id   TEXT NOT NULL,
  claude_session_id  TEXT,                    -- 最近一次 query 的 session_id（resume 用），建帖瞬间为 NULL
  cwd                TEXT NOT NULL,           -- 该帖固定工作目录（已过 path-guard）
  requester_id       TEXT,                    -- 建帖人（仅记录，不做 owner 闸门——帖内驱动用 bot.allowedRequesters）
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'closed')),
  reset_count        INTEGER NOT NULL DEFAULT 0,
  title              TEXT,
  created_at         INTEGER NOT NULL,
  last_active_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_sessions_bot ON thread_sessions (bot_id, last_active_at DESC);

-- reset 链历史：每次「重开 session」记一行（旧→新 session、交接文档落盘路径、生成的开场白）。
CREATE TABLE IF NOT EXISTS thread_session_resets (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  old_session  TEXT,
  new_session  TEXT,
  handoff_doc  TEXT,                          -- 交接文档落盘绝对路径
  opening_line TEXT,                          -- 喂给新 session 的开场白
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_resets_thread ON thread_session_resets (thread_id, created_at);
