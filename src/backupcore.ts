// Off-Cloudflare backups (#1550): what the Worker, the Board object and scripts/backup.mjs share. It imports nothing,
// so Node runs this file as is (type stripping) when restoring from the bucket.
//
// A part (D1, one board, the night's manifest) is JSON → gzip → sealed to the backup public key (X25519 → HKDF-SHA256 →
// AES-256-GCM, a fresh ephemeral key per part) → PUT to an S3-compatible bucket outside Cloudflare (Backblaze B2, S3)
// with AWS Signature V4. The Worker holds only the public key and a write-only bucket key, so it can write backups
// but never read them back; the private key lives offline with the operators.

export interface S3Config {
  endpoint: string; // https://s3.us-west-004.backblazeb2.com
  bucket: string;
  region: string; // us-west-004, us-east-1…
  keyId: string;
  secret: string;
  prefix: string; // "atteo/": every object's key starts with it
  virtualHost?: boolean; // bucket.host/key instead of host/bucket/key
}

/** A table dumped as column names plus rows of values; a BLOB value is {$b64: "…"}. */
export type DumpValue = string | number | null | { $b64: string };
export interface DumpTable {
  columns: string[];
  rows: DumpValue[][];
}
export type DumpTables = Record<string, DumpTable>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

/** A SQLite value as JSON: blobs become {$b64}. */
export function encodeValue(v: unknown): DumpValue {
  if (v == null) return null;
  if (v instanceof ArrayBuffer) return { $b64: b64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $b64: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (typeof v === "bigint") return Number(v);
  return v as string | number;
}
export function decodeValue(v: DumpValue): string | number | null | ArrayBuffer {
  if (v && typeof v === "object") {
    const u = unb64(v.$b64);
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  }
  return v;
}

/** One table as SQL INSERTs (restoring D1 with `wrangler d1 execute --file`). */
export function tableToSql(name: string, t: DumpTable): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lit = (v: DumpValue) =>
    v == null ? "NULL" : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "NULL") : typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : `X'${hex(unb64(v.$b64))}'`;
  const cols = t.columns.map(q).join(", ");
  return t.rows.map((r) => `INSERT INTO ${q(name)} (${cols}) VALUES (${r.map(lit).join(", ")});\n`).join("");
}

// ---- compression ----

/** Runs pieces through a (de)compression stream, read as it's written: the input is never copied into one more buffer. */
async function pipe(pieces: Iterable<Uint8Array>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(stream.readable).arrayBuffer();
  const w = stream.writable.getWriter();
  try {
    for (const p of pieces) await w.write(p);
    await w.close();
  } catch (e) {
    await out; // the stream's own error (bad gzip) says more than the writer's
    throw e;
  }
  return new Uint8Array(await out);
}
export const gzip = (data: Uint8Array) => pipe([data], new CompressionStream("gzip"));
export const gunzip = (data: Uint8Array) => pipe([data], new DecompressionStream("gzip"));

/** Text pieces → gzip, encoded about 64 KB at a time, so a part's JSON never exists as one string or one byte array. */
export function gzipText(pieces: Iterable<string>): Promise<Uint8Array> {
  function* bytes() {
    let buf = "";
    for (const p of pieces) {
      buf += p;
      if (buf.length >= 65_536) {
        yield enc.encode(buf);
        buf = "";
      }
    }
    if (buf) yield enc.encode(buf);
  }
  return pipe(bytes(), new CompressionStream("gzip"));
}

/** A string's UTF-8 length without encoding it. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) (n += 4), i++; // a surrogate pair
    else n += 3;
  }
  return n;
}

// ---- sealing: X25519 → HKDF-SHA256 → AES-256-GCM ----

const MAGIC = "atteo-backup-v1\n";
const INFO = enc.encode("atteo-backup-v1");
const ALG = "x25519-hkdf-sha256-aes256gcm";

/** Short id of a public key (the first 8 bytes of its SHA-256), so a restore can say which key a file needs. */
export async function keyId(publicKeyB64: string): Promise<string> {
  return (await sha256Hex(unb64(publicKeyB64))).slice(0, 16);
}

async function aesKey(shared: ArrayBuffer, epk: Uint8Array, use: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: epk, info: INFO }, hk, { name: "AES-GCM", length: 256 }, false, [use]);
}

/** Encrypts to the backup public key (raw 32-byte X25519, base64): magic line, JSON header line, then ciphertext. */
export async function seal(publicKeyB64: string, plain: Uint8Array): Promise<Uint8Array> {
  const recipient = await crypto.subtle.importKey("raw", unb64(publicKeyB64), { name: "X25519" }, false, []);
  const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: recipient } as { name: "X25519"; public: CryptoKey }, eph.privateKey, 256);
  const epk = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(shared, epk, "encrypt"), plain));
  const head = enc.encode(MAGIC + JSON.stringify({ alg: ALG, kid: await keyId(publicKeyB64), epk: b64(epk), iv: b64(iv) }) + "\n");
  const out = new Uint8Array(head.length + ct.length);
  out.set(head);
  out.set(ct, head.length);
  return out;
}

