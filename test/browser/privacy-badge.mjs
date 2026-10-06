// E2E Phase 0 (vedu #5452): every board says at the top of its conversation whether it's end-to-end encrypted or readable by Atteo's
// servers, and one tap explains it and lists who can read it (members' agents, Slack channels). The new-board checkbox
// says what works on encrypted boards today. Desktop and phone width; no page errors. BASE, ADMIN_KEY.
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `pv${run}`, B = `pw${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const plain = (await ops("boards", { user: A, title: `Plain ${run}` })).board.id;
const sealed = (await ops("boards", { user: A, title: `Sealed ${run}`, encrypted: true })).board.id;
for (const b of [plain, sealed]) await ops("members", { board: b, user: B });
// B's agent shows up on the plain board: a session that reads it.
const tokB = (await ops("tokens", { user: B })).token;
const sid = (await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { authorization: `Bearer ${tokB}`, "content-type": "application/json" }, body: JSON.stringify({ suggest: "scout", client: "Claude Code" }) })).json()).session?.id;
await fetch(`${BASE}/api/sessions/${sid}/boards`, { method: "POST", headers: { authorization: `Bearer ${tokB}`, "content-type": "application/json" }, body: JSON.stringify({ board: plain }) });

let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ck = (await ops("sessions", { user: A })).cookie.split(";")[0];
const [k, ...v] = ck.split("=");
const errors = [];
for (const [w, h, tag] of [[1280, 860, "desktop"], [390, 844, "phone"]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));

  await p.goto(`${BASE}/b/${plain}`);
  const badge = p.locator(".e2e-badge").first();
  await badge.waitFor({ timeout: 8000 }).catch(() => {});
  check((await badge.innerText().catch(() => "")).includes("Readable by Atteo's servers"), `${tag}: a regular board says "Readable by Atteo's servers" at the top of the conversation`);
  check(await badge.isVisible(), `${tag}: …and the badge is on screen`);
  await badge.click();
  const dlg = p.locator("#privacy-info");
  await dlg.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  const t = await dlg.innerText().catch(() => "");
  check(/isn't end-to-end encrypted/.test(t) && /Atteo staff don't look at boards/.test(t), `${tag}: one tap explains it, with the staff promise`);
  check(/Who can read this board/.test(t) && /Atteo's servers/.test(t), `${tag}: …and lists Atteo's servers as a reader`);
  if (tag === "desktop") check(t.includes(B), `the readers list names the agent on the board (${JSON.stringify(t.slice(t.indexOf("Who can read")).slice(0, 120))})`);
  check((await dlg.locator('a[href="/privacy"]').count()) === 1, `${tag}: …with a link to the privacy policy`);
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${tag}: no sideways page scroll`);
  await p.waitForTimeout(350); // the dialog fades in
  await p.screenshot({ path: `${SHOTS_DIR}/privacy-badge-plain-${tag}.png` });
  await p.keyboard.press("Escape");

  await p.goto(`${BASE}/b/${sealed}`);
  const lock = p.locator(".e2e-badge").first();
  await lock.waitFor({ timeout: 8000 }).catch(() => {});
  check((await lock.innerText().catch(() => "")).includes("End-to-end encrypted"), `${tag}: an encrypted board says 🔒 End-to-end encrypted`);
  await lock.click();
  await dlg.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  const s = await dlg.innerText().catch(() => "");
  check(/can't read them/.test(s) && /still sees the board's name/.test(s) && /Not available here yet/.test(s), `${tag}: …explained honestly: what's encrypted, what Atteo still sees, what doesn't work yet`);
  check(/Members' devices/.test(s) && !/^Atteo's servers$/m.test(s), `${tag}: …readers are members' devices, not Atteo's servers`);
  await p.waitForTimeout(350);
  await p.screenshot({ path: `${SHOTS_DIR}/privacy-badge-sealed-${tag}.png` });
  await p.keyboard.press("Escape");

  if (tag === "desktop") {
    await p.goto(`${BASE}/`);
    const copy = await p.evaluate(() => document.querySelector('#new-board input[name="encrypted"]')?.closest("label")?.innerText ?? "");
    check(/Works on the web, in the app and in the atteo CLI/.test(copy) && !/through the atteo CLI;/.test(copy), `the new-board checkbox says what works today (${JSON.stringify(copy.slice(0, 80))})`);
  }
  await ctx.close();
}
check(!errors.length, `no page errors${errors.length ? `: ${errors.slice(0, 2).join(" | ")}` : ""}`);
await b.close();
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
