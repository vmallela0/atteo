// Access across your boards (#3568, GAPS P0 network #6): the Account page lists every board you're on with your role,
// and on the boards you own everyone's access (role, end date, since when), the invite links still open and the
// invitations not yet accepted. Access with no end date held 90+ days and links that never expire are marked Review, and
// the header counts them. Remove (a second tap confirms) and Revoke work from here. Titles and names render as text; an
// agent's token can't read it. 1280 and 390. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
import { d1Execute } from "./lib/d1.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
// The d1 writes below block for seconds (execSync); the server may close the idle keep-alive socket meanwhile, and the next
// fetch on it fails with "other side closed". Retry that one error once; anything else fails as before.
const fetch = async (...a) => { try { return await globalThis.fetch(...a); } catch (e) { if (!/other side closed/i.test(String(e?.cause?.message ?? ""))) throw e; return globalThis.fetch(...a); } };
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const sql = (q) => d1Execute(`--command ${JSON.stringify(q)}`, { cwd: new URL("../../", import.meta.url).pathname });
const run = Date.now().toString(36).slice(-4), O = `ao${run}`, M = `am${run}`, V = `av${run}`, R = `ar${run}`;
for (const u of [O, M, V, R]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const TITLE = `Mine ${run} <b>bold</b>`;
const mine = (await ops("boards", { user: O, title: TITLE })).board.id;
const theirs = (await ops("boards", { user: M, title: `Theirs ${run}` })).board.id;
for (const u of [M, V]) await ops("members", { board: mine, user: u });
await ops("members", { board: theirs, user: O });
const ck = {}; for (const u of [O, M]) ck[u] = (await ops("sessions", { user: u })).cookie;
const api = (u, path, method = "GET", body) => fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", cookie: ck[u] }, body: body ? JSON.stringify(body) : undefined });
await api(O, `/api/boards/${mine}/members/${V}`, "POST", { role: "viewer", expires_days: 30 });
const forever = (await (await api(O, `/api/boards/${mine}/links`, "POST", { role: "viewer", link_days: 0 })).json()).link?.id;
const dated = (await (await api(O, `/api/boards/${mine}/links`, "POST", { role: "contributor", link_days: 7 })).json()).link?.id;
// M has had open-ended access for 120 days; two invitations wait: one to an outside address, one to R's.
const OUTSIDE = `guest.${run}@outside.example`, now = Date.now();
await sql(`UPDATE members SET joined_at = ${now - 120 * 86_400_000} WHERE board_id = '${mine}' AND user = '${M}'`);
await sql(`INSERT INTO invites (id, board_id, email, invited_by, created_at, email_status, role) VALUES ('iv1${run}', '${mine}', '${OUTSIDE}', '${O}', ${now}, 'sent', 'contributor'), ('iv2${run}', '${mine}', '${R}@example.com', '${O}', ${now}, 'sent', 'viewer')`);

let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const tok = (await ops("tokens", { user: O })).token;
check((await fetch(`${BASE}/api/me/access`, { headers: { authorization: `Bearer ${tok}` } })).status === 403, "an agent's token can't read it");
const j = await (await api(O, "/api/me/access")).json();
const jm = j.boards?.find((b) => b.id === mine), jt = j.boards?.find((b) => b.id === theirs);
check(jm?.owner && jm.members.length === 2 && jm.links.length === 2 && jm.invites.length === 2 && jt && !jt.owner && !jt.members, `the API: grants on the board you own, only your role on the other (${JSON.stringify({ m: jm?.members?.length, l: jm?.links?.length, i: jm?.invites?.length })})`);
check(j.nudges === 2 && jm.members.find((x) => x.user === M)?.review && jm.links.find((x) => x.id === forever)?.review && !jm.links.find((x) => x.id === dated)?.review, `nudges: M's 120 open-ended days and the link that never expires (${j.nudges})`);

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const open = async (viewport) => {
  const ctx = await b.newContext({ viewport }); const [k, ...v] = ck[O].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/me`); await p.locator("#access-all").waitFor(); return { p, errors };
};
const rowOf = (p, text) => p.locator(`#access-all li[data-board="${mine}"] .acc-all-r`, { hasText: text });

const D = await open({ width: 1280, height: 900 });
const head = await D.p.locator("h2", { hasText: "Access across your boards" }).locator("xpath=../p").innerText();
check(head.includes("2 to review"), `the header counts what's worth reviewing (${head.slice(-40)})`);
const mineEl = D.p.locator(`#access-all li[data-board="${mine}"]`);
check((await mineEl.locator("a b").innerText()) === TITLE && (await mineEl.locator("a b *").count()) === 0, "the board's title renders as text");
check((await mineEl.locator("> div").innerText()).includes("Owner"), "your role on it: Owner");
const mRow = await rowOf(D.p, M).innerText(), vRow = await rowOf(D.p, V).innerText();
check(/Can post · No end date · since \d{4}-\d\d-\d\d/.test(mRow) && mRow.includes("Review"), `M: no end date for 120 days, marked Review (${mRow.replace(/\s+/g, " ")})`);
check(/View only · until \d{4}-\d\d-\d\d/.test(vRow) && !vRow.includes("Review"), `V: view only with an end date, not marked (${vRow.replace(/\s+/g, " ")})`);
const links = await D.p.locator(`#access-all li[data-board="${mine}"] [data-all-revoke]`).count();
const neverRow = await rowOf(D.p, "Never expires").innerText();
check(links === 2 && neverRow.includes("Review") && neverRow.includes("View only") && neverRow.includes("0 joined"), `two open links; the one that never expires is marked (${neverRow.replace(/\s+/g, " ")})`);
const inv = await D.p.locator(`#access-all li[data-board="${mine}"] .acc-all-r`, { hasText: "Invited, not yet accepted" }).allInnerTexts();
check(inv.length === 2 && inv.some((t) => t.includes(OUTSIDE)) && inv.some((t) => t.includes(R) && !t.includes(`${R}@example.com`)), `invitations: the outside address, and R by name (${inv.map((t) => t.split(" ")[0]).join(", ")})`);
const theirsEl = await D.p.locator(`#access-all li[data-board="${theirs}"]`).innerText();
check(theirsEl.includes("Can post") && (await D.p.locator(`#access-all li[data-board="${theirs}"] .acc-all-g`).count()) === 0, "a board you don't own: your role, no one else's access");

// Remove M (the first tap arms it, the second removes), then revoke the link that never expires.
const rm = D.p.locator(`#access-all [data-all-remove="${mine}"][data-user="${M}"]`);
await rm.click(); check((await rm.innerText()).includes(`${M}?`), "Remove asks once more");
await Promise.all([D.p.waitForEvent("load"), rm.click()]); await D.p.locator("#access-all").waitFor();
const after = await (await api(O, `/api/boards/${mine}/members`)).json();
check(!after.members.some((x) => x.user === M) && (await rowOf(D.p, M).count()) === 0, "M is removed from the board and the list");
await Promise.all([D.p.waitForEvent("load"), D.p.locator(`#access-all [data-link="${forever}"]`).click()]); await D.p.locator("#access-all").waitFor();
check((await D.p.locator(`#access-all [data-link="${forever}"]`).count()) === 0 && (await D.p.locator(`#access-all [data-link="${dated}"]`).count()) === 1, "the link that never expired is revoked; the other stays");
const head2 = await D.p.locator("h2", { hasText: "Access across your boards" }).locator("xpath=../p").innerText();
check(!/to review/.test(head2), "nothing left to review");

const P = await open({ width: 390, height: 844 });
check(await P.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: no sideways scroll");
check((await P.p.locator(`#access-all li[data-board="${mine}"] [data-all-revoke]`).first().isVisible()), "phone: Revoke is there");
check(!D.errors.length && !P.errors.length, `no page errors ${[...D.errors, ...P.errors].join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "access across boards: all passed"); process.exit(fails ? 1 : 0);
