-- One UTC-day count per person, independent of PIN resets.
CREATE TABLE approval_pin_daily (
  user TEXT PRIMARY KEY,
  day INTEGER NOT NULL,
  approvals INTEGER NOT NULL DEFAULT 0
);
