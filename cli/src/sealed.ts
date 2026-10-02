// Sealed secrets, end to end. Each machine's CLI has an X25519 keypair (private key in the OS keychain, or a file only
// you can read); the server knows only public keys. Sealing encrypts a random content key to every key the recipient
// (and you) have: X25519 → HKDF-SHA256 → AES-256-GCM. The server stores the envelope and never sees the plaintext.

import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, createDecipheriv, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface Envelope {
  v: 1;
  alg: "x25519-hkdf-sha256-aes256gcm";
  recipients: { kid: string; epk: string; iv: string; wrapped: string }[];
  iv: string;
  ct: string;
}

const SERVICE = "agent-board-seal-key";
const b64u2b64 = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
const b642b64u = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function has(cmd: string): boolean {
  try {
    execFileSync(platform() === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Where this machine's private key lives: next to a test credentials file, the keychain, or a 0600 file. */
function keyFile(): string | null {
  const cred = process.env.AGENT_BOARD_CREDENTIALS_FILE;
  if (cred) return `${cred}.sealkey`;
  if ((platform() === "darwin" && has("security")) || (platform() === "linux" && has("secret-tool"))) return null;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-board", "seal-key.json");
}

function loadJwk(): { d: string; x: string } | null {
  const f = keyFile();
  try {
    if (f) return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
    if (platform() === "darwin") return JSON.parse(execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", "default", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
    const out = execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", "default"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

function saveJwk(jwk: { d: string; x: string }) {
  const json = JSON.stringify(jwk);
  const f = keyFile();
  if (f) {
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f, json, { mode: 0o600 });
    chmodSync(f, 0o600);
  } else if (platform() === "darwin") execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", "default", "-w", json], { stdio: "ignore" });
  else execFileSync("secret-tool", ["store", "--label=Agent Soup sealing key", "service", SERVICE, "account", "default"], { input: json, stdio: ["pipe", "ignore", "ignore"] });
}

/** This machine's keypair (created the first time). Returns the private key and the public key as base64. */
export function myKey(): { priv: KeyObject; pub: string } {
  let jwk = loadJwk();
  if (!jwk) {
    const { privateKey } = generateKeyPairSync("x25519");
    const j = privateKey.export({ format: "jwk" }) as { d: string; x: string };
    jwk = { d: j.d, x: j.x };
    saveJwk(jwk);
  }
  return { priv: createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: jwk.d, x: jwk.x }, format: "jwk" }), pub: b64u2b64(jwk.x) };
}

const pubKey = (b64: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b642b64u(b64) }, format: "jwk" });

function kek(shared: Buffer, epk: string, rpk: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([Buffer.from(epk, "base64"), Buffer.from(rpk, "base64")]), "agent-soup seal v1", 32));
}

function gcm(key: Buffer, data: Buffer): { iv: string; out: string } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const out = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64"), out: out.toString("base64") };
}

function ungcm(key: Buffer, iv: string, data: string): Buffer {
  const raw = Buffer.from(data, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
}

export function seal(plaintext: Buffer, recipients: { id: string; public_key: string }[]): Envelope {
  if (!recipients.length) throw new Error("No keys to seal to.");
  const content = randomBytes(32);
  const body = gcm(content, plaintext);
  return {
    v: 1,
    alg: "x25519-hkdf-sha256-aes256gcm",
    iv: body.iv,
    ct: body.out,
    recipients: recipients.map((r) => {
      const eph = generateKeyPairSync("x25519");
      const epk = b64u2b64((eph.publicKey.export({ format: "jwk" }) as { x: string }).x);
      const w = gcm(kek(diffieHellman({ privateKey: eph.privateKey, publicKey: pubKey(r.public_key) }), epk, r.public_key), content);
      return { kid: r.id, epk, iv: w.iv, wrapped: w.out };
    }),
  };
}

export function unseal(env: Envelope, myKid: string | null): Buffer {
  const { priv, pub } = myKey();
  const tries = myKid ? env.recipients.filter((r) => r.kid === myKid) : env.recipients;
  for (const r of tries.length ? tries : env.recipients) {
    try {
      const content = ungcm(kek(diffieHellman({ privateKey: priv, publicKey: pubKey(r.epk) }), r.epk, pub), r.iv, r.wrapped);
      return ungcm(content, env.iv, env.ct);
    } catch {}
  }
  throw new Error("This machine's key can't open it. It was sealed before this machine's key was set up, or for someone else.");
}
