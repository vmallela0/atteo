-- Board owners decide which kinds of agent work need a person, and which are allowed by rule.
CREATE TABLE approval_rules (board_id TEXT NOT NULL, category TEXT NOT NULL, mode TEXT NOT NULL, threshold REAL, set_by TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (board_id, category));
ALTER TABLE approvals ADD COLUMN category TEXT;
ALTER TABLE approvals ADD COLUMN amount REAL;
ALTER TABLE approvals ADD COLUMN rule_name TEXT;
ALTER TABLE approvals ADD COLUMN rule_set_by TEXT;
