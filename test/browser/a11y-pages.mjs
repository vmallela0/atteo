// Every page, whole (#3815): axe-core (WCAG 2.1 A/AA, serious and critical fail) on each web page's full content at 1280
// light, 1280 dark and 390 (touch), and at 390 nothing wider than the screen. a11y.mjs scans chosen regions and overlays;
// this one walks the pages, including the newer sections and states: Account's Access across boards and Standing rules,
// board info's charter, the Report dialog, Members & access, a hover card, a thread, Connect, New and Edit board, a muted post's fold, the Tasks and Files tabs, a profile, an invite link.
// BASE, ADMIN_KEY, PW_CHROME. ONLY=<label substring> narrows it while fixing.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
let axePath;
try { axePath = require.resolve("axe-core/axe.min.js"); } catch { console.log("SKIP: axe-core isn't installed: run npm ci"); process.exit(3); }
const AXE = readFileSync(axePath, "utf8");
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
// P reads in everyday mode, V in developer mode (the Log tab, ids): both looks get scanned. W isn't on the board.
const run = Date.now().toString(36).slice(-4), P = `ap${run}`, V = `av${run}`, W = `aw${run}`;
for (const [u, mode] of [[P, "everyday"], [V, "developer"], [W, "everyday"]]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode } });
const board = (await ops("boards", { user: P, title: `Pages ${run}` })).board.id;
await ops("members", { board, user: V });
const ck = {}; for (const u of [P, V, W]) ck[u] = (await ops("sessions", { user: u })).cookie;
const api = (u, path, method = "GET", body) => fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", cookie: ck[u] }, body: body ? JSON.stringify(body) : undefined });
const post = async (u, body) => (await (await api(u, `/api/boards/${board}/entries`, "POST", body)).json()).entry.seq;
// Something on every page: posts, a task, a charter, a mute, an invite link and an invitation, a standing rule.
const vSeq = await post(V, { type: "note", text: `@${P} a note to report ${run}` });
await post(V, { type: "question", text: `@${P} can you look? ${run}` });
await post(P, { type: "task", text: `A task for the tab ${run}` });
await post(P, { type: "decision", text: `We ship Friday ${run}` });
await post(P, { type: "note", text: `a reply in a thread ${run}`, reply_to: vSeq });
await api(P, `/api/boards/${board}/charter`, "POST", { goal: `Ship the checkout ${run}`, data_classes: "internal, customer-pii", retention_days: 30 });
const linkUrl = (await (await api(P, `/api/boards/${board}/links`, "POST", { role: "viewer", link_days: 7 })).json()).url;
await api(P, `/api/boards/${board}/invites`, "POST", { to: `someone-${run}@example.com` });
await api(P, "/api/rules", "POST", { action: "accept_friends", scope: "person", scope_id: V, expires_in: 7 * 86400 });
await api(V, "/api/friends/request", "POST", { user: P });
const muted = (await ops("boards", { user: V, title: `Muted ${run}` })).board.id;
await ops("members", { board: muted, user: P });
await fetch(`${BASE}/api/boards/${muted}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck[V] }, body: JSON.stringify({ type: "note", text: `muted words ${run}` }) });
await api(P, `/api/boards/${muted}/mutes`, "POST", { user: V });

const B = `/b/${board}`;
// [label, path, optional setup on the page, who (default P; null = signed out)]
const PAGES = [
  ["landing", "/", null, null],
  ["sign in", "/auth/login", null, null],
  ["privacy", "/privacy", null, null],
  ["terms", "/terms", null, null],
  ["guide", "/guide"],
  ["docs", "/docs"],
  ["welcome", "/welcome"],
  ["boards", "/?home=1"],
  ["chats", "/chats"],
  ["agent chat", "/agent"],
  ["for you", "/for-you"],
  ["inbox", "/inbox"],
  ["approvals", "/approvals"],
  ["people", "/people"],
  ["ask", "/ask"],
  ["device", "/device"],
  ["account", "/me"],
  ["profile", `/u/${V}`],
  ["invite link", linkUrl ? new URL(linkUrl).pathname : null, null, W],
  ["board", B],
  ["board info + charter", B, async (p) => { await p.locator("#charter-side").waitFor({ state: "attached" }); if (!(await p.locator("#charter-side").isVisible())) await p.locator("#info-btn").click(); await p.locator("#charter-side").waitFor(); }],
  ["board tasks", B, async (p) => { await p.locator('#board-tabs [aria-controls="panel-tasks"]').click(); await p.locator("#panel-tasks").waitFor(); }],
  // A task card opens from the keyboard (it was click-only), and the detail is scanned too.
  ["task from the keyboard", B, async (p) => {
    await p.locator('#board-tabs [aria-controls="panel-tasks"]').click(); const c = p.locator(".kcard").first(); await c.waitFor();
    await c.focus(); await p.keyboard.press("Enter"); await p.locator("#td-meta").waitFor({ timeout: 5000 });
  }],
  ["board files", B, async (p) => { await p.locator('#board-tabs [aria-controls="panel-docs"]').click(); await p.locator("#panel-docs").waitFor(); }],
  ["board, developer", B, null, V],
  ["board log", B, async (p) => { await p.locator('#board-tabs [aria-controls="panel-log"]').click(); await p.locator("#panel-log").waitFor(); }, V],
  ["report dialog", B, async (p, phone) => {
    const e = p.locator(`#e${vSeq}`); await e.waitFor();
    if (phone) await e.locator("[data-more]").tap(); else await e.hover();
    await e.locator("[data-report]").click(); await p.locator("#report-dlg").waitFor(); await p.locator("#rp-reason").fill("spam");
  }],
  ["members & access", B, async (p) => { await p.locator('[data-open="invite"]').first().click(); await p.locator("#invite").waitFor(); await p.waitForTimeout(600); }],
  ["hover card", B, async (p) => { await p.locator(`#e${vSeq} .meta .who`).first().click(); await p.locator(".hcard [data-mute]").waitFor(); }],
  ["thread", B, async (p) => { await p.locator(`#e${vSeq} [data-thread]`).first().click(); await p.locator("dialog.thr-dlg[open]").waitFor(); }],
  ["connect an agent", B, async (p) => { await p.locator('[data-open="connect"]').first().click(); await p.locator("#connect[open]").waitFor(); }],
  ["new board", "/?home=1", async (p) => { await p.locator('[data-open="new-board"]:visible').first().click(); await p.locator("#new-board[open]").waitFor(); }],
  ["edit board", "/?home=1", async (p) => { const c = p.locator(".bcard").first(); await c.hover(); await c.locator("[data-edit-board]").click(); await p.locator("#edit-board[open]").waitFor(); }],
  ["muted fold", `/b/${muted}`, async (p) => { await p.locator(".mu-line").first().waitFor(); }],
];

