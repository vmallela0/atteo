import { describe, expect, it } from "vitest";
import { createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createDecipheriv } from "node:crypto";
import { E2E_JS } from "../src/e2eweb";
import { decryptV2, encryptV2, newEpochKey, seal, wrapKey } from "../cli/src/sealed";
import { boardPage } from "../src/html";

// A .mjs test: it runs the CLI's Node crypto (cli/src/sealed.ts), which the Workers tsconfig doesn't type.
// The browser's crypto, lifted out of the page script and run on Node's WebCrypto, against the CLI's implementation.
const lines = E2E_JS.split("\n");
const pick = (start, end) => lines.slice(lines.findIndex((l) => l.startsWith(start)), lines.findIndex((l) => l.startsWith(end))).join("\n");
const pre = lines.filter((l) => /^const (b64|unb64|cat)=/.test(l)).join("\n");
const web = new Function(
  `${lines.find((l) => l.startsWith("const S=crypto.subtle"))}\n${pre}\n${pick("// ---- crypto", "// ---- this browser")}\nreturn {kek,gcm,ungcm,aesKey,wrapFor,unwrapMine,b64};`,
)();
const S = globalThis.crypto.subtle;
const webDevice = async () => {
  const k = await S.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  return { priv: k.privateKey, pub: web.b64(await S.exportKey("raw", k.publicKey)) };
};
const nodeDevice = () => {
  const k = generateKeyPairSync("x25519");
  const x = k.publicKey.export({ format: "jwk" }).x;
  return { priv: k.privateKey, pub: Buffer.from(x, "base64url").toString("base64") };
};
const nodeUnwrap = (g, d, info = "agent-soup board key v2") => {
  const pub = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(g.epk, "base64").toString("base64url") }, format: "jwk" });
  const kek = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: d.priv, publicKey: pub }), Buffer.concat([Buffer.from(g.epk, "base64"), Buffer.from(d.pub, "base64")]), info, 32));
  const raw = Buffer.from(g.wrapped, "base64");
  const dc = createDecipheriv("aes-256-gcm", kek, Buffer.from(g.iv, "base64"));
  dc.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([dc.update(raw.subarray(0, raw.length - 16)), dc.final()]);
};

describe("encryption v2 in the browser matches the CLI", () => {
  it("a key the CLI wraps for a browser device unwraps in the browser, and messages go both ways", async () => {
    const dev = await webDevice();
    const key = newEpochKey();
    const raw = await web.unwrapMine(wrapKey(key, dev.pub), dev);
    expect(Buffer.from(raw).equals(key)).toBe(true);
    const aes = await web.aesKey(raw);
    const fromCli = encryptV2(key, Buffer.from("hello from the CLI ✓"));
    expect(new TextDecoder().decode(await web.ungcm(aes, fromCli.iv, fromCli.ct))).toBe("hello from the CLI ✓");
    const fromWeb = await web.gcm(aes, new TextEncoder().encode("hello from the web ✓"));
    expect(decryptV2(key, fromWeb.iv, fromWeb.ct).toString()).toBe("hello from the web ✓");
  });
  it("a key the browser wraps for a CLI device unwraps there (and only there)", async () => {
    const d = nodeDevice(), other = nodeDevice();
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const g = await web.wrapFor(key, d.pub);
    expect(g.epk).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(g.iv, "base64").length).toBe(12);
    expect(Buffer.from(g.wrapped, "base64").length).toBe(48);
    expect(nodeUnwrap(g, d).equals(Buffer.from(key))).toBe(true);
    expect(() => nodeUnwrap(g, other)).toThrow();
  });
  it("opens a v1 envelope the CLI sealed to the browser's key", async () => {
    const dev = await webDevice();
    const env = seal(Buffer.from("old secret"), [{ id: "abc12345", public_key: dev.pub }]);
    const content = await web.unwrapMine(env.recipients[0], dev, "agent-soup seal v1");
    expect(new TextDecoder().decode(await web.ungcm(await web.aesKey(content), env.iv, env.ct))).toBe("old secret");
  });
  it("a tampered message or wrapped key is refused", async () => {
    const dev = await webDevice();
    const key = newEpochKey();
    const g = wrapKey(key, dev.pub);
    const bad = { ...g, wrapped: Buffer.from(Buffer.from(g.wrapped, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
    await expect(web.unwrapMine(bad, dev)).rejects.toThrow();
    const m = encryptV2(key, Buffer.from("x"));
    const aes = await web.aesKey(key);
    await expect(web.ungcm(aes, m.iv, Buffer.from(Buffer.from(m.ct, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64"))).rejects.toThrow();
  });
});

describe("encrypted board page", () => {
  it("its script (with the encryption part) compiles, and keeps the plaintext out of drafts", async () => {
    const info = { id: "b_enc12345", title: "Secret", created_by: "jxn", created_at: 0, entry_count: 0, last_seq: 0, encrypted: true };
    const html = await boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], [], []).text();
    const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    expect(js).toContain("window.e2eSync=");
    for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
    expect(js).toContain("function draftSave(k,v){if(true)return;");
    expect(html).toContain('id="e2e-msg"');
  });
});

describe("pins (which devices this browser wraps keys to)", () => {
  const pinsJs = new Function(`${pick("// A pin is a device id", "// ---- end pins")}\nreturn {pinUpdate,isPinned,pinId};`)();
  const K = (c) => c.repeat(43) + "="; // a public key, base64
  const st = (keys, missing = []) => ({ keys, missing });
  it("hold the device id and its public key: you, and each person's first device seen", () => {
    const pin = pinsJs.pinUpdate({}, "ann", { kid: "web1", pub: K("A") }, st([{ kid: "web1", user: "ann", public_key: K("A") }, { kid: "bob1", user: "bob", public_key: K("B") }, { kid: "bob2", user: "bob", public_key: K("C") }]));
    expect(pin).toEqual({ ann: [`web1|${K("A")}`], bob: [`bob1|${K("B")}`] });
    expect(pinsJs.isPinned(pin, { kid: "bob1", user: "bob", public_key: K("B") })).toBe(true);
    expect(pinsJs.isPinned(pin, { kid: "bob2", user: "bob", public_key: K("C") })).toBe(false); // Bob's later device: only Bob's own devices
  });
  it("a pinned device id with a different public key is not trusted (the server can't swap keys under a trusted id)", () => {
    const pin = { ann: [`web1|${K("A")}`], bob: [`bob1|${K("B")}`] };
    const after = pinsJs.pinUpdate(structuredClone(pin), "ann", { kid: "web1", pub: K("A") }, st([{ kid: "bob1", user: "bob", public_key: K("Z") }]));
    expect(after.bob).toEqual([`bob1|${K("B")}`]); // not re-pinned to the new key
    expect(pinsJs.isPinned(after, { kid: "bob1", user: "bob", public_key: K("Z") })).toBe(false);
  });
  it("older pins (ids alone) are bound to the key the server shows the next time they're seen", () => {
    const after = pinsJs.pinUpdate({ ann: ["web1"], bob: ["bob1", "gone9"] }, "ann", { kid: "web1", pub: K("A") }, st([{ kid: "web1", user: "ann", public_key: K("A") }], [{ kid: "bob1", user: "bob", public_key: K("B"), first_device: false }]));
    expect(after).toEqual({ ann: [`web1|${K("A")}`], bob: [`bob1|${K("B")}`, "gone9"] });
    expect(pinsJs.isPinned(after, { kid: "gone9", user: "bob", public_key: K("Q") })).toBe(false); // a bare id never matches a key
  });
});
