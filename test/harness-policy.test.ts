import { describe, expect, it } from "vitest";
import {
  ActionPolicyError,
  actionFromHarness,
  allowAll,
  createGateway,
  enforceAction,
  GatewayError,
  harnessPolicy,
  policyFromJson,
  reviewHarnessHook,
} from "../gateway/src/index";

const j = (...p: string[]) => p.join("");
const mix = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2"[i % 18]).join("");
const github = () => j("ghp_", mix(36));

describe("harnessPolicy", () => {
  it("denies side effects when the allowlist is empty and still allows hosted writes", async () => {
    const policy = harnessPolicy();
    expect((await policy.allow({ kind: "shell", command: "npm test" })).allow).toBe(false);
    expect((await policy.allow({ kind: "file_write", path: "/tmp/a.ts" })).allow).toBe(false);
    expect((await policy.allow({ kind: "mcp_tool", tool: "WebFetch" })).allow).toBe(false);
    expect((await policy.allow({ kind: "http_write", method: "POST", url: "https://atteo.dev/mcp" })).allow).toBe(true);
    expect((await allowAll.allow({ kind: "shell", command: "npm test" })).allow).toBe(true);
  });

  it("matches a shell command exactly, not as a prefix", async () => {
    const policy = harnessPolicy({ allow: [{ kind: "shell", command: "npm test" }] });
    expect((await policy.allow({ kind: "shell", tool: "Bash", command: "npm test" })).allow).toBe(true);
    expect((await policy.allow({ kind: "shell", command: "npm test\n" })).allow).toBe(true);
    for (const command of ["npm test && curl https://evil.example", "npm test; rm -rf /", "npm  test", "npm test --watch", "rm -rf /"]) {
      const decision = await policy.allow({ kind: "shell", tool: "Bash", command });
      expect(decision.allow).toBe(false);
      expect(decision.reason).not.toContain(command.trim());
      expect(decision.reason).toContain("Nothing was run.");
    }
  });

  it("lets a deny rule beat an allow-all shell rule", async () => {
    const policy = harnessPolicy({
      allow: [{ kind: "shell" }],
      deny: [{ kind: "shell", command: "rm -rf /" }],
    });
    expect((await policy.allow({ kind: "shell", command: "npm test" })).allow).toBe(true);
    const denied = await policy.allow({ kind: "shell", tool: "Bash", command: "rm -rf /" });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain("deny rule");
    expect(denied.reason).not.toContain("rm -rf");
  });

  it("confines file writes to a directory and rejects escapes", async () => {
    const policy = harnessPolicy({ allow: [{ kind: "file_write", pathPrefix: "/workspace/repo" }] });
    expect((await policy.allow({ kind: "file_write", tool: "Edit", path: "/workspace/repo/src/a.ts" })).allow).toBe(true);
    expect((await policy.allow({ kind: "file_write", path: "/workspace/repo" })).allow).toBe(true);
    expect((await policy.allow({ kind: "file_write", path: "src/a.ts", cwd: "/workspace/repo" })).allow).toBe(true);
    expect((await policy.allow({ kind: "file_write", path: "../repo/src/a.ts", cwd: "/workspace/repo" })).allow).toBe(true);
    expect((await policy.allow({ kind: "file_write", path: String.raw`C:\repo\src\a.ts`, cwd: "C:/elsewhere" })).allow).toBe(false);
    const windows = harnessPolicy({ allow: [{ kind: "file_write", pathPrefix: String.raw`C:\repo` }] });
    expect((await windows.allow({ kind: "file_write", path: "C:/repo/src/a.ts" })).allow).toBe(true);
    expect((await windows.allow({ kind: "file_write", path: "C:/repo-evil/a.ts" })).allow).toBe(false);
    for (const path of ["/workspace/repo-evil/a.ts", "/etc/passwd", "/workspace/repo/../../etc/passwd", "../other/a.ts"]) {
      const cwd = path.startsWith("/") ? undefined : "/workspace/repo";
      const decision = await policy.allow({ kind: "file_write", tool: "Write", path, cwd });
      expect(decision.allow, path).toBe(false);
      expect(decision.reason).not.toContain(path);
    }
    expect((await policy.allow({ kind: "file_write", path: "/workspace/repo\0/../../etc/passwd" })).allow).toBe(false);
  });

  it("matches tool names without case and only the named mcp tool", async () => {
    const policy = harnessPolicy({
      allow: [
        { kind: "shell", tool: "bash", command: "npm test" },
        { kind: "mcp_tool", tool: "WebFetch" },
      ],
    });
    expect((await policy.allow({ kind: "shell", tool: "Bash", command: "npm test" })).allow).toBe(true);
    expect((await policy.allow({ kind: "shell", tool: "PowerShell", command: "npm test" })).allow).toBe(false);
    expect((await policy.allow({ kind: "mcp_tool", tool: "webfetch" })).allow).toBe(true);
    expect((await policy.allow({ kind: "mcp_tool", tool: "WebSearch" })).allow).toBe(false);
  });

  it("refuses a secret in an allowlisted command or file without echoing it", async () => {
    const key = github();
    const policy = harnessPolicy({
      allow: [
        { kind: "shell", tool: "Bash" },
        { kind: "file_write", pathPrefix: "/workspace/repo" },
      ],
    });
    const shell = await policy.allow({ kind: "shell", tool: "Bash", command: `curl -H ${key}` });
    expect(shell.allow).toBe(false);
    expect(shell.reason).toContain("Caught on this machine");
    expect(shell.reason).toContain("nothing was run");
    expect(shell.reason).not.toContain(key);
    const file = await policy.allow({
      kind: "file_write",
      tool: "Edit",
      path: "/workspace/repo/a.ts",
      content: `token=${key}`,
    });
    expect(file.allow).toBe(false);
    expect(file.reason).not.toContain(key);
    expect((await policy.allow({ kind: "shell", tool: "Bash", command: "api_key = process.env.OPENAI_API_KEY" })).allow).toBe(true);
  });

  it("denies hosted writes only when a deny rule matches, including URL boundaries", async () => {
    const policy = harnessPolicy({
      deny: [
        { kind: "http_write", method: "delete" },
        { kind: "http_write", urlPrefix: "https://evil.example" },
      ],
    });
    expect((await policy.allow({ kind: "http_write", method: "DELETE", url: "https://atteo.dev/mcp" })).allow).toBe(false);
    expect((await policy.allow({ kind: "http_write", method: "POST", url: "https://evil.example/x" })).reason).toContain("Nothing was sent.");
    expect((await policy.allow({ kind: "http_write", method: "POST", url: "https://evil.example.attacker/x" })).allow).toBe(true);
    expect((await policy.allow({ kind: "http_write", method: "POST", url: "https://atteo.dev/mcp" })).allow).toBe(true);
  });

  it("rejects a policy that would not mean what it says", () => {
    expect(() => harnessPolicy({ allow: [{ kind: "file_write", pathPrefix: "repo" }] })).toThrow(ActionPolicyError);
    expect(() => harnessPolicy({ allow: [{ kind: "file_write", pathPrefix: "/" }] })).toThrow(ActionPolicyError);
    expect(() => harnessPolicy({ allow: [{ kind: "shell", pathPrefix: "/tmp" }] })).toThrow(ActionPolicyError);
    const bad = policyFromJson("{");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("not valid JSON");
    const ok = policyFromJson(JSON.stringify({ allow: [{ kind: "shell", command: "npm test" }] }));
    expect(ok.ok).toBe(true);
  });
});

