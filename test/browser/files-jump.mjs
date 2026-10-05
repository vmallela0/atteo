// Show in chat (jxn #4359): a file in the Files tab links to the message that posted the version you're viewing, through
// the board's jump (older messages load, the message is centred and tinted). v1 is posted 90 messages back, outside the
// 80 the page loads; v2 is recent. A file whose message was unsent has no link.
// Usage: BASE=http://localhost:8787 node files-jump.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `fj${run}`, V = `fk${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Files jump ${run}` })).board.id;
await ops("members", { board, user: V });
const ck = (await ops("sessions", { user: P })).cookie, tokV = (await ops("tokens", { user: V })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokV}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
const seqOf = (t) => +(/#(\d+)/.exec(t)?.[1] ?? 0);
const post = (text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck.split(";")[0] }, body: JSON.stringify({ text }) });
const F = `notes-${run}.md`;
await mcp("read", {});
const v1 = seqOf(await mcp("post", { type: "artifact", text: "first draft", artifact_name: F, artifact_content: "# v1" }));
for (let i = 0; i < 90; i += 10) await Promise.all(Array.from({ length: 10 }, (_, k) => post(`filler ${i + k} ${run}`)));
await mcp("read", {});
const v2 = seqOf(await mcp("post", { type: "artifact", text: "second draft", artifact_name: F, artifact_content: "# v2" }));
await mcp("read", {});
const gone = seqOf(await mcp("post", { type: "artifact", text: "oops", artifact_name: `gone-${run}.md`, artifact_content: "x" }));
await mcp("retract", { seq: gone, reason: "posted by mistake" });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 } });
const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}#files`);
const open = async (name) => { await p.locator(`#doc-items [data-doc="${name}"]`).click(); await p.locator("#doc-view b.mono", { hasText: name }).waitFor(); };
const centred = (seq) => p.locator(`#e${seq}`).evaluate((el) => { const r = el.getBoundingClientRect(); return el.classList.contains("hit") && r.top < innerHeight && r.bottom > 0; });

await open(`gone-${run}.md`);
check(await p.locator("#doc-view a", { hasText: "Show in chat" }).count() === 0, "a file whose message was unsent has no Show in chat");

await open(F);
const link = p.locator("#doc-view a", { hasText: "Show in chat" });
check(await link.getAttribute("href") === `#e${v2}`, `the latest version links to its own message (#${v2})`);
// v1 from History, then by keyboard: its message is older than the page holds.
await p.locator("#doc-hist").click(); await p.locator(`#doc-history [data-ver="1"]`).click();
await p.locator("#doc-view .xs", { hasText: "v1" }).first().waitFor();
check(await link.getAttribute("href") === `#e${v1}` && await p.locator(`#e${v1}`).count() === 0, `v1 links to its own message (#${v1}), not loaded yet`);
await link.focus(); await p.keyboard.press("Enter");
await p.locator(`#e${v1}.hit`).waitFor({ timeout: 8000 }).catch(() => {});
await p.waitForFunction((s) => { const r = document.getElementById("e" + s)?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= innerHeight; }, v1, { timeout: 3000 }).catch(() => {}); // the smooth scroll
check(!(await p.locator("#panel-conv").isHidden()) && await centred(v1) && p.url().endsWith(`#e${v1}`), "Enter on it loads the older messages, lands on v1's message and tints it");
await p.screenshot({ path: `${process.env.SHOTS_DIR || "/tmp"}/files-jump.png` });
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "files jump: all passed");
process.exit(fails ? 1 : 0);
