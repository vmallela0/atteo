// Purge on the web (#3853, after #3573): the message menu has Purge where the server allows it (your own posts; any post
// when you own the board), behind a dialog that says it's for good and to rotate the secret anyway. After it, every
// member's page shows "Purged by …" instead of the words, live; search no longer finds them. An unsent post can be purged
// too. From the keyboard: the dialog opens on Cancel, Escape closes it back on Purge. axe on the dialog; 1280 and 390.
// BASE, ADMIN_KEY, PW_CHROME.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
let axePath;
try { axePath = require.resolve("axe-core/axe.min.js"); } catch { console.log("SKIP: axe-core isn't installed: run npm ci"); process.exit(3); }
const AXE = readFileSync(axePath, "utf8");
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), O = `po${run}`, A = `pa${run}`, B = `pb${run}`;
for (const u of [O, A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: O, title: `Purge ${run}` })).board.id;
for (const u of [A, B]) await ops("members", { board, user: u });
const ck = {}; for (const u of [O, A, B]) ck[u] = (await ops("sessions", { user: u })).cookie;
const api = (u, path, method = "GET", body) => fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", cookie: ck[u] }, body: body ? JSON.stringify(body) : undefined });
const post = async (u, text) => (await (await api(u, `/api/boards/${board}/entries`, "POST", { type: "note", text })).json()).entry.seq;
const LEAK = `the staging password is hunter2-${run}`;
const leak = await post(B, LEAK), mine = await post(A, `A's own words ${run}`), other = await post(B, `B's other post ${run}`);
await api(A, `/api/boards/${board}/entries`, "POST", { type: "note", text: `a reply to it ${run}`, reply_to: leak }); // its quote bar quotes the words
const unsent = await post(A, `oops, unsent-${run} secret here`);
await api(A, `/api/boards/${board}/entries/${unsent}/retract`, "POST", {});

let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const open = async (u, viewport, touch = false) => {
  const ctx = await b.newContext({ viewport, reducedMotion: "reduce", ...(touch ? { hasTouch: true, isMobile: true } : {}) }); const [k, ...v] = ck[u].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]); await ctx.addInitScript(AXE);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.locator(`#e${leak}`).waitFor(); return { p, errors };
};
const shown = (p, seq) => p.locator(`#e${seq} [data-purge]`).isVisible();

// A member who isn't an owner: Purge on their own posts (unsent included), not on anyone else's.
const MA = await open(A, { width: 1280, height: 860 });
await MA.p.locator(`#e${mine}`).hover();
check(await shown(MA.p, mine), "a member: Purge on their own post");
await MA.p.locator(`#e${leak}`).hover();
check(!(await shown(MA.p, leak)) && (await MA.p.locator(`#e${leak} [data-purge]`).count()) === 1, "…and not on someone else's");
check((await (await api(A, `/api/boards/${board}/entries/${leak}/purge`, "POST")).status) === 400, "(the server refuses it too)");

// The owner: Purge on anyone's post. Keyboard: Tab reaches it; Enter opens the dialog on Cancel; Escape goes back.
const D = await open(O, { width: 1280, height: 860 });
const focused = () => D.p.evaluate(() => { const a = document.activeElement; return a?.dataset?.purge ? `purge:${a.dataset.purge}` : a?.id || a?.textContent?.trim(); });
await D.p.locator(`#e${leak} [data-reply]`).focus(); // from the post's first action, as a keyboard arrives at it
let reached = false; for (let i = 0; i < 40 && !reached; i++) { await D.p.keyboard.press("Tab"); reached = (await focused()) === `purge:${leak}`; }
check(reached, "the owner: Tab reaches Purge on B's post");
await D.p.keyboard.press("Enter");
const dlg = D.p.locator("#purge-dlg"); await dlg.waitFor();
const say = await dlg.innerText();
check(say.includes(`#${leak}`) && say.includes("hunter2") && say.includes("for good") && say.includes("rotate the secret"), "the dialog names the post, says it's for good and to rotate the secret");
check((await focused()) === "Cancel", `it opens on Cancel, so an Enter purges nothing (${await focused()})`);
const ax = await D.p.evaluate(async () => (await axe.run("#purge-dlg", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id));
check(!ax.length, `axe: the dialog is clean ${ax.join(", ")}`);
await D.p.keyboard.press("Escape");
check(!(await dlg.isVisible()) && (await focused()) === `purge:${leak}`, "Escape closes it, back on Purge");

// Purge it: the owner's page and A's page both show the placeholder; the words are gone, from search too.
await D.p.keyboard.press("Enter"); await dlg.waitFor(); await D.p.locator("#pg-go").click();
await D.p.locator("#toast.show", { hasText: "rotate" }).waitFor();
await D.p.locator(`#e${leak} .body.purged`).waitFor({ timeout: 10000 });
const PLACE = `Purged by ${O}. Its text and files were removed for good.`;
const left = await D.p.evaluate(() => [...document.querySelectorAll("*")].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes("hunter2")) || [...el.attributes].some((a) => a.value.includes("hunter2"))).map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${el.className} in ${el.parentElement?.className}/${el.parentElement?.parentElement?.className}/${el.closest("[id]")?.id}`).slice(0, 5));
check((await D.p.locator(`#e${leak} .body`).innerText()) === PLACE && !left.length, `purged: the placeholder, and the words are nowhere on the page ${left.join(", ")}`);
await MA.p.locator(`#e${leak} .body.purged`).waitFor({ timeout: 10000 }).catch(() => {});
check((await MA.p.locator(`#e${leak} .body`).innerText().catch(() => "")) === PLACE, "another member's open page shows it too, without reloading by hand");
const leftA = await MA.p.evaluate(() => document.documentElement.outerHTML.includes("hunter2"));
check(!leftA, "…with the words nowhere on it, the reply's quote bar included");
check((await D.p.locator(`#e${leak} [data-purge]`).count()) === 0, "a purged post has no Purge");
const found = await (await api(O, `/api/boards/search?q=${encodeURIComponent(`hunter2-${run}`)}`)).json();
check(!(found.hits ?? []).length, "search doesn't find the words");
check((await D.p.locator(`#e${other}`).innerText()).includes("B's other post"), "the other posts are untouched");

// An unsent post: still purgeable, by its author.
await MA.p.reload(); await MA.p.locator(`#e${unsent}`).waitFor();
await MA.p.locator(`#e${unsent}`).hover(); await MA.p.locator(`#e${unsent} [data-purge]`).click();
await MA.p.locator("#pg-go").click(); await MA.p.locator(`#e${unsent} .body.purged`).waitFor({ timeout: 10000 });
check((await MA.p.locator(`#e${unsent} .body`).innerText()) === `Purged by ${A}. Its text and files were removed for good.`, "an unsent post can be purged by its author");

// Phone: ⋯ shows Purge; the dialog fits.
const P = await open(O, { width: 390, height: 844 }, true);
await P.p.locator(`#e${other} [data-more]`).tap();
await P.p.locator(`#e${other} [data-purge]`).waitFor({ timeout: 5000 }).catch(() => {});
check(await shown(P.p, other), "phone: ⋯ shows Purge");
await P.p.locator(`#e${other} [data-purge]`).tap(); await P.p.locator("#purge-dlg").waitFor();
check(await P.p.evaluate(() => { const r = document.getElementById("purge-dlg").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; }), "phone: the dialog fits, no sideways scroll");
check(!D.errors.length && !MA.errors.length && !P.errors.length, `no page errors ${[...D.errors, ...MA.errors, ...P.errors].join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "purge: all passed"); process.exit(fails ? 1 : 0);
