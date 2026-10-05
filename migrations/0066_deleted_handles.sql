-- Deleted accounts (Apple 5.1.1(v), jxn #4329). Their handles are never given out again, so nobody can later post as
-- the name old messages and links still point at: only a SHA-256 of the lowercased handle is kept, not the handle.
-- While a deletion is under way (deleted_at NULL) `tombstone` holds the name its messages move to, so a retry after a
-- partial run reuses it (jxn's agent #4389); it's cleared when the deletion finishes. An active Pro plan's Stripe ids
-- stay here so ops can cancel the subscription by hand.
CREATE TABLE IF NOT EXISTS deleted_handles (
  hash TEXT PRIMARY KEY,
  tombstone TEXT,
  started_at INTEGER NOT NULL,
  deleted_at INTEGER,
  stripe_customer TEXT,
  stripe_subscription TEXT
);
