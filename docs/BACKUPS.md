# Backups outside Cloudflare (#1550)

Every night (from 03:00 UTC) the Worker writes the day's data to an S3-compatible bucket **outside Cloudflare** —
Backblaze B2 or AWS S3 — encrypted with a public key whose private half lives offline. Cloudflare losing everything
(including D1) is the case this covers, so nothing Atteo needs for a restore lives only on Cloudflare.

What it writes, from the 5-minute cron, a few boards per run (so no run is long):

```
<bucket>/atteo/<day>/d1.json.gz.enc             every D1 table (users, sessions, boards, members, …)
<bucket>/atteo/<day>/boards/<id>.json.gz.enc   every table of one board's Durable Object (the board uploads it itself)…
<bucket>/atteo/<day>/boards/<id>.files-<k>…     …except its files and pictures, about 8 MB per part, so a board with
                                                many never builds one huge object in its 128 MB
<bucket>/atteo/<day>/manifest.json.gz.enc       written last: every part, its size and SHA-256, and any that failed
```

Each part is JSON → gzip → X25519 → HKDF-SHA256 → AES-256-GCM (a fresh ephemeral key per part; the format is in
`src/backupcore.ts`). The Worker holds only the backup **public** key and a **write-only** bucket key: it can write
backups, never read them back, and never sees the private key. A part that fails is retried on later runs (3 tries);
a night with no manifest by ~09:00 UTC, or a part that gave up, is reported once (Sentry, the ops errors list,
`GET /api/ops/backups`). Backups are **off** until all the settings below are set; a restore is possible for as long
as the bucket (30-day retention) *and* the private key both exist. Binary uploads also live in Cloudflare R2
(`FILES`); this backup still dumps the SQLite copy of those bytes, not the R2 objects.

## Setup (once)

1. **Bucket** — Backblaze B2 (or S3): create a private bucket, e.g. `atteo-backups`, and a bucket lifecycle rule that
   deletes objects after 30 days (B2: "Keep until / days from uploading: 30"). Nothing in the bucket needs another tier.
2. **Keys** — an application key restricted to that one bucket, **write-only** (B2: "Write Only"; S3: a policy with only
   `s3:PutObject` on the bucket), plus a read-only key for the operator machine.
3. **Key pair** — on the operator machine (keep the file offline; without it no backup can ever be read back):
   `node scripts/backup.mjs keygen [--out backup-key.json]`
   It prints the public key — put it in `wrangler.jsonc` vars as `BACKUP_PUBLIC_KEY`.
4. **Settings** — `wrangler.jsonc` vars: `BACKUP_S3_ENDPOINT` (e.g. `https://s3.us-west-004.backblazeb2.com`),
   `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION` (B2: the bucket's region, e.g. `us-west-004`; S3: e.g. `us-east-1`),
   optionally `BACKUP_S3_PREFIX` (default `atteo/`), `BACKUP_S3_VIRTUAL_HOST: "1"` for virtual-hosted URLs (S3),
   `BACKUP_HOUR` (UTC, default 3), `BACKUP_BATCH` (boards per cron run, default 20), `BACKUP_ALERT_HOURS` (default 6),
   `BACKUP_BLOB_PART_BYTES` (a board's files per part, default 8,000,000).
   Secrets (`wrangler secret put`): `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`.
5. **Deploy, then verify the next day**: `GET /api/ops/backups` (operator) shows `configured: true` and the nights;
   `node scripts/backup.mjs list --endpoint … --bucket atteo-backups --key-id … --secret <read-only key>` lists the
   objects. The first good night ends with a manifest and `last_complete` set.

A board's FTS5 search index (`search_idx`) is dumped as rows and rebuilt on restore, so the shadow tables
(`search_idx_data`, `…_idx`, `…_content`, `…_docsize`, `…_config`) never leave Cloudflare.

## Restore drill (task #1550's done bar; repeat quarterly)

From the operator machine (any fresh clone; the private key file and the read-only bucket key):

```bash
day=2026-10-06; b=b_xxxxxxxx; port=8850; state=$(mktemp -d /tmp/atteo-drill.XXXXXX)
export BACKUP_S3_ENDPOINT=… BACKUP_S3_BUCKET=… BACKUP_S3_REGION=… BACKUP_S3_KEY_ID=… BACKUP_S3_SECRET=…   # read-only key

# 1. D1 back: a fresh local D1 with the real schema (indexes included), then the night's rows over it
CI=1 npx wrangler d1 migrations apply agent-board --local --persist-to "$state"
node scripts/backup.mjs d1-sql "$day" --out d1-$day.sql
CI=1 npx wrangler d1 execute agent-board --local --persist-to "$state" --file d1-$day.sql

# 2. One board back: a Worker on that state (ADMIN_KEY in .dev.vars), then the board's tables through the ops route
npx wrangler dev --port $port --persist-to "$state" &
node scripts/backup.mjs restore-board "$day" "$b" --base http://localhost:$port   # its tables, then each file part

# 3. e2e against it (drill passed = this comes back green)
BASE=http://localhost:$port node test/e2e.mjs
```

`d1-sql` writes `PRAGMA defer_foreign_keys = ON`, a `CREATE TABLE IF NOT EXISTS` for any table the checkout lacks,
then each table's `DELETE` and its rows, so table order doesn't matter and the migrated schema (indexes, defaults)
stays. The board half goes through `POST /api/ops/restore-board`, which works on localhost or with `BACKUP_RESTORE=1`
(disaster recovery, never a routine route). Disasters: the same steps against a fresh Worker + D1, with
`BACKUP_RESTORE=1` set for the board half, one `restore-board` per board (`node scripts/backup.mjs list` lists them).

## The pieces

| Piece | What |
| --- | --- |
| `src/backupcore.ts` | sealing, gzip, dump values, S3 SigV4 (imports nothing, so the script and Node run it as is) |
| `src/backup.ts` | the nightly tick: D1 dump, board batches, the manifest, the alert; `GET /api/ops/backups` |
| `src/board.ts` (`backup`/`restoreTables`) | each board uploads its own dump; the drill replaces a board's tables |
| `migrations/0059_backup_parts.sql` | one row per part per night (retries, bookkeeping) |
| `scripts/backup.mjs` | keygen, list, decrypt, the drill |
| `test/backup.mjs` (verify.sh suite `backup`) | the drill as a test: a local Worker with backups on, a fake S3, write → decrypt → restore D1 and a board → retries and the alert |
| `test/backupcore.test.ts` | SigV4 against AWS's published examples, sealing, dump values |