// LANGS=de,ar,… adds each language at 390 (longer words, right to left), with ?lang= on every page.
const RUNS = [["1280", { width: 1280, height: 860 }, false, "light", ""], ["1280 dark", { width: 1280, height: 860 }, false, "dark", ""], ["390", { width: 390, height: 844 }, true, "light", ""],
  ...(process.env.LANGS ?? "").split(",").filter(Boolean).map((l) => [`390 ${l}`, { width: 390, height: 844 }, true, "light", l])];
let fails = 0; const out = [];
const check = (ok, t, more = []) => { out.push(`${ok ? "✓" : "✗"} ${t}`, ...more); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
await Promise.all(RUNS.map(async ([tag, viewport, phone, scheme, lang]) => {
  const ctxs = {};
  const ctxFor = async (who) => {
    if (ctxs[who ?? "-"]) return ctxs[who ?? "-"];
    const ctx = await b.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    if (who) { const [k, ...v] = ck[who].split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]); }
    await ctx.addInitScript(AXE);
    return (ctxs[who ?? "-"] = ctx);
  };
  for (const [label, path, setup, who = P] of PAGES) {
    if (process.env.ONLY && !label.includes(process.env.ONLY)) continue;
    const name = `${label} ${tag}`;
    if (!path) { check(false, `${name}: no path (setup failed)`); continue; }
    const p = await (await ctxFor(who)).newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
    try {
      await p.goto(`${BASE}${path}${lang ? `${path.includes("?") ? "&" : "?"}lang=${lang}` : ""}`, { waitUntil: "load" }); await p.waitForTimeout(700);
      // Signing in hands over to WorkOS's hosted page: not ours to scan.
      if (new URL(p.url()).origin !== new URL(BASE).origin) { check(true, `${name}: hands over to ${new URL(p.url()).host}, not scanned`); await p.close(); continue; }
      if (setup) await setup(p, phone);
      await p.waitForTimeout(300);
      // Colours mid-fade (a post for you flashes for 1.6s) aren't what anyone reads: let finite animations finish first.
      await p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]));
      const r = await p.evaluate(async () => await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      const why = (n) => { const d = n.any?.[0]?.data; return d && d.fgColor ? `${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1` : n.failureSummary?.split("\n")[1]?.trim() || ""; };
      check(!bad.length, `${name}: axe ${bad.length ? bad.map((v) => v.id).join(", ") : "clean"}`, bad.map((v) => `    [${v.impact}] ${v.id}: ${v.help} — ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} ${n.html.slice(0, 80)} (${why(n)})`).join("; ")}`));
      if (phone) {
        const wide = await p.evaluate(() => {
          const W = innerWidth, scrolls = (el) => { for (let x = el.parentElement; x; x = x.parentElement) { const s = getComputedStyle(x); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true; } return false; };
          const over = [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.right > W + 1 && getComputedStyle(el).position !== "fixed" && !scrolls(el); })
            .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} right=${Math.round(el.getBoundingClientRect().right)}`);
          return { sw: document.documentElement.scrollWidth, W, over };
        });
        check(wide.sw <= wide.W && !wide.over.length, `${name}: ${wide.sw <= wide.W ? "fits" : `scrollWidth ${wide.sw} > ${wide.W}`}${wide.over.length ? `; wider than the screen: ${wide.over.join(", ")}` : ""}`);
      }
      check(!errors.length, `${name}: no page errors ${errors.join(" | ")}`);
    } catch (e) {
      check(false, `${name}: ${String(e.message).split("\n")[0]}`);
    }
    await p.close();
  }
}));
await b.close();
console.log(out.join("\n")); console.log(fails ? `${fails} FAILED` : "every page: all passed"); process.exit(fails ? 1 : 0);
