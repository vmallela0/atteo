import { describe, expect, it } from "vitest";
import { allowAll, blockedLocally, createGateway, GatewayError, inspectWrite, isWriteMethod } from "../gateway/src/index";

const j = (...p: string[]) => p.join("");
const mix = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2"[i % 18]).join("");
const github = () => j("ghp_", mix(36));

describe("inspectWrite", () => {
  it("ignores reads", () => {
    expect(isWriteMethod("GET")).toBe(false);
    expect(inspectWrite({ method: "GET", body: `token=${github()}` })).toBeNull();
  });

  it("ignores an empty write", () => {
    expect(inspectWrite({ method: "POST" })).toBeNull();
    expect(inspectWrite({ method: "POST", body: "" })).toBeNull();
  });

  it("blocks a REST post whose text looks like a GitHub token", () => {
    const key = github();
    const hit = inspectWrite({ method: "POST", body: { text: `GH_TOKEN=${key}`, type: "note" } });
    expect(hit?.rule).toBe("github-token");
    expect(hit?.field).toBe("text");
    expect(blockedLocally(hit!)).toContain("Caught on this machine");
    expect(blockedLocally(hit!)).not.toContain(key);
  });

  it("blocks a nested JSON field", () => {
    const hit = inspectWrite({ method: "PUT", body: JSON.stringify({ title: "ok", extra: { note: `sk-ant-api03-${mix(40)}` } }) });
    expect(hit?.rule).toBe("anthropic-key");
    expect(hit?.field).toBe("extra.note");
  });

  it("blocks MCP tools/call arguments under their own field names", () => {
    const key = github();
    const hit = inspectWrite({
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "post", arguments: { type: "note", text: `GH_TOKEN=${key}` } },
      },
    });
    expect(hit?.rule).toBe("github-token");
    expect(hit?.field).toBe("text");
  });

  it("allows placeholders the server also allows", () => {
    expect(inspectWrite({ method: "POST", body: { text: "api_key = process.env.OPENAI_API_KEY" } })).toBeNull();
  });
});

describe("gatewayFetch", () => {
  const sent: { method: string; url: string; auth: string | null; body: string }[] = [];
  const inner: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    sent.push({ method: req.method, url: req.url, auth: req.headers.get("authorization"), body: await req.text() });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  it("does not send a write that contains a secret", async () => {
    sent.length = 0;
    const { fetch: send } = createGateway({ fetch: inner });
    const key = github();
    await expect(
      send("https://atteo.dev/api/boards/b_test/entries", {
        method: "POST",
        headers: { authorization: `Bearer ab_${mix(43)}`, "content-type": "application/json" },
        body: JSON.stringify({ text: `GH_TOKEN=${key}`, type: "note" }),
      }),
    ).rejects.toMatchObject({ name: "GatewayError", code: "GATEWAY_BLOCKED" });
    expect(sent).toEqual([]);
  });

  it("sends a clean write, including an Atteo token in the Authorization header", async () => {
    sent.length = 0;
    const { fetch: send } = createGateway({ fetch: inner });
    const token = `ab_${mix(43)}`;
    const res = await send("https://atteo.dev/api/boards/b_test/entries", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "shipped the checkout", type: "note" }),
    });
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe(`Bearer ${token}`);
    expect(sent[0].body).toContain("shipped the checkout");
  });

  it("lets GET through even if the URL looks like it contains a token", async () => {
    sent.length = 0;
    const { fetch: send } = createGateway({ fetch: inner });
    await send(`https://atteo.dev/api/search?q=${github()}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("GET");
  });

  it("does not send a write the action policy denies", async () => {
    sent.length = 0;
    const { fetch: send } = createGateway({
      fetch: inner,
      policy: { allow: () => ({ allow: false, reason: "Blocked by action policy. Nothing was sent." }) },
    });
    await expect(send("https://atteo.dev/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }) })).rejects.toThrow(GatewayError);
    expect(sent).toEqual([]);
  });

  it("allowAll is the default policy", async () => {
    sent.length = 0;
    const { fetch: send } = createGateway({ fetch: inner, policy: allowAll });
    await send("https://atteo.dev/mcp", { method: "POST", body: "{}" });
    expect(sent).toHaveLength(1);
  });

  it("GatewayError never includes the secret", async () => {
    const key = github();
    const { fetch: send } = createGateway({ fetch: inner });
    try {
      await send("https://atteo.dev/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "post", arguments: { text: key } } }),
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).message).not.toContain(key);
      expect((e as GatewayError).hit?.rule).toBe("github-token");
    }
  });
});
