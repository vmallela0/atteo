// Nightly encrypted backups (#1550, INFRA-ASSESSMENT rec 2). The 5-minute cron runs backupTick: from BACKUP_HOUR (UTC,
// default 3) it writes the night's parts to the bucket, a few per run so no run is long:
//   <prefix><day>/d1.json.gz.enc            every D1 table
//   <prefix><day>/boards/<id>.json.gz.enc   every table of one board's Durable Object (the board uploads it itself),
//   <prefix><day>/boards/<id>.files-<k>…    except its files and pictures, a few MB per part (BACKUP_BLOB_PART_BYTES)
//   <prefix><day>/manifest.json.gz.enc      written last: every part with its size and SHA-256, and any that failed
// A part that fails is retried on later runs (3 tries). If the manifest isn't written BACKUP_ALERT_HOURS after the start,
// or a part gave up, the cron reports it once that day (Sentry, the ops errors list, the log). Retention (30 days) is the
// bucket's lifecycle rule. scripts/backup.mjs makes the key pair, decrypts, and restores into local wrangler dev.
// The bucket is R2 in our own account through the BACKUP_R2 binding (vedu #5342: keep it on Cloudflare), or, when every
// BACKUP_S3_* setting is set, an S3-compatible bucket elsewhere (that wins: someone set it on purpose). Off until
// BACKUP_PUBLIC_KEY is set too; docs/BACKUPS.md has the setup and the drill.

import * as Sentry from "@sentry/cloudflare";
import { encodeValue, keyId, packPart, putObject, sha256Hex, unb64, type DumpTables, type S3Config } from "./backupcore";
import type { Env } from "./types";
import { recordError } from "./usage";

export interface BackupConfig {
  publicKey: string;
  prefix: string; // "atteo/" unless BACKUP_S3_PREFIX says otherwise ("" is allowed)
  s3?: S3Config; // set: an S3-compatible bucket, signed with BACKUP_S3_KEY_ID/SECRET
  r2?: R2Bucket; // otherwise: R2 in this account, through the BACKUP_R2 binding
}
export interface PartResult {
  object_key: string;
  bytes: number;
  sha256: string;
  extra?: Omit<PartResult, "extra">[]; // a board's file parts, written before it
}

const MAX_ATTEMPTS = 3;
const STALE_MS = 15 * 60_000; // a part "running" longer than this was cut off: another run may take it
const CONCURRENCY = 5;

