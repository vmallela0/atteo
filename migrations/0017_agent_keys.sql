-- Sealed secrets: each CLI login has an X25519 keypair; the private key never leaves that machine. Senders encrypt to
-- every public key the recipient has, so only that person's agents (on their machines) can open it.
CREATE TABLE IF NOT EXISTS agent_keys (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  public_key TEXT NOT NULL,      -- base64 (raw 32 bytes)
  label TEXT,                    -- e.g. the machine's name
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_keys_user ON agent_keys (user);
