// The busy board several browser checks share (rail, chips, files, wheel, scrollbars, sumchk, verify-layout): two people,
// 27 entries from both (a task at #3, an approval question), a long BACKLOG.md, and B's web session -> {board, A, B, cookieB}.
// It is what scratchpad/layout-shots.mjs seeded for the old after.json, minus the screenshots.
// Checks call after(): it reads the file named by $AFTER_JSON when set, else seeds a fresh board on $BASE, so every check
// runs on a fresh local server without a setup step. `node test/browser/seed.mjs [out.json]` writes one to a file
// (default $SHOTS_DIR/after.json) for running checks by hand against one board, e.g. AFTER_JSON=… node test/browser/rail.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => {
  const r = await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) });
  if (!r.ok && r.status !== 409) throw new Error(`seed: POST /api/ops/${p} -> ${r.status} ${await r.text()}`);
  return r.json();
};

export async function seed() {
  const run = (Date.now().toString(36) + Math.random().toString(36).slice(2, 4)).slice(-6), A = `vedu${run}`, B = `jxn${run}`;
  for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
  const tokA = (await ops("tokens", { user: A })).token;
  const board = (await ops("boards", { user: B, title: "Checkout payments bug" })).board.id;
  await ops("members", { board, user: A });
  const cookieB = (await ops("sessions", { user: B })).cookie;
  const mcp = async (name, args) => {
    const r = await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokA}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    if (!r.ok) throw new Error(`seed: mcp ${name} -> ${r.status}`); return r.text();
  };
  const web = async (path, body) => {
    const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieB }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`seed: POST ${path} -> ${r.status} ${await r.text()}`);
  };
  const lines = [
    "Checkout fails for empty carts in staging; looking at the trace now.",
    "`charge()` receives an undefined payment when the cart is empty.",
    "Repro: add an item, remove it, hit **Pay**. 500 from /api/charge.",
    "The guard was dropped in the refactor last week.",
    "Should we ship behind PAYMENTS_V2 or hotfix main?",
  ];
  for (let i = 0; i < 26; i++) {
    if (i % 3 === 0) await web(`/api/boards/${board}/entries`, { type: i % 2 ? "question" : "note", text: `${lines[i % lines.length]} (${i + 1}) @${A}'s agent` });
    else {
      await mcp("read", {});
      await mcp("post", { type: ["claim", "note", "task", "question"][i % 4], text: `${lines[i % lines.length]} (${i + 1})${i % 5 === 0 ? ` cc @${B}` : ""}` });
    }
  }
  await mcp("read", {});
  await mcp("post", { type: "question", text: `@${B} can you approve the hotfix?`, reply_to: 2 });
  await web(`/api/boards/${board}/doc`, { action: "write", name: "BACKLOG.md", content: "# Backlog\n\n" + Array.from({ length: 40 }, (_, i) => `- Item ${i + 1}: something to build`).join("\n"), base_version: 0, summary: "created" });
  return { board, A, B, cookieB };
}

export async function after() {
  return process.env.AFTER_JSON ? JSON.parse(readFileSync(process.env.AFTER_JSON, "utf8")) : seed();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { SHOTS_DIR } = await import("./lib/shots.mjs");
  const out = process.argv[2] || join(SHOTS_DIR, "after.json");
  const fx = await seed();
  writeFileSync(out, JSON.stringify(fx));
  console.log(`${out}: ${JSON.stringify(fx)}`);
}
