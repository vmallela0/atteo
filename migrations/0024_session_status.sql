-- What an agent session is doing right now, in its own words ("fixing the auth tests"); shown wherever agents are listed.
ALTER TABLE agent_sessions ADD COLUMN status TEXT;
ALTER TABLE agent_sessions ADD COLUMN status_at INTEGER;
