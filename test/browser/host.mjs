// atteo host on the web (docs/HOST.md; vedu #4807/#4815): while a member's machine is attached and online, the board
// shows a red banner naming it; the side panel lists it with Stop (its owner, or the board's owner); Attach a machine
// says how to start atteo host; its link opens the consent, whose button stays disabled until "I understand what I'm
// doing" is typed exactly, and then shows a one-time code for that machine. Stop clears the banner. Light 1280. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `ho${run}`, Q = `hq${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Hosts ${run}` })).board.id;
await ops("members", { board, user: Q });
const tq = (await ops("tokens", { user: Q })).token;
const qapi = async (path, body) => (await fetch(`${BASE}/api/boards/${board}/hosts${path}`, { method: "POST", headers: { authorization: `Bearer ${tq}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();
// Q's machine: the code is minted by Q as a person (an agent's token can't), for one machine, and spent once.
const qck = (await ops("sessions", { user: Q })).cookie.split(";")[0];
const QM = `m_browserq${run}xyz`;
const { code: qcode } = await (await fetch(`${BASE}/api/boards/${board}/hosts/confirm`, { method: "POST", headers: { cookie: qck, "content-type": "application/json" }, body: JSON.stringify({ phrase: "I understand what I'm doing", machine: QM, shares: ["/home/q/proj"], allow: [] }) })).json();
const { host } = await qapi("", { code: qcode, machine: QM, name: `qbox${run}`, shares: ["/home/q/proj"], allow: [] });
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
// A polite status, rewritten only when it changes, so a screen reader doesn't re-read it every poll (#4932).
check((await ban.getAttribute("role")) === "status" && (await ban.getAttribute("aria-live")) === "polite", "the banner is a polite status, not an alert");
await ban.evaluate((e) => { e.firstElementChild.dataset.same = "1"; });
await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // the banner reloads on this
await p.waitForTimeout(2000);
check(await ban.evaluate((e) => e.firstElementChild?.dataset.same === "1").catch(() => false), "…and a poll with nothing new leaves it untouched");
const geo = await p.evaluate(() => { const b = document.getElementById("host-ban").getBoundingClientRect(), t = document.getElementById("thread-scroll").getBoundingClientRect(); return { bh: Math.round(b.height), bw: Math.round(b.width), th: Math.round(t.height), tw: Math.round(t.width), above: b.bottom <= t.top + 1 }; });
check(geo.bh < 140 && geo.above && geo.th > 200 && geo.tw >= geo.bw - 40, `the banner is a strip above the messages, not a wall over them (jxn #4899): ${JSON.stringify(geo)}`);
const side = await p.evaluate(() => document.querySelector("#host-side .host-list")?.innerText || "");
check(side.includes(`qbox${run}`) && side.includes("/home/q/proj") && side.includes("Stop"), `the side panel lists it with Stop for the board's owner ("${side.replace(/\s+/g, " ").slice(0, 120)}")`);
// Attach a machine, from the side panel: how to start atteo host there (no phrase here: that comes from its link).
await p.evaluate(() => document.querySelector("[data-host-attach]").click());
const dlg = p.locator("#host-dlg");
await dlg.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
const how = await dlg.innerText().catch(() => "");
check(how.includes(`atteo host --board ${board} --share .`) && !(await p.locator("#host-ph").count()), `Attach a machine says how to start it, with no phrase box ("${how.replace(/\s+/g, " ").slice(0, 100)}")`);
await p.keyboard.press("Escape");
// atteo host's link: the consent for that machine. The button waits for the exact phrase; the code works once there.
// A link from an older atteo host (no folders in it) can't be confirmed: it says to update (#4917).
await p.goto(`${BASE}/host/consent?board=${board}&machine=m_browserold${run}xyz`);
await p.locator("#host-dlg").waitFor({ timeout: 8000 }).catch(() => {});
const old = await p.locator("#host-dlg").innerText().catch(() => "");
check(/update atteo/i.test(old) && !(await p.locator("#host-ph").count()), `a link without its folders can't be confirmed ("${old.replace(/\s+/g, " ").slice(0, 100)}")`);
await p.keyboard.press("Escape");
const PM = `m_browserp${run}xyz`;
const pscope = { shares: ["/home/p/proj"], allow: ["make test"], network: true };
await p.goto(`${BASE}/host/consent?board=${board}&machine=${PM}&scope=${Buffer.from(JSON.stringify(pscope)).toString("base64url")}`);
await p.locator("#host-ph").waitFor({ timeout: 8000 }).catch(() => {});
check(await p.locator("#host-dlg").isVisible() && !new URL(p.url()).searchParams.has("host_consent"), `the link opens the consent dialog (and tidies the address: ${p.url()})`);
const shown = await p.locator("#host-dlg").innerText().catch(() => "");
check(shown.includes("/home/p/proj") && shown.includes("make test"), `the consent shows exactly which folders and commands it allows (#4917): "${shown.replace(/\s+/g, " ").slice(0, 160)}"`);
check(/Network on \(--allow-network\)/.test(shown), "…and that this host has network, in words (jxn #4945)");
check(await p.locator("#host-go").isDisabled(), "…its button starts disabled");
await p.fill("#host-ph", "i understand");
check(await p.locator("#host-go").isDisabled(), "…stays disabled for anything but the exact phrase");
await p.fill("#host-ph", "I understand what I'm doing");
check(!(await p.locator("#host-go").isDisabled()), "…and enables once it's typed exactly");
await p.click("#host-go");
await p.locator("#host-code").waitFor({ timeout: 5000 }).catch(() => {});
const pcode = (await p.locator("#host-code").innerText().catch(() => "")).trim();
check(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(pcode), `…and shows a one-time code ("${pcode}")`);
const tp = (await ops("tokens", { user: P })).token;
const reg = (body) => fetch(`${BASE}/api/boards/${board}/hosts`, { method: "POST", headers: { authorization: `Bearer ${tp}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const first = await reg({ code: pcode, machine: PM, name: `pbox${run}`, ...pscope });
const again = await reg({ code: pcode, machine: PM, name: `pbox2${run}`, ...pscope });
check(first.status === 200 && again.status === 403, `the code attaches that machine once (${first.status}, then ${again.status})`);
const phost = first.ok ? (await first.json()).host : null;
check(phost?.network === true, "the host attaches with the network the person saw");
await p.keyboard.press("Escape");
// Q's agent asks P's machine for a long command with a look-alike letter. P's approval names Q's agent, shows the whole
// command in every mode, nothing clipped, and flags the non-ASCII letter (#4926/#4927/#4929/#4930).
const longCmd = Array.from({ length: 30 }, (_, i) => `echo line ${i}`).join("\n") + `\ncаt notes.txt # last ${run}`;
const asked = phost ? await (await fetch(`${BASE}/api/boards/${board}/hosts/${phost.id}/runs`, { method: "POST", headers: { authorization: `Bearer ${tq}`, "content-type": "application/json" }, body: JSON.stringify({ command: longCmd }) })).json() : {};
const apId = asked.run?.approval;
await p.goto(`${BASE}/approvals`);
const card = p.locator(`article.approval[id="${apId}"]`);
await card.waitFor({ timeout: 10000 }).catch(() => {});
const cardText = await card.innerText().catch(() => "");
check(!!apId && cardText.includes(`${Q}'s agent`) && !/Your agent/.test(cardText) && !(await card.locator('a[href*="#enull"]').count()), `the approval names whose agent asked (#4930): "${cardText.replace(/\s+/g, " ").slice(0, 140)}"`);
for (const mode of ["developer", "everyday"]) {
  await p.evaluate((m) => { document.documentElement.dataset.mode = m; }, mode);
  const box = await card.locator(".ap-cmd").evaluate((e) => ({ vis: getComputedStyle(e).display !== "none", last: e.innerText.includes("# last"), sh: e.scrollHeight, ch: e.clientHeight })).catch(() => ({}));
  check(box.vis && box.last && box.sh <= box.ch + 1, `${mode}: the whole command is on screen, nothing scrolled away (#4926/#4927): ${JSON.stringify(box)}`);
}
check((await card.locator(".apc-u").count()) > 0 && (await card.locator(".apc-u-note").count()) === 1, "the look-alike letter is highlighted, with a note (#4929)");
// Stop closes that approval, so it can't be approved afterwards (#4931).
if (phost) await fetch(`${BASE}/api/boards/${board}/hosts/${phost.id}/stop`, { method: "POST", headers: { authorization: `Bearer ${tp}` } });
const ap = await (await fetch(`${BASE}/api/approvals/${apId}`, { headers: { authorization: `Bearer ${tp}` } })).json().catch(() => ({}));
check((ap.approval ?? ap).status === "rejected", `Stop closes the waiting approval (${(ap.approval ?? ap).status})`);
await p.goto(`${BASE}/b/${board}`);
await ban.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
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
