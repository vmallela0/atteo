// Report a bug on the web (jxn #4051, #4053, #4116): a warning-triangle button at the end of the account row opens a
// form; nothing is captured on its own; pictures go with it like the composer's (the paper clip, a paste), shown as
// thumbnails you can remove; Send posts one multipart report (note + a `screenshot` part per picture) to /api/bugs.
// Light 1280 and dark 390. The endpoint itself is answered here (the bug board isn't set up locally). BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `br${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Bugs ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie.split(";")[0];
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const out = await Promise.all([[1280, 800, "light"], [390, 844, "dark"]].map(async ([w, h, scheme]) => {
  const lines = []; const chk = (ok, t) => lines.push([ok, t]);
  const tag = `${w}px ${scheme}`, phone = w < 500;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const [k, ...v] = ck.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  const sent = [], vendor = [];
  p.on("request", (r) => { if (/html2canvas/.test(r.url())) vendor.push(r.url()); });
  await p.route("**/api/bugs", async (route) => { const r = route.request(); sent.push({ type: r.headers()["content-type"] || "", body: r.postDataBuffer()?.toString("latin1") || "" }); await route.fulfill({ status: 201, json: { ok: true, seq: 1 } }); });
  await p.goto(`${BASE}/b/${board}`);
  if (phone) await p.locator("[data-nav]").first().click();
  const btn = p.locator(".sidebar .me [data-bug]");
  await btn.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const row = await p.evaluate(() => { const me = document.querySelector(".sidebar .me"), a = me.querySelector(".side-link").getBoundingClientRect(), b = me.querySelector("[data-bug]").getBoundingClientRect();
    return { same: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 4 && b.left > a.left, right: Math.round(me.getBoundingClientRect().right - b.right), w: Math.round(b.width), svg: !!me.querySelector("[data-bug] svg path"), label: me.querySelector("[data-bug]").getAttribute("aria-label"), text: me.querySelector("[data-bug]").textContent.trim() }; });
  chk(row.same && row.right < 12 && row.w >= 24 && row.svg && row.label === "Report a bug" && !row.text, `${tag}: a triangle button at the end of the account row (${JSON.stringify(row)})`);
  await btn.click();
  await p.locator("#bug[open]").waitFor({ timeout: 8000 }).catch(() => {});
  const d = await p.evaluate(() => { const dl = document.getElementById("bug").getBoundingClientRect(), ta = document.getElementById("bug-text"), t = ta.getBoundingClientRect();
    return { open: document.getElementById("bug").open, pics: document.querySelectorAll("#bug-pics img").length, font: getComputedStyle(ta).fontFamily, inset: Math.round(t.left - dl.left), insetR: Math.round(dl.right - t.right),
      clip: !!document.querySelector("#bug-attach svg"), cancel: !!document.querySelector("#bug .ft [data-close]"), focus: document.activeElement?.id, doc: document.documentElement.scrollWidth <= innerWidth }; });
  await p.waitForTimeout(300);
  chk(d.open && d.pics === 0 && !vendor.length, `${tag}: it opens with no picture taken (and loads no capture library)`);
  chk(!/mono|courier/i.test(d.font) && d.inset >= 16 && d.insetR >= 16 && d.clip && d.cancel && d.focus === "bug-text" && d.doc, `${tag}: a form in the normal font inside the dialog's padding, the paper clip, Cancel and Send (${JSON.stringify({ ...d, font: d.font.split(",")[0] })})`);
  // The paper clip (the file input behind it), then a paste: two thumbnails; remove one.
  const png = Buffer.from(await p.evaluate(async () => { const c = document.createElement("canvas"); c.width = 400; c.height = 300; const g = c.getContext("2d"); g.fillStyle = "#6A1B24"; g.fillRect(0, 0, 400, 300); const bl = await new Promise((r) => c.toBlob(r, "image/png")); return [...new Uint8Array(await bl.arrayBuffer())]; }));
  await p.setInputFiles("#bug-files", { name: "one.png", mimeType: "image/png", buffer: png });
  await p.evaluate(async (bytes) => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" })); document.getElementById("bug-text").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, [...png]);
  await p.waitForFunction(() => document.querySelectorAll("#bug-pics img").length === 2, null, { timeout: 5000 }).catch(() => {});
  chk((await p.locator("#bug-pics img").count()) === 2, `${tag}: the paper clip and a paste each add a picture, shown as thumbnails`);
  await p.locator("#bug-pics [data-bug-rm]").first().click();
  chk((await p.locator("#bug-pics img").count()) === 1, `${tag}: ✕ takes one off`);
  await p.fill("#bug-text", `the dialog looks off ${run}`);
  await p.locator("#bug-send").click();
  await p.waitForFunction(() => !document.getElementById("bug").open, null, { timeout: 5000 }).catch(() => {});
  const s = sent[0] || { type: "", body: "" };
  chk(sent.length === 1 && /multipart\/form-data/.test(s.type) && s.body.includes(`the dialog looks off ${run}`) && (s.body.match(/name="screenshot"/g) || []).length === 1 && /Content-Type: image\/(png|jpeg)/.test(s.body) && !(await p.evaluate(() => document.getElementById("bug").open)),
    `${tag}: Send posts one multipart report with the note and the picture, and closes (${sent.length} sent, ${s.type.split(";")[0]})`);
  await btn.click(); await p.locator("#bug[open]").waitFor({ timeout: 5000 }).catch(() => {});
  chk((await p.locator("#bug-pics img").count()) === 0 && (await p.inputValue("#bug-text")) === "", `${tag}: opening it again starts empty`);
  await p.locator("#bug .ft [data-close]").click();
  chk(!(await p.evaluate(() => document.getElementById("bug").open)), `${tag}: Cancel closes it`);
  chk(!errors.length, `${tag}: no page errors ${errors.join(" | ")}`);
  await ctx.close(); return lines;
}));
for (const lines of out) for (const [ok, t] of lines) check(ok, t);
await b.close(); console.log(fails ? `${fails} FAILED` : "bug report: all passed"); process.exit(fails ? 1 : 0);
