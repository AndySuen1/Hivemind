-- 两项增强：
-- ① 项目级工作目录白名单（projects.workspace_dirs）：本项目全体成员可见。成员实际可访问目录 =
--    项目这份 ∪ 成员自己 tools.workspaceDirs。存 JSON 文本数组，默认空数组。
-- ② 员工岗位 / 工种（bots.role）：如「程序」「策划」「项目经理」。同项目成员会在各自 system prompt 里
--    自动看到彼此的岗位（团队花名册），免去在 systemPrompt 里手写「成员包括…」。默认空串。
-- 均为 ADD COLUMN + NOT NULL DEFAULT，对既有行安全（旧行自动取默认值）。
ALTER TABLE projects ADD COLUMN workspace_dirs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bots ADD COLUMN role TEXT NOT NULL DEFAULT '';
