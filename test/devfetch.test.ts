import { describe, expect, it } from "vitest";
// @ts-expect-error: plain JS module used by test/e2e.mjs
import { devFetch, LOCAL, PROXY_FAILURES, retryPageFetch } from "./devfetch.mjs";

// test/devfetch.mjs (#3673): wrangler dev's proxy drops a POST now and then; e2e retries exactly those, once.

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const fake = (answers: Response[]) => {
  const calls: string[] = [];
  const f: Fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input}`);
    return answers.shift() ?? new Response("{}", { status: 200 });
  };
  return { f, calls };
};
const dropped = () => new Response("Error: Network connection lost.", { status: 500 });
const restarted = () => new Response("Your worker restarted mid-request. Please try sending the request again. Only GET or HEAD requests are retried automatically.", { status: 503, headers: { "Retry-After": "0" } });
const post = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0" }) };

describe("e2e's fetch against wrangler dev", () => {
  it("retries a POST the dev proxy dropped, once, and says so", async () => {
    for (const fail of [dropped, restarted]) {
      const { f, calls } = fake([fail(), new Response('{"ok":true}', { status: 200 })]);
      const logs: string[] = [];
      const res = await devFetch(f, (m: string) => logs.push(m))("http://localhost:8610/mcp?board=b_x", post);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls).toEqual(["POST http://localhost:8610/mcp?board=b_x", "POST http://localhost:8610/mcp?board=b_x"]);
      expect(logs).toEqual([`      (wrangler dev dropped POST /mcp: ${fail === dropped ? 500 : 503}; retried once)`]);
    }
  });
  it("retries a socket the proxy closed before answering (fetch failed: ECONNRESET), but not a refused connection", async () => {
    const thrown = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    for (const [code, tries] of [["ECONNRESET", 2], ["UND_ERR_SOCKET", 2], ["ECONNREFUSED", 1]] as const) {
      let n = 0;
      const f = async () => {
        if (++n === 1) throw thrown(code);
        return new Response("{}");
      };
      const r = devFetch(f, () => {})("http://localhost:8610/mcp", post);
      if (tries === 1) await expect(r).rejects.toThrow("fetch failed");
      else expect((await r).status).toBe(200);
      expect(n, code).toBe(tries);
    }
  });
  it("gives up after one retry", async () => {
    const { f, calls } = fake([dropped(), dropped(), new Response("{}")]);
    expect((await devFetch(f, () => {})("http://127.0.0.1:8787/api/x", post)).status).toBe(500);
    expect(calls).toHaveLength(2);
  });
  it("never retries the Worker's own errors, production, or a body it can't send twice", async () => {
    const cases: [string, Response, RequestInit][] = [
      ["http://localhost:8610/api/x", new Response('{"error":"Network connection lost."}', { status: 500 }), post], // ours: JSON
      ["http://localhost:8610/api/x", new Response("Internal Server Error", { status: 500 }), post],
      ["http://localhost:8610/api/x", new Response("Error: Network connection lost.", { status: 400 }), post],
      ["https://atteo.dev/api/x", dropped(), post],
      ["http://localhost:8610/api/x", dropped(), { method: "POST", body: new ReadableStream() }],
    ];
    for (const [url, answer, init] of cases) {
      const { f, calls } = fake([answer]);
      await devFetch(f, () => {})(url, init);
      expect(calls, url).toHaveLength(1);
    }
  });
});

// The browser checks' pages (#3808): retryPageFetch wraps a page's fetch with the same rule, as an init script.
describe("a browser check's page against wrangler dev", () => {
  const rules = { failures: PROXY_FAILURES.map((re: RegExp) => re.source), local: LOCAL.source };
  const page = (answers: Response[], href = "http://localhost:8610/b/b_x") => {
    const { f, calls } = fake(answers);
    const w: { fetch: Fetch; location: { href: string } } = { fetch: f, location: { href } };
    const logs: string[] = [];
    retryPageFetch(rules, w, (m: string) => logs.push(m));
    return { w, calls, logs };
  };
  it("retries a page's request the dev proxy dropped, once, and says so (relative URLs too)", async () => {
    for (const fail of [dropped, restarted]) {
      const { w, calls, logs } = page([fail(), new Response('{"ok":true}', { status: 200 })]);
      const res = await w.fetch("/api/boards/b_x/seen", { method: "POST", body: '{"seq":3}' });
      expect(await res.json()).toEqual({ ok: true });
      expect(calls).toEqual(["POST /api/boards/b_x/seen", "POST /api/boards/b_x/seen"]);
      expect(logs).toEqual([`(wrangler dev dropped POST /api/boards/b_x/seen: ${fail === dropped ? 500 : 503}; retried once)`]);
    }
    const { w, calls } = page([dropped(), dropped(), new Response("{}")]);
    expect((await w.fetch("/api/x", post)).status).toBe(500);
    expect(calls).toHaveLength(2);
  });
  it("never retries the Worker's own errors, a page served from elsewhere, or a body or Request it can't send twice", async () => {
    const cases: [string, Response, RequestInit | undefined, string?][] = [
      ["/api/x", new Response('{"error":"Network connection lost."}', { status: 500 }), post],
      ["/api/x", dropped(), post, "https://atteo.dev/b/b_x"],
      ["https://atteo.dev/api/x", dropped(), post],
      ["/api/x", dropped(), { method: "POST", body: new ReadableStream() }],
    ];
    for (const [url, answer, init, href] of cases) {
      const { w, calls } = page([answer], href);
      await w.fetch(url, init);
      expect(calls, url).toHaveLength(1);
    }
    const { w, calls } = page([dropped()]);
    await w.fetch(new Request("http://localhost:8610/api/x", post) as unknown as string);
    expect(calls).toHaveLength(1);
  });
  it("wraps a page once, however many times the script runs", async () => {
    const { w, calls } = page([dropped(), dropped(), new Response("{}")]);
    retryPageFetch(rules, w, () => {});
    await w.fetch("/api/x", post);
    expect(calls).toHaveLength(2);
  });
});
