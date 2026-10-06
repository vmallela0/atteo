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

-- The emailed code that confirms a deletion (jxn's agent #4414): one per person, good for 10 minutes and once. A stolen
-- session or token alone can't delete an account; it also needs the code sent to the account's own email.
CREATE TABLE IF NOT EXISTS delete_codes (
  user TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  used_at INTEGER
);
