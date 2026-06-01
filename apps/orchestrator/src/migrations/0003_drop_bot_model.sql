-- bots.model 是遗留列：模型已完全由 Provider 决定（providers.default_model），
-- botSchema 中无 model 字段，rowToBot 也不读它，INSERT 也不写它。
-- 但旧 schema 把它建成 TEXT NOT NULL 且无 DEFAULT，导致新建 bot 时
-- 报错 "NOT NULL constraint failed: bots.model"。直接删除该列。
ALTER TABLE bots DROP COLUMN model;
