// Board info → Spend shows the week's reported amount and top agents/tasks.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), user = `sp${run}`;
await ops("users", { name: user, email: `${user}@example.com`, verified: "true" });
const token = (await ops("tokens", { user })).token;
const board = (await ops("boards", { user, title: `Spend ${run}` })).board.id;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const report = async (usage, task) => fetch(`${BASE}/api/boards/${board}/usage`, { method: "POST", headers, body: JSON.stringify({ usage, task }) });
let fails = 0; const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) fails++; };
const task = await (await fetch(`${BASE}/api/boards/${board}/tasks`, { method: "POST", headers, body: JSON.stringify({ title: `Ship ${run}` }) })).json();
check(!!task.task?.seq, "task created");
check((await report({ model: "claude-sonnet-4-5", input_tokens: 1_000_000, output_tokens: 0 }, task.task.seq)).status === 200, "usage accepted");
const encrypted = (await ops("boards", { user, title: `Private spend ${run}`, encrypted: true })).board.id;
const privateReport = await fetch(`${BASE}/api/boards/${encrypted}/usage`, { method: "POST", headers, body: JSON.stringify({ usage: { model: "claude-sonnet-4-5", input_tokens: 10, output_tokens: 2 } }) });
const privateSpend = await (await fetch(`${BASE}/api/boards/${encrypted}/spend`, { headers })).json();
check(privateReport.status === 200 && privateSpend.this_week.input_tokens === 10, "encrypted board accepts server-visible usage metadata");
const cookie = (await ops("sessions", { user })).cookie;
let browser;
try { browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined }); }
catch (e) { if (!String(e).includes("MachPortRendezvousServer")) throw e; console.log("Chromium is blocked by this macOS sandbox; checking the rendered panel over HTTP."); }
if (browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, ...parts] = cookie.split(";")[0].split("="); await context.addCookies([{ name, value: parts.join("="), url: BASE }]);
  const page = await context.newPage(), errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/b/${board}`);
  const side = page.locator('#board-info [data-fold="spend"]');
  check(await side.count() === 1 && (await side.innerText()).includes("$3.00"), "week's estimated spend is shown");
  check((await side.innerText()).includes(user) && (await side.innerText()).includes(`#${task.task.seq}`), "top agent and task are shown");
  check((await side.innerText()).includes("Self-reported"), "self-reported note is visible");
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
  await browser.close();
} else {
  const html = await (await fetch(`${BASE}/b/${board}`, { headers: { cookie } })).text();
  const side = html.split('data-fold="spend"')[1]?.split("</section>")[0] ?? "";
  check(side.includes("$3.00"), "week's estimated spend is rendered");
  check(side.includes(user) && side.includes(`#${task.task.seq}`), "top agent and task are rendered");
  check(side.includes("Self-reported"), "self-reported note is rendered");
}
console.log(fails ? `${fails} FAILED` : "all spend checks passed"); process.exit(fails ? 1 : 0);
