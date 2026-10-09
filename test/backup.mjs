// The backup drill as a test (#1550, docs/BACKUPS.md): a local Worker with backups on, then the whole night — write,
// list, decrypt, and both halves of the restore (D1 through scripts/backup.mjs d1-sql + sqlite3, the board through
// /api/ops/restore-board), asserting the data comes back. Two modes, one Worker each:
//   BK_MODE=s3 (default): backups go to a fake S3 in this process (an S3-compatible bucket outside Cloudflare).
//     BASE=http://localhost:8614 BK_S3_PORT=8615 BK_KEY_FILE=backup-key.json ADMIN_KEY=… node test/backup.mjs
//   BK_MODE=r2: backups go to the Worker's BACKUP_R2 binding, a local bucket under its --persist-to dir (BK_R2_LOCAL),
//     read back the way the operator reads production's (scripts/backup.mjs --r2 … --r2-local …; vedu #5342).
// (verify.sh runs both as the "backup" suite: the S3 Worker on :PORT+4 with the fake S3 on :PORT+5, the R2 one on :PORT+6.)

import { execFile, execFileSync, spawnSync } from "node:child_process";
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
const MODE = process.env.BK_MODE === "r2" ? "r2" : "s3";
const R2_BUCKET = "atteo-backups";
const R2_LOCAL = process.env.BK_R2_LOCAL; // the R2 Worker's --persist-to dir
if (MODE === "r2" && !R2_LOCAL) throw new Error("BK_MODE=r2 needs BK_R2_LOCAL (the Worker's --persist-to dir)");
const FILES = ["a.png", "b.png", "c.png"];
// A valid 10×10 PNG with the file's name appended after IEND, so each file's bytes differ.
const png = (name) => Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC", "base64"), Buffer.from(name)]);
const s3env = () => ({ ...process.env, BACKUP_S3_ENDPOINT: `http://127.0.0.1:${S3PORT}`, BACKUP_S3_BUCKET: "atteo-test", BACKUP_S3_KEY_ID: "test", BACKUP_S3_SECRET: "test", BACKUP_S3_PREFIX: "" });
// How scripts/backup.mjs finds this mode's bucket: the fake S3's settings, or the local R2 (and no S3 settings at all).
const scriptEnv = () => (MODE === "r2" ? { ...process.env, BACKUP_S3_PREFIX: "" } : s3env());
const scriptArgs = () => (MODE === "r2" ? ["--r2", R2_BUCKET, "--r2-local", R2_LOCAL] : []);

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
const putCounts = new Map(); // key → PUTs stored: a resumed board writes each of its parts once
let refusePuts = false; // a bucket that's down, for the retry and alert step
let failPutIn = 0; // >0: that many PUTs from now, one fails (the big board's resume step)
const fake = (await import("node:http")).createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${S3PORT}`);
  const key = url.pathname.replace(/^\/atteo-test\//, "");
  if (!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization ?? "")) {
    res.writeHead(403).end("unsigned");
  } else if (req.method === "PUT" && (refusePuts || (failPutIn > 0 && --failPutIn === 0))) {
    req.resume();
    res.writeHead(503).end("SlowDown");
  } else if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      objects.set(key, Buffer.concat(chunks));
      putCounts.set(key, (putCounts.get(key) ?? 0) + 1);
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
if (MODE === "s3") await new Promise((r) => fake.listen(S3PORT, "127.0.0.1", r));

/** One object's bytes, or undefined: the fake S3's map, or the local R2 bucket through wrangler. */
const getObj = (key) => {
  if (MODE === "s3") return objects.get(key);
  try {
    const dir = mkdtempSync(join(tmpdir(), "atteo-bk-r2-"));
    const file = join(dir, "obj");
    execFileSync("npx", ["wrangler", "r2", "object", "get", `${R2_BUCKET}/${key}`, "--file", file, "--local", "--persist-to", R2_LOCAL], { stdio: "ignore", env: { ...process.env, CI: "1" } });
    const b = readFileSync(file);
    rmSync(dir, { recursive: true, force: true });
    return b;
  } catch {
    return undefined;
  }
};

// One retry when the request never got an answer ("fetch failed"): under a loaded gate Node's fetch can reuse a
// keep-alive socket the local server already closed. A backup run is safe to repeat: finished parts are skipped.
const ops = async (path, body, retry = true) => {
  const r = await fetch(`${BASE}/api/ops/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => { if (retry && e instanceof TypeError) return null; throw e; });
  if (!r) return ops(path, body, false);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const day0 = new Date();
