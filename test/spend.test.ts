import { describe, expect, it } from "vitest";
import { priceUsage, PRICE_DATE } from "../src/spend";
import { transcriptDelta, transcriptUsage } from "../cli/src/transcriptUsage";

describe("reported spend", () => {
  it("prices a known model, marks estimates, and leaves unknown models unpriced", () => {
    expect(PRICE_DATE).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(priceUsage({ model: "claude-sonnet-4-5", input_tokens: 1_000_000, output_tokens: 100_000 })).toMatchObject({ cost_usd: 4.5, estimate: true });
    expect(priceUsage({ model: "unknown", input_tokens: 3, output_tokens: 4 })).toMatchObject({ cost_usd: null, estimate: true });
    expect(priceUsage({ model: "unknown", input_tokens: 3, output_tokens: 4, cost_usd: 1.25 })).toMatchObject({ cost_usd: 1.25, estimate: false });
  });

  it("refuses invalid counts and model names", () => {
    for (const u of [
      { model: "", input_tokens: 0, output_tokens: 0 },
      { model: "x", input_tokens: -1, output_tokens: 0 },
      { model: "x", input_tokens: 0.5, output_tokens: 0 },
      { model: "x", input_tokens: 0, output_tokens: 0, cost_usd: Infinity },
    ]) expect(() => priceUsage(u)).toThrow();
  });

  it("counts a streaming message once and only the new totals after a Stop hook", () => {
    const line = (id: string, input: number, output: number) => JSON.stringify({ sessionId: "s1", type: "assistant", message: { id, model: "claude-sonnet-4-5", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 5 } } }) + "\n";
    const first = transcriptUsage(Buffer.from(line("m1", 10, 2) + line("m1", 10, 5)));
    expect(first.totals["claude-sonnet-4-5"]).toEqual({ input_tokens: 15, output_tokens: 5 });
    const next = transcriptUsage(Buffer.from(line("m1", 10, 2) + line("m1", 10, 5) + line("m2", 3, 1) + "{"));
    expect(transcriptDelta(next.totals, first.totals)).toEqual([{ model: "claude-sonnet-4-5", input_tokens: 8, output_tokens: 1 }]);
    expect(transcriptDelta(next.totals, next.totals)).toEqual([]);
    expect(next.offset).toBeLessThan(Buffer.byteLength(line("m1", 10, 2) + line("m1", 10, 5) + line("m2", 3, 1) + "{"));
  });
});
