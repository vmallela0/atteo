-- A person may name their agent ("Jarvis"). It's always shown with its owner ("Jarvis · vedu's agent").
-- Null: no name, the agent is just "vedu's agent". Validated in social.ts (no impersonation, no reserved words).
ALTER TABLE users ADD COLUMN agent_name TEXT;
