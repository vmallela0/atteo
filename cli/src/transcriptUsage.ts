/** Claude Code JSONL may repeat the same assistant message as it streams. Count each message id once. */
export type TokenTotal = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
export type TokenTotals = Record<string, TokenTotal>;

export function transcriptUsage(bytes: Uint8Array): { session: string | null; offset: number; totals: TokenTotals } {
  const data = Buffer.from(bytes);
  const end = data.lastIndexOf(10) + 1; // only complete JSONL records
  const messages = new Map<string, { model: string } & TokenTotal>();
  let session: string | null = null;
  for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try { row = JSON.parse(line); } catch { continue; }
    if (!session && typeof row.sessionId === "string") session = row.sessionId;
    if (row.type !== "assistant" || !row.message || !row.message.usage) continue;
    const m = row.message, u = m.usage;
    if (typeof m.model !== "string" || !m.model || !u || typeof u !== "object") continue;
    const counts = { input_tokens: Number(u.input_tokens ?? 0), output_tokens: Number(u.output_tokens ?? 0), cache_read_input_tokens: Number(u.cache_read_input_tokens ?? 0), cache_creation_input_tokens: Number(u.cache_creation_input_tokens ?? 0) };
    if (!Object.values(counts).every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000)) continue;
    const id = typeof m.id === "string" && m.id ? m.id : `${row.uuid ?? messages.size}`;
    const old = messages.get(id);
    messages.set(id, {
      model: m.model,
      input_tokens: Math.max(counts.input_tokens, old?.input_tokens ?? 0),
      output_tokens: Math.max(counts.output_tokens, old?.output_tokens ?? 0),
      ...(u.cache_read_input_tokens === undefined && old?.cache_read_input_tokens === undefined ? {} : { cache_read_input_tokens: Math.max(counts.cache_read_input_tokens, old?.cache_read_input_tokens ?? 0) }),
      ...(u.cache_creation_input_tokens === undefined && old?.cache_creation_input_tokens === undefined ? {} : { cache_creation_input_tokens: Math.max(counts.cache_creation_input_tokens, old?.cache_creation_input_tokens ?? 0) }),
    });
  }
  const totals: TokenTotals = {};
  for (const m of messages.values()) {
    const t = totals[m.model] ??= { input_tokens: 0, output_tokens: 0 };
    t.input_tokens += m.input_tokens; t.output_tokens += m.output_tokens;
    if (m.cache_read_input_tokens !== undefined) t.cache_read_input_tokens = (t.cache_read_input_tokens ?? 0) + m.cache_read_input_tokens;
    if (m.cache_creation_input_tokens !== undefined) t.cache_creation_input_tokens = (t.cache_creation_input_tokens ?? 0) + m.cache_creation_input_tokens;
  }
  return { session, offset: end, totals };
}

export function transcriptDelta(current: TokenTotals, previous: TokenTotals): ({ model: string } & TokenTotal)[] {
  return Object.entries(current).map(([model, now]) => ({
    model,
    input_tokens: Math.max(0, now.input_tokens - (previous[model]?.input_tokens ?? 0)),
    output_tokens: Math.max(0, now.output_tokens - (previous[model]?.output_tokens ?? 0)),
    ...(now.cache_read_input_tokens === undefined ? {} : { cache_read_input_tokens: Math.max(0, now.cache_read_input_tokens - (previous[model]?.cache_read_input_tokens ?? 0)) }),
    ...(now.cache_creation_input_tokens === undefined ? {} : { cache_creation_input_tokens: Math.max(0, now.cache_creation_input_tokens - (previous[model]?.cache_creation_input_tokens ?? 0)) }),
  })).filter((u) => u.input_tokens || u.output_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens);
}
