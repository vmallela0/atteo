// Board calls (vedu #5383, src/calls.ts + src/callWeb.ts) against the local stub room (no Cloudflare Realtime app here,
// so no audio): two people open the board, press Call, join the same call and see each other; Ask Atteo answers with
// voice's own words (not set up here) and frees the turn; the last one out ends it and the board gets the call's post
// and its summary. Also the call's page of its own (/b/:id/call, what the app opens).
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `ca${run}`, B = `cb${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Call ${run}` })).board.id;
await ops("members", { board, user: B });
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const open = async (user, path = `/b/${board}`) => {
  const ck = (await ops("sessions", { user })).cookie;
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${user}: ${e.message}`));
  await p.goto(BASE + path);
  return { ctx, p, ck };
};
const names = (p) => p.locator("#call-people li b").allInnerTexts();
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

const a = await open(A), bb = await open(B);
check(await a.p.locator(`[data-call="${board}"]`).isVisible(), "the board's header has a Call button");
await a.p.click(`[data-call="${board}"]`);
await a.p.locator("dialog.call-dlg #call-join").waitFor({ state: "visible", timeout: 8000 });
check((await a.p.locator("#call-join").innerText()).trim() === "Start a call" && (await a.p.locator("#call-people").innerText()).includes("Nobody"), "with no call on, the dialog offers to start one");
await a.p.click("#call-join");
check(await until(async () => (await names(a.p)).join() === A), "the first to join is in the call");
check(await until(async () => (await a.p.locator("#call-st").innerText()).includes("Test room")), "the stub room says there's no audio here");

await bb.p.click(`[data-call="${board}"]`);
await bb.p.locator("dialog.call-dlg #call-join").waitFor({ state: "visible", timeout: 8000 });
check(await until(async () => (await bb.p.locator("#call-join").innerText()).trim() === "Join call" && (await names(bb.p)).join() === A), "the second person sees the call on, and who's in it, before joining");
await bb.p.click("#call-join");
check(await until(async () => (await names(bb.p)).sort().join() === [A, B].sort().join()), "after joining, both are listed on the second page");
check(await until(async () => (await names(a.p)).sort().join() === [A, B].sort().join()), "and the first page sees the second person join (the 2 s ping)");
check(await bb.p.locator("#call-ask").isVisible() && await bb.p.locator("#call-leave").isVisible(), "in the call: Ask Atteo and Leave");
await a.p.screenshot({ path: `${SHOTS_DIR}/calls-two.png` });

// Ask Atteo: no xAI key on this server, so voice's own "not set up" comes back and the turn is let go.
await a.p.click("#call-ask");
check(await until(async () => (await a.p.locator("#call-st.err").innerText()).length > 0), "Ask Atteo without voice set up says so");
const st = await (await fetch(`${BASE}/api/boards/${board}/call`, { headers: { cookie: bb.ck } })).json();
check(st.call && st.call.atteo === null, "and nobody is left holding the Atteo turn");

// The post: "Started a call" from the first person.
await a.p.locator("dialog.call-dlg").evaluate((d) => d.close());
check(await until(async () => (await a.p.locator("#thread").innerText().catch(() => a.p.locator("body").innerText())).includes("Started a call")), "the board shows the call's post");

// The call's own page (what the app opens) shows the same call.
const pg = await open(A, `/b/${board}/call`);
check(await until(async () => (await names(pg.p)).sort().join() === [A, B].sort().join()), "/b/:id/call shows the call and who's in it");
await pg.ctx.close();

// Leaving: the first leaves, the second sees it; the last one out ends the call and the summary is posted.
await a.p.click(`[data-call="${board}"]`);
await a.p.click("#call-leave");
check(await until(async () => (await names(bb.p)).join() === B), "when one leaves, the other sees it");
await bb.p.click("#call-leave");
check(await until(async () => (await bb.p.locator("#call-people").innerText()).includes("Nobody")), "the last one out ends the call");
await bb.p.screenshot({ path: `${SHOTS_DIR}/calls-ended.png` });
await bb.p.locator("dialog.call-dlg").evaluate((d) => d.close());
check(await until(async () => (await bb.p.locator("body").innerText()).includes("Call ended after"), 10000), "the board gets the summary: who joined, how long");
check(await until(async () => (await bb.p.locator("body").innerText()).includes(`Joined: ${A}, ${B}.`)), "naming both people");
await bb.p.screenshot({ path: `${SHOTS_DIR}/calls-summary.png` });
check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all call checks passed");
process.exit(fails ? 1 : 0);
