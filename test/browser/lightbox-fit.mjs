// The picture viewer shows the whole picture (jxn #2990): it opens fitted to the screen, never cropped or scrolled, in
// its real proportions; a small picture stays its own size. Square, wide, tall and small pictures, at 1280 and 390px,
// light and dark (no frame around the picture). BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `lb${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Viewer ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie;
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const [k, ...v] = ck.split(";")[0].split("=");
const ctxFor = async (width, height, scheme) => {
  const ctx = await b.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]); return ctx;
};
const PICS = [["square", 1024, 1024], ["wide", 1600, 838], ["tall", 600, 1400], ["small", 200, 120]];

// Post the four pictures, one message each (drawn in the page, as PNGs).
{ const ctx = await ctxFor(1280, 860, "light"), p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}`);
  for (const [name, w, h] of PICS) {
    const png = Buffer.from(await p.evaluate(async ([w, h]) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#6A1B24"; g.fillRect(0, 0, w, h); g.fillStyle = "#fff"; g.fillRect(8, 8, w - 16, h - 16); const bl = await new Promise((r) => c.toBlob(r, "image/png")); return [...new Uint8Array(await bl.arrayBuffer())]; }, [w, h]));
    await p.setInputFiles("#attach-input", [{ name: `${name}.png`, mimeType: "image/png", buffer: png }]);
    await p.locator(".att").first().waitFor({ timeout: 5000 }).catch(() => {});
    await p.click("#composer-text"); await p.keyboard.type(`${name} ${run}`); await p.keyboard.press("Enter");
    await p.waitForFunction((t) => [...document.querySelectorAll("#thread .entry:not(.pending)")].some((e) => e.textContent.includes(t) && e.querySelector("figure.img img")), `${name} ${run}`, { timeout: 10000 });
  }
  // Two pictures in one message, for the arrows.
  const two = await p.evaluate(async () => { const out = []; for (const [w, h] of [[1600, 838], [1024, 1024]]) { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").fillRect(0, 0, w, h); const bl = await new Promise((r) => c.toBlob(r, "image/png")); out.push([...new Uint8Array(await bl.arrayBuffer())]); } return out; });
  await p.setInputFiles("#attach-input", two.map((x, i) => ({ name: `pair${i}.png`, mimeType: "image/png", buffer: Buffer.from(x) })));
  await p.locator(".att").first().waitFor({ timeout: 5000 }).catch(() => {});
  await p.click("#composer-text"); await p.keyboard.type(`pair ${run}`); await p.keyboard.press("Enter");
  await p.waitForFunction((t) => [...document.querySelectorAll("#thread .entry:not(.pending)")].some((e) => e.textContent.includes(t) && e.querySelector("[data-img]")), `pair ${run}`, { timeout: 10000 });
  await ctx.close(); }

for (const [width, height, scheme] of [[1280, 860, "light"], [390, 844, "light"], [1280, 860, "dark"]]) {
  const ctx = await ctxFor(width, height, scheme), p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  for (const [name, w, h] of PICS) {
    const tag = `${width}px ${scheme}, ${name} ${w}×${h}`;
    const fig = p.locator("#thread .entry", { hasText: `${name} ${run}` }).locator("figure.img .img-open, figure.img [data-img]").first();
    await fig.scrollIntoViewIfNeeded(); await fig.click();
    await p.waitForFunction(() => { const i = document.getElementById("lightbox-img"); return document.getElementById("lightbox").open && i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 }).catch(() => {});
    const g = await p.evaluate(() => { const d = document.getElementById("lightbox"), i = document.getElementById("lightbox-img"), r = i.getBoundingClientRect(), dr = d.getBoundingClientRect();
      return { nw: i.naturalWidth, nh: i.naturalHeight, x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, dw: dr.width, dh: dr.height, sw: d.scrollWidth, cw: d.clientWidth, sh: d.scrollHeight, ch: d.clientHeight }; });
    const r = (n) => Math.round(n);
    const inside = g.x >= -1 && g.y >= -1 && g.x + g.w <= g.vw + 1 && g.y + g.h <= g.vh + 1;
    const noScroll = g.sw <= g.cw + 1 && g.sh <= g.ch + 1;
    const ratio = Math.abs(g.w / g.h - w / h) < 0.02 * (w / h);
    const scale = Math.min(1, Math.min(g.vw * 0.96, 1600) / w, (g.vh * 0.92) / h); // fitted, never enlarged
    const fits = Math.abs(g.w - w * scale) <= 3 && Math.abs(g.h - h * scale) <= 3;
    check(inside && noScroll && ratio && fits, `${tag}: the whole picture, fitted (shown ${r(g.w)}×${r(g.h)}, expected ${r(w * scale)}×${r(h * scale)}; viewer ${r(g.dw)}×${r(g.dh)}, scroll ${g.sw}/${g.cw} ${g.sh}/${g.ch})`);
    check(Math.abs(g.dw - g.w) <= 2 && Math.abs(g.dh - g.h) <= 2, `${tag}: no frame around it (viewer ${r(g.dw)}×${r(g.dh)}, picture ${r(g.w)}×${r(g.h)})`);
    await p.keyboard.press("Escape"); await p.waitForFunction(() => !document.getElementById("lightbox").open, null, { timeout: 3000 }).catch(() => {});
  }
  // Several pictures: the arrows, the count and Save sit on the screen, over the backdrop, and work.
  await p.locator("#thread .entry", { hasText: `pair ${run}` }).locator("[data-img]").first().click();
  await p.waitForFunction(() => document.getElementById("lightbox").open, null, { timeout: 5000 }).catch(() => {});
  const on = await p.evaluate(() => ["#lightbox .lb-prev", "#lightbox .lb-next", "#lightbox .lb-count", "#lightbox-save"].map((s) => { const e = document.querySelector(s), r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return !e.hidden && r.width > 0 && x > 0 && x < innerWidth && y > 0 && y < innerHeight && (document.elementFromPoint(x, y) === e || e.contains(document.elementFromPoint(x, y))); }));
  await p.locator("#lightbox .lb-next").click();
  const second = await p.evaluate(() => document.querySelector("#lightbox .lb-count").textContent.trim());
  check(on.every(Boolean) && second.startsWith("2"), `${width}px ${scheme}: with two pictures, ‹ › the count and Save are on screen and › goes on (${JSON.stringify(on)}, "${second}")`);
  await p.keyboard.press("Escape");
  check(!errors.length, `${width}px ${scheme}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
