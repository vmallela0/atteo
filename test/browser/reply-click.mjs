// Replies in the main conversation (jxn #1351): selecting words in a reply keeps the selection and offers Quote (it used
// to start a reply to the thread's first message on mouse-up); Reply on a reply answers that reply; links inside a reply
// work; a thread opened from a reply's quote bar answers that reply.
// Usage: BASE=http://localhost:8787 node reply-click.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ADMIN = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": ADMIN, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `rc${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Replies ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
const post = async (a) => { await mcp("read", {}); return +(await mcp("post", a)).match(/#(\d+)/)[1]; };
const A = await post({ type: "note", text: "Top message of the thread", title: "Thread top" });
const B = await post({ type: "note", text: "A reply in the thread with some quotable words in it", reply_to: A });
const L = await post({ type: "note", text: `Another reply that links back to #${A} here`, reply_to: B });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const [k, ...v] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
await p.waitForTimeout(800);
const state = () => p.evaluate(() => ({ to: document.getElementById("reply-to").value, quote: !document.getElementById("quote-btn").hidden, sel: String(getSelection()), dlg: !!document.querySelector("dialog.thr-dlg")?.open, text: document.getElementById("composer-text").value }));

// 1. Select words in a reply with the mouse: the selection stays, Quote shows, no reply starts.
const box = await p.locator(`#e${B} > .grow > .body p`).boundingBox();
await p.mouse.move(box.x + 3, box.y + box.height / 2);
await p.mouse.down();
await p.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(400);
let s = await state();
check(s.to === "" && s.quote && /quotable words/.test(s.sel) && !s.dlg, `selecting words in a reply keeps them and offers Quote; no reply starts (${JSON.stringify({ to: s.to, quote: s.quote, sel: s.sel.slice(0, 30) })})`);
await p.click("#quote-btn");
s = await state();
check(s.to === "" && /^> A reply in the thread/.test(s.text) && new RegExp(`#${B}`).test(s.text), "Quote puts the words in the box, still not a reply");
await p.fill("#composer-text", "");

// 2. Reply on a reply answers that reply, not the thread's first message.
await p.hover(`#e${B}`);
await p.locator(`#e${B} button[data-reply="${B}"]`).click({ force: true });
s = await state();
check(s.to === String(B), `Reply on a reply answers that reply (#${B}), not the thread's first message (got #${s.to})`);
await p.locator("#composer-text").press("End");
await p.keyboard.type("answering the reply");
await p.keyboard.press("Enter");
await p.waitForTimeout(1200);
const mine = await (await fetch(`${BASE}/api/boards/${board}/entries?after=0`, { headers: { authorization: `Bearer ${tok}` } })).json();
const sent = mine.entries.find((e) => /answering the reply/.test(e.text));
check(sent?.reply_to === B, `the reply is stored as a reply to #${B} (reply_to ${sent?.reply_to})`);

// 3. A link inside a reply works, and doesn't start a reply either.
await p.evaluate(() => { document.getElementById("reply-cancel")?.click(); });
await p.locator(`#e${L} a.ref[data-ref="${A}"]`).click();
await p.waitForTimeout(600);
s = await state();
check(s.to === "" && (await p.evaluate(() => location.hash)) === `#e${A}`, `a link inside a reply goes to its message; no reply starts (to "${s.to}")`);
// 4. Opening the thread from a reply in the conversation (its quote bar): the box answers that reply, not the first message.
await p.locator(`#e${L}`).scrollIntoViewIfNeeded();
await p.locator(`#e${L} > .grow > .rq`).click();
await p.waitForTimeout(500);
s = await state();
check(s.dlg && s.to === String(L), `the thread opened from #${L}'s quote bar answers #${L} (got #${s.to})`);
await p.locator("#composer-text").press("End");
await p.keyboard.type("from the thread");
await p.keyboard.press("Enter");
await p.waitForTimeout(1200);
s = await state();
const all = await (await fetch(`${BASE}/api/boards/${board}/entries?after=0`, { headers: { authorization: `Bearer ${tok}` } })).json();
check(all.entries.find((e) => /from the thread/.test(e.text))?.reply_to === L && s.to === String(L), `sent from the thread it's a reply to #${L}, and the box stays on it`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "reply-click: all passed");
process.exit(fails ? 1 : 0);
