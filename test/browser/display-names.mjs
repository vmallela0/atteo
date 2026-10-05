// Display names (jxn #4369): a person shows as the name they chose wherever the web names them (messages, reply bars,
// "→ to", the sidebar's own row and chats, the board's member lists, the inbox, a chat's title), with their @handle on
// hover; no name, the handle. A name is their text: escaped, its invisible and direction-flipping characters dropped,
// and one that reads like someone else's handle carries the real @handle beside it. Agents stay "<handle>'s agent".
// Typing "@" + the start of someone's name offers them, and what goes in is still their handle.
// BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), J = `nj${run}`, V = `nv${run}`, W = `nw${run}`, N = `nn${run}`, M = `nm${run}`;
const HOSTILE = `<b>Vee</b>‮​ Dee`; // markup, a right-to-left override and a zero-width space
for (const [u, d] of [[J, "Jay Ex"], [V, HOSTILE], [W, J], [N, null], [M, "Maya"]]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display_name: d, display: { mode: "developer" } });
const board = (await ops("boards", { user: J, title: `Names ${run}` })).board.id;
for (const u of [V, W, N, M]) await ops("members", { board, user: u });
const ck = {}; for (const u of [J, V, W, N, M]) ck[u] = (await ops("sessions", { user: u })).cookie.split(";")[0];
const api = (u, path, method = "GET", body) => fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", cookie: ck[u] }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const post = async (u, body) => (await api(u, `/api/boards/${board}/entries`, "POST", body)).entry.seq;
const sV = await post(V, { text: `hello from V ${run}` });
const sW = await post(W, { text: `hello from W ${run}` });
const sN = await post(N, { text: `hello from N ${run}` });
const sM = await post(M, { text: `hello from M ${run}` });
const sJ = await post(J, { text: "my reply", reply_to: sV });
const sQ = await post(V, { type: "question", text: `a question ${run}`, to: J });
await api(V, "/api/friends/request", "POST", { user: J }); await api(J, "/api/friends/request", "POST", { user: V });
const dm = (await api(J, `/api/direct/${V}`, "POST", {})).board;

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: ck[J].split("=")[0], value: ck[J].split("=").slice(1).join("="), url: BASE }]);
const p = await ctx.newPage(), errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
await p.goto(`${BASE}/b/${board}`);
await p.locator(`#e${sQ}`).waitFor();
const who = (seq) => p.evaluate((s) => { const w = document.querySelector(`#e${s}>.grow>.meta>.who`); const n = w?.querySelector("bdi"); return { text: w?.textContent ?? "", title: n?.getAttribute("title") ?? w?.getAttribute("title") ?? "", tags: w ? [...w.querySelectorAll("*")].map((x) => x.tagName.toLowerCase()).join(",") : "" }; }, seq);
const v = await who(sV), wq = await who(sW), n = await who(sN), j = await who(sJ), m = await who(sM);
check(v.text === "<b>Vee</b> Dee" && v.title === `@${V}` && v.tags === "bdi", `a message shows its writer's name, escaped and without invisible or direction-flipping characters, @handle on hover (${JSON.stringify(v)})`);
check(wq.text === `${J} @${W}` && wq.title === `@${W}`, `a name that reads like someone else's handle carries the real @handle (${JSON.stringify(wq)})`);
check(n.text === N, `no display name: the handle (${n.text})`);
check(m.text === "Maya" && m.tags === "bdi", `a one-word name that isn't anyone's handle shows alone (${JSON.stringify(m)})`);
check(j.text === "Jay Ex", `your own messages show your name (${j.text})`);
const rest = await p.evaluate(({ sJ, sQ, J }) => ({
  rq: document.querySelector(`#e${sJ} .rq-who`)?.textContent,
  to: document.querySelector(`#e${sQ}>.grow>.meta>.to`)?.textContent,
  me: document.querySelector(".sidebar .me .truncate")?.textContent,
  members: [...document.querySelectorAll("#ch-members li b")].map((x) => x.textContent),
  peek: document.querySelector('[data-fold="members"] .fold-peek, #fold-members')?.closest("section")?.querySelector(".fold-peek")?.textContent ?? "",
}), { sJ, sQ, J });
check(rest.rq === "<b>Vee</b> Dee", `a reply's bar names who it answers by name (${rest.rq})`);
check(rest.to === "→ Jay Ex", `"→ to" names the person (${rest.to})`);
check(rest.me === "Jay Ex", `the sidebar's own row shows your name (${rest.me})`);
check(rest.members.includes("Jay Ex") && rest.members.includes("<b>Vee</b> Dee") && rest.members.includes(N), `the charter's member list uses names (${rest.members.join(" | ")})`);
// The mention menu: "@maya" offers M (handle nm…), and what goes in is the handle.
await p.locator("#composer-text").fill("");
await p.locator("#composer-text").pressSequentially("@maya");
const opt = await p.locator("#mention-menu li[role=option]").first().textContent().catch(() => "");
await p.keyboard.press("Enter");
const typed = await p.locator("#composer-text").inputValue();
check(opt.includes("Maya") && opt.includes(`@${M}`) && typed.startsWith(`@${M}`), `typing someone's name offers them; their handle goes in ("${opt}" → "${typed}")`);
await p.locator("#composer-text").fill("");
// A direct chat: the sidebar and the title.
const side = await p.evaluate((dm) => document.querySelector(`.sidebar a[href="/b/${dm}"] .truncate`)?.textContent, dm);
check(side === "<b>Vee</b> Dee", `the sidebar names a direct chat by the other person's name (${side})`);
await p.goto(`${BASE}/b/${dm}`);
const title = await p.locator("#board-title").textContent();
check(title === "Jay Ex ↔ <b>Vee</b> Dee", `a direct chat's title reads with names (${title})`);
// The inbox.
await p.goto(`${BASE}/inbox`);
const inbox = await p.evaluate(() => [...document.querySelectorAll(".inbox-item .small>b")].map((x) => x.textContent));
check(inbox.some((x) => x === "<b>Vee</b> Dee"), `the inbox names people by name (${inbox.join(" | ")})`);
check(!errors.length, `no page errors or script dialogs ${errors.join(" | ")}`);
// Choosing one (#4429): a name that reads as an agent, a handle, or another person's handle (look-alikes too) is refused.
const setName = async (d) => (await fetch(`${BASE}/api/me/profile`, { method: "POST", headers: { "content-type": "application/json", cookie: ck[M] }, body: JSON.stringify({ display_name: d }) })).status;
const refused = await Promise.all([`${J}'s agent`, `My Assistant’s agent`, `@${J}`, J.replace("j", "\u0458"), [...J].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("")].map(setName));
const fine = await setName("Maya Chen");
check(refused.every((s) => s === 400) && fine === 200, `a chosen name can't read as an agent or pass for another handle (${refused.join(",")}; a plain name ${fine})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "display names: all passed");
process.exit(fails ? 1 : 0);
