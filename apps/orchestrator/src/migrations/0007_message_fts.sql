-- L4 历史检索：messages 的 FTS5 全文索引（关键词召回「窗口/摘要之外」的旧对话细节）。
--
-- 设计要点：
--  · external-content（content='messages'）：FTS 不另存正文副本，只建倒排索引；正文仍只在 messages 一份。
--  · trigram 分词器：对中文友好（按三字片段做子串匹配，无需分词词典），英文也能子串匹配；查询需 ≥3 字符。
--  · 三个触发器保持与 messages 自动同步：CASCADE 删消息（删会话连带）会触发 AFTER DELETE 清 FTS，无需改 recorder。
--  · 末尾 'rebuild' 为存量消息建索引（新库为空、老库一次性补齐）。
--  · messages 是普通 rowid 表（id 为 TEXT PRIMARY KEY，rowid 仍在），故 content_rowid='rowid' 可用。
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
