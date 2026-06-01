-- L2 滚动摘要（对话记忆）：每会话一行，持续把「滑出近期窗口」的旧对话压成一段有上限的摘要，
-- 注入 system prompt，让 bot 在重启/多天后仍记得整段会话，且 token 恒定（不随对话变长而增长）。
--
-- 设计要点：
--  · session_id 主键 + FK→sessions ON DELETE CASCADE：生命周期与会话/消息对齐，P7 retention 删会话时自动连带清。
--  · 写入只经 conversation-repo.ts（与可观测性 recorder.ts 分离——摘要是另一类关注点，不走 seq/广播）。
--  · summary 已是模型从「已脱敏」消息生成的二次产物，落库前按字符上限截断；不再单独脱敏。
--  · summarized_through_msg_id / turn_count 为可选元信息（重锚、L3 整理触发用），Phase B 不强依赖。
CREATE TABLE IF NOT EXISTS conversation_state (
  session_id                TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  bot_id                    TEXT NOT NULL,
  summary                   TEXT NOT NULL DEFAULT '',
  summarized_through_msg_id TEXT,
  turn_count                INTEGER NOT NULL DEFAULT 0,
  -- L3 整理（固化进长期记忆文件）最近一次完成时刻；空闲整理 loop 据 (consolidated_at < last_active_at) 判定「有新内容待整理」
  consolidated_at           INTEGER NOT NULL DEFAULT 0,
  updated_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_state_bot ON conversation_state (bot_id);
