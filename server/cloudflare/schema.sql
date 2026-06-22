CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vaults (
  account_id TEXT PRIMARY KEY,
  blob       TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
