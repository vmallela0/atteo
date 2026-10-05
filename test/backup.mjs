// The backup drill as a test (#1550, docs/BACKUPS.md): a local Worker with backups pointed at a fake S3 in this
// process, then the whole night — write, list, decrypt, and both halves of the restore (D1 through scripts/backup.mjs
// d1-sql + sqlite3, the board through /api/ops/restore-board), asserting the data comes back.
//   BASE=http://localhost:8614 BK_S3_PORT=8615 BK_KEY_FILE=backup-key.json ADMIN_KEY=… node test/backup.mjs
// (verify.sh runs it as the "backup" suite: server on :PORT+4 with --var BACKUP_* at the fake S3 on :PORT+5.)

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { webcrypto as crypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bc from "../src/backupcore.ts";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY ?? readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY=(.*)$/m)?.[1];
const S3PORT = Number(process.env.BK_S3_PORT ?? 8615);
const KEY_FILE = process.env.BK_KEY_FILE ?? "backup-key.json";

let passed = 0;
let failed = 0;
const ok = (m) => (passed++, console.log(`  ✓ ${m}`));
const fail = (m) => (failed++, console.error(`  ✗ ${m}`));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The fake bucket: S3 enough for the backup (PUT, GET, ListObjectsV2). It checks the request is signed (the signature
// math itself is test/backupcore.test.ts against AWS's examples), and stores the bytes.
const objects = new Map();
let refusePuts = false; // a bucket that's down, for the retry and alert step
const fake = (await import("node:http")).createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${S3PORT}`);
  const key = url.pathname.replace(/^\/atteo-test\//, "");
  if (!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization ?? "")) {
    res.writeHead(403).end("unsigned");
  } else if (req.method === "PUT" && refusePuts) {
    req.resume();
    res.writeHead(503).end("SlowDown");
  } else if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200).end();
    });
  } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const mine = [...objects.entries()].filter(([k]) => k.startsWith(prefix));
    res.writeHead(200, { "content-type": "application/xml" }).end(
      `<?xml version="1.0"?><ListBucketResult>${mine
        .map(([k, b]) => `<Contents><Key>${k}</Key><Size>${b.length}</Size></Contents>`)
        .join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
    );
  } else if (req.method === "GET") {
    if (!objects.has(key)) res.writeHead(404).end("no such key");
    else {
      const b = objects.get(key);
      res.writeHead(200, { "content-length": b.length }).end(b);
    }
  } else res.writeHead(405).end();
});
await new Promise((r) => fake.listen(S3PORT, "127.0.0.1", r));