const num = (v: string | undefined, d: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function backupConfig(env: Env): BackupConfig | null {
  const { BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_BUCKET: bucket, BACKUP_S3_KEY_ID: keyId, BACKUP_S3_SECRET: secret, BACKUP_PUBLIC_KEY: publicKey } = env;
  if (!publicKey) return null;
  try {
    if (unb64(publicKey).length !== 32) return null;
  } catch {
    return null;
  }
  const raw = env.BACKUP_S3_PREFIX ?? "atteo/";
  const prefix = raw && !raw.endsWith("/") ? `${raw}/` : raw;
  if (endpoint && bucket && keyId && secret)
    return { publicKey, prefix, s3: { endpoint, bucket, keyId, secret, region: env.BACKUP_S3_REGION || "us-east-1", prefix, virtualHost: env.BACKUP_S3_VIRTUAL_HOST === "1" } };
  if (env.BACKUP_R2) return { publicKey, prefix, r2: env.BACKUP_R2 };
  return null;
}

export const objectKey = (cfg: BackupConfig, day: string, part: string) =>
  `${cfg.prefix}${day}/${part.startsWith("board:") ? `boards/${part.slice(6)}` : part}.json.gz.enc`;

/** A board's files, a few MB per part: <day>/boards/<id>.files-<k>.json.gz.enc. */
export const blobPartKey = (cfg: BackupConfig, day: string, board: string, k: number) => `${cfg.prefix}${day}/boards/${board}.files-${k}.json.gz.enc`;

/** Packs, seals and uploads one part. */
export async function uploadPart(cfg: BackupConfig, key: string, value: unknown): Promise<PartResult> {
  const body = await packPart(cfg.publicKey, value);
  if (cfg.s3) await putObject(cfg.s3, key, body);
  else if (cfg.r2) await cfg.r2.put(key, body, { httpMetadata: { contentType: "application/octet-stream" } });
  else throw new Error("backups have no bucket");
  return { object_key: key, bytes: body.length, sha256: await sha256Hex(body) };
}

/** Every D1 table (sqlite_master order), paged by rowid so each row is read once. */
export async function dumpD1(env: Env): Promise<{ schema: { name: string; sql: string }[]; tables: DumpTables }> {
  const schema = (await env.DB.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all<{ name: string; sql: string }>()).results;
  const tables: DumpTables = {};
  for (const t of schema) {
    const q = `"${t.name.replace(/"/g, '""')}"`;
    const columns = (await env.DB.prepare(`PRAGMA table_info(${q})`).all<{ name: string }>()).results.map((c) => c.name);
    const rows: unknown[][] = [];
    if (/without\s+rowid/i.test(t.sql ?? "")) rows.push(...(await env.DB.prepare(`SELECT * FROM ${q}`).raw()));
    else {
      for (let after = Number.MIN_SAFE_INTEGER; ; ) {
        const page = await env.DB.prepare(`SELECT rowid, * FROM ${q} WHERE rowid > ? ORDER BY rowid LIMIT 2000`).bind(after).raw();
        for (const r of page) rows.push(r.slice(1));
        if (page.length < 2000) break;
        after = page[page.length - 1][0] as number;
      }
    }
    tables[t.name] = { columns, rows: rows.map((r) => r.map(encodeValue)) };
  }
  return { schema, tables };
}

/** Takes a part for this run: new, or failed with tries left, or abandoned mid-run. */
async function claim(env: Env, day: string, part: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `INSERT INTO backup_parts (day, part, status, attempts, started_at) VALUES (?, ?, 'running', 1, ?)
     ON CONFLICT(day, part) DO UPDATE SET status = 'running', attempts = backup_parts.attempts + 1, started_at = excluded.started_at
     WHERE (backup_parts.status = 'failed' AND backup_parts.attempts < ?) OR (backup_parts.status = 'running' AND backup_parts.started_at < ?)
     RETURNING part`,
  )
    .bind(day, part, now, MAX_ATTEMPTS, now - STALE_MS)
    .first();
  return !!r;
}

async function finish(env: Env, day: string, part: string, r: PromiseSettledResult<PartResult>): Promise<boolean> {
  if (r.status === "fulfilled")
    await env.DB.prepare(`UPDATE backup_parts SET status = 'done', object_key = ?, bytes = ?, sha256 = ?, extra = ?, error = NULL, done_at = ? WHERE day = ? AND part = ?`)
      .bind(r.value.object_key, r.value.bytes + (r.value.extra ?? []).reduce((n, e) => n + e.bytes, 0), r.value.sha256, r.value.extra?.length ? JSON.stringify(r.value.extra) : null, Date.now(), day, part)
      .run();
  else {
    const msg = (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 500);
    console.error("backup part failed", day, part, msg);
    await env.DB.prepare(`UPDATE backup_parts SET status = 'failed', error = ? WHERE day = ? AND part = ?`).bind(msg, day, part).run();
  }
  return r.status === "fulfilled";
}

async function run(env: Env, day: string, part: string, fn: () => Promise<PartResult>): Promise<boolean> {
  const r = await fn().then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason) => ({ status: "rejected", reason }) as const,
  );
  return finish(env, day, part, r);
}

export interface BackupTick {
  configured: boolean;
  day?: string;
  waiting?: boolean; // before BACKUP_HOUR
  finished?: boolean; // tonight's manifest is written (or gave up): nothing left, one read
  d1?: boolean;
  boards?: number; // boards written this run
  failed?: number; // parts that failed this run
  manifest?: boolean; // the manifest was written this run
  alert?: string; // reported this run
}

