// The "Atteo was updated · Reload" bar is one piece (jxn #4304, #4325): Reload keeps its corners and sits the same inset
// on top, right and bottom, and the bar's corners are the button's radius plus that inset, so the edges line up. The bar is built the way the page builds it. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const u = `ub${Date.now().toString(36).slice(-4)}`;
await ops("users", { name: u, email: `${u}@example.com`, verified: "true" }); const ck = (await ops("sessions", { user: u })).cookie.split(";")[0];
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 800, height: 400 } });
const [k, ...v] = ck.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); await p.goto(`${BASE}/people`);
const m = await p.evaluate(() => { const b = document.createElement("div"); b.className = "upd-bar"; b.innerHTML = '<span>Atteo was updated</span><button class="btn sm primary" type="button">Reload</button>'; document.body.appendChild(b);
  const r = b.getBoundingClientRect(), q = b.querySelector("button").getBoundingClientRect(), bs = getComputedStyle(b), qs = getComputedStyle(b.querySelector("button"));
  return { top: Math.round(q.top - r.top), right: Math.round(r.right - q.right), bottom: Math.round(r.bottom - q.bottom), btnR: parseFloat(qs.borderTopLeftRadius), barR: parseFloat(bs.borderTopLeftRadius), border: parseFloat(bs.borderTopWidth) }; });
check(m.top === m.right && m.right === m.bottom && m.btnR < 12 && Math.abs(m.barR - (m.btnR + m.top)) <= 1, `Reload is evenly inset and the bar takes its corners (${JSON.stringify(m)})`);
await b.close(); console.log(fails ? `${fails} FAILED` : "update pill: all passed"); process.exit(fails ? 1 : 0);
