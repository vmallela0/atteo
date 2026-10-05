// Standing rules on the web (#3775, P0 network #5; the Cursor session's draft dd88bd2): Account → Standing rules adds one
// automatic yes, for one person or the people on one board, for 1 to 90 days; it's listed with Revoke, and the account
// log says when one was added or revoked. A person rule accepts that person's friend request (nobody else's); a board
// rule joins boards its members invite you to, until it's revoked. Agents' tokens get 403. 1280 and 390.
// BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), R = `sr${run}`, F = `sf${run}`, M = `sm${run}`, X = `sx${run}`;
for (const u of [R, F, M, X]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const B1 = `Rules ${run}`, b1 = (await ops("boards", { user: R, title: B1 })).board.id;
await ops("members", { board: b1, user: M });
const b2 = (await ops("boards", { user: M, title: `M's first ${run}` })).board.id, b3 = (await ops("boards", { user: M, title: `M's second ${run}` })).board.id;
const ck = {}; for (const u of [R, F, M, X]) ck[u] = (await ops("sessions", { user: u })).cookie;
const api = (u, path, method = "GET", body) => fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", cookie: ck[u] }, body: body ? JSON.stringify(body) : undefined });
const rules = async () => (await (await api(R, "/api/rules")).json()).rules ?? [];

let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const tok = (await ops("tokens", { user: R })).token;
check((await fetch(`${BASE}/api/rules`, { headers: { authorization: `Bearer ${tok}` } })).status === 403, "an agent's token can't list or set standing rules");

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const open = async (viewport, touch = false) => {
  const ctx = await b.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) }); const [k, ...v] = ck[R].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/me`); await p.locator("#sr-form").waitFor(); return { p, errors };
};
const D = await open({ width: 1280, height: 900 }), f = D.p.locator("#sr-form");
check((await D.p.locator("#sr-list").innerText()).includes("No standing rules."), "Account → Standing rules: none yet");

// Your own name is refused, in the form.
await f.locator('[name="action"]').selectOption("accept_friends"); await f.locator('[name="person"]').fill(R);
await f.locator("button").click(); await D.p.locator("#sr-err:not([hidden])").waitFor();
check((await D.p.locator("#sr-err").innerText()).includes("names someone else"), "a rule naming yourself is refused, in the form");

// A person rule: F's friend request is accepted on the spot; X's waits.
await f.locator('[name="person"]').fill(`@${F}`); await f.locator('[name="days"]').selectOption("30");
await Promise.all([D.p.waitForNavigation(), f.locator("button").click()]); await f.waitFor();
const row = D.p.locator(".sr-row").first(), until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
check((await row.innerText()).startsWith(`Accept their friend requests · @${F} · until`) && (await row.innerText()).includes(until.slice(0, 8)), `the rule is listed with its end (${(await row.innerText()).split("\n")[0]})`);
check((await D.p.locator("#account-log").innerText()).includes(`Added a standing rule @${F}`), "the account log says a rule was added, and for whom");
check((await (await api(F, "/api/friends/request", "POST", { user: R })).json()).relation === "friend", "F's friend request is accepted by the rule");
check((await (await api(X, "/api/friends/request", "POST", { user: R })).json()).relation === "pending_out", "X's isn't (the rule names F)");
check(((await (await api(R, "/api/inbox")).json()).items ?? []).some((i) => i.kind === "friend_accept" && i.actor === F && /standing rule/.test(i.excerpt)), "R's inbox says the rule accepted F");

// A board rule: M (on B1) invites R and R joins right away; after Revoke, the next invitation waits.
await f.locator('[name="action"]').selectOption("accept_invites"); await f.locator('[name="scope"]').selectOption("board");
check(!(await f.locator('[name="person"]').isVisible()) && (await f.locator('[name="board"]').isVisible()), "a board scope swaps the name for a board picker");
await f.locator('[name="board"]').selectOption(b1);
await Promise.all([D.p.waitForNavigation(), f.locator("button").click()]); await f.waitFor();
check((await D.p.locator(".sr-row").first().innerText()).startsWith(`Join boards they invite me to · people on ${B1} · until`), "the board rule is listed by the board's title");
check((await (await api(M, `/api/boards/${b2}/invites`, "POST", { to: `${R}@example.com` })).json()).added === true, "M, on that board, invites R: R joins right away");
const sr = (await rules()).find((r) => r.action === "accept_invites");
await D.p.locator(`[data-sr-revoke="${sr.id}"]`).click(); await D.p.locator("#toast.show", { hasText: "Rule revoked" }).waitFor();
check((await D.p.locator(`.sr-row[data-rule="${sr.id}"]`).count()) === 0 && !(await rules()).some((r) => r.id === sr.id), "Revoke takes it off the list and the server");
check((await (await api(M, `/api/boards/${b3}/invites`, "POST", { to: `${R}@example.com` })).json()).added === false, "after Revoke, M's next invitation waits for R");
await D.p.reload(); await f.waitFor();
check((await D.p.locator("#account-log").innerText()).includes(`Revoked a standing rule ${B1}`), "the account log has the revoke");

const P = await open({ width: 390, height: 844 }, true);
check(await P.p.locator(".sr-row").first().isVisible(), "phone: the rules are there");
await P.p.locator("#sr-form").scrollIntoViewIfNeeded();
check(await P.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: no sideways scroll");
check(!D.errors.length && !P.errors.length, `no page errors ${[...D.errors, ...P.errors].join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "standing rules: all passed"); process.exit(fails ? 1 : 0);
