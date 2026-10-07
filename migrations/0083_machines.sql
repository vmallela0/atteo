-- How many agents run on each of a person's machines (jxn #5722): `atteo agents` and `atteo spawn --listen` report the
-- count from the machine itself, so the board's Agents panel can say "jxn · desktop · 3 agents running". A machine that
-- stops reporting drops out after 10 minutes (machines.ts). The label is the person's (their hostname by default).
CREATE TABLE IF NOT EXISTS machines (
  user TEXT NOT NULL,
  machine TEXT NOT NULL,
  agents INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (user, machine)
);
