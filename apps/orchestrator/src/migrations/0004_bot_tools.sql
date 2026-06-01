-- Phase 1：bot 工具配置（fs / bash / memory）以 JSON 存于 tools 列。
-- 旧行默认 '{}'，rowToBot 解析后由 botToolsSchema 补齐各项默认值。
ALTER TABLE bots ADD COLUMN tools TEXT NOT NULL DEFAULT '{}';
