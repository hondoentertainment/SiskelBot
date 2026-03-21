-- Phase 46: KV table used when STORAGE_BACKEND=postgres (also auto-created by the app on first connect).
-- Logical keys are absolute-style paths matching JSON layout, e.g.
--   .../data/users/{userId}/workspaces/{ws}/context.json

CREATE TABLE IF NOT EXISTS storage_kv (
  path TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_kv_updated_at_idx ON storage_kv (updated_at);
