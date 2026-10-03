-- Shared crons (vedu #1129): board schedules live in each board's Durable Object; this indexes when each enabled one
-- is next due (ms), so the 5-minute cron wakes only boards with a schedule due.
CREATE TABLE IF NOT EXISTS board_schedules (
  board_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  next_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, schedule_id)
);
CREATE INDEX IF NOT EXISTS board_schedules_next ON board_schedules (next_at);
