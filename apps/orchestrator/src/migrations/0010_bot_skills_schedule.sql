-- Phase 3.5：Skill 系统 + 调度器，给 bots 加两列：
-- ① skills：启用的 skill 名 JSON 数组（对应共享 SKILL_ROOT/<name>/SKILL.md）。
--    skill 内容是纯文件系统事实源，库里只存「启用了哪些」（仿 workspace_dirs 存路径而非内容）。
-- ② schedule：每 bot 的定时任务 JSON 数组 [{cron,prompt,targetChannelId?,enabled}]。
-- 均为 ADD COLUMN + NOT NULL DEFAULT '[]'，对既有行安全（旧行自动取默认值，rowToBot 解析后由 schema 补齐）。
-- 注：tools.discordPush 不需要新列——它进既有 bots.tools JSON 列，由 botToolsSchema 补默认值。
ALTER TABLE bots ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bots ADD COLUMN schedule TEXT NOT NULL DEFAULT '[]';
