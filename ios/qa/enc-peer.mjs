// theo's side of an encrypted board, as a plain client (the CLI's scheme): registers a device key, waits for the
// phone's message, decrypts it, and answers "theo read: <text>", encrypted with the board key; then opens the phone's
// encrypted picture, says so ("theo opened <name> (a picture)") and sends an encrypted picture back (theo.png).
import zlib from "node:zlib";
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
// Files (docs/SPEC.md §16): a key each, 64 KB AES-GCM chunks with the nonce 0⁸ ‖ chunk index; the keys ride in x.
const chunkIv = (i) => { const iv = Buffer.alloc(12); iv.writeUInt32BE(i, 8); return iv; };
const decFile = (key, blob) => { const out = []; for (let i = 0, off = 0; off < blob.length; i++, off += 65552) { const c = blob.subarray(off, off + 65552); const d = createDecipheriv("aes-256-gcm", key, chunkIv(i)); d.setAuthTag(c.subarray(c.length - 16)); out.push(d.update(c.subarray(0, c.length - 16)), d.final()); } return Buffer.concat(out); };
const encFile = (plain) => { const key = randomBytes(32), parts = []; for (let i = 0; i === 0 || i * 65536 < plain.length; i++) { const c = createCipheriv("aes-256-gcm", key, chunkIv(i)); parts.push(c.update(plain.subarray(i * 65536, (i + 1) * 65536)), c.final(), c.getAuthTag()); } return { key, blob: Buffer.concat(parts) }; };
/** A small solid PNG (w×h, one colour), for theo's picture back to the phone. */
const png = (w, h) => { const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [40, 150, 90]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]); };
const seal = (key, epoch, text, x) => { const c = gcm(key, Buffer.from(text)), p = { v: 2, epoch, iv: c.iv, ct: c.out }; if (x) { const e = gcm(key, Buffer.from(JSON.stringify({ xv: 1, ...x }))); p.x = { iv: e.iv, ct: e.out }; } return JSON.stringify(p); };
const done = new Set();
for (let i = 0; i < 600; i++) {
  const st = await api(`/api/boards/${BOARD}/epochs`);
  const keys = new Map(st.mine.filter((g) => g.kid === me.kid).map((g) => [g.epoch, unwrap(g, me)]));
  const es = (await api(`/api/boards/${BOARD}/sealed?after=0`)).entries ?? [];
  for (const e of es) {
    const p = JSON.parse(e.payload);
    if (done.has(e.seq) || p.v !== 2 || !keys.has(p.epoch)) continue;
    const k = keys.get(p.epoch), text = ungcm(k, p.iv, p.ct).toString(), x = p.x ? JSON.parse(ungcm(k, p.x.iv, p.x.ct).toString()) : {};
    if (text.startsWith("hello encrypted")) {
      done.add(e.seq);
      const r = await api(`/api/boards/${BOARD}/sealed`, { payload: seal(keys.get(st.current), st.current, `theo read: ${text}`) });
      console.log("decrypted:", text, "→ replied", r.ok ? "ok" : JSON.stringify(r));
    } else if (x.files?.length && !text.startsWith("theo")) {
      // The phone's picture: fetch the ciphertext, decrypt it here, say what it was, and send one back.
      done.add(e.seq);
      const f = x.files[0];
      const blob = Buffer.from(await (await fetch(`${BASE}/api/boards/${BOARD}/sealed-files/${f.id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).arrayBuffer());
      const plain = decFile(Buffer.from(f.key, "base64"), blob);
      const isPng = (plain.subarray(1, 4).toString() === "PNG" || plain.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) && plain.length === f.size; // the phone sends photos as JPEG
      await api(`/api/boards/${BOARD}/sealed`, { payload: seal(keys.get(st.current), st.current, `theo opened ${f.name}${isPng ? " (a picture)" : " (unreadable)"}`) });
      const pic = png(48, 32), { key, blob: out } = encFile(pic);
      const up = await (await fetch(`${BASE}/api/boards/${BOARD}/sealed-files`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" }, body: out })).json();
      const r = await api(`/api/boards/${BOARD}/sealed`, { payload: seal(keys.get(st.current), st.current, "theo's picture", { files: [{ id: up.id, name: "theo.png", mime: "image/png", size: pic.length, key: key.toString("base64"), chunk: 65536, w: 48, h: 32 }] }), files: [up.id] });
      console.log("opened", f.name, isPng ? "ok" : "BAD", "→ sent theo.png", r.ok ? "ok" : JSON.stringify(r));
      process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("timed out"); process.exit(1);
