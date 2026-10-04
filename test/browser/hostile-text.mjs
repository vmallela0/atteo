// Text other people write shows as text on every web page and never runs (coordinator #2107 item 2). An attacker sets
// HTML, script and markdown payloads in everything a person can type that someone else sees: their display name, bio
// and agent name, a board title, an invitation, a file name, a task title, a friend request, a message (raw HTML,
// javascript: links, image tricks, tables, code, a chart), the board's soul, memory, a schedule, a pinned doc and a
// decision, and an approval title their victim's agent was talked into. The victim then opens every page those reach
// (Developer and Everyday, 1280 and 390px). Each payload sets window.__pwned if it ever runs.
// Fails on: any alert/confirm, window.__pwned set, an element the payloads made (an on* attribute, a javascript: or
// data: link), a page error (a quote breaking a page script), or a title or name that isn't shown as written.
// Usage: BASE=http://localhost:8787 node hostile-text.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `ha${run}`, B = `hb${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const ckA = (await ops("sessions", { user: A })).cookie, ckB = (await ops("sessions", { user: B })).cookie;
const tokA = (await ops("tokens", { user: A })).token, tokB = (await ops("tokens", { user: B })).token;
const web = async (ck, path, body, method = "POST") => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) console.log(`  (setup ${method} ${path}: ${r.status} ${t.slice(0, 120)})`);
  return j;
};
const mcp = async (tok, board, name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text ?? "";

// The payloads. Short ones where the field is short (a display name is 60 characters, a title 8 words).
const img = (n) => `<img src=x onerror=__pwned=${n}>`;
const DISPLAY = `"'><img src=x onerror=__pwned=1>`;
const BIO = `</script><svg onload=__pwned=2> ${img(3)} [x](javascript:__pwned=4)`;
const AGENT = `D'Arcy ${run}`; // agent names allow letters, digits, spaces, _ ' -: the quote is the risk
const TITLE1 = `</script><svg onload=__pwned=5>'"`;
const TITLE2 = `${img(6)} t2`;
const TASK = `${img(7)} "q' task`;
const FILE = `<img onerror=__pwned=8>.html`;
const NOTE = `${img(9)} </script><script>__pwned=10</script>`;
const APPROVAL = `${img(11)} '"approve`;
const MSG = [
  `@${B} hello ${run}`,
  `[click](javascript:__pwned=51) [x](JaVaScRiPt:__pwned=52) [y](<javascript:__pwned=53>) [z](&#106;avascript:__pwned=54) [w](java\tscript:__pwned=55)`,
  `![pic](x" onerror="__pwned=56) <img src=x onerror=__pwned=57> <a href="javascript:__pwned=58">a</a> <javascript:__pwned=59>`,
  `**<svg onload=__pwned=60>** _<b onmouseover=__pwned=61>b</b>_ \`</code><img src=x onerror=__pwned=62>\``,
  `[t](https://example.com "a\\" onmouseover=\\"__pwned=63") [d](data:text/html,<script>__pwned=64</script>)`,
  ``,
  `| a | b |`,
  `| --- | --- |`,
  `| ${img(65)} | </td></tr></table><img src=x onerror=__pwned=66> |`,
  ``,
  "```html",
  `<img src=x onerror=__pwned=67></code></pre><img src=x onerror=__pwned=68>`,
  "```",
  "```chart",
  `{"type":"bar","title":"<img src=x onerror=__pwned=69>","x":["<svg onload=__pwned=70>"],"series":[{"name":"</text><svg onload=__pwned=71>","values":[1]}],"unit":"'\\"><img src=x onerror=__pwned=72>"}`,
  "```",
].join("\n");

// The attacker's side.
await web(ckA, "/api/me/profile", { display_name: DISPLAY, bio: BIO, agent_name: AGENT });
const b1 = (await ops("boards", { user: A, title: TITLE1 })).board.id;
await ops("members", { board: b1, user: B });
const b2 = (await ops("boards", { user: A, title: TITLE2 })).board.id;
await web(ckA, `/api/boards/${b2}/invites`, { email: `${B}@example.com` });
await web(ckA, `/api/boards/${b1}/entries`, { text: MSG });
await web(ckA, `/api/boards/${b1}/tasks`, { title: TASK });
await mcp(tokA, b1, "read", {});
await mcp(tokA, b1, "post", { type: "artifact", text: `a file ${img(12)}`, artifact_name: FILE, artifact_content: `<p>${img(13)}</p>` });
await mcp(tokA, b1, "post", { type: "note", text: `@${B} from my agent ${img(14)} [x](javascript:__pwned=15)` });
await web(ckA, "/api/friends/request", { user: B, note: NOTE });
const link = await web(ckA, `/api/boards/${b1}/links`, {});
// The board's own words: its soul, a memory item, a schedule, a pinned doc and a decision.
await web(ckA, `/api/boards/${b1}/soul`, { text: `# Rules ${img(20)}\n[x](javascript:__pwned=21) </script><script>__pwned=22</script>` }, "PUT");
await web(ckA, `/api/boards/${b1}/memory`, { text: `remember ${img(23)} '"` });
await web(ckA, `/api/boards/${b1}/schedules`, { title: `${img(24)} '"sync`, at: "09:00", tz: "Europe/Berlin", days: "weekdays" });
await mcp(tokA, b1, "post", { type: "artifact", text: "the plan", artifact_name: "plan.md", artifact_content: `# Plan ${img(25)}\n[x](javascript:__pwned=26)` });
await web(ckA, `/api/boards/${b1}/pin`, { name: "plan.md" });
await web(ckA, `/api/boards/${b1}/entries`, { type: "decision", text: `${img(27)} '"we ship\n\nbecause <svg onload=__pwned=28>` });
// The victim's own agent, talked into asking for something with a hostile title.
await mcp(tokB, b1, "read", {});
await mcp(tokB, b1, "request_approval", { title: APPROVAL, details: `${img(16)}\n</script><script>__pwned=17</script>`, risk: "high", wait_seconds: 0 });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const [ckName, ...ckVal] = ckB.split(";")[0].split("=");
await ctx.addCookies([{ name: ckName, value: ckVal.join("="), url: BASE }]);
const p = await ctx.newPage();
let dialogs = [], errors = [];
p.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
p.on("pageerror", (e) => errors.push(e.message));

// What the payloads would leave behind if any reached the page as markup.
const scan = () => p.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll("*")) {
    for (const a of el.attributes) {
      const v = a.value || "";
      if (/^on/i.test(a.name) && /__pwned/.test(v)) bad.push(`${el.tagName.toLowerCase()}[${a.name}]`);
      if (/^(href|src|action|formaction|xlink:href|data)$/i.test(a.name) && /^\s*(javascript|data:text\/html)/i.test(v.replace(/[\u0000- ]/g, ""))) bad.push(`${el.tagName.toLowerCase()}[${a.name}=${v.slice(0, 30)}]`);
    }
  }
  for (const a of document.querySelectorAll("a[href]")) if (/^(javascript|data):$/i.test(a.protocol)) bad.push(`a ${a.protocol}`);
  return { pwned: window.__pwned ?? null, bad: [...new Set(bad)] };
});
const visit = async (label, path, also) => {
  dialogs = []; errors = [];
  await p.goto(`${BASE}${path}`); await p.waitForTimeout(900);
  const text = await p.evaluate(() => document.body.innerText + "\n" + document.title); // before any panel covers the thread
  if (also) await also();
  // Hover and focus everything once, so on* handlers that need a pointer would fire too.
  await p.evaluate(() => { for (const el of document.querySelectorAll("b,svg,img,a,td")) { el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); } });
  await p.waitForTimeout(300);
  const s = await scan();
  check(s.pwned === null && !dialogs.length && !s.bad.length, `${label}: nothing runs (pwned ${s.pwned}, dialogs ${dialogs.length}, injected ${s.bad.join(" ") || "none"})`);
  check(!errors.length, `${label}: no page errors ${errors.join(" | ").slice(0, 200)}`);
  return text;
};

