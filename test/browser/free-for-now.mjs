// Atteo is free for now (jxn #5631, #5636): Account → Plan says so with the plans announced for later and offers no
// Upgrade; a 4th board is created (no Free cap); checkout is refused. Phone, dark. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), U = `ffn${run}`;
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
await ops("users", { name: U, email: `${U}@example.com`, verified: "true" });
const ck = (await ops("sessions", { user: U })).cookie.split(";")[0];
const create = (title) => fetch(`${BASE}/boards`, { method: "POST", redirect: "manual", headers: { cookie: ck, "content-type": "application/x-www-form-urlencoded" }, body: `title=${encodeURIComponent(title)}` });
const made = [];
for (let i = 1; i <= 4; i++) made.push((await create(`Free ${i} ${run}`)).status);
check(made.every((s) => s === 302 || s === 303), `4 boards created, no Free cap (${made.join(", ")})`);
const co = await fetch(`${BASE}/api/billing/checkout`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: '{"interval":"month"}' });
check(co.status === 400 && /free for now/.test((await co.json()).error ?? ""), `checkout is refused (${co.status})`);

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true, hasTouch: true });
const [k, ...v] = ck.split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/me#billing`);
await p.locator("#billing").waitFor({ timeout: 8000 }).catch(() => {});
const text = `${await p.locator("#billing").innerText().catch(() => "")}\n${await p.locator("#billing + .plans").innerText().catch(() => "")}`;
check(/free for now/i.test(text), "Plan says Atteo is free for now");
check(/100 messages a day/.test(text) && /\$50 \/ month/.test(text), "…with the plans announced for later");
check((await p.locator("[data-checkout]").count()) === 0 && !/Upgrade/.test(text), "no Upgrade or checkout button");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "free-for-now: all passed");
process.exit(fails ? 1 : 0);
