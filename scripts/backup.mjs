#!/usr/bin/env node
// Nightly backups (#1550, docs/BACKUPS.md): the operator side. The bucket, the day and the private key come as flags or
// environment variables; nothing here talks to Atteo except restore-board, which posts to a local Worker. The Worker
// holds only the public key, so only the machine with the private key can read a backup.
//
// Where the backups are:
//   R2 in our account (production, vedu #5342): --r2 atteo-backups (or BACKUP_R2_BUCKET). Objects come through
//       `wrangler r2 object get --remote`, so your wrangler login reads them (set CLOUDFLARE_ACCOUNT_ID if it asks).
//       --r2-local <dir> reads a local wrangler dev bucket instead (its --persist-to dir; the backup test does this).
//       R2 has no listing here: list and night read the night's manifest, so they take a day.
//   An S3-compatible bucket: --endpoint --bucket --region --key-id --secret (or BACKUP_S3_* in the environment).
//
//   node scripts/backup.mjs keygen [--out backup-key.json]
//       A backup key pair: prints the public key as a wrangler var; the private key file is yours to keep offline.
//   node scripts/backup.mjs list [<day>]                  every object in the bucket (R2: the night's, from its manifest)
//   node scripts/backup.mjs night <day>                   the whole night decrypted into ./backup-<day>/ (d1, boards, manifest)
//   node scripts/backup.mjs part <day> <part>             one part decrypted to stdout (d1 | boards/<id> | manifest)
//   node scripts/backup.mjs d1-sql <day> [--out file.sql] the night's D1 as SQL for `wrangler d1 execute` (the drill's step 1)
//   node scripts/backup.mjs restore-board <day> <id> --base http://localhost:8787 [--admin-key k]
//       The drill's step 2: post the board's decrypted tables to POST /api/ops/restore-board on a local Worker.
//
// Flags: --r2 <bucket> [--r2-local <dir>] | --endpoint --bucket --region --key-id --secret; --prefix
//        [--key backup-key.json] [--out file] --base --admin-key  (the S3 ones and prefix also come from BACKUP_S3_*)

import { execFileSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bc from "../src/backupcore.ts";

const args = process.argv.slice(2);
const cmd = args.shift() ?? "";
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    const v = args.splice(i, 2)[1];
    return v;
  }
  return process.env[`BACKUP_S3_${name.toUpperCase().replace(/-/g, "_")}`];
};
/** A flag without the BACKUP_S3_ fallback (the R2 ones have their own environment names). */
const opt = (name, envName) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : process.env[envName];
};
const positional = () => args.filter((a) => !a.startsWith("--"));
const die = (m) => {
  console.error(m);
  process.exit(2);
};
const need = (name) => {
  const v = flag(name);
  if (!v) die(`--${name} (or ${name.toUpperCase().replace(/-/g, "_")} in the environment) is required`);
  return v;
};