// Zoom (vedu's agent #2993): a click on a picture bigger than the screen shows it at full size, scrolled to where you
// clicked; Esc (or a click) fits it again; a click off the picture closes; a small picture just closes.
{ const ctx = await ctxFor(1280, 860, "light"), p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  const open = async (name) => { const f = p.locator("#thread .entry", { hasText: `${name} ${run}` }).locator("figure.img .img-open, figure.img [data-img]").first(); await f.scrollIntoViewIfNeeded(); await f.click();
    await p.waitForFunction(() => { const i = document.getElementById("lightbox-img"); return document.getElementById("lightbox").open && i.complete && i.naturalWidth > 0 && document.getElementById("lightbox").classList.contains("zoomable") || i.naturalWidth <= 300; }, null, { timeout: 5000 }).catch(() => {}); };
  const st = () => p.evaluate(() => { const d = document.getElementById("lightbox"), i = document.getElementById("lightbox-img"), r = i.getBoundingClientRect(); return { open: d.open, zoomed: d.classList.contains("zoomed"), w: Math.round(r.width), cursor: getComputedStyle(i).cursor, sl: Math.round(d.scrollLeft), st: Math.round(d.scrollTop), sw: d.scrollWidth, cw: d.clientWidth }; });
  await open("wide"); // 1600×838, fitted to 1229 wide
  const fit = await st();
  await p.mouse.click(640 + 400, 430); // right of centre
  await p.waitForFunction(() => document.getElementById("lightbox").classList.contains("zoomed"), null, { timeout: 3000 }).catch(() => {});
  const z = await st();
  check(fit.cursor === "zoom-in" && z.zoomed && z.w === 1600 && z.sw > z.cw && z.sl > 0, `a click on a big picture shows it at full size, scrolled toward the click (${JSON.stringify({ fit: fit.w, ...z })})`);
  await p.mouse.move(500, 430); await p.mouse.down(); await p.mouse.move(700, 430, { steps: 5 }); await p.mouse.up();
  const dragged = await st();
  check(dragged.zoomed && dragged.sl < z.sl - 150, `dragging pans it, and letting go doesn't fit it again (scrollLeft ${z.sl} → ${dragged.sl})`);
  await p.keyboard.press("Escape");
  const back = await st();
  check(back.open && !back.zoomed && back.w === fit.w, `Esc fits it again and the viewer stays open (${JSON.stringify(back)})`);
  await p.mouse.click(640, 430); await p.mouse.click(640, 430); // zoom, then a click again
  const again = await st();
  check(again.open && !again.zoomed && again.w === fit.w, `a click on the zoomed picture fits it again (${JSON.stringify(again)})`);
  // The keyboard: Z (or Enter) zooms and fits; while zoomed the arrows pan instead of going to another picture.
  await p.keyboard.press("z"); const kz = await st();
  await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight"); const kp = await st();
  await p.keyboard.press("Enter"); const kf = await st();
  check(kz.zoomed && kp.zoomed && kp.sl > kz.sl && !kf.zoomed && kf.open, `Z zooms, the arrows pan while zoomed (scrollLeft ${kz.sl} → ${kp.sl}), Enter fits it again`);
  await p.mouse.click(20, 20);
  check(!(await st()).open, "a click off the picture closes the viewer");
  await open("small");
  const sm = await st();
  check(sm.open && sm.cursor !== "zoom-in", `a small picture doesn't offer zoom (${JSON.stringify(sm)})`);
  await p.mouse.click(640, 430);
  check(!(await st()).open, "and a click on it closes, as before");
  check(!errors.length, `zoom: no page errors ${errors.join(" | ")}`); await ctx.close(); }
await b.close(); console.log(fails ? `${fails} FAILED` : "picture viewer fits: all passed"); process.exit(fails ? 1 : 0);
