// atteo host on the web (docs/HOST.md; vedu #4807/#4815): while a member's machine is attached and online, the board
// shows a red banner naming it; the side panel lists it with Stop (its owner, or the board's owner); Attach a machine
// opens a dialog whose button stays disabled until "I understand what I'm doing" is typed exactly, and then hands out
// a one-time `atteo host --token …` command. Stop clears the banner. Light 1280. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `ho${run}`, Q = `hq${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Hosts ${run}` })).board.id;
await ops("members", { board, user: Q });
const tq = (await ops("tokens", { user: Q })).token;
const qapi = async (path, body) => (await fetch(`${BASE}/api/boards/${board}/hosts${path}`, { method: "POST", headers: { authorization: `Bearer ${tq}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();
const { token } = await qapi("/confirm", { phrase: "I understand what I'm doing" });
const { host } = await qapi("", { token, name: `qbox${run}`, shares: ["/home/q/proj"] });
const ck = (await ops("sessions", { user: P })).cookie.split(";")[0];
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
const [k, ...v] = ck.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused/.test(m.text())) errors.push(m.text()); });
await p.goto(`${BASE}/b/${board}`);
const ban = p.locator("#host-ban");
await ban.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
const text = await ban.innerText().catch(() => "");
check(text.includes(`${Q}'s qbox${run}`) && /Machine attached/.test(text), `a red banner names the attached machine ("${text.slice(0, 120)}")`);
const red = await p.evaluate(() => { const s = getComputedStyle(document.getElementById("host-ban")); return s.backgroundColor; });
const inter = await p.evaluate(() => { const d = document.createElement("div"); d.style.background = "var(--intervene)"; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; });
check(red === inter, `the banner is the intervention colour (${red} vs ${inter})`);
const side = await p.evaluate(() => document.querySelector("#host-side .host-list")?.innerText || "");
check(side.includes(`qbox${run}`) && side.includes("/home/q/proj") && side.includes("Stop"), `the side panel lists it with Stop for the board's owner ("${side.replace(/\s+/g, " ").slice(0, 120)}")`);
// Attach a machine: the button waits for the exact phrase.
await p.evaluate(() => document.querySelector("[data-host-attach]").click());
const dlg = p.locator("#host-dlg");
await dlg.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
check(await dlg.isVisible(), "Attach a machine opens the warning dialog");
check(await p.locator("#host-go").isDisabled(), "…its button starts disabled");
await p.fill("#host-ph", "i understand");
check(await p.locator("#host-go").isDisabled(), "…stays disabled for anything but the exact phrase");
await p.fill("#host-ph", "I understand what I'm doing");
check(!(await p.locator("#host-go").isDisabled()), "…and enables once it's typed exactly");
await p.click("#host-go");
await p.locator("#host-cmd pre").waitFor({ timeout: 5000 }).catch(() => {});
const cmd = await p.locator("#host-cmd pre").innerText().catch(() => "");
check(new RegExp(`^atteo host --board ${board} --token hc_\\S+ --share \\.$`).test(cmd.trim()), `…and hands out a one-time command ("${cmd.trim().slice(0, 60)}…")`);
await p.keyboard.press("Escape");
// Stop, from the banner: it goes, and the server knows who stopped it.
await p.locator(`#host-ban [data-host-stop="${host.id}"]`).click();
await ban.waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
check(!(await ban.count()), "Stop clears the banner");
const after = await (await fetch(`${BASE}/api/boards/${board}/hosts`, { headers: { authorization: `Bearer ${tq}` } })).json();
check(after.hosts.find((h) => h.id === host.id)?.stopped_by === P, "…and the machine is stopped, by the board's owner");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all host checks passed");
process.exit(fails ? 1 : 0);
