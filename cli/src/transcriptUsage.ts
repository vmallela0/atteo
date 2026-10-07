/** Claude Code JSONL may repeat the same assistant message as it streams. Count each message id once. */
export type TokenTotal = { input_tokens: number; output_tokens: number };
export type TokenTotals = Record<string, TokenTotal>;

export function transcriptUsage(bytes: Uint8Array): { session: string | null; offset: number; totals: TokenTotals } {
  const data = Buffer.from(bytes);
  const end = data.lastIndexOf(10) + 1; // only complete JSONL records
  const messages = new Map<string, { model: string; input_tokens: number; output_tokens: number }>();
  let session: string | null = null;
  for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try { row = JSON.parse(line); } catch { continue; }
    if (!session && typeof row.sessionId === "string") session = row.sessionId;
    if (row.type !== "assistant" || !row.message || !row.message.usage) continue;
    const m = row.message, u = m.usage;
    if (typeof m.model !== "string" || !m.model || !u || typeof u !== "object") continue;
    const input = Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0);
    const output = Number(u.output_tokens ?? 0);
    if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) continue;
    const id = typeof m.id === "string" && m.id ? m.id : `${row.uuid ?? messages.size}`;
    const old = messages.get(id);
    messages.set(id, { model: m.model, input_tokens: Math.max(input, old?.input_tokens ?? 0), output_tokens: Math.max(output, old?.output_tokens ?? 0) });
  }
  const totals: TokenTotals = {};
  for (const m of messages.values()) {
    const t = totals[m.model] ??= { input_tokens: 0, output_tokens: 0 };
    t.input_tokens += m.input_tokens; t.output_tokens += m.output_tokens;
  }
  return { session, offset: end, totals };
}

export function transcriptDelta(current: TokenTotals, previous: TokenTotals): { model: string; input_tokens: number; output_tokens: number }[] {
  return Object.entries(current).map(([model, now]) => ({ model, input_tokens: Math.max(0, now.input_tokens - (previous[model]?.input_tokens ?? 0)), output_tokens: Math.max(0, now.output_tokens - (previous[model]?.output_tokens ?? 0)) })).filter((u) => u.input_tokens || u.output_tokens);
}
