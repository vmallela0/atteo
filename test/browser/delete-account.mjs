// Delete account on the web (Apple 5.1.1(v); jxn #4329): Account → Delete account. The handle typed back sends a code to
// the account's email; the code deletes it (a wrong one is refused). The button stays off until the
// handle is typed back; then the account is gone, you land signed out, and a shared board shows what you wrote as
// "Deleted user". Light 1280 and dark 390, each its own person. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4);
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
await Promise.all([[1280, 800, "light"], [390, 844, "dark"]].map(async ([w, h, scheme]) => {
  const tag = `${w}px ${scheme}`, phone = w < 500;
  const P = `dl${run}${w}`, O = `do${run}${w}`;
  await ops("users", { name: P, email: `${P}@example.com`, verified: "true" });
  await ops("users", { name: O, email: `${O}@example.com`, verified: "true" });
  const board = (await ops("boards", { user: O, title: `Shared ${run}` })).board.id;
  await ops("members", { board, user: P });
  const ckP = (await ops("sessions", { user: P })).cookie.split(";")[0], ckO = (await ops("sessions", { user: O })).cookie.split(";")[0];
  const said = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ckP, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text: `before I leave ${run}` }) });
  check(said.ok, `${tag}: posted on the shared board (${said.status})`);
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const [k, ...v] = ckP.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/me`);
  const go = p.locator("#delete-go");
  await go.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
  check(await go.isDisabled(), `${tag}: Delete my account is off until the handle is typed`);
  await p.locator("#delete-confirm").fill("someone-else");
  check(await go.isDisabled(), `${tag}: a wrong handle keeps it off`);
  await p.locator("#delete-confirm").fill(P);
  check(!(await go.isDisabled()), `${tag}: the right handle turns it on`);
  // Step 1 emails a code to the account (jxn's agent #4414); the local server's code is 000000.
  const [sent] = await Promise.all([p.waitForResponse((r) => r.url().endsWith("/api/me/delete-code")), go.click()]);
  check(sent.status() === 200, `${tag}: a code is sent (${sent.status()})`);
  await p.locator("#delete-code").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  check(await go.isDisabled(), `${tag}: the code field shows, and Delete waits for 6 digits`);
  await p.locator("#delete-code").fill("123123");
  const [wrong] = await Promise.all([p.waitForResponse((r) => r.url().endsWith("/api/me") && r.request().method() === "DELETE"), go.click()]);
  check(wrong.status() === 400 && (await p.locator("#delete-code").isVisible()), `${tag}: a wrong code is refused and the field stays (${wrong.status()})`);
  await p.locator("#delete-code").fill("000000");
  const [res] = await Promise.all([p.waitForResponse((r) => r.url().endsWith("/api/me") && r.request().method() === "DELETE"), go.click()]);
  check(res.status() === 200, `${tag}: deleted (${res.status()})`);
  await p.waitForURL((u) => !u.pathname.startsWith("/me"), { timeout: 8000 }).catch(() => {});
  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: ckP } });
  check(me.status === 401 || me.status === 302, `${tag}: the session no longer signs in (${me.status})`);
  const html = await (await fetch(`${BASE}/b/${board}`, { headers: { cookie: ckO } })).text();
  check(html.includes(`before I leave ${run}`) && html.includes("Deleted user"), `${tag}: the other member still sees the message, by "Deleted user"`);
  check(!errors.length, `${tag}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}));
await b.close();
console.log(fails ? `${fails} FAILED` : "delete-account: all passed");
process.exit(fails ? 1 : 0);
