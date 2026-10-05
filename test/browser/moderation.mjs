// Moderation on the web (#3602): a member you mute on a board folds to one line ("Muted: … · Show") on your page, live
// posts included, and stops notifying you (mail for your agent still arrives); unmute from the same hover card. Report
// sends a post to the board's owners with a reason, once: they get it in their inbox and the board's log has it, which
// members who aren't owners don't see. Your own posts have no Report. Agents' tokens get 403. 1280 and 390.
// BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), O = `mo${run}`, A = `ma${run}`, B = `mb${run}`;
for (const u of [O, A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: O, title: `Moderation ${run}` })).board.id;
for (const u of [A, B]) await ops("members", { board, user: u });
const ck = {}; for (const u of [O, A, B]) ck[u] = (await ops("sessions", { user: u })).cookie;
const api = (u, path, method = "GET", body) => fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", cookie: ck[u] }, body: body ? JSON.stringify(body) : undefined });
const post = async (u, text) => (await (await api(u, `/api/boards/${board}/entries`, "POST", { type: "note", text })).json()).entry.seq;
const inbox = async (u) => (await (await api(u, "/api/inbox")).json()).items ?? [];

let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const tok = (await ops("tokens", { user: B })).token;
const asAgent = (path, method, body) => fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const before = await post(A, `@${B} before the mute ${run}`);
check((await asAgent(`/api/boards/${board}/mutes`, "POST", { user: A })).status === 403 && (await asAgent(`/api/boards/${board}/entries/${before}/report`, "POST", { reason: "x" })).status === 403, "an agent's token can't mute or report");
check((await api(B, `/api/boards/${board}/mutes`, "POST", { user: B })).status === 400, "you can't mute yourself");
check((await inbox(B)).some((i) => i.seq === before && i.kind === "mention"), "before the mute, A's @mention reaches B");
const mine = await post(B, `B's own post ${run}`);

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const open = async (u, viewport, touch = false) => {
  const ctx = await b.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) }); const [k, ...v] = ck[u].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.locator(`#e${before}`).waitFor(); return { p, errors };
};
const D = await open(B, { width: 1280, height: 900 });
const card = D.p.locator(".hcard");
await D.p.locator(`#e${before} .meta .who`).first().click(); await card.locator("[data-mute]").waitFor();
check((await card.locator("[data-mute]").innerText()) === "Mute on this board", "A's card offers Mute on this board");
await card.locator("[data-mute]").click();
const fold = D.p.locator(`#e${before}.mu .mu-line`); await fold.waitFor();
check((await fold.innerText()) === `Muted: ${A} · Show` && !(await D.p.locator(`#e${before} .body`).isVisible()), "A's post folds to one line, its text hidden");
check((await (await api(B, `/api/boards/${board}/mutes`)).json()).muted?.join() === A, "the mute is saved");
const after = await post(A, `@${B} after the mute ${run}`), mail = await post(A, `@${B}'s agent please look ${run}`);
await D.p.locator(`#e${after}.mu .mu-line`).waitFor({ timeout: 10000 });
check(true, "A's new post arrives folded too");
const bi = await inbox(B);
check(!bi.some((i) => i.seq === after), "after the mute, A's @mention doesn't notify B");
check(bi.some((i) => i.seq === mail && i.kind === "agent"), `mail for B's agent still arrives (${bi.filter((i) => i.seq === mail).map((i) => i.kind).join() || "none"})`);
await fold.click();
check(await D.p.locator(`#e${before} .body`).isVisible(), "Show opens it");
check(!(await D.p.locator(`#e${mine} [data-report]`).isVisible()) && (await D.p.locator(`#e${mine} [data-report]`).count()) === 1, "your own post has no Report");

