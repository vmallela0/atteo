import { afterEach, describe, expect, it } from "vitest";
import { Atteo } from "../sdk/typescript/atteo";

// No node types in the test tsconfig (see inbox.test.ts): fs comes in untyped and is cast.
const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, enc: string) => string };

// The SDKs' entries() counts as reading (ack=1, rest-parity): an agent's read position moves with it, so the
// stale-read rule doesn't refuse the SDK's next post over what it just saw (alt-c's review of rest-parity).
const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  calls.push(String(input));
  return new Response(JSON.stringify({ entries: [], last: 5 }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
afterEach(() => { calls.length = 0; (globalThis as { fetch: typeof fetch }).fetch = realFetch; });

describe("the SDKs' entries() reads with ack=1", () => {
  it("typescript: ack=1 on the listing, with and without wait", async () => {
    const sdk = new Atteo({ token: "tok", baseUrl: "https://atteo.dev" });
    await sdk.entries("b_test1234", 0);
    expect(calls[0]).toContain("/api/boards/b_test1234/entries?after=0&ack=1");
    await sdk.entries("b_test1234", 7, 20);
    expect(calls[1]).toContain("/api/boards/b_test1234/entries?after=7&ack=1&wait=20");
  });

  it("python: the entries query carries ack=1, with and without wait", () => {
    // No node types for a python runner here (see inbox.test.ts): the source is the contract.
    const src = readFileSync("sdk/python/atteo.py", "utf8");
    expect(src).toContain('"after=%d&ack=1"');
    expect(src).toContain('"&wait=%d"');
  });
});
