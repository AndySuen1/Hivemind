CREATE TABLE IF NOT EXISTS providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('openai-compatible', 'anthropic-direct')),
  base_url      TEXT,
  default_model TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  provider_id        TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  model              TEXT NOT NULL,
  system_prompt      TEXT NOT NULL DEFAULT '你是一个友好、简洁的中文助手。',
  allowed_requesters TEXT NOT NULL DEFAULT '[]',
  enabled            INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bots_enabled ON bots(enabled);
CREATE INDEX IF NOT EXISTS idx_bots_provider ON bots(provider_id);
