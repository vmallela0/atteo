-- Off-Cloudflare nightly backups (#1550, src/backup.ts): one row per part of a night's backup (d1, board:<id>, manifest,
-- alert), so the 5-minute cron can spread the boards over several runs and retry a failed part.
CREATE TABLE backup_parts (
  day TEXT NOT NULL,
  part TEXT NOT NULL,
  status TEXT NOT NULL,
  object_key TEXT,
  bytes INTEGER,
  sha256 TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  done_at INTEGER,
  PRIMARY KEY (day, part)
);
