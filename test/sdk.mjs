// SDK test: the TypeScript SDK asks a question; an agent written with the Python SDK follows the board and answers.
// Usage: BASE=… ADMIN_KEY=… node test/sdk.mjs
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY ?? readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY=(.*)$/m)?.[1];
const dir = mkdtempSync(join(tmpdir(), "atteo-sdk-"));
const out = join(dir, "sdk.mjs");
await build({ entryPoints: [new URL("../sdk/typescript/atteo.ts", import.meta.url).pathname], outfile: out, format: "esm", platform: "neutral", logLevel: "warning" });
const { Atteo, verifyWebhook } = await import(out);
const ops = (p, b) => fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY, "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const run = Date.now().toString(36).slice(-5);
const A = `e2e-sdk-a-${run}`, B = `e2e-sdk-b-${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const ta = (await ops("tokens", { user: A })).token, tb = (await ops("tokens", { user: B })).token;
const board = (await ops("boards", { user: A, title: `e2e sdk ${run}` })).board.id;
await ops("members", { board, user: B });
let failed = 0;
const check = (ok, name, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      ${detail}`}`); if (!ok) failed++; };

// B's agent: Python, following the board and answering questions addressed to it.
const py = join(dir, "bot.py");
writeFileSync(py, `import sys
sys.path.insert(0, ${JSON.stringify(new URL("../sdk/python", import.meta.url).pathname)})
from atteo import Atteo
soup = Atteo(${JSON.stringify(tb)}, base_url=${JSON.stringify(BASE)})
assert any(b["id"] == ${JSON.stringify(board)} for b in soup.boards())
print("ready", flush=True)
def on(e):
    if e["type"] == "question" and e.get("to") == ${JSON.stringify(B)}:
        soup.post(${JSON.stringify(board)}, "8443 (from python)", reply_to=e["seq"])
        print("answered", flush=True)
        raise SystemExit(0)
soup.follow(${JSON.stringify(board)}, on)
`);
const bot = spawn("python3", [py]);
let botOut = "";
bot.stdout.on("data", (d) => (botOut += d));
bot.stderr.on("data", (d) => (botOut += d));
for (let i = 0; i < 100 && !botOut.includes("ready"); i++) await new Promise((r) => setTimeout(r, 100));
check(botOut.includes("ready"), "python SDK: lists boards and starts following", botOut);
await new Promise((r) => setTimeout(r, 500));

const soup = new Atteo({ token: ta, baseUrl: BASE });
check((await soup.boards()).some((b) => b.id === board), "ts SDK: lists boards");
const reply = await soup.ask(board, B, "Which port does staging use?", 30_000);
check(reply?.text === "8443 (from python)", "ts asks, python answers", JSON.stringify(reply) + botOut);
const t = await soup.createTask(board, `sdk task ${run}`, "- [ ] one");
const claimed = await soup.task(board, t.seq, { action: "claim" });
check(claimed.status === "doing", "ts SDK: tasks", JSON.stringify(claimed));
// Webhook signature helper (matches the server's scheme).
const { createHmac } = await import("node:crypto");
const ts = Math.floor(Date.now() / 1000), body = '{"event":"ping"}';
const sig = `t=${ts},v1=${createHmac("sha256", "whs_x").update(`${ts}.${body}`).digest("hex")}`;
check((await verifyWebhook(body, sig, "whs_x")) && !(await verifyWebhook(body + " ", sig, "whs_x")), "ts verifyWebhook");
bot.kill();
console.log(`\n${failed ? "SDK tests failed" : "SDK tests passed"}`);
process.exit(failed ? 1 : 0);
