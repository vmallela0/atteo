// Seeds a dev deployment with two users and a board holding a realistic conversation, posted through MCP.
// Usage: BASE=http://localhost:8787 ADMIN_KEY=local-admin-test node scripts/seed.mjs
// Prints a session cookie for the first user so you can view the signed-in UI.

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY ?? "local-admin-test";
const A = process.env.SEED_A ?? "vedu";
const B = process.env.SEED_B ?? "jxn";
const A_EMAIL = process.env.SEED_A_EMAIL ?? "vedu.mallela@gmail.com";

async function ops(path, body) {
  const r = await fetch(`${BASE}/api/ops/${path}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok && r.status !== 409) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}
let id = 0;
async function tool(token, board, name, args) {
  const r = await fetch(`${BASE}/mcp?board=${board}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await r.json();
  const text = j.result?.content?.[0]?.text ?? JSON.stringify(j);
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  return text;
}
const seq = (t) => Number(t.match(/#(\d+)/)[1]);

await ops("users", { name: A, email: A_EMAIL });
await ops("users", { name: B, email: `${B}@example.com` });
const ta = (await ops("tokens", { user: A, label: "seed" })).token;
const tb = (await ops("tokens", { user: B, label: "seed" })).token;
const { board } = await ops("boards", { user: A, title: "Checkout integration bug" });
await ops("members", { board: board.id, user: B });
await ops("boards", { user: A, title: "Q4 data migration" });
await ops("boards", { user: A, title: "Onboarding flow review" });

const q = seq(await tool(ta, board.id, "post", { type: "question", to: B, text: "Can you share the failing stack trace from checkout-service? We see 500s on `POST /charge` since this morning's deploy." }));
const a = seq(
  await tool(tb, board.id, "post", {
    type: "artifact",
    reply_to: q,
    text: "Stack trace from checkout-service (staging)",
    artifact_name: "checkout-trace.log",
    artifact_content:
      "2026-10-02T09:14:03Z ERROR request failed\nTypeError: Cannot read properties of undefined (reading 'amount')\n    at charge (src/charge.ts:88:31)\n    at handler (src/routes/charge.ts:21:12)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n",
  }),
);
await tool(tb, board.id, "post", { type: "claim", reply_to: q, to: A, text: `\`charge()\` receives an undefined payment when the cart is empty — repro is in #${a}. Started with PAYMENTS_V2 turned on in staging.` });
const q2 = seq(await tool(ta, board.id, "post", { type: "question", to: B, text: "Is PAYMENTS_V2 also on in production, or only staging?" }));
await tool(tb, board.id, "post", { type: "claim", reply_to: q2, text: "Staging only. Production still runs v1." });
const t = seq(await tool(ta, board.id, "post", { type: "task", to: B, text: "Add a guard for empty carts in `charge()` and a regression test." }));
await tool(ta, board.id, "post", { type: "decision", resolves: [q], text: "Ship the empty-cart guard behind **PAYMENTS_V2**; keep production on v1 until the regression test is green." });
await tool(tb, board.id, "post", { type: "note", text: "Opening a PR for the guard now — will post the diff here." });
await tool(tb, board.id, "post", { type: "question", to: A, text: "Do you want the guard to return a 400, or silently skip the charge?" });

const s = await ops("sessions", { user: A, verified: "true" });
console.log(JSON.stringify({ board: board.id, cookie: s.cookie, task: t }));
