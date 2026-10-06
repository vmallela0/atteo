// E2E design §3.3 (Phase 1c): an encrypted board's invite link carries the board key after its "#". The inviter's browser
// makes a one-time invite key and wraps the epoch keys to it; whoever opens the link reads at once, with nobody else
// online, and everyone sees a 🔑 line saying how that device got the key. The server never sees the "#" part.
import { chromium } from "playwright-core";
import { d1Execute } from "./lib/d1.mjs";
const BASE = process.env.BASE || "http://localhost:8787", ADMIN = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": ADMIN, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), D = `dee${run}`, E = `eve${run}`;
for (const u of [D, E]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: D, title: `Invite key ${run}`, encrypted: true })).board.id;
let fails = 0;
const until = async (get, ok, ms = 10000) => { const t = Date.now(); for (;;) { const v = await get().catch(() => null); if ((v && ok(v)) || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 100)); } };
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const login = async (u) => { const ck = (await ops("sessions", { user: u })).cookie; const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]); return ctx; };
const errors = [];
const watch = (p) => { p.on("pageerror", (e) => errors.push(e.message)); if (process.env.DEBUG) p.on("console", (m) => console.log("console:", m.text())); };
const post = async (p, text) => { await p.locator("#composer-text").fill(text); await p.locator("form.composer button.primary").click(); };
const bodyOf = (p, text) => p.locator("#thread .entry .e2e-text", { hasText: text });
const ready = (p) => p.waitForFunction(() => !document.querySelector("form.composer").hidden, null, { timeout: 10000 }).catch(() => {});

// Dee opens the board (epoch 1 is opened for her browser), writes, and makes a "Can post" link.
const ctxD = await login(D); const pd = await ctxD.newPage(); watch(pd);
await pd.goto(`${BASE}/b/${board}`); await ready(pd);
const secret = `for eve's eyes ${run}`;
await post(pd, secret); await bodyOf(pd, secret).waitFor({ timeout: 8000 }).catch(() => {});
await pd.locator('[data-open="invite"]').first().click();
await pd.locator("#link-role").selectOption("contributor");
await pd.locator("#link-make").click();
await pd.locator("#link-url").waitFor({ timeout: 8000 }).catch(() => {});
const url = await pd.locator("#link-url").inputValue().catch(() => "");
check(/\/i\/il_[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]{43}$/.test(url), `the link carries a key after the # (${url.replace(/#k=.*/, "#k=…")})`);
check(await pd.locator("#link-new", { hasText: "carries the board key" }).count() === 1, "…and says so next to it");
await pd.close(); // nobody else is online when Eve opens it (the context keeps her browser's device key)

