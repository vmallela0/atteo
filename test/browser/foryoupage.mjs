// For you (Atteo Everyday's home, board #1272): seeds an approval from the viewer's agent (MCP request_approval), a
// human decision and a question for the viewer, and a to-do the viewer's agent finished; then checks every section
// shows, Approve and Not now work from For you, a decision button votes, the Ask bar posts to "Your agent", the empty
// state, 1280px and 390px (and 320px) light/dark with no sideways scroll, and no page errors.
// Usage: BASE=http://localhost:8787 node foryou.mjs
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), V = `fv${run}`, P = `fp${run}`, E = `fe${run}`;
await ops("users", { name: V, email: `${V}@example.com`, verified: "true", display_name: "Maya Chen" });
for (const u of [P, E]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Field trip ${run}` })).board.id;
await ops("members", { board, user: V });
const ck = {};
for (const u of [V, P, E]) ck[u] = (await ops("sessions", { user: u })).cookie;
const tok = (await ops("tokens", { user: V, label: "foryou" })).token;
const asCookie = (who, path, body) => fetch(`${BASE}${path}`, { method: body ? "POST" : "GET", headers: { cookie: ck[who], "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const asAgent = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
let rpc = 0;
const mcp = async (name, args) => {
  const r = await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
  const j = await r.json();
  return (j.result?.content ?? []).map((c) => c.text).join("\n") || JSON.stringify(j);
};

// Seed: two approvals from V's agent (the newer one shows first), a decision and a question for V, a to-do V's agent did.
console.log(await mcp("request_approval", { title: "Send the slides to the team", details: "deck.pdf to team@corner.studio", wait_seconds: 0 }).then((t) => t.split("\n")[0]));
await new Promise((r) => setTimeout(r, 20));
console.log(await mcp("request_approval", { title: "Pay $42 to Lisa for the field trip?", details: "Museum $30 + lunch $12, Fri Oct 10\nFrom: Visa ··4821", risk: "medium", wait_seconds: 0 }).then((t) => t.split("\n")[0]));
const dec = await asCookie(P, `/api/boards/${board}/entries`, { type: "decision", text: "Saturday dinner: tacos?" });
const que = await asCookie(P, `/api/boards/${board}/entries`, { type: "question", text: `@${V} can you cover the 2pm client call Thu?` });
const task = await asAgent(`/api/boards/${board}/tasks`, { title: "Booked the dentist for Tue 3pm" });
const fin = await asAgent(`/api/boards/${board}/tasks/${task.task.seq}`, { action: "update", status: "done" });
console.log(`seeded: decision #${dec.entry?.seq} question #${que.entry?.seq} task #${task.task?.seq} (${fin.task?.status})`);

let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const SHOTS = `${SHOTS_DIR}/`;
const errors = [];
async function open(who, width, scheme, height = 900) {
  const mobile = width < 500;
  const ctx = await b.newContext({ viewport: { width, height }, colorScheme: scheme, timezoneId: "America/Los_Angeles", ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const [k, ...v] = ck[who].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${width} ${scheme}: ${e.message}`));
  p.on("dialog", (d) => d.accept());
  const res = await p.goto(`${BASE}/for-you`);
  await p.waitForTimeout(700);
  return { ctx, p, status: res.status() };
}
const noSideways = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);

// Every section, at each size and theme (screenshots before anything is decided).
// The five sizes only read, so they run side by side; the steps after them act (approve, reply…), so they follow.
await Promise.all([[1280, "dark"], [1280, "light"], [390, "light"], [390, "dark"], [320, "light"]].map(([w, scheme]) => full(w, scheme)));
async function full(w, scheme) {
  const tag = `${w}px ${scheme}`;
  const { ctx, p, status } = await open(V, w, scheme);
  check(status === 200, `${tag}: GET /for-you is 200`);
  const greet = await p.locator("#fy-greet").innerText();
  check(/^Good (morning|afternoon|evening), Maya$/.test(greet), `${tag}: greeting "${greet}"`);
  const lede = await p.locator("#fy-lede").innerText();
  check(lede === "4 things need you. Your assistant did 1 more.", `${tag}: subtitle "${lede}"`);
  const card = p.locator(".fy-apc:visible");
  check((await card.count()) === 1 && /Pay \$42 to Lisa for the field trip\?/.test(await card.innerText()), `${tag}: the newest approval shows big`);
  const ct = await card.innerText();
  check(/Needs your OK/.test(ct) && /1 of 2/.test(ct) && /Your assistant asked in Field trip/.test(ct) && /Visa ··4821/.test(ct) && /Museum \$30/.test(ct), `${tag}: …with "1 of 2", who asked and where, and the detail lines`);
  check((await card.locator('[data-fy-ap="approve"]').innerText()) === "Approve $42" && (await card.locator('[data-fy-ap="reject"]').innerText()) === "Not now", `${tag}: …and Not now / Approve $42`);
  check(await p.locator("#fy-edge1").isVisible() && await p.locator('#fy-more a[href="/approvals"]').isVisible(), `${tag}: the rest peek out under it, with See all`);
  const rows = await p.locator(".fy-quick .nrow").allInnerTexts();
  check(rows.some((r) => /Saturday dinner: tacos\?/.test(r) && new RegExp(`${P[0].toUpperCase()}${P.slice(1)} · Field trip`).test(r) && /Agree/.test(r) && /Object/.test(r)), `${tag}: the decision row with its buttons`);
  check(rows.some((r) => /^Can you cover the 2pm client call Thu\?/.test(r) && /Reply/.test(r)), `${tag}: the question row with Reply`);
  check((await p.locator(`.fy-quick a.btn[href="/b/${board}#e${que.entry.seq}"]`).count()) === 1, `${tag}: Reply opens that message in its chat`);
  const done = await p.locator("#fy-done").innerText();
  check(/Done for you today · 1/.test(done.replace(/\s+/g, " ")) && /Booked the dentist for Tue 3pm/.test(done) && /Field trip .* · \d{1,2}:\d{2}/.test(done), `${tag}: Done for you today · 1 with the to-do, its chat and time`);
  check(await p.locator("#fy-ask-text").isVisible(), `${tag}: the Ask bar is there`);
  const ask = await p.locator("#fy-ask").boundingBox();
  check(ask && ask.y + ask.height <= (await p.evaluate(() => innerHeight)) && ask.y > (await p.evaluate(() => innerHeight)) - 120, `${tag}: …fixed at the bottom`);
  check(await p.locator('.side-link[href="/for-you"][aria-current="page"]').count() === 1, `${tag}: "For you" is in the sidebar, current`);
  check(await noSideways(p), `${tag}: no sideways scroll`);
  if (w !== 320) await p.screenshot({ path: `${SHOTS}foryou-${w}-${scheme}.png`, fullPage: false });
  await ctx.close();
}

// The sidebar: "For you" sits above Inbox.
{
  const { ctx, p } = await open(V, 1280, "light");
  const order = await p.$$eval(".sidebar .side-link", (xs) => xs.map((x) => x.getAttribute("href")));
  check(order.indexOf("/for-you") >= 0 && order.indexOf("/for-you") === order.indexOf("/inbox") - 1, `sidebar: For you is right above Inbox (${order.slice(0, 3).join(" ")})`);

  // Approve from For you: the API says approved and the next one moves up.
  const first = await p.locator(".fy-apc:visible").getAttribute("data-ap");
  await p.locator('.fy-apc:visible [data-fy-ap="approve"]').click();
  await p.waitForTimeout(800);
  const a1 = (await asCookie(V, `/api/approvals/${first}`)).approval;
  check(a1?.status === "approved", `Approve works from For you (${a1?.status})`);
  const next = p.locator(".fy-apc:visible");
  check((await next.count()) === 1 && /Send the slides to the team/.test(await next.innerText()) && /1 of 1/.test(await next.innerText()), "…and the next request moves up, 1 of 1");
  check(!(await p.locator("#fy-edge1").isVisible()) && !(await p.locator("#fy-more").isVisible()), "…with no stack left under it");
  check((await p.locator("#fy-lede").innerText()) === "3 things need you. Your assistant did 1 more.", `…and the count goes down (${await p.locator("#fy-lede").innerText()})`);
  // Not now denies it.
  const second = await next.getAttribute("data-ap");
  await p.locator('.fy-apc:visible [data-fy-ap="reject"]').click();
  await p.waitForTimeout(800);
  const a2 = (await asCookie(V, `/api/approvals/${second}`)).approval;
  check(a2?.status === "rejected" && (await p.locator(".fy-apc").count()) === 0, `Not now denies it and the card goes (${a2?.status})`);

  // A decision button votes.
  await p.locator(`[data-hd-seq="${dec.entry.seq}"] [data-fy-vote="agree"]`).click();
  await p.waitForTimeout(800);
  const row = await p.locator(`[data-hd-seq="${dec.entry.seq}"]`).innerText();
  const hd = (await asCookie(V, `/api/boards/${board}/entries/${dec.entry.seq}`)).entry?.human_decision;
  check(/You agreed/.test(row) && (hd?.votes ?? []).some((x) => x.user === V && x.vote === "agree"), `Agree on a decision votes (${hd?.state}, votes: ${(hd?.votes ?? []).map((x) => x.user + ":" + x.vote).join(",")})`);
  check((await p.locator("#fy-lede").innerText()) === "1 thing needs you. Your assistant did 1 more.", `…and the count goes down again (${await p.locator("#fy-lede").innerText()})`);

  // Ask your assistant: posts to "Your agent", then a toast with a link to that chat.
  const said = `Remind me to buy milk ${run}`;
  await p.fill("#fy-ask-text", said);
  check(await p.locator("#fy-send").isVisible(), "the send button shows once there's text");
  await p.press("#fy-ask-text", "Enter");
  await p.locator("#fy-toast").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const chat = (await asCookie(V, "/api/me/agent-chat", {})).board;
  const toastTxt = await p.locator("#fy-toast").innerText().catch(() => "");
  check(/Sent to your assistant/.test(toastTxt) && (await p.locator("#fy-toast-a").getAttribute("href")) === `/b/${chat}`, `the toast says "Sent to your assistant" and links to that chat (/b/${chat})`);
  const ents = await fetch(`${BASE}/api/boards/${chat}/entries?after=0`, { headers: { cookie: ck[V] } }).then((r) => r.json());
  const list = ents.entries ?? ents.updates ?? [];
  check(JSON.stringify(list).includes(said), `the message landed in "Your agent" (${list.length} entries)`);
  check((await p.inputValue("#fy-ask-text")) === "", "the box clears after sending");
  await ctx.close();
}

// The mic: hidden where Web Speech is missing, shown where it's there (the chat composer's rule).
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
  const [k, ...v] = ck[V].split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`mic: ${e.message}`));
  await p.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  await p.goto(`${BASE}/for-you`);
  await p.waitForTimeout(500);
  check(!(await p.locator("#fy-mic").isVisible()) && (await p.locator("#fy-send").isVisible()), "no Web Speech: the mic hides and the send button shows");
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => { window.webkitSpeechRecognition = function () { this.start = () => {}; this.stop = () => {}; }; });
  await p2.goto(`${BASE}/for-you`);
  await p2.waitForTimeout(500);
  check(await p2.locator("#fy-mic").isVisible(), "with Web Speech: the mic shows");
  await ctx.close();
}

// Empty state: someone with nothing waiting.
await Promise.all([[1280, "light"], [390, "dark"]].map(async ([w, scheme]) => {
  const { ctx, p } = await open(E, w, scheme);
  const txt = await p.locator("#fy").innerText();
  check(/Nothing needs you right now/.test(txt) && (await p.locator("#fy-empty").isVisible()) && (await p.locator(".fy-apc").count()) === 0 && !(await p.locator("#fy-done").isVisible()), `${w}px ${scheme}: empty state in plain words`);
  check(await noSideways(p), `${w}px ${scheme}: empty page has no sideways scroll`);
  if (w === 390) await p.screenshot({ path: `${SHOTS}foryou-empty-390-dark.png` });
  await ctx.close();
}));

// Signed out: sign in first.
{
  const r = await fetch(`${BASE}/for-you`, { redirect: "manual" });
  check(r.status === 302 || r.status === 303 || r.status === 401 || (r.status === 200 && /sign in/i.test(await r.text())), `signed out: /for-you asks you to sign in (${r.status})`);
}

check(!errors.length, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "for-you: all passed");
process.exit(fails ? 1 : 0);
