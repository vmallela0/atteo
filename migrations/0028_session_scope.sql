-- What an agent session may do: "full" (default) or "read" (read and wait only: it can't post, react, claim or change
-- anything). A session can lower its own scope; only its person, from the web, raises it again.
ALTER TABLE agent_sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';
