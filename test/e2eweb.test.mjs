import { describe, expect, it } from "vitest";
import { createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createDecipheriv } from "node:crypto";
import { CLIENT_SCAN_JS } from "../src/clientScan";
import { E2E_JS, SIGN_OUT_JS, signedOutPage } from "../src/e2eweb";
import { decryptV2, encryptV2, newEpochKey, seal, wrapKey } from "../cli/src/sealed";
import { BOARD_JS, boardPage, boardTail } from "../src/html";

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
    // The shared board script comes from /board.js: put it back inline to read the page's scripts whole.
    const html = (await boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false }, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], [], []).text()).replace(/<script src="\/board\.js\?v=[^"]+"[^>]*><\/script>/, () => `<script>${BOARD_JS}</script>`).replace(/<script src="\/board-tail\.js\?f=([01]{4})(?:&amp;|&)v=[^"]+"[^>]*><\/script>/, (_, f) => `<script>${boardTail(f).js}</script>`);
    const js = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    expect(js).toContain("window.e2eSync=");
    for (const s of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
    expect(js).toContain("function draftSave(k,v){if(BC.encrypted)return;");
    expect(js).toContain('"encrypted":true');
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

describe("search on an encrypted board happens on the device", async () => {
  const { searchEntries, grepEntries } = await import("../src/localSearch");
  // The browser's search (e2eweb.ts), lifted out of the page script, given an index directly.
  const webSearch = (entries) => {
    const window = {};
    new Function("window", "ME", "BOARD", `${pick("// ---- on-device search", "// ---- writing")}\nIDX_FULL=Promise.resolve(new Map(arguments[3].map(e=>[e.seq,e])));`)(window, "ann", "b_x", entries);
    return window.e2eSearch;
  };
  const E = (seq, text, o = {}) => ({ seq, ts: 1_700_000_000_000 + seq, author: o.author ?? "ann", via: o.via ?? null, type: o.type ?? "note", text });
  const entries = [
    E(1, "Deploy the checkout service on Friday"),
    E(2, "The CHECKOUT bug: refunds double-count", { author: "bob", via: "agent" }),
    E(3, "prechecking isn't a match for checkout"),
    E(4, "Café opening hours are posted", { type: "decision" }),
    E(5, "x".repeat(120) + " checkout " + "y".repeat(200)),
    E(6, "checkout checkout refunds", { author: "bob" }),
  ];
  it("every word starts a word (any case); best match first, then newest; snippets mark the words like the server's", async () => {
    const hits = searchEntries(entries, "checkout");
    expect(hits.map((h) => h.seq)).toEqual([6, 5, 3, 2, 1]);
    expect(hits[0].snippet).toBe("«checkout» «checkout» refunds");
    expect(hits.find((h) => h.seq === 2).snippet).toContain("«CHECKOUT»");
    expect(hits.find((h) => h.seq === 5).snippet).toMatch(/^… x+ «checkout» y+ …$/);
    expect(searchEntries(entries, "checkout refunds").map((h) => h.seq)).toEqual([6, 2]);
    expect(searchEntries(entries, "heck")).toEqual([]); // inside a word: no
    expect(searchEntries(entries, "café").map((h) => h.seq)).toEqual([4]);
  });
  it("filters by who, agent or person, and type; no words lists the newest", () => {
    expect(searchEntries(entries, "checkout", { from: "bob" }).map((h) => h.seq)).toEqual([6, 2]);
    expect(searchEntries(entries, "checkout", { from: "bob", agent: true }).map((h) => h.seq)).toEqual([2]);
    expect(searchEntries(entries, "", { type: "decision" }).map((h) => h.seq)).toEqual([4]);
  });
  it("the browser's search answers exactly as the CLI's", async () => {
    const web = webSearch(entries);
    for (const [q, o] of [["checkout", {}], ["checkout refunds", {}], ["CAFÉ", {}], ["", { from: "bob" }], ["checkout", { from: "bob", agent: false }], ["nothing", {}]])
      expect((await web(q, o)).entries, q).toEqual(searchEntries(entries, q, o));
  });
  it("grep: literal or regex lines, newest message first, each line once", () => {
    const g = grepEntries([E(1, "a: one\nb: two\na: one"), E(2, "a.b literal\nab")], "a.b");
    expect(g.map((h) => [h.seq, h.line, h.text])).toEqual([[2, 1, "a.b literal"]]);
    expect(grepEntries([E(1, "a: one\nb: two\na: one")], "^a:", { regex: true }).map((h) => h.line)).toEqual([1]);
    expect(grepEntries([E(1, "Hello")], "hello", { caseSensitive: true })).toEqual([]);
    expect(() => grepEntries([], "(", { regex: true })).toThrow(/valid regular expression/);
  });
});

describe("the client screen on an encrypted board page", () => {
  it("blocks a credential before encrypting, and badges instruction-like text it opens", () => {
    expect(E2E_JS).toContain("{const no=scanRefusal(text);if(no){toast(no);return}}");
    expect(E2E_JS).toContain("async function encPost(text,type,reply_to,tries){tries=tries||0;{const no=scanRefusal(text);if(no)throw new Error(no)}");
    expect(E2E_JS).toContain("flagShow(en,r.text)");
  });
  it("fails closed: without the scan's rules nothing is sent (review #5551 item 5)", () => {
    const line = E2E_JS.split("\n").find((l) => l.startsWith("function scanRefusal("));
    const refusal = (w) => new Function("window", "tr", `${line}\nreturn scanRefusal;`)(w, (s) => s);
    const scan = {};
    new Function("window", CLIENT_SCAN_JS)(scan);
    expect(refusal({})("hello")).toMatch(/couldn't check the message for secrets, so nothing was encrypted or sent/);
    expect(refusal({ atteoScan: {} })("hello")).toMatch(/couldn't check/);
    // the real rules: fine text passes, a credential doesn't
    expect(refusal(scan)("hello")).toBeNull();
    expect(refusal(scan)("AKIAABCDEFGHIJKLMNOP")).toMatch(/^Blocked: this looks like it contains an AWS access key.*Caught in this browser/);
  });
  it("is on encrypted board pages only", () => {
    expect(boardTail("0100").js).toContain("g.atteoScan=");
    expect(boardTail("0000").js).not.toContain("g.atteoScan=");
  });
});

describe("the search index's lifetime (review #5551 item 7)", () => {
  // The page's index code with a fake IndexedDB store, a fake board key epoch and identity "encryption".
  const page = ({ epoch = 2, store = new Map(), boards = ["b_x"] } = {}) => {
    const window = {};
    const req = (result) => ({ result });
    const fake = { get: (k) => req(store.get(k)), put: (v, k) => (store.set(k, v), req(k)), delete: (k) => (store.delete(k), req(undefined)), getAllKeys: () => req([...store.keys()]) };
    const idbDo = async (_mode, f) => f(fake).result;
    const api = async (_m, path) => (path === "/api/me/boards" ? { boards: boards.map((id) => ({ id })) } : { entries: [] });
    const S = { generateKey: async () => ({ k: 1 }) };
    const gcm = async (_k, bytes) => ({ iv: "iv", ct: bytes });
    const ungcm = async (_k, _iv, ct) => ct;
    const f = new Function("window", "ME", "BOARD", "idbDo", "api", "S", "gcm", "ungcm", "te", "td", "openOne", "EPOCH",
      `let ST=null;const epochKeys=async()=>(ST={current:EPOCH});\n${pick("// ---- on-device search", "// ---- writing")}\nreturn {idxLoad,idxSave,idxSweep,set:(m)=>{IDX=m}};`);
    return { window, store, ...f(window, "ann", "b_x", idbDo, api, S, gcm, ungcm, new TextEncoder(), new TextDecoder(), async () => ({ text: null }), epoch) };
  };
  const rec = (epoch) => ({ iv: "iv", ct: new TextEncoder().encode(JSON.stringify([{ seq: 1, ts: 1, author: "bob", via: null, type: "note", text: "hello" }])), epoch });

  it("keeps an index made under the current board key", async () => {
    const p = page({ epoch: 2, store: new Map([["index:ann:b_x", rec(2)]]) });
    expect((await p.idxLoad()).size).toBe(1);
  });

  it("drops one made under an older key (someone left or was removed), to rebuild", async () => {
    const p = page({ epoch: 3, store: new Map([["index:ann:b_x", rec(2)]]) });
    expect((await p.idxLoad()).size).toBe(0);
    expect(p.store.has("index:ann:b_x")).toBe(false);
  });

  it("saves under the current key's epoch", async () => {
    const p = page({ epoch: 4 });
    await p.idxLoad();
    p.set(new Map([[1, { seq: 1, text: "x" }]]));
    await p.idxSave();
    expect(p.store.get("index:ann:b_x").epoch).toBe(4);
  });

  it("leaving drops this board's index", async () => {
    const p = page({ store: new Map([["index:ann:b_x", rec(2)], ["index:ann:b_y", rec(1)], ["index-key:ann", {}]]) });
    await p.window.e2eForget();
    expect([...p.store.keys()]).toEqual(["index:ann:b_y", "index-key:ann"]);
  });

  it("a board you're no longer on loses its index the next time any encrypted board opens", async () => {
    const p = page({ boards: ["b_x"], store: new Map([["index:ann:b_x", rec(2)], ["index:ann:b_gone", rec(1)], ["index:cat:b_other", rec(1)], ["device", {}]]) });
    await p.idxSweep();
    expect([...p.store.keys()]).toEqual(["index:ann:b_x", "index:cat:b_other", "device"]);
    const partial = page({ boards: ["b_q"], store: new Map([["index:ann:b_gone", rec(1)]]) });
    await partial.idxSweep();
    expect(partial.store.has("index:ann:b_gone")).toBe(true); // a list without this very board isn't trusted
  });

  it("signing out clears every index and the index key, keeps the device key, and goes home", async () => {
    const res = signedOutPage("s=; Max-Age=0", { nonce: "n0nce", headers: { "content-security-policy": "x" } });
    const html = await res.text();
    expect(res.headers.get("set-cookie")).toBe("s=; Max-Age=0");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain('<script nonce="n0nce">');
    expect(html).toContain(SIGN_OUT_JS);
    // Run it against a fake IndexedDB.
    const store = new Map([["index:ann:b_x", 1], ["index-key:ann", 2], ["device-key", 3], ["device:ann", 4]]);
    let went = null;
    const tx = { objectStore: () => ({ getAllKeys() { const q = { result: [...store.keys()] }; setTimeout(() => { q.onsuccess(); setTimeout(() => tx.oncomplete(), 0); }, 0); return q; }, delete: (k) => store.delete(k) }) };
    const indexedDB = { open() { const r = { result: { transaction: () => tx, close() {} } }; setTimeout(() => r.onsuccess(), 0); return r; } };
    new Function("indexedDB", "location", SIGN_OUT_JS)(indexedDB, { replace: (u) => (went = u) });
    await new Promise((r) => setTimeout(r, 20));
    expect([...store.keys()]).toEqual(["device-key", "device:ann"]);
    expect(went).toBe("/");
  });
});
