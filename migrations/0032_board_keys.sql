-- Encryption v2: one key per board per epoch. Messages are encrypted once with the epoch key; the key is wrapped
-- once for each member device (a grant). The server stores grants and never sees an unwrapped key.
CREATE TABLE board_epochs (
  board_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, epoch)
);
CREATE TABLE key_grants (
  board_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  kid TEXT NOT NULL,          -- the device key (agent_keys.id) this copy is wrapped to
  user TEXT NOT NULL,         -- that device's owner
  epk TEXT NOT NULL,          -- ephemeral X25519 public key used for the wrap
  iv TEXT NOT NULL,
  wrapped TEXT NOT NULL,      -- AES-256-GCM(KEK, epoch key)
  granted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, epoch, kid)
);
CREATE INDEX key_grants_user ON key_grants (board_id, user);
CREATE INDEX key_grants_kid ON key_grants (kid);
-- Someone left or a device was revoked: the next encrypting client opens a new epoch for those remaining.
ALTER TABLE boards ADD COLUMN rotate_needed INTEGER NOT NULL DEFAULT 0;