/** One cron run's share of tonight's backup. `board` asks a board's Durable Object to upload itself. */
export async function backupTick(env: Env, now: number, board: (id: string, day: string) => Promise<PartResult>): Promise<BackupTick> {
  const cfg = backupConfig(env);
  if (!cfg) return { configured: false };
  const d = new Date(now);
  const day = d.toISOString().slice(0, 10);
  const start = num(env.BACKUP_HOUR, 3);
  if (d.getUTCHours() < start) return { configured: true, day, waiting: true };
  // Once the night is finished the rest of the day's runs cost one row read, not a scan of every board.
  const m = await env.DB.prepare(`SELECT status, attempts FROM backup_parts WHERE day = ? AND part = 'manifest'`).bind(day).first<{ status: string; attempts: number }>();
  if (m && (m.status === "done" || (m.status === "failed" && m.attempts >= MAX_ATTEMPTS))) return { configured: true, day, finished: true };
  const out = { configured: true, day, d1: false, boards: 0, failed: 0, manifest: false } as BackupTick & { boards: number; failed: number };

  if (await claim(env, day, "d1", now)) {
    out.d1 = await run(env, day, "d1", async () => uploadPart(cfg, objectKey(cfg, day, "d1"), { kind: "d1", day, created_at: now, ...(await dumpD1(env)) }));
    if (!out.d1) out.failed++;
  }

  // Boards not yet written tonight (nor given up on, nor being written by another run), a batch per run.
  const settled = `SELECT 1 FROM backup_parts p WHERE p.day = ? AND p.part = 'board:' || b.id AND (p.status = 'done' OR (p.status = 'failed' AND p.attempts >= ?) OR (p.status = 'running' AND p.started_at >= ?))`;
  const todo = (
    await env.DB.prepare(`SELECT id FROM boards b WHERE NOT EXISTS (${settled}) ORDER BY id LIMIT ?`)
      .bind(day, MAX_ATTEMPTS, now - STALE_MS, num(env.BACKUP_BATCH, 20))
      .all<{ id: string }>()
  ).results;
  const mine: string[] = [];
  for (const b of todo) if (await claim(env, day, `board:${b.id}`, now)) mine.push(b.id);
  for (let i = 0; i < mine.length; i += CONCURRENCY) {
    const ok = await Promise.all(mine.slice(i, i + CONCURRENCY).map((id) => run(env, day, `board:${id}`, () => board(id, day))));
    out.boards += ok.filter(Boolean).length;
    out.failed += ok.filter((x) => !x).length;
  }

  // Everything settled (written or given up): the manifest, once.
  const final = `SELECT 1 FROM backup_parts p WHERE p.day = ? AND p.part = 'board:' || b.id AND (p.status = 'done' OR (p.status = 'failed' AND p.attempts >= ?))`;
  const left = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM boards b WHERE NOT EXISTS (${final}))
          + (SELECT COUNT(*) = 0 FROM backup_parts WHERE day = ? AND part = 'd1' AND (status = 'done' OR (status = 'failed' AND attempts >= ?))) AS n`,
  )
    .bind(day, MAX_ATTEMPTS, day, MAX_ATTEMPTS)
    .first<{ n: number }>();
  if (!left?.n && (await claim(env, day, "manifest", now))) {
    const parts = (await env.DB.prepare(`SELECT part, status, object_key, bytes, sha256, extra, error, attempts FROM backup_parts WHERE day = ? AND part NOT IN ('manifest', 'alert') ORDER BY part`).bind(day).all()).results.map((p) => ({ ...p, extra: p.extra ? JSON.parse(p.extra as string) : undefined }));
    out.manifest = await run(env, day, "manifest", async () => uploadPart(cfg, objectKey(cfg, day, "manifest"), { kind: "manifest", day, created_at: Date.now(), key_id: await keyId(cfg.publicKey), parts }));
  }

  // Report a night that hasn't finished in time, or that gave up on a part: once a day. Not the night backups were
  // turned on after the deadline (SOUP-A): nothing of it was there by then and no night before it ever finished.
  const lateHour = Math.min(23, start + num(env.BACKUP_ALERT_HOURS, 6));
  const late = d.getUTCHours() >= lateHour;
  const st = await env.DB.prepare(
    `SELECT (SELECT status FROM backup_parts WHERE day = ?1 AND part = 'manifest') AS manifest,
            (SELECT COUNT(*) FROM backup_parts WHERE day = ?1 AND status = 'failed' AND attempts >= ?2 AND part NOT IN ('alert')) AS gave_up,
            (SELECT MIN(started_at) FROM backup_parts WHERE day = ?1 AND part NOT IN ('alert')) AS first_at,
            EXISTS (SELECT 1 FROM backup_parts WHERE day < ?1 AND part = 'manifest' AND status = 'done') AS ever_done`,
  )
    .bind(day, MAX_ATTEMPTS)
    .first<{ manifest: string | null; gave_up: number; first_at: number | null; ever_done: number }>();
  const firstNight = !st?.ever_done && (st?.first_at ?? now) >= Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), lateHour);
  const problem = st?.gave_up ? `${st.gave_up} part${st.gave_up === 1 ? "" : "s"} failed ${MAX_ATTEMPTS} times` : late && !firstNight && st?.manifest !== "done" ? `no manifest by ${String(start + num(env.BACKUP_ALERT_HOURS, 6)).padStart(2, "0")}:00 UTC` : "";
  if (problem && (await env.DB.prepare(`INSERT OR IGNORE INTO backup_parts (day, part, status, error, started_at) VALUES (?, 'alert', 'done', ?, ?)`).bind(day, problem, now).run()).meta.changes) {
    out.alert = `Backup ${day} incomplete: ${problem} (GET /api/ops/backups)`;
    console.error(out.alert);
    await recordError(env, "CRON backup", new Error(out.alert)).catch(() => {});
    Sentry.captureMessage(out.alert, "error");
  }
  return out;
}

/** For GET /api/ops/backups: whether it's on, and the last two weeks of nights. */
export async function backupStatus(env: Env): Promise<unknown> {
  const cfg = backupConfig(env);
  const days = (
    await env.DB.prepare(
      `SELECT day, SUM(status = 'done' AND part NOT IN ('manifest', 'alert')) AS done, SUM(status = 'failed') AS failed, SUM(status = 'running') AS running,
              SUM(CASE WHEN status = 'done' THEN bytes ELSE 0 END) AS bytes, MAX(part = 'manifest' AND status = 'done') AS complete,
              MAX(CASE WHEN part = 'alert' THEN error END) AS alert
       FROM backup_parts GROUP BY day ORDER BY day DESC LIMIT 14`,
    ).all()
  ).results;
  const failures = days.length
    ? (await env.DB.prepare(`SELECT part, error, attempts FROM backup_parts WHERE day = ? AND status = 'failed' ORDER BY part LIMIT 50`).bind(days[0].day).all()).results
    : [];
  return {
    configured: !!cfg,
    ...(cfg
      ? { target: cfg.s3 ? "s3" : "r2", ...(cfg.s3 ? { endpoint: cfg.s3.endpoint, bucket: cfg.s3.bucket } : { binding: "BACKUP_R2" }), prefix: cfg.prefix, key_id: await keyId(cfg.publicKey), hour_utc: num(env.BACKUP_HOUR, 3) }
      : {}),
    last_complete: (days.find((d) => d.complete) as { day?: string } | undefined)?.day ?? null,
    days,
    failures,
  };
}

/** Housekeeping: forget backup bookkeeping older than 90 days (the bucket keeps 30). */
export function pruneBackupParts(env: Env, now: number): Promise<unknown> {
  return env.DB.prepare(`DELETE FROM backup_parts WHERE day < ?`).bind(new Date(now - 90 * 86_400_000).toISOString().slice(0, 10)).run();
}
