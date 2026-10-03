-- "Your agent": each person's private 1:1 board with their own agent (boards.kind = 'agent', direct_key 'self:<user>',
-- made the first time it's opened). Mail there can be for one of their agent sessions ("@vedu/claude-2"): that
-- session's id, so only its own mailbox gets it and the person's other sessions (and the dispatcher) leave it alone.
ALTER TABLE notifications ADD COLUMN to_session TEXT;
