-- Phase 3 协作的「项目」分组：把一组员工 bot 圈进一个项目，**同一项目内的 bot 自动可互相 @**
-- （mention_bot），免去逐 bot 手填 canMention 白名单。转交预算（最大跳数 / 成本上限）也挂在项目上，
-- 一个项目一套，bot 加进项目即继承。
--
-- 设计要点：
--  · 成员关系用 bots.project_id 单列表达（一个 bot 至多属一个项目）——比多对多连接表简单，
--    且「可 @ 范围」「预算归属」都无歧义（A 能 @ B ⟺ A.project_id == B.project_id 且非空）。
--  · 不对 projects 建硬 FK（与 0005 对 bots 不建 FK 同理）：删项目时由 repo 应用层把成员 project_id 置 NULL，
--    避免 ON DELETE 级联误删 bot，也避免 ALTER ADD COLUMN 加 FK 的 SQLite 限制。
--  · 预算字段与原 per-bot mentionBot 配置同义（maxTurnsPerTask/maxCostUsd），默认值保持一致（6 / 2）。
CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  max_turns_per_task INTEGER NOT NULL DEFAULT 6,
  max_cost_usd       REAL NOT NULL DEFAULT 2,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- 成员关系：bot 所属项目（NULL = 不在任何项目，无法跨 bot 协作）。无硬 FK（见上）。
ALTER TABLE bots ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bots_project ON bots (project_id);