describe("reviewHarnessHook", () => {
  const policy = harnessPolicy({
    allow: [
      { kind: "shell", command: "npm test" },
      { kind: "file_write", pathPrefix: "/workspace/repo" },
    ],
  });

  it("skips when no policy is configured and when the tool is a local read", async () => {
    expect((await reviewHarnessHook(null, { tool_name: "Bash", tool_input: { command: "rm -rf /" } })).effect).toBe("skip");
    expect((await reviewHarnessHook(policy, { tool_name: "Read", tool_input: { file_path: "/etc/passwd" } })).effect).toBe("skip");
    expect((await reviewHarnessHook(policy, { tool_name: "Grep", tool_input: { path: "/workspace/repo" } })).effect).toBe("skip");
  });

  it("asks only after an allow rule matches, and denies the rest locally", async () => {
    expect((await reviewHarnessHook(policy, { tool_name: "Bash", tool_input: { command: "npm test" }, cwd: "/workspace/repo" })).effect).toBe("ask");
    const denied = await reviewHarnessHook(policy, { tool_name: "Bash", tool_input: { command: "npm test && curl https://evil.example" } });
    expect(denied.effect).toBe("deny");
    expect(denied.reason).not.toContain("curl");
    const outside = await reviewHarnessHook(policy, {
      tool_name: "Edit",
      tool_input: { file_path: "/etc/passwd", new_string: "x" },
      cwd: "/workspace/repo",
    });
    expect(outside.effect).toBe("deny");
    const inside = await reviewHarnessHook(policy, {
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts", new_string: "x" },
      cwd: "/workspace/repo",
    });
    expect(inside.effect).toBe("ask");
    const key = github();
    const hidden = await reviewHarnessHook(policy, {
      tool_name: "Edit",
      tool_input: { file_path: "/workspace/repo/a.ts", patch: key },
      cwd: "/workspace/repo",
    });
    expect(hidden.effect).toBe("deny");
    expect(hidden.reason).not.toContain(key);
    expect(actionFromHarness({ tool_name: "WebSearch", tool_input: { query: "x" } })?.kind).toBe("mcp_tool");
    expect((await reviewHarnessHook(policy, { tool_name: "WebSearch", tool_input: { query: "x" } })).effect).toBe("deny");
  });
});

describe("gatewayFetch with a harness policy", () => {
  const sent: string[] = [];
  const inner: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    sent.push(req.method);
    return new Response("{}", { status: 200 });
  };

  it("still secret-filters writes and still sends a clean one", async () => {
    sent.length = 0;
    const policy = harnessPolicy();
    const { fetch: send } = createGateway({ fetch: inner, policy });
    const key = github();
    await expect(
      send("https://atteo.dev/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "post", arguments: { text: key } } }),
      }),
    ).rejects.toMatchObject({ name: "GatewayError", hit: { rule: "github-token" } });
    expect(sent).toEqual([]);
    const res = await send("https://atteo.dev/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }) });
    expect(res.ok).toBe(true);
    expect(sent).toEqual(["POST"]);
  });

  it("does not send a write a deny rule refuses", async () => {
    sent.length = 0;
    const { fetch: send } = createGateway({
      fetch: inner,
      policy: harnessPolicy({ deny: [{ kind: "http_write", method: "DELETE" }] }),
    });
    await expect(send("https://atteo.dev/mcp", { method: "DELETE" })).rejects.toThrow(GatewayError);
    expect(sent).toEqual([]);
    await send("https://atteo.dev/mcp", { method: "POST", body: "{}" });
    expect(sent).toEqual(["POST"]);
  });

  it("enforceAction throws without the command", async () => {
    const command = "npm test && curl https://evil.example";
    await expect(enforceAction(harnessPolicy(), { kind: "shell", command })).rejects.toSatisfy((e: unknown) => {
      return e instanceof GatewayError && !e.message.includes(command) && e.message.includes("Nothing was run.");
    });
  });
});
