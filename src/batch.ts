// The MCP `batch` tool (jxn #2172/#2189, plan #2177 D1): up to 10 of the server's own tools in order, in one request.
// Pure parts here (parse, rate-limit units, output); src/mcp.ts runs each call through callTool exactly as if alone.

import { isMcpWait } from "./limits";

export const BATCH_MAX = 10;

export interface BatchCall {
  tool: string;
  args: Record<string, unknown>;
}

export class BatchError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const waits = (c: BatchCall) => isMcpWait({ method: "tools/call", params: { name: c.tool, arguments: c.args } });

/** Checks the whole batch before anything runs: 1–10 known tools, no nested batch, a wait only as the last call. */
export function parseBatch(args: Record<string, unknown>, known: readonly string[]): { calls: BatchCall[]; continueOnError: boolean } {
  const raw = args.calls;
  if (!Array.isArray(raw) || !raw.length) throw new BatchError(`calls must be a list of 1–${BATCH_MAX} {tool, args}.`);
  if (raw.length > BATCH_MAX) throw new BatchError(`At most ${BATCH_MAX} calls in one batch (got ${raw.length}).`);
  const calls = raw.map((c, i): BatchCall => {
    if (!isObj(c) || typeof c.tool !== "string" || !c.tool.trim()) throw new BatchError(`Call ${i + 1}: needs {tool, args}.`);
    const tool = c.tool.trim();
    if (tool === "batch") throw new BatchError(`Call ${i + 1}: a batch can't contain another batch.`);
    if (!known.includes(tool)) throw new BatchError(`Call ${i + 1}: unknown tool "${tool}".`);
    if (c.args != null && !isObj(c.args)) throw new BatchError(`Call ${i + 1}: args must be an object.`);
    return { tool, args: (c.args as Record<string, unknown> | undefined) ?? {} };
  });
  const w = calls.findIndex(waits);
  if (w >= 0 && w < calls.length - 1) throw new BatchError(`Call ${w + 1}: a wait can only be the last call in a batch.`);
  return { calls, continueOnError: args.continue_on_error === true };
}

type RpcCall = { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };

/** What the rate limiter counts for one JSON-RPC message: a batch is its inner calls (as if sent one by one). */
export function batchUnits(m: RpcCall): RpcCall[] {
  if (m?.method !== "tools/call" || m.params?.name !== "batch") return [m];
  const calls = m.params?.arguments?.calls;
  if (!Array.isArray(calls) || !calls.length) return [m];
  return calls.slice(0, BATCH_MAX).map((c) => ({ method: "tools/call", params: { name: isObj(c) ? String(c.tool ?? "") : "", arguments: isObj(c) && isObj(c.args) ? c.args : {} } }));
}

export interface BatchResult {
  tool: string;
  ok: boolean;
  text: string;
}

/** "1 ✓ read …" per call: a one-line result stays on its line, a longer one follows it; then what didn't run. */
export function formatBatch(results: BatchResult[], total: number): string {
  const out: string[] = [];
  results.forEach((r, i) => {
    const head = `${i + 1} ${r.ok ? "✓" : "✗"} ${r.tool}`;
    const text = r.text.trim();
    if (!text) out.push(head);
    else if (!text.includes("\n") && text.length <= 200) out.push(`${head}: ${text}`);
    else out.push(head, text);
  });
  if (results.length < total) {
    const from = results.length + 1;
    out.push(`stopped at ${results.length}: ${from === total ? `${total} not run` : `${from}–${total} not run`}`);
  }
  return out.join("\n");
}
