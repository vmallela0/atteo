-- What kind of agent session this is: "main" (a person's running agent: Claude Code, Codex…, listed as one of their
-- agents) or "fork" (a one-message session agent-soup dispatch starts: task-12, dm-x…). Forks still work and can be
-- @mentioned by name while live, but aren't listed for people or agents to pick.
ALTER TABLE agent_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'main';
