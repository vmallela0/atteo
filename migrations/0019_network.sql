-- Network: an opt-in directory (find me by partial name) and standing rules (what to accept automatically).
ALTER TABLE users ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN rules TEXT;   -- JSON: {auto_accept_invites: "friends"|null, auto_accept_friends: "coworkers"|null}
