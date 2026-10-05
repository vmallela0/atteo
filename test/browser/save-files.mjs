// Save any picture or file from the chat in one tap (jxn #2684): a single picture's caption, the picture viewer (for
// a grid too), text files next to Open, other files, and the Files viewer each have Save / Download, which downloads
// with the real file name. On a phone that can share files the share sheet opens instead (navigator.share is
// stubbed here and records the file). BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `sf${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Save ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie;
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(600);
const png = await p.evaluate(async () => { const c = document.createElement("canvas"); c.width = 300; c.height = 200; const g = c.getContext("2d"); g.fillStyle = "#A8121E"; g.fillRect(0, 0, 300, 200); const bl = await new Promise((r) => c.toBlob(r, "image/png")); return [...new Uint8Array(await bl.arrayBuffer())]; }).then((a) => Buffer.from(a));
const send = async (files, text) => { await p.setInputFiles("#attach-input", files); await p.waitForTimeout(300); await p.click("#composer-text"); await p.keyboard.type(text); await p.keyboard.press("Enter"); await p.waitForFunction((t) => [...document.querySelectorAll("#thread .entry:not(.pending)")].some((e) => e.textContent.includes(t)), text, { timeout: 10000 }); await p.waitForTimeout(400); };
const download = async (loc) => { const [d] = await Promise.all([p.waitForEvent("download", { timeout: 8000 }), loc.click()]); return { name: d.suggestedFilename(), size: (await d.createReadStream().then((s) => new Promise((r) => { let n = 0; s.on("data", (c) => (n += c.length)); s.on("end", () => r(n)); }))) }; };
// A single picture.
await send([{ name: "sunset.png", mimeType: "image/png", buffer: png }], `one picture ${run}`);
let d = await download(p.locator("#thread figure.img figcaption a[data-save]").first());
check(d.name === "sunset.png" && d.size > 100, `a picture's caption has Save, and it saves sunset.png (${d.name}, ${d.size} bytes)`);
// The viewer has Save too, and saving doesn't close it.
await p.locator("#thread figure.img .img-open").first().click(); await p.waitForTimeout(300);
d = await download(p.locator("#lightbox-save"));
check(d.name === "sunset.png" && await p.locator("#lightbox").evaluate((x) => x.open), `the picture viewer has Save (${d.name}) and stays open`);
await p.keyboard.press("Escape");
// Several files: two pictures, a text file and a zip. The viewer saves each picture under its own name; the text file
// has Download next to Open.
await send([{ name: "a.png", mimeType: "image/png", buffer: png }, { name: "b.png", mimeType: "image/png", buffer: png }, { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n\nhello\n") }, { name: "data.bin", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3, 4]) }], `several ${run}`);
await p.locator("#thread .mg-tile").nth(1).click(); await p.waitForTimeout(300);
d = await download(p.locator("#lightbox-save"));
check(d.name === "b.png", `in a grid, the viewer saves the picture it shows (${d.name})`);
await p.keyboard.press("Escape");
d = await download(p.locator('#thread .mchips a[data-save][download="notes.md"]').first());
check(d.name === "notes.md" && d.size > 5, `a text file has Download next to Open (${d.name}, ${d.size} bytes)`);
d = await download(p.locator('#thread .mchips a[data-save][download="data.bin"]').first());
check(d.name === "data.bin" && d.size === 4, `other files download as they are (${d.name}, ${d.size} bytes)`);
// The Files viewer.
await p.locator('#thread [data-open-file="notes.md"]').first().click(); await p.waitForTimeout(800);
d = await download(p.locator("#doc-view a[data-save]").first());
check(d.name === "notes.md", `the Files viewer has Download (${d.name})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await ctx.close();

// A phone that can share files: Save opens the share sheet with the file instead of downloading.
{ const c2 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  await c2.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  await c2.addInitScript(() => { window.__shared = []; navigator.canShare = (d) => !!(d && d.files && d.files.length); navigator.share = async (d) => { window.__shared.push(...d.files.map((f) => ({ name: f.name, size: f.size, type: f.type }))); }; });
  const q = await c2.newPage(); const errs = []; q.on("pageerror", (e) => errs.push(e.message));
  await q.goto(`${BASE}/b/${board}`); await q.waitForTimeout(800);
  let downloaded = false; q.on("download", () => { downloaded = true; });
  await q.locator("#thread figure.img figcaption a[data-save]").first().tap(); await q.waitForTimeout(800);
  const sh = await q.evaluate(() => window.__shared);
  check(sh.length === 1 && sh[0].name === "sunset.png" && sh[0].size > 100 && /image\/png/.test(sh[0].type) && !downloaded, `phone: Save opens the share sheet with sunset.png (${JSON.stringify(sh)})`);
  const geo = await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check(geo, "phone: nothing wider than the screen");
  check(!errs.length, `phone: no page errors ${errs.join(" | ")}`); await c2.close(); }
await b.close(); console.log(fails ? `${fails} FAILED` : "save files: all passed"); process.exit(fails ? 1 : 0);
