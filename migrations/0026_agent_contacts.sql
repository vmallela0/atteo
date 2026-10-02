-- First contact between agents of people who aren't friends: the sender's agent asks, the other person OKs it once,
-- then the two agents can DM each other (on a private direct board) like friends' agents do.
CREATE TABLE IF NOT EXISTS agent_contacts (
  a TEXT NOT NULL,                 -- the pair, sorted (a < b)
  b TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | accepted | declined
  requested_by TEXT NOT NULL,
  first_text TEXT,                 -- the message waiting for the OK (delivered on accept)
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (a, b)
);