// Eve opens the link: the /i/ page moves the key out of the address bar, she joins, and her browser takes the key.
const ctxE = await login(E); const pe = await ctxE.newPage(); watch(pe);
const seen = [];
pe.on("request", (r) => seen.push(r));
await pe.goto(url);
await pe.waitForURL(new RegExp(`/b/${board}`), { timeout: 10000 }).catch(() => {});
check(new URL(pe.url()).pathname === `/b/${board}` && !pe.url().includes("#k="), `Eve lands on the board, the key gone from the address bar (${pe.url().replace(BASE, "")})`);
await bodyOf(pe, secret).waitFor({ timeout: 10000 }).catch(() => {});
check(await bodyOf(pe, secret).count() === 1, "…and reads the history at once, with nobody else online");
check(!seen.some((r) => r.url().includes(url.split("#k=")[1]) || (r.postData() || "").includes(url.split("#k=")[1])), "the key never went to the server in any request");
check(await pe.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("atteo.invite.")).length) === 0, "…and isn't kept in the browser once used");
await pe.locator("#thread .entry", { hasText: `${E} joined with an invite link that carries this board` }).first().waitFor({ timeout: 8000 }).catch(() => {});
check(await pe.locator("#thread .entry", { hasText: `${E} joined with an invite link that carries this board` }).count() === 1, "everyone sees the 🔑 line saying how Eve's device got the key");
await ready(pe);
const reply = `eve writes back ${run}`;
await post(pe, reply); await bodyOf(pe, reply).waitFor({ timeout: 8000 }).catch(() => {});
check(await bodyOf(pe, reply).count() === 1, "Eve (Can post) writes encrypted");
// Dee comes back and reads Eve's message.
const pd2 = await ctxD.newPage(); watch(pd2);
await pd2.goto(`${BASE}/b/${board}`);
await bodyOf(pd2, reply).waitFor({ timeout: 10000 }).catch(() => {});
check(await bodyOf(pd2, reply).count() === 1, "Dee reads what Eve wrote");
// Cross-signed device lists (E2E design §2.2): Eve's browser registered an Ed25519 signing key; approving her second
// browser there signs it, and Dee's browser pins it after checking the signature against Eve's pinned signing key.
const keysOf = (p) => p.evaluate(async () => (await (await fetch("/api/me/keys")).json()).keys);
const k1 = await keysOf(pe);
check(k1.length === 1 && /^[A-Za-z0-9+/]{43}=$/.test(k1[0].sign_pub || ""), "a browser registers an Ed25519 signing key with its device key");
const ctxE2 = await login(E); const pe2 = await ctxE2.newPage(); watch(pe2);
await pe2.goto(`${BASE}/b/${board}`);
const k2 = await until(() => keysOf(pe), (ks) => ks.length === 2);
const newKid = k2.find((k) => k.id !== k1[0].id)?.id;
await pe.reload();
await pe.locator(`[data-e2e-approve="${newKid}"]`).click({ timeout: 10000 }).catch(() => {});
const signedK = await until(() => keysOf(pe), (ks) => ks.some((k) => k.id === newKid && k.sig));
check(signedK.find((k) => k.id === newKid)?.signed_by === k1[0].id, "Approve signs the new browser into Eve's device list");
await pd2.reload();
const dPins = await until(() => pd2.evaluate((e) => JSON.parse(localStorage.getItem("soup.e2e.pins." + e.me) || "{}")[e.eve] || [], { me: D, eve: E }), (l) => l.some((x) => x.startsWith(newKid + "|")));
check(dPins.some((x) => x.startsWith(newKid + "|")), "Dee's browser checks the signature and trusts Eve's new browser");
await pd2.locator("#thread .entry", { hasText: `${E} added a device` }).first().waitFor({ timeout: 8000 }).catch(() => {});
check(await pd2.locator("#thread .entry", { hasText: `${E} added a device` }).count() === 1, "everyone sees the device change on the board");
await bodyOf(pe2, secret).waitFor({ timeout: 10000 }).catch(() => {});
check(await bodyOf(pe2, secret).count() === 1, "Eve's second browser reads");
// A server that shows Eve's browser with a signing key of its own: the browser says so.
await d1Execute(`--command ${JSON.stringify(`UPDATE agent_keys SET sign_pub = '${Buffer.alloc(32, 9).toString("base64")}' WHERE id = '${k1[0].id}'`)}`, { cwd: new URL("../../", import.meta.url).pathname });
await pe.reload();
await pe.locator("#e2e-msg", { hasText: "signing key that isn't this browser's" }).waitFor({ timeout: 8000 }).catch(() => {});
check(await pe.locator("#e2e-msg", { hasText: "signing key that isn't this browser's" }).count() === 1, "a browser shown with a signing key that isn't its own warns");
// Revoking the link drops the wrapped copies it carried.
const links = await pd2.evaluate(async (bd) => (await (await fetch(`/api/boards/${bd}/links`)).json()).links, board);
await pd2.evaluate(async ([bd, id]) => fetch(`/api/boards/${bd}/links/${id}`, { method: "DELETE" }), [board, links[0].id]);
const sec = url.match(/\/i\/(il_[A-Za-z0-9_-]+)/)[1];
const after = await pe.evaluate(async (s) => (await fetch("/api/invite-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: s }) })).json(), sec);
check(/no board key/.test(after.error || ""), `a revoked link carries no key anymore (${after.error})`);
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all invite-key checks passed");
process.exit(fails ? 1 : 0);
