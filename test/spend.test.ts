import { describe, expect, it, vi } from "vitest";
import { priceUsage, PRICE_DATE } from "../src/spend";
import { transcriptDelta, transcriptUsage } from "../cli/src/transcriptUsage";

describe("reported spend", () => {
  it("prices a known model, marks estimates, and leaves unknown models unpriced", () => {
    expect(PRICE_DATE).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(priceUsage({ model: "claude-sonnet-4-5", input_tokens: 1_000_000, output_tokens: 100_000 })).toMatchObject({ cost_usd: 4.5, estimate: true });
    expect(priceUsage({ model: "unknown", input_tokens: 3, output_tokens: 4 })).toMatchObject({ cost_usd: null, estimate: true });
    expect(priceUsage({ model: "unknown", input_tokens: 3, output_tokens: 4, cost_usd: 1.25 })).toMatchObject({ cost_usd: 1.25, estimate: false });
    for (const model of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"])
      expect(priceUsage({ model, input_tokens: 1_000_000, output_tokens: 1_000_000 }).cost_usd).toBe(30);
    expect(priceUsage({ model: "claude-fable-5", input_tokens: 1_000_000, output_tokens: 1_000_000 }).cost_usd).toBe(60);
    expect(priceUsage({ model: "claude-fable-5-1", input_tokens: 1_000_000, output_tokens: 1_000_000 }).cost_usd).toBe(60);
    expect(priceUsage({ model: "claude-opus-5", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toMatchObject({ cost_usd: 6.75, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 });
    expect(priceUsage({ model: "claude-fable-5-1", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }).cost_usd).toBe(0.25);
    expect(priceUsage({ model: "claude-opus-5-5", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }).cost_usd).toBe(0.2);
  });

  it("refuses invalid counts and model names", () => {
    for (const u of [
      { model: "", input_tokens: 0, output_tokens: 0 },
      { model: "x", input_tokens: -1, output_tokens: 0 },
      { model: "x", input_tokens: 0.5, output_tokens: 0 },
      { model: "x", input_tokens: 0, output_tokens: 0, cost_usd: Infinity },
      { model: "x", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: -1 },
      { model: "x", input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100_000_001 },
    ]) expect(() => priceUsage(u)).toThrow();
  });

  it("counts a streaming message once and only the new totals after a Stop hook", () => {
    const line = (id: string, input: number, output: number) => JSON.stringify({ sessionId: "s1", type: "assistant", message: { id, model: "claude-sonnet-4-5", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } }) + "\n";
    const first = transcriptUsage(Buffer.from(line("m1", 10, 2) + line("m1", 10, 5)));
    expect(first.totals["claude-sonnet-4-5"]).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 });
    const next = transcriptUsage(Buffer.from(line("m1", 10, 2) + line("m1", 10, 5) + line("m2", 3, 1) + "{"));
    expect(transcriptDelta(next.totals, first.totals)).toEqual([{ model: "claude-sonnet-4-5", input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }]);
    expect(transcriptDelta(next.totals, next.totals)).toEqual([]);
    expect(transcriptDelta({ "claude-sonnet-4-5": { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } }, first.totals)).toEqual([{ model: "claude-sonnet-4-5", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 }]);
    expect(transcriptUsage(Buffer.from(JSON.stringify({ type: "assistant", message: { id: "plain", model: "claude-sonnet-4-5", usage: { input_tokens: 2, output_tokens: 1 } } }) + "\n")).totals["claude-sonnet-4-5"]).toEqual({ input_tokens: 2, output_tokens: 1 });
    expect(next.offset).toBeLessThan(Buffer.byteLength(line("m1", 10, 2) + line("m1", 10, 5) + line("m2", 3, 1) + "{"));
  });

  // A unit check, not an e2e one: the landing server's .dev.vars raises POSTS_PER_MINUTE, so a live server can't show it.
  it("a standalone usage report spends the person's board write budget", async () => {
    vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
    const { Board } = await import("../src/board");
    const calls: string[] = [];
    const fake = {
      info: () => ({ id: "b_spend001", archived: null }),
      sql: { exec: () => ({ toArray: () => [{ x: 1 }] }) },
      checkSpend: () => calls.push("check"),
      rateLimit: (user: string) => calls.push(`rate:${user}`),
      saveSpend: () => (calls.push("save"), { recorded: true }),
    };
    await (Board.prototype as unknown as { reportUsage: (...a: unknown[]) => Promise<unknown> }).reportUsage.call(fake, "ann", { model: "x", input_tokens: 1, output_tokens: 0 }, {});
    expect(calls).toEqual(["check", "rate:ann", "save"]);
  });
});
