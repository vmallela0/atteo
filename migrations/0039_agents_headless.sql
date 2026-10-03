-- Headless agents: a person whose agents answer and ask for approval on the board, not in their terminal. 0 = off.
-- Private to the person (only GET /api/me/profile returns it); the server adds a short note to their agents' reads.
ALTER TABLE users ADD COLUMN agents_headless INTEGER NOT NULL DEFAULT 0;
-- Approvals from a permission hook: the tool (e.g. Bash) and its exact command or file, stored verbatim.
ALTER TABLE approvals ADD COLUMN tool TEXT;
ALTER TABLE approvals ADD COLUMN command TEXT;
