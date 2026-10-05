#!/usr/bin/env node
// Off-Cloudflare backups (#1550, docs/BACKUPS.md): the operator side. The bucket credentials, the day and the private
// key come as flags or the same-named environment variables; nothing here talks to Atteo except restore-board, which
// posts to a local Worker. The Worker holds only the public key and a write-only bucket key, so only this machine can
// read backups back.
//
//   node scripts/backup.mjs keygen [--out backup-key.json]
//       A backup key pair: prints the public key as a wrangler var; the private key file is yours to keep offline.
//   node scripts/backup.mjs list                          every object in the bucket (this key: read-only is fine)
//   node scripts/backup.mjs night <day>                   the whole night decrypted into ./backup-<day>/ (d1, boards, manifest)
//   node scripts/backup.mjs part <day> <part>             one part decrypted to stdout (d1 | boards/<id> | manifest)
//   node scripts/backup.mjs d1-sql <day> [--out file.sql] the night's D1 as SQL for `wrangler d1 execute` (the drill's step 1)
//   node scripts/backup.mjs restore-board <day> <id> --base http://localhost:8787 [--admin-key k]
//       The drill's step 2: post the board's decrypted tables to POST /api/ops/restore-board on a local Worker.
//
// Flags: --endpoint --bucket --region --key-id --secret --prefix [--key backup-key.json] [--out file]
//        --base --admin-key  (endpoint/bucket/region/key-id/secret/prefix also come from BACKUP_S3_* in the environment)

import { webcrypto as crypto } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

const privKey = async () => {
  const path = flag("key") || "backup-key.json";
  if (!existsSync(path)) die(`no ${path}: make one with 'node scripts/backup.mjs keygen'`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  const pkcs8 = Buffer.from(j.private_key_b64 || j.private, "base64");
  return { key: await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]), kid: await bc.keyId(j.public_key ?? j.public) };
};

const night = async (cfg, day) => {
  const files = (await bc.listObjects(cfg, `${cfg.prefix}${day}/`)).filter((f) => f.key.endsWith(".json.gz.enc"));
  if (!files.length) die(`no backup objects under ${cfg.prefix}${day}/ (check the day, and the prefix)`);
  return files;
};

const partKey = (cfg, day, part) => `${cfg.prefix}${day}/${part}.json.gz.enc`;

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
    for (const f of await bc.listObjects(s3cfg(), flag("prefix") || "")) console.log(`${String(f.size).padStart(10)}  ${f.key}`);
  } else if (cmd === "night") {
    const day = positional()[0] || die("usage: night <YYYY-MM-DD>");
    const cfg = s3cfg();
    const { key } = await privKey();
    const files = await night(cfg, day);
    const dir = flag("out") || `backup-${day}`;
    for (const f of files) {
      const rel = f.key.slice(`${cfg.prefix}${day}/`.length).replace(/\.json\.gz\.enc$/, "");
      const v = await bc.unpackPart(key, await bc.getObject(cfg, f.key));
      writeFileSync(`${dir}/${rel.replace(/\//g, "_")}.json`, JSON.stringify(v, null, 1));
      console.log(`${f.key} -> ${dir}/${rel.replace(/\//g, "_")}.json`);
    }
    console.log(`${files.length} parts into ${dir}/`);
  } else if (cmd === "part") {
    const [day, part] = positional();
    if (!day || !part) die("usage: part <YYYY-MM-DD> <d1 | boards/<id> | manifest>");
    const { key } = await privKey();
    const v = await bc.unpackPart(key, await bc.getObject(s3cfg(), partKey(s3cfg(), day, part)));
    const out = flag("out");
    if (out) writeFileSync(out, JSON.stringify(v, null, 1));
    else console.log(JSON.stringify(v, null, 1));
  } else if (cmd === "d1-sql") {
    const day = positional()[0] || die("usage: d1-sql <YYYY-MM-DD> [--out file.sql]");
    const { key } = await privKey();
    const d1 = await bc.unpackPart(key, await bc.getObject(s3cfg(), partKey(s3cfg(), day, "d1")));
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
    const [day, id] = positional();
    if (!day || !id) die("usage: restore-board <YYYY-MM-DD> <board id> --base http://localhost:8787 [--admin-key k]");
    const base = need("base").replace(/\/$/, "");
    const { key } = await privKey();
    const part = await bc.unpackPart(key, await bc.getObject(s3cfg(), partKey(s3cfg(), day, `boards/${id}`)));
    const adminKey = flag("admin-key") || (readFileSync(".dev.vars", "utf8").match(/^ADMIN_KEY=(.*)$/m) || [])[1] || "";
    const r = await fetch(`${base}/api/ops/restore-board`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify({ board: id, tables: part.tables }),
    });
    if (!r.ok) die(`restore-board ${r.status}: ${await r.text()}`);
    console.log(`${id} restored from ${day}: ${JSON.stringify(await r.json())}`);
  } else if (cmd === "help" || cmd === "--help" || cmd === "") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n\n")[0].replace(/^\/\/ ?/gm, "").replace(/^#!.*\n/, ""));
  } else {
    die(`unknown command ${cmd}: keygen | list | night | part | d1-sql | restore-board (help for each: node scripts/backup.mjs help)`);
  }
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