const day = new Date(day0.getTime() + 4 * 3600_000).toISOString().slice(0, 10); // 04:00 UTC today
const at = (h, m = 0) => new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`).getTime();
const priv = await crypto.subtle.importKey("pkcs8", Buffer.from(JSON.parse(readFileSync(KEY_FILE, "utf8")).private_key_b64, "base64"), { name: "X25519" }, false, ["deriveBits"]);
const unseal = async (key) => {
  const b = getObj(key);
  assert(b, `no object ${key}`);
  return JSON.parse(Buffer.from(await bc.gunzip(await bc.open(priv, b))).toString());
};
const boardEntries = async () => {
  const r = await fetch(`${BASE}/api/boards/${globalThis.__boardId}/entries?after=0&limit=100`, { headers: { authorization: `Bearer ${globalThis.__token}` } });
  assert(r.status === 200, `entries read: ${r.status}`);
  return (await r.json()).entries;
};

const steps = [
  ["a night before BACKUP_HOUR writes nothing", async () => {
    const r = await ops("backup", { now: at(1) });
    assert(r.status === 200 && r.body.configured === true && r.body.waiting === true, JSON.stringify(r.body));
    assert(MODE === "s3" ? objects.size === 0 : !getObj(`${day}/d1.json.gz.enc`), "nothing uploaded before the hour");
  }],
  ["the night: d1, the boards, then the manifest", async () => {
    const r = await ops("backup", { now: at(4) });
    const b = r.body;
    assert(r.status === 200 && b.d1 === true && b.boards >= 1 && b.manifest === true, JSON.stringify(b));
    if (MODE === "s3") assert([...objects.keys()].every((k) => k.startsWith(`${day}/`)), "objects under the day");
    for (const part of ["d1", "manifest"]) {
      const b = getObj(`${day}/${part}.json.gz.enc`);
      assert(b, `${part} uploaded`);
      assert(b.toString("utf8").startsWith("atteo-backup-v1\n"), `${part} sealed`);
    }
  }],
  ["a second run the same night adds nothing (finished: one read)", async () => {
    const before = objects.size;
    const r = await ops("backup", { now: at(4, 5) });
    assert(r.body.finished === true && r.body.d1 === undefined, JSON.stringify(r.body));
    if (MODE === "s3") assert(objects.size === before, "no new objects");
  }],
  ["GET /api/ops/backups: the night complete, key id, no failures", async () => {
    const r = await ops("backups");
    assert(r.body.configured === true && r.body.last_complete === day, JSON.stringify(r.body).slice(0, 300));
    assert(r.body.target === MODE, `writing to ${MODE}: ${r.body.target}`);
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
  ["the board's rows and files decrypt from bounded parts", async () => {
    globalThis.__board = await unseal(`${day}/boards/${globalThis.__boardId}.json.gz.enc`);
    const b = globalThis.__board;
    assert(b.kind === "board" && b.board === globalThis.__boardId, "board header");
    assert(b.tables.entries.rows.length === 0 && b.tables.docs.rows.length === 0, "the main part has table columns but no growing rows");
    const entryParts = b.row_parts.filter((name) => name.includes(".rows-entries-"));
    assert(entryParts.length >= 3, `entries split across several row parts: ${JSON.stringify(entryParts)}`);
    const rows = [];
    for (let k = 0; k < entryParts.length; k++) {
      const rp = await unseal(`${day}/boards/${entryParts[k]}`);
      assert(rp.kind === "board-rows" && rp.table === "entries" && rp.part === k && rp.tables.entries.rows.length > 0, `ordered entry part ${k}`);
      rows.push(...rp.tables.entries.rows);
    }
    const entries = rows.map((r) => r[b.tables.entries.columns.indexOf("text")]);
    assert(entries.length === 7 && entries.slice(0, 5).every((t) => /^bk-seed \d/.test(t)) && entries[5] === "bk-files" && entries[6] === "bk-long-artifact", `entries as of the backup: ${entries.join(" | ")}`);
    const versionParts = b.row_parts.filter((name) => name.includes(".rows-doc_versions-"));
    assert(versionParts.length > 0, "document versions have row parts");
    const versionData = await Promise.all(versionParts.map((name) => unseal(`${day}/boards/${name}`)));
    const contentIndex = versionData[0].tables.doc_versions.columns.indexOf("content");
    assert(versionData.some((p) => p.tables.doc_versions.rows.some((r) => r[contentIndex] === globalThis.__artifact)), "long artifact content survives the split");
    const searchParts = b.row_parts.filter((name) => name.includes(".rows-search_idx-"));
    assert(searchParts.length > 0, "the search index has row parts");
    assert(!("search_idx_data" in b.tables), "no FTS5 shadow tables");
    assert(b.tables.blobs && b.tables.blobs.rows.length === 0 && b.tables.blobs.columns.includes("bytes"), "the main part has no file bytes");
    assert(b.file_parts?.length === 3, `one file part per file at this part size: ${JSON.stringify(b.file_parts)}`);
    const names = [];
    for (const fp of b.file_parts) {
      const f = await unseal(`${day}/boards/${fp}`);
      const t = f.tables.blobs;
      assert(f.kind === "board-files" && t.rows.length === 1, `a file part: ${fp}`);
      const row = t.rows[0];
      names.push(row[t.columns.indexOf("name")]);
      assert(Buffer.from(row[t.columns.indexOf("bytes")].$b64, "base64").equals(png(row[t.columns.indexOf("name")])), "the bytes, exactly");
    }
    assert(names.sort().join() === FILES.join(), `every file once: ${names}`);
    const m = await unseal(`${day}/manifest.json.gz.enc`);
    const bp = m.parts.find((p) => p.part === `board:${globalThis.__boardId}`);
    assert(bp?.extra?.length === b.file_parts.length + b.row_parts.length && bp.extra.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)), `the manifest lists every part with a hash: ${JSON.stringify(bp)}`);
  }],
  ["d1-sql (scripts/backup.mjs) turns the night into SQL sqlite3 accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atteo-bk-"));
    const sqlFile = join(dir, "d1.sql");
    // Async: the fake S3 the script calls is served by this process's event loop.
    await promisify(execFile)(process.execPath, ["scripts/backup.mjs", "d1-sql", day, "--key", KEY_FILE, "--out", sqlFile, ...scriptArgs()], { env: scriptEnv() }).catch((e) => {
      throw new Error(`d1-sql failed: ${e.stderr || e.message}`);
    });
    const db = join(dir, "d1.sqlite");
    const s = spawnSync("sqlite3", [db, `.read ${sqlFile}`], { encoding: "utf8" });
    assert(s.status === 0, `sqlite3 refused the SQL: ${s.stderr}`);
    const q = spawnSync("sqlite3", [db, "SELECT name FROM users WHERE name = 'bk-user'"], { encoding: "utf8" });
    assert(q.stdout.trim() === "bk-user", `the user restored into sqlite: ${q.stdout}${q.stderr}`);
    const av = spawnSync("sqlite3", [db, "SELECT typeof(bytes), hex(bytes) FROM avatars WHERE user = 'bk-user' AND kind = 'person'"], { encoding: "utf8" });
    assert(av.stdout.trim() === `blob|${png("avatar").toString("hex").toUpperCase()}`, `the avatar's BLOB restored byte for byte: ${av.stdout.slice(0, 80)}${av.stderr}`);
    rmSync(dir, { recursive: true, force: true });
  }],
  ["restore-board (scripts/backup.mjs): the board back as of the night, files included (a later entry gone)", async () => {
    await ops("seed", { user: "bk-user", board: globalThis.__boardId, count: 3, prefix: "bk-after" }); // 3 more entries, after the backup
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/backup.mjs", "restore-board", day, globalThis.__boardId, "--key", KEY_FILE, "--base", BASE, "--admin-key", ADMIN_KEY, ...scriptArgs()], { env: scriptEnv() }).catch((e) => {
      throw new Error(`restore-board failed: ${e.stderr || e.message}`);
    });
    assert(/restored from .*"skipped":\[\].*, \d+ rows from \d+ row parts, 3 files from 3 file parts/.test(stdout), `the script's report: ${stdout}`);
    const restored = await boardEntries();
    assert(JSON.stringify(restored) === JSON.stringify(globalThis.__entriesBefore), "every visible entry row restored exactly");
    const texts = restored.map((e) => e.text);
    assert(texts.length === 7 && !texts.some((t) => /bk-after/.test(t)), `entries back as of the night, not after: ${texts.join(" | ")}`);
    for (const name of FILES) {
      const r = await fetch(`${BASE}/api/boards/${globalThis.__boardId}/image?name=${name}`, { headers: { authorization: `Bearer ${globalThis.__token}` } });
      assert(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(png(name)), `${name} served again, byte for byte (${r.status})`);
    }
  }],
  ["restore-board reads a legacy main part containing all table rows", async () => {
    if (MODE === "r2") return; // the fake S3 lets this test replace one object without touching wrangler's local R2 state
    const mainKey = `${day}/boards/${globalThis.__boardId}.json.gz.enc`;
    const original = objects.get(mainKey);
    const legacy = structuredClone(globalThis.__board);
    for (const name of legacy.row_parts) {
      const rp = await unseal(`${day}/boards/${name}`);
      for (const [table, data] of Object.entries(rp.tables)) legacy.tables[table].rows.push(...data.rows);
    }
    delete legacy.row_parts;
    const pub = JSON.parse(readFileSync(KEY_FILE, "utf8")).public_key;
    objects.set(mainKey, Buffer.from(await bc.packPart(pub, legacy)));
    try {
      await ops("seed", { user: "bk-user", board: globalThis.__boardId, count: 2, prefix: "bk-legacy-after" });
      const { stdout } = await promisify(execFile)(process.execPath, ["scripts/backup.mjs", "restore-board", day, globalThis.__boardId, "--key", KEY_FILE, "--base", BASE, "--admin-key", ADMIN_KEY, ...scriptArgs()], { env: scriptEnv() });
      assert(/0 rows from 0 row parts, 3 files from 3 file parts/.test(stdout), `legacy restore report: ${stdout}`);
      assert(JSON.stringify(await boardEntries()) === JSON.stringify(globalThis.__entriesBefore), "legacy backup restores identical entries");
    } finally {
      objects.set(mainKey, original);
    }
  }],
  ["a complete night isn't reported late in the day", async () => {
    const r = await ops("backup", { now: at(10) });
    assert(r.status === 200 && r.body.alert === undefined, `a complete night isn't reported: ${JSON.stringify(r.body)}`);
  }],
  ["a bucket that's down: each part tried 3 times, then the night is reported once", async () => {
    if (MODE === "r2") return; // the same retry code as S3; a local R2 can't be made to refuse writes
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
  ["a big board: about 200 parts over many calls, a failed attempt resumes, restore-board brings it back exactly", async () => {
    if (MODE === "r2") return; // the fake S3 counts PUTs and fails one; restoring hundreds of parts through wrangler is slow
    const b = await ops("boards", { user: "bk-user", title: "bk big board" });
    assert(b.status === 201, `big board created: ${JSON.stringify(b.body)}`);
    const big = b.body.board.id;
    const s = await ops("seed", { user: "bk-user", board: big, count: 150, prefix: "bk-big" });
    assert(s.status === 200 && s.body.count === 150, "150 entries seeded");
    const bigFiles = ["big-1.png", "big-2.png", "big-3.png", "big-4.png", "big-5.png"];
    const fd = new FormData();
    for (const name of bigFiles) (fd.append("file", new Blob([png(name)], { type: "image/png" }), name), fd.append("w", "10"), fd.append("h", "10"));
    fd.append("text", "bk-big-files");
    const up = await fetch(`${BASE}/api/boards/${big}/upload`, { method: "POST", headers: { authorization: `Bearer ${globalThis.__token}` }, body: fd });
    assert(up.status === 201, `big files uploaded: ${up.status}`);
    const before = await allEntries(big);
    assert(before.length === 151, `151 entries before the night: ${before.length}`);

    // Two nights on: the first run's attempt dies partway (one PUT refused), the next run finishes from where it stopped.
    const night2 = new Date(at(4) + 2 * 86_400_000).toISOString().slice(0, 10);
    failPutIn = 60;
    const r1 = (await ops("backup", { now: at(4) + 2 * 86_400_000 })).body;
    assert(failPutIn === 0 && r1.failed >= 1 && !r1.manifest, `the first run fails a board partway: ${JSON.stringify(r1)}`);
    const r2 = (await ops("backup", { now: at(4, 5) + 2 * 86_400_000 })).body;
    assert(!r2.failed && r2.manifest === true, `the next run finishes the night: ${JSON.stringify(r2)}`);
    const mine = [...putCounts.entries()].filter(([k]) => k.startsWith(`${night2}/boards/`));
    assert(mine.length > 150 && mine.every(([, n]) => n === 1), `each part written once, the retry picking up after the last one written: ${mine.filter(([, n]) => n !== 1).map(([k]) => k).join(", ") || mine.length}`);

    const main = await unseal(`${night2}/boards/${big}.json.gz.enc`);
    const count = (t) => main.row_parts.filter((n) => n.includes(`.rows-${t}-`)).length;
    assert(count("entries") >= 100 && count("search_idx") >= 5 && main.file_parts.length === 5, `entries, search index and files across many parts: ${count("entries")}, ${count("search_idx")}, ${main.file_parts.length}`);
    const m = await unseal(`${night2}/manifest.json.gz.enc`);
    const bp = m.parts.find((p) => p.part === `board:${big}`);
    const keys = bp.extra.map((e) => e.object_key);
    assert(new Set(keys).size === keys.length && keys.length === main.row_parts.length + main.file_parts.length, "the manifest lists every part once");
    for (const e of bp.extra) assert(objects.get(e.object_key)?.length === e.bytes && (await bc.sha256Hex(new Uint8Array(objects.get(e.object_key)))) === e.sha256, `size and hash of ${e.object_key}`);

    await ops("seed", { user: "bk-user", board: big, count: 4, prefix: "bk-big-after" });
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/backup.mjs", "restore-board", night2, big, "--key", KEY_FILE, "--base", BASE, "--admin-key", ADMIN_KEY, ...scriptArgs()], { env: scriptEnv() }).catch((e) => {
      throw new Error(`restore-board failed: ${e.stderr || e.message}`);
    });
    assert(new RegExp(`from ${main.row_parts.length} row parts, 5 files from 5 file parts`).test(stdout), `the script's report: ${stdout}`);
    const after = await allEntries(big);
    assert(JSON.stringify(after) === JSON.stringify(before), `every entry back exactly, none after the night (${after.length})`);
    for (const name of bigFiles) {
      const r = await fetch(`${BASE}/api/boards/${big}/image?name=${name}`, { headers: { authorization: `Bearer ${globalThis.__token}` } });
      assert(r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(png(name)), `${name} back byte for byte (${r.status})`);
    }
    const hit = await fetch(`${BASE}/api/boards/${big}/search?q=bk-big`, { headers: { authorization: `Bearer ${globalThis.__token}` } });
    const found = hit.status === 200 ? (await hit.json()).entries : [];
    assert(found.length > 0 && !JSON.stringify(found).includes("bk-big-after"), `the search index comes back with the rows: ${hit.status} ${found.length}`);
  }],
];