const ops = async (path, body) => {
  const r = await fetch(`${BASE}/api/ops/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const day0 = new Date();
const day = new Date(day0.getTime() + 4 * 3600_000).toISOString().slice(0, 10); // 04:00 UTC today
const at = (h, m = 0) => new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`).getTime();
const priv = await crypto.subtle.importKey("pkcs8", Buffer.from(JSON.parse(readFileSync(KEY_FILE, "utf8")).private_key_b64, "base64"), { name: "X25519" }, false, ["deriveBits"]);
const unseal = async (key) => JSON.parse(Buffer.from(await bc.gunzip(await bc.open(priv, objects.get(key)))).toString());

const steps = [
  ["a night before BACKUP_HOUR writes nothing", async () => {
    const r = await ops("backup", { now: at(1) });
    assert(r.status === 200 && r.body.configured === true && r.body.waiting === true, JSON.stringify(r.body));
    assert(objects.size === 0, "nothing uploaded before the hour");
  }],
  ["the night: d1, the boards, then the manifest", async () => {
    const r = await ops("backup", { now: at(4) });
    const b = r.body;
    assert(r.status === 200 && b.d1 === true && b.boards >= 1 && b.manifest === true, JSON.stringify(b));
    assert([...objects.keys()].every((k) => k.startsWith(`${day}/`)), "objects under the day");
    for (const part of ["d1", "manifest"]) {
      assert(objects.has(`${day}/${part}.json.gz.enc`), `${part} uploaded`);
      assert(objects.get(`${day}/${part}.json.gz.enc`).toString("utf8").startsWith("atteo-backup-v1\n"), `${part} sealed`);
    }
  }],
  ["a second run the same night adds nothing (finished: one read)", async () => {
    const before = objects.size;
    const r = await ops("backup", { now: at(4, 5) });
    assert(r.body.finished === true && r.body.d1 === undefined, JSON.stringify(r.body));
    assert(objects.size === before, "no new objects");
  }],
  ["GET /api/ops/backups: the night complete, key id, no failures", async () => {
    const r = await ops("backups");
    assert(r.body.configured === true && r.body.last_complete === day, JSON.stringify(r.body).slice(0, 300));
    assert(r.body.failures.length === 0, "no failed parts");
    assert(/^[0-9a-f]{16}$/.test(r.body.key_id), "short key id");
  }],
  ["the D1 part decrypts to the users and boards", async () => {
    const d1 = await unseal(`${day}/d1.json.gz.enc`);
    assert(d1.kind === "d1" && d1.day === day, "d1 header");
    assert(d1.tables.users?.columns.includes("name") && d1.tables.users.rows.some((r) => r[d1.tables.users.columns.indexOf("name")] === "bk-user"), "the user row");
    assert(d1.tables.boards?.rows.length >= 1, "boards dumped");
    assert(!Object.keys(d1.tables).some((t) => t.startsWith("sqlite_")), "no sqlite internals");
  }],
  ["the board part decrypts with its entries and blobs as $b64", async () => {
    globalThis.__board = await unseal(`${day}/boards/${globalThis.__boardId}.json.gz.enc`);
    const b = globalThis.__board;
    assert(b.kind === "board" && b.board === globalThis.__boardId, "board header");
    const entries = b.tables.entries.rows.map((r) => r[b.tables.entries.columns.indexOf("text")]);
    assert(b.tables.entries.rows.length === 5 && entries.every((t) => /^bk-seed \d/.test(t)), `entries as of the backup: ${entries.join(" | ")}`);
    assert(b.tables.search_idx.rows.length === 5, "the search index as rows");
    assert(!("search_idx_data" in b.tables), "no FTS5 shadow tables");
  }],
  ["d1-sql (scripts/backup.mjs) turns the night into SQL sqlite3 accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atteo-bk-"));
    const sqlFile = join(dir, "d1.sql");
    const env = { ...process.env, BACKUP_S3_ENDPOINT: `http://127.0.0.1:${S3PORT}`, BACKUP_S3_BUCKET: "atteo-test", BACKUP_S3_KEY_ID: "test", BACKUP_S3_SECRET: "test", BACKUP_S3_PREFIX: "" };
    // Async: the fake S3 the script calls is served by this process's event loop.
    await promisify(execFile)(process.execPath, ["scripts/backup.mjs", "d1-sql", day, "--key", KEY_FILE, "--out", sqlFile], { env }).catch((e) => {
      throw new Error(`d1-sql failed: ${e.stderr || e.message}`);
    });
    const db = join(dir, "d1.sqlite");
    const s = spawnSync("sqlite3", [db, `.read ${sqlFile}`], { encoding: "utf8" });
    assert(s.status === 0, `sqlite3 refused the SQL: ${s.stderr}`);
    const q = spawnSync("sqlite3", [db, "SELECT name FROM users WHERE name = 'bk-user'"], { encoding: "utf8" });
    assert(q.stdout.trim() === "bk-user", `the user restored into sqlite: ${q.stdout}${q.stderr}`);
    rmSync(dir, { recursive: true, force: true });
  }],
  ["restore-board: the board back as of the night (a later entry gone)", async () => {
    await ops("seed", { user: "bk-user", board: globalThis.__boardId, count: 3, prefix: "bk-after" }); // 3 more entries, after the backup
    const tables = globalThis.__board.tables;
    const r = await ops("restore-board", { board: globalThis.__boardId, tables });
    assert(r.status === 200 && r.body.ok === true && r.body.tables >= 10 && r.body.skipped.length === 0, JSON.stringify(r.body));
    const after = await fetch(`${BASE}/api/boards/${globalThis.__boardId}/entries?after=0&limit=100`, { headers: { authorization: `Bearer ${globalThis.__token}` } });
    const j = await after.json();
    const texts = j.entries.map((e) => e.text);
    assert(texts.length === 5 && texts.every((t) => /^bk-seed \d/.test(t)), `entries back as of the night, not after: ${texts.join(" | ")}`);
  }],
  ["a complete night isn't reported late in the day", async () => {
    const r = await ops("backup", { now: at(10) });
    assert(r.status === 200 && r.body.alert === undefined, `a complete night isn't reported: ${JSON.stringify(r.body)}`);
  }],
  ["a bucket that's down: each part tried 3 times, then the night is reported once", async () => {
    refusePuts = true;
    const next = (h) => at(h) + 86_400_000;
    const runs = [];
    for (const h of [4, 4.1, 4.2, 4.3]) runs.push((await ops("backup", { now: next(Math.floor(h)) + Math.round((h % 1) * 600_000) })).body);
    refusePuts = false;
    assert(runs[0].failed >= 2 && runs[0].d1 === false, `first run fails d1 and the board: ${JSON.stringify(runs[0])}`);
    assert(runs[1].failed >= 2 && !runs[1].alert, `second run retries, no alert yet: ${JSON.stringify(runs[1])}`);
    assert(/Backup \d{4}-\d{2}-\d{2} incomplete: \d+ parts failed 3 times/.test(runs[2].alert ?? ""), `third try gives up and reports: ${JSON.stringify(runs[2])}`);
    assert(!runs[3].failed && !runs[3].alert && !runs[3].d1, `then nothing more is tried or reported: ${JSON.stringify(runs[3])}`);
    const st = (await ops("backups")).body;
    assert(st.days[0].alert && st.failures.some((f) => f.part === "d1" && f.attempts === 3 && /503/.test(f.error)), `ops/backups shows the night's failures: ${JSON.stringify(st).slice(0, 500)}`);
    assert(st.last_complete === day, "the last good night is still the first one");
  }],
];

// One board, seeded before the night (the local Worker is fresh, so the boards table has only ours).
const setup = [
  async () => {
    const u = await ops("users", { name: "bk-user", email: "bk@example.test", verified: true });
    assert(u.status === 201 || u.status === 409, "user created");
    const b = await ops("boards", { user: "bk-user", title: "bk board" });
    assert(b.status === 201, `board created: ${JSON.stringify(b.body)}`);
    globalThis.__boardId = b.body.board.id;
    const t = await ops("tokens", { user: "bk-user", label: "bk" });
    assert(t.status === 201, "token issued");
    globalThis.__token = t.body.token;
    const s = await ops("seed", { user: "bk-user", board: globalThis.__boardId, count: 5, prefix: "bk-seed" });
    assert(s.status === 200 && s.body.count === 5, "5 entries seeded");
  },
];

try {
  for (const fn of setup) await fn();
  ok("setup: user, token, board with 5 entries");
  for (const [name, fn] of steps) {
    const t0 = Date.now();
    try {
      await fn();
      ok(`${name} (${Date.now() - t0}ms)`);
    } catch (e) {
      fail(`${name}: ${e?.message ?? e}`);
    }
  }
} finally {
  fake.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
