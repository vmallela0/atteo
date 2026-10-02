// theo's side of an encrypted board, as a plain client (the CLI's scheme): registers a device key, waits for the
// phone's message, decrypts it, and answers "theo read: <text>", encrypted with the board key.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
const [BASE, TOKEN, BOARD] = process.argv.slice(2);
const b64u = (s) => s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
const device = () => { const k = generateKeyPairSync("x25519"); return { priv: k.privateKey, pub: b64u(k.publicKey.export({ format: "jwk" }).x) }; };
const pubKey = (b) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }, format: "jwk" });
const gcm = (key, data) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv); return { iv: iv.toString("base64"), out: Buffer.concat([c.update(data), c.final(), c.getAuthTag()]).toString("base64") }; };
const ungcm = (key, iv, data) => { const raw = Buffer.from(data, "base64"); const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64")); d.setAuthTag(raw.subarray(raw.length - 16)); return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]); };
const kek = (shared, epk, rpk) => Buffer.from(hkdfSync("sha256", shared, Buffer.concat([Buffer.from(epk, "base64"), Buffer.from(rpk, "base64")]), "agent-soup board key v2", 32));
const unwrap = (g, d) => ungcm(kek(diffieHellman({ privateKey: d.priv, publicKey: pubKey(g.epk) }), g.epk, d.pub), g.iv, g.wrapped);
const api = async (path, body) => (await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
const me = device();
me.kid = (await api("/api/me/keys", { public_key: me.pub, label: "theo's laptop" })).id;
console.log("registered", me.kid);
for (let i = 0; i < 600; i++) {
  const st = await api(`/api/boards/${BOARD}/epochs`);
  const keys = new Map(st.mine.filter((g) => g.kid === me.kid).map((g) => [g.epoch, unwrap(g, me)]));
  const es = (await api(`/api/boards/${BOARD}/sealed?after=0`)).entries ?? [];
  for (const e of es) {
    const p = JSON.parse(e.payload);
    if (p.v !== 2 || !keys.has(p.epoch)) continue;
    const text = ungcm(keys.get(p.epoch), p.iv, p.ct).toString();
    if (!text.startsWith("hello encrypted")) continue;
    const c = gcm(keys.get(st.current), Buffer.from(`theo read: ${text}`));
    const r = await api(`/api/boards/${BOARD}/sealed`, { payload: JSON.stringify({ v: 2, epoch: st.current, iv: c.iv, ct: c.out }) });
    console.log("decrypted:", text, "→ replied", r.ok ? "ok" : JSON.stringify(r));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("timed out"); process.exit(1);