const s3cfg = () => {
  const cfg = {
    endpoint: need("endpoint"),
    bucket: need("bucket"),
    region: flag("region") || "us-east-1",
    keyId: need("key-id"),
    secret: need("secret"),
    prefix: (flag("prefix") ?? "atteo/").replace(/([^/])$/, "$1/"),
    virtualHost: flag("virtual-host") === "1",
  };
  if (!/^https?:\/\//.test(cfg.endpoint)) die(`--endpoint must be an https URL, like https://s3.us-west-004.backblazeb2.com (got ${cfg.endpoint})`);
  return cfg;
};

/** One object out of R2 through wrangler: the remote bucket, or a local wrangler dev one (`local` = its --persist-to). */
const r2Get = (bucket, key, local) => {
  const dir = mkdtempSync(join(tmpdir(), "atteo-r2-"));
  const file = join(dir, "part");
  try {
    execFileSync("npx", ["wrangler", "r2", "object", "get", `${bucket}/${key}`, "--file", file, ...(local ? ["--local", "--persist-to", local] : ["--remote"])], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    });
    if (!existsSync(file)) throw new Error("not written");
    return new Uint8Array(readFileSync(file));
  } catch (e) {
    throw new Error(`R2 ${bucket}/${key}: ${String(e.stderr || e.message || e).trim().split("\n").slice(-3).join(" ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Where the backups are read from: { prefix, get(key), list(prefix) | null }. Call it before positional(). */
const source = () => {
  const bucket = opt("r2", "BACKUP_R2_BUCKET");
  if (bucket) {
    const local = opt("r2-local", "BACKUP_R2_LOCAL");
    const prefix = (flag("prefix") ?? "atteo/").replace(/([^/])$/, "$1/");
    return { prefix, get: async (key) => r2Get(bucket, key, local), list: null };
  }
  const cfg = s3cfg();
  return { prefix: cfg.prefix, get: (key) => bc.getObject(cfg, key), list: (p) => bc.listObjects(cfg, p) };
};

/** R2 has no listing here: a night's objects are the ones its manifest names (and the manifest). */
const fromManifest = async (src, day) => {
  const { key } = await privKey();
  const mkey = `${src.prefix}${day}/manifest.json.gz.enc`;
  const m = await bc.unpackPart(key, await src.get(mkey));
  const out = [];
  for (const p of m.parts) {
    if (p.status !== "done" || !p.object_key) continue;
    for (const e of p.extra ?? []) out.push({ key: e.object_key, size: e.bytes });
    out.push({ key: p.object_key, size: p.bytes - (p.extra ?? []).reduce((n, e) => n + e.bytes, 0) });
  }
  out.push({ key: mkey, size: null });
  return out;
};

const privKey = async () => {
  const path = flag("key") || "backup-key.json";
  if (!existsSync(path)) die(`no ${path}: make one with 'node scripts/backup.mjs keygen'`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  const pkcs8 = Buffer.from(j.private_key_b64 || j.private, "base64");
  return { key: await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]), kid: await bc.keyId(j.public_key ?? j.public) };
};

const night = async (src, day) => {
  const files = (src.list ? await src.list(`${src.prefix}${day}/`) : await fromManifest(src, day)).filter((f) => f.key.endsWith(".json.gz.enc"));
  if (!files.length) die(`no backup objects under ${src.prefix}${day}/ (check the day, and the prefix)`);
  return files;
};

const partKey = (src, day, part) => `${src.prefix}${day}/${part}.json.gz.enc`;

try {
  if (cmd === "keygen") {
    const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const pub = bc.b64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    const priv = bc.b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
    const out = flag("out") || "backup-key.json";
    writeFileSync(out, JSON.stringify({ alg: "x25519-hkdf-sha256-aes256gcm", public_key: pub, private_key_b64: priv, created: new Date().toISOString() }, null, 2) + "\n");
    chmodSync(out, 0o600);
    console.log(`Private key: ${out} (keep it offline; without it no backup can be read back)`);
    console.log(`Public key (wrangler.jsonc vars, then deploy):  BACKUP_PUBLIC_KEY: "${pub}"`);
  } else if (cmd === "list") {
    const src = source();
    const day = positional()[0];
    if (!src.list && !day) die("usage with --r2: list <YYYY-MM-DD> (the night's objects, from its manifest)");
    for (const f of src.list ? await src.list(day ? `${src.prefix}${day}/` : "") : await fromManifest(src, day)) console.log(`${String(f.size ?? "").padStart(10)}  ${f.key}`);
  } else if (cmd === "night") {
    const src = source();
    const day = positional()[0] || die("usage: night <YYYY-MM-DD>");
    const { key } = await privKey();
    const files = await night(src, day);
    const dir = flag("out") || `backup-${day}`;
    for (const f of files) {
      const rel = f.key.slice(`${src.prefix}${day}/`.length).replace(/\.json\.gz\.enc$/, "");
      const v = await bc.unpackPart(key, await src.get(f.key));
      writeFileSync(`${dir}/${rel.replace(/\//g, "_")}.json`, JSON.stringify(v, null, 1));
      console.log(`${f.key} -> ${dir}/${rel.replace(/\//g, "_")}.json`);
    }
    console.log(`${files.length} parts into ${dir}/`);
  } else if (cmd === "part") {
    const src = source();
    const [day, part] = positional();
    if (!day || !part) die("usage: part <YYYY-MM-DD> <d1 | boards/<id> | manifest>");
    const { key } = await privKey();
    const v = await bc.unpackPart(key, await src.get(partKey(src, day, part)));
    const out = flag("out");
    if (out) writeFileSync(out, JSON.stringify(v, null, 1));
    else console.log(JSON.stringify(v, null, 1));
  } else if (cmd === "d1-sql") {
    const src = source();
    const day = positional()[0] || die("usage: d1-sql <YYYY-MM-DD> [--out file.sql]");
    const { key } = await privKey();
    const d1 = await bc.unpackPart(key, await src.get(partKey(src, day, "d1")));
    // For a D1 that `wrangler d1 migrations apply` just made (the real schema, indexes included): the backup's rows
    // replace whatever is there. A table that checkout lacks is created from the backup's own CREATE. Foreign keys are
    // checked once at the end, so table order doesn't matter.
    const q = (n) => `"${n.replace(/"/g, '""')}"`;
    let sql = `-- Atteo D1 backup ${day} (docs/BACKUPS.md): onto a freshly migrated D1, wrangler d1 execute agent-board --local --file this.sql\n`;
    sql += "PRAGMA defer_foreign_keys = ON;\n";
    for (const t of d1.schema) if (t.sql) sql += t.sql.replace(/^\s*CREATE TABLE\s+(IF NOT EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS ").replace(/;?\s*$/, ";\n");
    for (const t of d1.schema) sql += `DELETE FROM ${q(t.name)};\n`;
    for (const t of d1.schema) sql += bc.tableToSql(t.name, d1.tables[t.name]);
    const out = flag("out") || `d1-${day}.sql`;
    writeFileSync(out, sql);
    console.log(`${out}: ${d1.schema.length} tables, ${Object.values(d1.tables).reduce((n, t) => n + t.rows.length, 0)} rows`);
  } else if (cmd === "restore-board") {
    const src = source();
    const base = need("base").replace(/\/$/, "");
    const [day, id] = positional();
    if (!day || !id) die("usage: restore-board <YYYY-MM-DD> <board id> --base http://localhost:8787 [--admin-key k]");
    const { key } = await privKey();
    const adminKey = flag("admin-key") || (existsSync(".dev.vars") ? (readFileSync(".dev.vars", "utf8").match(/^ADMIN_KEY=(.*)$/m) || [])[1] : "") || "";
    const post = async (tables, append) => {
      const r = await fetch(`${base}/api/ops/restore-board`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ board: id, tables, append }),
      });
      if (!r.ok) die(`restore-board ${r.status}: ${await r.text()}`);
      return r.json();
    };
    // The board's tables first (that empties its files), then its file parts one at a time, so no request is huge.
    const part = await bc.unpackPart(key, await src.get(partKey(src, day, `boards/${id}`)));
    const main = await post(part.tables, false);
    let files = 0;
    for (const name of part.file_parts ?? []) {
      const fp = await bc.unpackPart(key, await src.get(`${src.prefix}${day}/boards/${name}`));
      files += (await post(fp.tables, true)).rows;
    }
    console.log(`${id} restored from ${day}: ${JSON.stringify(main)}, ${files} files from ${(part.file_parts ?? []).length} file parts`);
  } else if (cmd === "help" || cmd === "--help" || cmd === "") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n\n")[0].replace(/^\/\/ ?/gm, "").replace(/^#!.*\n/, ""));
  } else {
    die(`unknown command ${cmd}: keygen | list | night | part | d1-sql | restore-board (help for each: node scripts/backup.mjs help)`);
  }
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
