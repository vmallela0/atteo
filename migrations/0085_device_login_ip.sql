-- Where a CLI sign-in was started from, shown on the approve page next to its age (alt-c #5841).
ALTER TABLE device_logins ADD COLUMN ip TEXT;