/** The header of a sealed file (which key it needs), without decrypting. */
export function sealedHeader(data: Uint8Array): { alg: string; kid: string; epk: string; iv: string; body: Uint8Array } {
  const m = enc.encode(MAGIC);
  if (dec.decode(data.subarray(0, m.length)) !== MAGIC) throw new Error("not an Atteo backup file");
  const nl = data.indexOf(10, m.length);
  if (nl < 0) throw new Error("backup file has no header");
  const h = JSON.parse(dec.decode(data.subarray(m.length, nl))) as { alg: string; kid: string; epk: string; iv: string };
  if (h.alg !== ALG) throw new Error(`unknown backup algorithm ${h.alg}`);
  return { ...h, body: data.subarray(nl + 1) };
}

/** Decrypts with the backup private key (an X25519 CryptoKey, e.g. imported from PKCS#8). */
export async function open(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const h = sealedHeader(data);
  const epk = unb64(h.epk);
  const pub = await crypto.subtle.importKey("raw", epk, { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub } as { name: "X25519"; public: CryptoKey }, privateKey, 256);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(h.iv) }, await aesKey(shared, epk, "decrypt"), h.body));
}

/** JSON → gzip → sealed bytes, and back. */
export async function packPart(publicKeyB64: string, value: unknown): Promise<Uint8Array> {
  return seal(publicKeyB64, await gzip(enc.encode(JSON.stringify(value))));
}
/** The same sealed format from JSON text already in pieces (a board's table parts: one piece per row). */
export async function packText(publicKeyB64: string, pieces: Iterable<string>): Promise<Uint8Array> {
  return seal(publicKeyB64, await gzipText(pieces));
}
/** A table part's JSON in pieces, the same as JSON.stringify({...head, tables: {[table]: {columns, rows}}}) with each
 *  row already JSON. */
export function* tablePartText(head: Record<string, unknown>, table: string, columns: string[], rowsJson: string[]): Generator<string> {
  yield `${JSON.stringify(head).slice(0, -1)},"tables":{${JSON.stringify(table)}:{"columns":${JSON.stringify(columns)},"rows":[`;
  for (let i = 0; i < rowsJson.length; i++) yield i ? `,${rowsJson[i]}` : rowsJson[i];
  yield "]}}}";
}
export async function unpackPart<T = unknown>(privateKey: CryptoKey, data: Uint8Array): Promise<T> {
  return JSON.parse(dec.decode(await gunzip(await open(privateKey, data)))) as T;
}

// ---- S3 (AWS Signature Version 4), enough for PUT, GET and ListObjectsV2 ----

async function hmac(key: Uint8Array | ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

/** RFC 3986 percent-encoding as SigV4 wants it ('/' kept in paths only). */
function uriEncode(s: string, keepSlash: boolean): string {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? e.replace(/%2F/g, "/") : e;
}

const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The URL and signed headers for one request to `key` (empty key: the bucket itself). */
export async function signS3(
  cfg: S3Config,
  method: string,
  key: string,
  opts: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string>; now?: Date } = {},
): Promise<{ url: string; headers: Record<string, string> }> {
  const base = new URL(cfg.endpoint);
  const host = cfg.virtualHost ? `${cfg.bucket}.${base.host}` : base.host;
  const path = (cfg.virtualHost ? "/" : `/${uriEncode(cfg.bucket, false)}/`) + uriEncode(key, true);
  const query = Object.entries(opts.query ?? {})
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const date = amzDate(opts.now ?? new Date());
  const payload = await sha256Hex(opts.body ?? new Uint8Array());
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host, "x-amz-content-sha256": payload, "x-amz-date": date };
  const names = Object.keys(headers).sort();
  const canonical = [method, path, query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payload].join("\n");
  const scope = `${date.slice(0, 8)}/${cfg.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonical)].join("\n");
  let k: ArrayBuffer = await hmac(enc.encode("AWS4" + cfg.secret), date.slice(0, 8));
  for (const part of [cfg.region, "s3", "aws4_request"]) k = await hmac(k, part);
  const signature = hex(await hmac(k, toSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete headers.host; // fetch sets it from the URL
  return { url: `${base.protocol}//${host}${path}${query ? `?${query}` : ""}`, headers };
}

async function s3(cfg: S3Config, method: string, key: string, opts: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
  const { url, headers } = await signS3(cfg, method, key, opts);
  const r = await fetch(url, { method, headers, body: opts.body });
  if (!r.ok) throw new Error(`S3 ${method} ${key || "/"}: ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
  return r;
}

export async function putObject(cfg: S3Config, key: string, body: Uint8Array): Promise<void> {
  await (await s3(cfg, "PUT", key, { body, headers: { "content-type": "application/octet-stream" } })).arrayBuffer();
}

export async function getObject(cfg: S3Config, key: string): Promise<Uint8Array> {
  return new Uint8Array(await (await s3(cfg, "GET", key)).arrayBuffer());
}

/** Every key under `prefix` (ListObjectsV2, following continuation tokens). */
export async function listObjects(cfg: S3Config, prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  do {
    const xml = await (await s3(cfg, "GET", "", { query: { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) } })).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
      if (key) out.push({ key: unxml(key), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0) });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    if (token) token = unxml(token);
  } while (token);
  return out;
}