// Report A's opened post: the reason is required; the owners get it once.
await D.p.locator(`#e${before}`).hover(); await D.p.locator(`#e${before} [data-report]`).click();
const dlg = D.p.locator("#report-dlg"); await dlg.waitFor();
check((await dlg.locator("#rp-n").innerText()) === `#${before}` && (await dlg.locator("#rp-prev").innerText()).includes("before the mute") && (await dlg.locator("#rp-send").isDisabled()), "the dialog shows the post, and Report waits for a reason");
const REASON = `Spam <b>${run}</b>`;
await dlg.locator("#rp-reason").fill(REASON); await dlg.locator("#rp-send").click();
await D.p.locator("#toast.show", { hasText: "Reported to the board's owners" }).waitFor();
check(!(await dlg.isVisible()), "sent: the dialog closes and says the owners have it");
await D.p.locator(`#e${before}`).hover(); await D.p.locator(`#e${before} [data-report]`).click();
await dlg.locator("#rp-reason").fill("again"); await dlg.locator("#rp-send").click(); await dlg.locator("#rp-err").waitFor();
check((await dlg.locator("#rp-err").innerText()).includes("already reported"), "a second report of the same post is refused");
await D.p.keyboard.press("Escape");
const oi = (await inbox(O)).find((i) => i.seq === before && i.board_id === board);
check(oi?.kind === "report" && oi.actor === B && oi.excerpt === REASON, `the owner's inbox has it, with the reason (${JSON.stringify(oi && { kind: oi.kind, actor: oi.actor })})`);
check(!(await inbox(A)).some((i) => i.kind === "report"), "the person reported isn't told");
const oa = (await (await api(O, `/api/boards/${board}/audit`)).json()).audit ?? [], aa = (await (await api(A, `/api/boards/${board}/audit`)).json()).audit ?? [];
const ax = await (await api(A, `/api/boards/${board}/audit/export`)).json();
check(oa.some((r) => r.action === "reported" && r.actor === B && r.target === `#${before}` && r.detail === `${A}: ${REASON}`), "the board's log has the report, for its owner");
check(!aa.some((r) => r.action === "reported") && !ax.audit.some((r) => r.action === "reported"), "members who aren't owners don't see reports in the log or its export");
const OP = await open(O, { width: 1280, height: 900 }); await OP.p.goto(`${BASE}/inbox`);
const row = OP.p.locator("li, .item, article", { hasText: "reported a post to you, as an owner" }).first(); await row.waitFor();
check((await row.innerText()).includes(REASON), "the owner's inbox page shows the reason as text");

// Unmute from the same card: the folds go.
await D.p.locator(`#e${after} .mu-line`).click(); await D.p.locator(`#e${after} .meta .who`).first().click();
await card.locator("[data-mute]", { hasText: "Unmute" }).click();
await D.p.locator(`#e${before}.mu`).waitFor({ state: "detached" }).catch(() => {});
check((await D.p.locator("#thread .entry.mu").count()) === 0 && (await D.p.locator(".mu-line").count()) === 0, "Unmute: nothing is folded any more");
check((await (await api(B, `/api/boards/${board}/mutes`)).json()).muted?.length === 0, "and the mute is gone");

await api(B, `/api/boards/${board}/mutes`, "POST", { user: A });
const P = await open(B, { width: 390, height: 844 }, true);
check(await P.p.locator(`#e${before}.mu .mu-line`).isVisible(), "phone: the fold is there on load");
check(await P.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: no sideways scroll");
await P.p.locator(`#e${before} .mu-line`).tap(); await P.p.locator(`#e${before} [data-more]`).tap();
await P.p.locator(`#e${before} [data-report]`).waitFor({ timeout: 5000 }).catch(() => {});
check(await P.p.locator(`#e${before} [data-report]`).isVisible(), "phone: Show, then ⋯ shows Report");
check(!D.errors.length && !P.errors.length && !OP.errors.length, `no page errors ${[...D.errors, ...P.errors, ...OP.errors].join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "moderation: all passed"); process.exit(fails ? 1 : 0);
