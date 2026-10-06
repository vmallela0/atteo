-- Invite links that carry an encrypted board's key (E2E design §3.3, Phase 1c). The inviter's device makes a one-time
-- X25519 "invite key", wraps each epoch key it holds to the invite key's public half, and puts the private half after the
-- link's "#", which browsers never send to the server. The server keeps only the public half and the wrapped copies; the
-- person who opens the link unwraps them on their own device and hands the board key to that device at once.

ALTER TABLE invite_links ADD COLUMN invite_pub TEXT;

CREATE TABLE IF NOT EXISTS invite_key_grants (
  link_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  epk TEXT NOT NULL,
  iv TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  PRIMARY KEY (link_id, epoch)
);
