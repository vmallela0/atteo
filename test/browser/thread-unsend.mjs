// Unsending inside an open thread (vedu #4761): your own reply in the thread has its Unsend (others' don't, unless you
// own the board), the same two-tap confirm as the chat, and the unsent reply shows as unsent in the thread and the chat.
// Usage: BASE=http://localhost:8787 PW_CHROME=… node thread-unsend.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `tu${run}`, B = `tv${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: A, title: `Thread unsend ${run}` })).board.id;
await ops("members", { board, user: B });
const ckA = (await ops("sessions", { user: A })).cookie, ckB = (await ops("sessions", { user: B })).cookie;
const post = async (ck, body) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(body) })).json()).entry.seq;
const root = await post(ckA, { text: `thread root ${run}` });
const theirs = await post(ckA, { text: `their reply ${run}`, reply_to: root });
const mine = await post(ckB, { text: `my reply to unsend ${run}`, reply_to: root });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const [k, ...v] = ckB.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
await p.locator(`#e${root}`).waitFor();
await p.locator(`#e${root} [data-thread]`).first().click();
const myCopy = p.locator(`#thr-list [data-src="${mine}"]`), theirCopy = p.locator(`#thr-list [data-src="${theirs}"]`);
await myCopy.waitFor({ timeout: 5000 });
const un = myCopy.locator("[data-retract]");
check(await un.count() === 1, "my reply in the thread has its Unsend");
check(await theirCopy.locator("[data-retract]").count() === 0, "someone else's reply in the thread doesn't (I don't own the board)");
await myCopy.hover();
await un.click();
check(/Unsend #/.test(await un.textContent()), "the first tap asks to confirm, like in the chat");
await un.click();
await p.waitForFunction((s) => document.getElementById("e" + s)?.classList.contains("retracted"), mine, { timeout: 8000 }).catch(() => {});
check(await p.locator(`#e${mine}.retracted`).count() === 1, "the chat shows it unsent");
await p.waitForFunction((s) => document.querySelector(`#thr-list [data-src="${s}"]`)?.classList.contains("retracted"), mine, { timeout: 8000 }).catch(() => {});
check(await p.locator(`#thr-list [data-src="${mine}"].retracted`).count() === 1, "so does the open thread, without reopening it");
check(await p.locator(`#thr-list [data-src="${mine}"] [data-retract]`).count() === 0, "and its Unsend is gone");
check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all thread unsend checks passed");
process.exit(fails ? 1 : 0);
