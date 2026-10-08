// Conductor (#1288): Connect an agent → "Set up every workspace at once" shows one screen with the setup-script lines
// (this server's address filled in), the .mcp.json alternative, and a way back. The snippet's URL path works for real:
// /mcp?name=ws-<workspace> with a token makes that named session, and a reconnect is the same one. Desktop and phone,
// light and dark, no page errors.
// Usage: BASE=http://localhost:8787 [ADMIN_KEY=…] node conductor.mjs
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
let KEY = process.env.ADMIN_KEY;
// (the gate runs against 8787, whose ADMIN_KEY is ci-admin-key)
KEY ||= "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `cd${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Conductor ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const [k, ...v] = ck.split(";")[0].split("=");
const errors = [];
let setup = "", json = "";
for (const [w, h, scheme] of [[1300, 900, "light"], [390, 844, "dark"]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  for (const where of ["/", `/b/${board}`]) {
    await p.goto(BASE + where);
    await p.evaluate(() => document.getElementById("connect").showModal());
    const dlg = p.locator("#connect");
    const go = dlg.locator('.linkish[data-ctab-go="conductor"]');
    check(await go.isVisible(), `${w}px ${where}: One click offers Conductor`);
    await go.click();
    const panel = dlg.locator('[data-cpanel="conductor"]');
    check(await panel.isVisible() && (await dlg.locator('[data-cpanel]:not([hidden])').count()) === 1, `${w}px ${where}: the Conductor panel alone is shown`);
    check(await dlg.locator('[data-ctab][aria-selected="true"]').count() === 0, `${w}px ${where}: no tab claims it`);
    setup = await p.locator("#cn-conductor-setup").textContent();
    json = await p.locator("#cn-conductor-json").textContent();
    check(setup.includes(`${BASE}/mcp?name=$ws`) && !setup.includes("atteo.example") && setup.includes('ATTEO_SESSION_NAME="$ws"') && setup.includes("CONDUCTOR_WORKSPACE_NAME"), `${w}px ${where}: setup lines carry this server and the workspace name`);
    check(json.includes(`${BASE}/mcp?name=ws-\${CONDUCTOR_WORKSPACE_NAME:-conductor}`) && JSON.parse(json).mcpServers.atteo.type === "http", `${w}px ${where}: .mcp.json is valid and carries this server`);
    check((await panel.textContent()).includes(`${P}/ws-checkout-fix`), `${w}px ${where}: names the session you'll see`);
    const over = await p.evaluate(() => { const d = document.getElementById("connect"); return d.scrollWidth - d.clientWidth; });
    check(over <= 1, `${w}px ${where}: no sideways scroll in the dialog (${over}px)`);
    const bg = await p.evaluate(() => getComputedStyle(document.getElementById("connect")).backgroundColor);
    check(scheme === "dark" ? !/255, 255, 255/.test(bg) : true, `${w}px ${where}: themed (${bg})`);
    await p.screenshot({ path: `${SHOTS_DIR}/conductor-${w}-${where === "/" ? "home" : "board"}.png` });
    await dlg.locator('[data-ctab-go="quick"]').click();
    check(await dlg.locator('[data-cpanel="quick"]').isVisible() && !(await panel.isVisible()) && (await dlg.locator('[data-ctab="quick"]').getAttribute("aria-selected")) === "true", `${w}px ${where}: ← All agents goes back to One click`);
    await dlg.locator('[data-ctab="cli"]').click();
    check(await dlg.locator('[data-cpanel="cli"]').isVisible() && !(await panel.isVisible()), `${w}px ${where}: tabs still work`);
  }
  await ctx.close();
}
// The snippet's no-CLI path, for real: what the setup script registers for workspace "Kyoto Fix".
const ws = "ws-" + "Kyoto Fix".replace(/[^A-Za-z0-9._-]+/g, "-");
const url = setup.match(/"(http[^"]+)"/)[1].replace("$ws", ws);
const connect = async () => {
  const init = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } }) });
  const sid = init.headers.get("mcp-session-id");
  await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid, authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_boards", arguments: {} } }) });
};
const sessions = async () => (await (await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${tok}` } })).json()).sessions.map((s) => s.name);
await connect();
check(JSON.stringify(await sessions()) === '["ws-kyoto-fix"]', `the snippet's URL makes the workspace's session (${JSON.stringify(await sessions())})`);
await connect();
check(JSON.stringify(await sessions()) === '["ws-kyoto-fix"]', `a restarted workspace is the same session (${JSON.stringify(await sessions())})`);
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
