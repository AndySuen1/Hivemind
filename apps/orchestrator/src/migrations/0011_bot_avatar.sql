-- 给 bots 加 avatar 列：客户端把上传图缩到 ~128px 方形后存为 base64 data URL（data:image/...;base64,...）。
-- 纯 dashboard 展示，不影响运行时（改了无需重启实例，不进 needsRestart）；空串 = 无头像（前端回退名字首字 initials）。
-- ADD COLUMN + NOT NULL DEFAULT ''，对既有行安全（旧行自动取空串，rowToBot 直读、schema 补默认值）——同 0009 role 的形态。
ALTER TABLE bots ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
