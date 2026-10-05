// The full access log as JSON from board info (#3375, GAPS P0 #10): Activity shows the latest 50; a link under it
// downloads every access event, oldest first, from /api/boards/:id/audit/export. The owner downloads it at 1280 (the
// file's name and contents); a viewer sees the link on a phone, without sideways scroll; an outsider gets a 404.
// BASE, ADMIN_KEY, PW_CHROME.
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `ad${run}`, V = `av${run}`, F = `af${run}`;
for (const u of [A, V, F]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Audit ${run}` })).board.id;
await ops("members", { board, user: V });
const ck = {}; for (const u of [A, V, F]) ck[u] = (await ops("sessions", { user: u })).cookie;
const api = (u, path, body) => fetch(`${BASE}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", cookie: ck[u] }, body: body ? JSON.stringify(body) : undefined });
// Two access events: V becomes a viewer, then the board is renamed.
await api(A, `/api/boards/${board}/members/${V}`, { role: "viewer" });
await api(A, `/api/boards/${board}/rename`, { title: `Audit ${run} renamed` });

let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const open = async (u, viewport) => {
  const ctx = await b.newContext({ viewport, acceptDownloads: true }); const [k, ...v] = ck[u].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); return { p, errors };
};
// Board info's Members & access dialog, with Activity open.
const activity = async (p, phone) => {
  if (phone) await p.locator("#info-btn").click();
  await p.locator('[data-open="invite"]').first().click(); await p.locator("#invite").waitFor();
  await p.locator("#acc-audit").evaluate((e) => (e.closest("details").open = true));
  await p.locator("#acc-audit li").first().waitFor();
};
const link = (p) => p.locator("#invite .acc-dl a");

// Owner, desktop: the link, then the file it downloads.
const D = await open(A, { width: 1280, height: 860 });
await activity(D.p);
const href = await link(D.p).getAttribute("href");
check(href === `/api/boards/${board}/audit/export` && (await link(D.p).getAttribute("download")) !== null, `Activity links the export as a download (${href})`);
check((await link(D.p).innerText()) === "Download the full log (JSON)" && (await link(D.p).isVisible()), "the link shows under the list");
const [dl] = await Promise.all([D.p.waitForEvent("download"), link(D.p).click()]);
const name = dl.suggestedFilename();
check(new RegExp(`^atteo-audit-${board}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(name), `it downloads as a dated file (${name})`);
const doc = JSON.parse(await readFile(await dl.path(), "utf8"));
const acts = (doc.audit || []).map((x) => x.action);
check(doc.kind === "access_audit" && doc.board_id === board && doc.count === doc.audit.length && acts.indexOf("access_changed") > -1 && acts.indexOf("access_changed") < acts.indexOf("renamed"), `the file holds every event, oldest first (${acts.join(", ")})`);

// A viewer, phone: the same link in the drawer's dialog, nothing wider than the screen.
const M = await open(V, { width: 390, height: 844 });
await activity(M.p, true);
check((await link(M.p).isVisible()) && (await link(M.p).getAttribute("href")) === href, "phone: a viewer sees the link too");
check(await M.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone: no sideways scroll");
check((await api(V, href)).status === 200, "a viewer can download it");

// Someone who isn't on the board: nothing.
check((await api(F, href)).status === 404, "an outsider gets a 404");
check(!D.errors.length && !M.errors.length, `no page errors ${[...D.errors, ...M.errors].join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "audit download: all passed"); process.exit(fails ? 1 : 0);