let t = await visit("home", "/");
check(t.includes(TITLE1) && t.includes(TITLE2.replace(/ t2$/, "")), "home shows both board titles as written (one an invitation)");
await visit("boards", "/boards");
await visit("chats", "/chats");
t = await visit("for you", "/for-you");
await visit("inbox", "/inbox");
t = await visit("approvals", "/approvals");
check(t.includes(APPROVAL.replace(/'"approve$/, "")), "approvals shows the approval's title as written");
t = await visit("people", "/people");
check(t.includes(DISPLAY.slice(3)), "people shows the attacker's display name as written");
await visit("account", "/me");
await visit("ask", "/ask");
t = await visit("board", `/b/${b1}`, async () => {
  for (const tab of await p.locator('[aria-controls^="panel-"]').all()) { await tab.click().catch(() => {}); await p.waitForTimeout(400); }
});
check(t.includes(TITLE1), "the board shows its title as written");
check(t.includes(`onerror=__pwned=57`) && t.includes(`javascript:__pwned=58`), "the message's raw HTML shows as text");
check(t.includes(TASK.replace(/ "q' task$/, "")) || (await p.locator(`text=${"__pwned=7"}`).count()) > 0, "the task title shows as written");
check(t.includes(`D'Arcy ${run}`), "the agent name with its quote shows as written");
t = await visit("profile", `/u/${A}`);
check(t.includes(DISPLAY.slice(3)) && t.includes("onerror=__pwned=3"), "the profile shows the name and bio as written");
if (link?.url) await visit("invite link", new URL(link.url).pathname);
else check(false, "the invite link was made");
await visit("invited board", `/b/${b2}`);
// Everyday mode draws names and cards its own way.
await web(ckB, "/api/me/profile", { display: { mode: "everyday" } });
await visit("board (Everyday)", `/b/${b1}`);
await visit("home (Everyday)", "/");
await visit("for you (Everyday)", "/for-you");
// And on a phone.
await p.setViewportSize({ width: 390, height: 844 });
await visit("board (390px)", `/b/${b1}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "hostile text: all passed");
process.exit(fails ? 1 : 0);