/** Every entry of a board, a page at a time. */
const allEntries = async (board) => {
  const out = [];
  for (let after = 0; ; ) {
    const r = await fetch(`${BASE}/api/boards/${board}/entries?after=${after}&limit=100`, { headers: { authorization: `Bearer ${globalThis.__token}` } });
    assert(r.status === 200, `entries read: ${r.status}`);
    const page = (await r.json()).entries;
    out.push(...page);
    if (!page.length) return out;
    after = page[page.length - 1].seq;
  }
};

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
    // A profile picture: a BLOB in D1 (avatars.bytes), which D1 hands back as an array of numbers, not an ArrayBuffer.
    // The first real night's d1-sql died on exactly that (atob: "not correctly encoded"). People only: a web session.
    const cookie = (await ops("sessions", { user: "bk-user", verified: "true" })).body.cookie;
    assert(cookie?.startsWith("ab_session="), "a person session for bk-user");
    const av = await fetch(`${BASE}/api/me/avatar?kind=person`, { method: "POST", headers: { cookie, "content-type": "image/png" }, body: png("avatar") });
    assert(av.status === 200, `avatar uploaded: ${av.status} ${(await av.text()).slice(0, 200)}`);
    const s = await ops("seed", { user: "bk-user", board: globalThis.__boardId, count: 5, prefix: "bk-seed" });
    assert(s.status === 200 && s.body.count === 5, "5 entries seeded");
    // Three pictures in one message, each its own bytes (the server's BACKUP_BLOB_PART_BYTES is tiny here, so each gets
    // a file part of its own).
    const fd = new FormData();
    for (const name of FILES) {
      fd.append("file", new Blob([png(name)], { type: "image/png" }), name);
      fd.append("w", "10");
      fd.append("h", "10");
    }
    fd.append("text", "bk-files");
    const up = await fetch(`${BASE}/api/boards/${globalThis.__boardId}/upload`, { method: "POST", headers: { authorization: `Bearer ${globalThis.__token}` }, body: fd });
    assert(up.status === 201, `files uploaded: ${up.status} ${(await up.text()).slice(0, 200)}`);
    globalThis.__artifact = "A long artifact\n" + "line with text and symbols → 🟦\n".repeat(80);
    const artifact = await fetch(`${BASE}/api/boards/${globalThis.__boardId}/entries`, { method: "POST", headers: { authorization: `Bearer ${globalThis.__token}`, "content-type": "application/json" }, body: JSON.stringify({ type: "artifact", text: "bk-long-artifact", artifact_name: "backup.txt", artifact_content: globalThis.__artifact }) });
    assert(artifact.status === 201, `artifact posted: ${artifact.status} ${(await artifact.text()).slice(0, 200)}`);
    globalThis.__entriesBefore = await boardEntries();
  },
];

try {
  for (const fn of setup) await fn();
  ok("setup: user, token, avatar, board with 7 entries including a long artifact and 3 pictures");
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
  if (MODE === "s3") fake.close();
}
console.log(`\n${MODE}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
