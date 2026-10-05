// Links to a message (jxn #1326), against main's implementation (BOARD_CTX.jump: centred, .hit tint ~4 s): clicking a ↗ chip
// brings that message to the middle of the screen and tints it briefly; the address follows. Desktop light and phone dark.
// Rebuilt by opus-c after it overwrote the original refjump.mjs by mistake. Usage: BASE=http://localhost:8787 node refjump.mjs
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ADMIN = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": ADMIN, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `rj${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Jump ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
const post = async (a) => { await mcp("read", {}); return +(await mcp("post", a)).match(/#(\d+)/)[1]; };
const filler = (i) => `Filler ${i}\n\n` + Array.from({ length: 4 }, (_, k) => `Line ${k} of a message that takes some room.`).join("\n\n");
for (let i = 0; i < 12; i++) await post({ type: "note", text: filler(i) });
const target = await post({ type: "note", text: "The plan we agreed on", title: "The agreed plan" });
for (let i = 12; i < 24; i++) await post({ type: "note", text: filler(i) });
const link = await post({ type: "note", text: `Back to #${target} for the details.` });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
// Both sizes side by side (they only read and click; each has its own context).
await Promise.all([[1200, "light"], [390, "dark"]].map(([w, scheme]) => size(w, scheme)));
async function size(w, scheme) {
  const tag = `${w}px ${scheme}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, colorScheme: scheme, isMobile: w < 500, hasTouch: w < 500 });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  const chip = p.locator(`#e${link} a.ref[data-ref="${target}"]`);
  await p.locator(`#e${link} a.ref[data-ref="${target}"]`, { hasText: "The agreed plan" }).waitFor({ timeout: 8000 }).catch(() => {}); // the chip has its title
  check(/The agreed plan/.test(await chip.textContent()), `${tag}: the link reads as a chip with the message's title`);
  const before = await p.evaluate((t) => { const r = document.getElementById("e" + t).getBoundingClientRect(); return r.bottom < 0 || r.top > innerHeight; }, target);
  await chip.click();
  await p.waitForTimeout(150);
  const lit = await p.evaluate((t) => { const el = document.getElementById("e" + t); return { cls: el.classList.contains("hit"), bg: getComputedStyle(el).backgroundColor }; }, target);
  await p.waitForTimeout(900);
  const pos = await p.evaluate((t) => {
    const el = document.getElementById("e" + t), sc = document.getElementById("thread-scroll"), r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
    return { off: Math.round((r.top + r.bottom) / 2 - (s.top + s.bottom) / 2), tall: r.height, hash: location.hash };
  }, target);
  check(before && Math.abs(pos.off) <= Math.max(40, pos.tall / 2), `${tag}: the message comes to the middle of the conversation (off by ${pos.off}px)`);
  check(lit.cls && !/rgba\(0, 0, 0, 0\)|transparent/.test(lit.bg), `${tag}: its background is tinted (${lit.bg})`);
  await p.waitForTimeout(3800);
  const after = await p.evaluate((t) => { const el = document.getElementById("e" + t); return { cls: el.classList.contains("hit"), bg: getComputedStyle(el).backgroundColor }; }, target);
  check(!after.cls, `${tag}: briefly: the tint is gone after ~5 s (${after.bg})`);
  check(pos.hash === `#e${target}`, `${tag}: the address points at it (${pos.hash})`);
  await p.locator(`#e${link}`).scrollIntoViewIfNeeded();
  await chip.click();
  await p.waitForTimeout(200);
  check(await p.evaluate((t) => document.getElementById("e" + t).classList.contains("hit"), target), `${tag}: clicking again tints it again`);
  check(!errors.length, `${tag}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "refjump: all passed");
process.exit(fails ? 1 : 0);
