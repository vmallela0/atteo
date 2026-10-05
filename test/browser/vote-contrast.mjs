// A human decision's "hasn't voted" avatars stay readable (opus-a #2768, claude #2769): they used to be faded to 45%,
// which put their initials at about 2:1 for some name colours. Now they're an empty dashed ring with muted initials.
// Several voters (so several hues), light and dark, 1280 and 390px: axe finds no contrast problem in the decision, and
// voted and not-yet-voted marks still look different.
// Usage: BASE=http://localhost:8798 node vote-contrast.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4);
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const names = ["ava", "ben", "cyd", "dee", "eli", "fay", "gus", "hal"].map((n) => `${n}${run}`);
for (const u of names) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const [A, B] = names;
const ck = async (u) => (await ops("sessions", { user: u })).cookie.split(";")[0];
const ckA = await ck(A), ckB = await ck(B);
const board = (await ops("boards", { user: A, title: `Votes ${run}` })).board.id;
for (const u of names.slice(1)) await ops("members", { board, user: u });
const post = (c, body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).then((j) => j.entry.seq);
const d = await post(ckB, { type: "decision", text: `We ship on Friday ${run}` });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w, scheme] of [[1280, "light"], [1280, "dark"], [390, "light"]]) {
  const tag = `${w}px ${scheme}`, phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, colorScheme: scheme, isMobile: phone, hasTouch: phone });
  const [k, ...v] = ckA.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(1200);
  const marks = await p.evaluate((s) => [...document.querySelectorAll(`#e${s} .hd-m`)].map((m) => m.className), d);
  const waiting = marks.filter((c) => /\bw\b/.test(c)).length;
  check(waiting >= 5, `${tag}: the decision shows its voters (${marks.length}, ${waiting} not yet voted)`);
  await p.evaluate(AXE); // not addScriptTag: an inline <script> without the nonce is refused once CSP_ENFORCE is on
  const bad = await p.evaluate(async (s) => (await axe.run({ include: [[`#e${s} .hd-ms`]] }, { runOnly: { type: "rule", values: ["color-contrast"] } })).violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")} ${n.any?.[0]?.data?.contrastRatio}:1`)), d);
  check(!bad.length, `${tag}: every voter's initials are readable${bad.length ? ` (${bad.slice(0, 3).join("; ")})` : ""}`);
  const look = await p.evaluate((s) => { const w = document.querySelector(`#e${s} .hd-m.w .av`); const cs = getComputedStyle(w); return { border: cs.borderTopStyle, bg: cs.backgroundColor }; }, d);
  check(look.border === "dashed" && /rgba\(0, 0, 0, 0\)|transparent/.test(look.bg), `${tag}: not yet voted reads as an empty dashed ring (${JSON.stringify(look)})`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "vote contrast: all passed");
process.exit(fails ? 1 : 0);
