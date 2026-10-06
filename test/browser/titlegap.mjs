// Browser check (#711): on touch screens the hover-only rename pencil leaves no gap after the board title; tapping the title still renames.
// Usage: node titlegap.mjs <label>   (screenshots: tg-<label>-*.png)
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const OUT = `${SHOTS_DIR}/`, label = process.argv[2] || "after";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `tg${run}`, B = `th${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Roadmap ${run}` })).board.id; await ops("members", { board, user: B });
let fails = 0; const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
// Phones (390) show the board in the header instead (jxn #4860), renamed from ⋯ → Board settings; the tablet keeps the touch case.
for (const [w, scheme] of [[820, "light"], [820, "dark"], [1280, "dark"]]) {
  const touch = w < 1000; // 820 = a tablet
  const ctx = await b.newContext({ viewport: { width: w, height: 700 }, isMobile: touch, hasTouch: touch, deviceScaleFactor: 2, colorScheme: scheme });
  const ck = (await ops("sessions", { user: A })).cookie; const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`); await p.locator("#board-title").waitFor(); await p.evaluate(() => document.fonts.ready); // measured below: the title's font must be in
  const m = await p.evaluate(() => { const h = document.getElementById("board-title").getBoundingClientRect(), a = document.querySelector(".bp-meta .avs").getBoundingClientRect(), pen = document.getElementById("title-pencil"); return { hoverNone: matchMedia("(hover: none)").matches, gap: Math.round(a.left - h.right), penW: Math.round(pen.getBoundingClientRect().width) }; });
  console.log(`-- ${w}px ${scheme} ${touch ? "touch" : "mouse"}: ${JSON.stringify(m)}`);
  check(m.hoverNone === touch, `(hover: none) is ${m.hoverNone}`);
  if (touch) check(m.gap <= 20 && m.penW === 0, `title to avatars: ${m.gap}px, pencil takes ${m.penW}px`);
  else check(m.penW > 0, `desktop keeps the pencil (${m.penW}px)`);
  await p.locator(".bp-title").screenshot({ path: `${OUT}tg-${label}-${w}-${scheme}.png` });
  // rename still works: tap/click the title, type, Enter
  if (touch) await p.locator("#board-title").tap(); else await p.locator("#board-title").click();
  await until(() => p.locator("#title-input").isVisible());
  check(await p.locator("#title-input").isVisible(), "the title opens the rename field");
  if (!touch) { await p.keyboard.press("Escape"); await until(async () => !(await p.locator("#title-input").isVisible())); await p.hover(".title-edit"); await until(() => p.evaluate(() => getComputedStyle(document.getElementById("title-pencil")).opacity === "1")); check(await p.evaluate(() => getComputedStyle(document.getElementById("title-pencil")).opacity) === "1", "desktop: the pencil shows on hover"); }
  else { await p.fill("#title-input", `Roadmap ${run} ${w}${scheme}`); await p.keyboard.press("Enter"); await until(async () => (await p.textContent("#board-title")).includes(`${w}${scheme}`)); check((await p.textContent("#board-title")).includes(`${w}${scheme}`), "renamed from a phone"); }
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "all title-gap checks passed"); process.exit(fails ? 1 : 0);
