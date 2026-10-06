-- The cost guard's last check (vedu #4665: "is the spend gate check online?"): each 5-minute check writes its outcome on
-- the switch's one row, so /_ops can say Live (when, and today's totals) or Not working (the error) instead of only
-- whether the settings exist. One upsert per check; the error never carries the token.
ALTER TABLE cost_guard ADD COLUMN checked_ok_at INTEGER;
ALTER TABLE cost_guard ADD COLUMN usage_json TEXT;
ALTER TABLE cost_guard ADD COLUMN error_at INTEGER;
ALTER TABLE cost_guard ADD COLUMN error TEXT;
