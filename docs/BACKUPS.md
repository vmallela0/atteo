# Backups (#1550)

Every night (from 03:00 UTC) the Worker writes the day's data, encrypted, to the **`atteo-backups` R2 bucket in our own
Cloudflare account** (vedu #5342: keep backups on Cloudflare). The bucket deletes each object after 30 days. The
encryption key's private half never touches Cloudflare: it lives on the operator's machine.

What this covers: a bad deploy, a bad migration, a buggy sweep or a person deleting data. Any of those can be undone
from any of the last 30 nights. What it doesn't cover: Cloudflare losing our account, or someone with our Cloudflare
access deleting the bucket. The backups sit with the thing they back up, and the Worker's binding could delete them.
That trade (one vendor, nothing extra to run or pay for) was vedu's call. To cover it later, set the `BACKUP_S3_*`
settings below to a bucket outside Cloudflare (Backblaze B2 or AWS S3, a write-only key): when all of them are set they
win over R2, and nothing else changes.

What it writes, from the 5-minute cron, a few boards per run (so no run is long):

```
atteo-backups/atteo/<day>/d1.json.gz.enc             every D1 table (users, sessions, boards, members, …)
atteo-backups/atteo/<day>/boards/<id>.json.gz.enc   one board's Durable Object: its tables' columns, meta, and its parts…
atteo-backups/atteo/<day>/boards/<id>.files-<k>…     …its files and pictures, about 2 MB per part
atteo-backups/atteo/<day>/boards/<id>.rows-<t>-<k>…  …every other table's rows in rowid order, about 2 MB of JSON per part
atteo-backups/atteo/<day>/manifest.json.gz.enc       written last: every part, its size and SHA-256, and any that failed
```

A board uploads its own parts (nothing big crosses from the board to the Worker), a few per call: the cron calls
`Board.backupStep` until the board says it's done. Each part is read, turned into JSON, gzipped, sealed and uploaded on
its own, and the board saves its place after each one (in its own storage, which no dump includes), so a big board never
holds more than one part in memory, and a call that dies (the object reset: out of memory, a deploy) is called again and
carries on after the last part written. A failed attempt resumes the same way on the next run. The main part goes last.
(Oct 6–8 2026 the busiest board, b_skyvcqtm7fei, failed every night with "Network connection lost." within seconds: one
call built ~8 MB parts several copies over, on top of what the live board holds in its 128 MB, and every retry started over.)

Each part is JSON → gzip → X25519 → HKDF-SHA256 → AES-256-GCM (a fresh ephemeral key per part; the format is in
`src/backupcore.ts`). The Worker holds only the backup **public** key, so it can write backups but never read one. A part
that fails is retried on later runs (3 tries); a night with no manifest by ~09:00 UTC, or a part that gave up, is
reported once (Sentry, the ops errors list, `GET /api/ops/backups`). A restore is possible for as long as the night's
objects (30 days) *and* the private key both exist.

## Setup (done 2026-10-06; for a new account, or to redo it)

1. **Bucket**: `npx wrangler r2 bucket create atteo-backups`, then
   `npx wrangler r2 bucket lifecycle add atteo-backups expire-30d --expire-days 30`.
2. **Binding**: `wrangler.jsonc` binds it as `BACKUP_R2` (`r2_buckets`). Local `wrangler dev` gets a local bucket under
   its `--persist-to` directory instead, never the real one.
3. **Key pair**, on the operator machine (keep the file off Cloudflare and backed up, e.g. in a password manager; without
   it no backup can ever be read):
   `node scripts/backup.mjs keygen --out ~/.atteo-backup/backup-key.json`
   It prints the public key. Today's is `uB5jH6mzn5r6aTlT2wp/M2u9OVR4/qZvuCHMMgau/Ws=` (key id in `GET /api/ops/backups`).
4. **Turn it on**: `npx wrangler secret put BACKUP_PUBLIC_KEY` and paste the public key. It's a secret rather than a
   `wrangler.jsonc` var only so that local and test servers, which share `wrangler.jsonc`, don't back up on every cron
   call; it isn't sensitive. Backups are **off** until it's set.
5. **Optional** `wrangler.jsonc` vars: `BACKUP_HOUR` (UTC, default 3), `BACKUP_BATCH` (boards per cron run, default 20),
   `BACKUP_ALERT_HOURS` (default 6), `BACKUP_BLOB_PART_BYTES` (a board's files per part, default 2,000,000),
   `BACKUP_ROWS_PART_BYTES` (a board's table rows per part, estimated JSON bytes, default 2,000,000),
   `BACKUP_STEP_BYTES` (about how much of a board one call writes before it saves its place and returns, default
   8,000,000), `BACKUP_S3_PREFIX` (default `atteo/`).
6. **Verify the next day**: `GET /api/ops/backups` (operator) shows `configured: true`, `target: "r2"` and the nights.
   The first good night ends with a manifest and `last_complete` set.
   `node scripts/backup.mjs list <day> --r2 atteo-backups --key ~/.atteo-backup/backup-key.json` lists its objects.

**An outside bucket instead** (B2 or S3, for the case R2 doesn't cover): a private bucket with a 30-day lifecycle rule;
a **write-only** application key for it (B2: "Write Only"; S3: only `s3:PutObject`) and a read-only one for the operator.
Then `wrangler.jsonc` vars `BACKUP_S3_ENDPOINT` (e.g. `https://s3.us-west-004.backblazeb2.com`), `BACKUP_S3_BUCKET`,
`BACKUP_S3_REGION` (B2: the bucket's region; S3: e.g. `us-east-1`), optionally `BACKUP_S3_VIRTUAL_HOST: "1"`
(virtual-hosted URLs, S3), and the secrets `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`. With all of them set, nights go
there instead of R2; the script reads them with `--endpoint … --bucket … --key-id … --secret …` in place of `--r2`.

A board's FTS5 search index (`search_idx`) is dumped as rows and rebuilt on restore, so the shadow tables
(`search_idx_data`, `…_idx`, `…_content`, `…_docsize`, `…_config`) are never backed up.
Each board's main object contains table columns, the small `meta` table, and ordered `row_parts` and `file_parts`
filenames. Growing tables (including `entries`, `doc_versions`, and `search_idx`) are uploaded in rowid order as
`boards/<id>.rows-<table>-<k>.json.gz.enc`; `blobs` keeps its `boards/<id>.files-<k>.json.gz.enc` layout. The
manifest includes the size and hash of every extra object. The restore script also accepts older main objects with
all non-file rows embedded and no `row_parts` list.

## Restore drill (task #1550's done bar; repeat quarterly)

From the operator machine (any fresh clone, logged in to wrangler, with the private key file). The script reads R2
through `wrangler r2 object get --remote`; set `CLOUDFLARE_ACCOUNT_ID` if wrangler asks which account:

```bash
day=2026-10-06; b=b_xxxxxxxx; port=8850; state=$(mktemp -d /tmp/atteo-drill.XXXXXX)
export BACKUP_R2_BUCKET=atteo-backups   # an outside bucket instead: BACKUP_S3_ENDPOINT/BUCKET/REGION/KEY_ID/SECRET (read-only key)

# 1. D1 back: a fresh local D1 with the real schema (indexes included), then the night's rows over it
CI=1 npx wrangler d1 migrations apply agent-board --local --persist-to "$state"
node scripts/backup.mjs d1-sql "$day" --key ~/.atteo-backup/backup-key.json --out d1-$day.sql
CI=1 npx wrangler d1 execute agent-board --local --persist-to "$state" --file d1-$day.sql

# 2. One board back: a Worker on that state (ADMIN_KEY in .dev.vars), then the board's tables through the ops route
npx wrangler dev --port $port --persist-to "$state" &
node scripts/backup.mjs restore-board "$day" "$b" --key ~/.atteo-backup/backup-key.json --base http://localhost:$port   # its main part, row parts, then file parts

# 3. e2e against it (drill passed = this comes back green)
BASE=http://localhost:$port node test/e2e.mjs
```

`d1-sql` writes `PRAGMA defer_foreign_keys = ON`, a `CREATE TABLE IF NOT EXISTS` for any table the checkout lacks,
then each table's `DELETE` and its rows, so table order doesn't matter and the migrated schema (indexes, defaults)
stays. The board half goes through `POST /api/ops/restore-board`, which works on localhost or with `BACKUP_RESTORE=1`
(disaster recovery, never a routine route). Disasters: the same steps against a fresh Worker + D1, with
`BACKUP_RESTORE=1` set for the board half, one `restore-board` per board (`node scripts/backup.mjs list <day>` lists them).

## The pieces

| Piece | What |
| --- | --- |
| `src/backupcore.ts` | sealing, gzip, dump values, S3 SigV4 (imports nothing, so the script and Node run it as is) |
| `src/backup.ts` | where nights go (R2 binding, or S3 when fully set), the nightly tick: D1 dump, board batches, the manifest, the alert; `GET /api/ops/backups` |
| `src/board.ts` (`backupStep`/`restoreTables`) | each board uploads its own parts, a few per call, resuming after the last; the drill replaces a board's tables |
| `migrations/0059_backup_parts.sql` | one row per part per night (retries, bookkeeping) |
| `scripts/backup.mjs` | keygen, list, decrypt, the drill (`--r2` through wrangler, or an S3 bucket) |
| `test/backup.mjs` (verify.sh suite `backup`) | the drill as a test, twice: a local Worker writing to its local R2 binding (read back with `--r2-local`), and one writing to a fake S3; write → decrypt → restore D1 and a board → (S3) retries and the alert |
| `test/backupR2.test.ts` | which bucket a night goes to, a part sealed into R2, and a big board (node:sqlite) backed up over many calls, through resets and a failed attempt, then restored exactly |
| `test/backupcore.test.ts` | SigV4 against AWS's published examples, sealing, dump values |
