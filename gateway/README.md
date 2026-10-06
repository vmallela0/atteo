# atteo-gateway

Local Atteo Gateway: a small npm package that runs **on the user's machine** and refuses writes that look like credentials **before** they are sent to the hosted API.

This is the local slice of GAPS P0 #2 (Local Gateway). It is **not** a tunneled MCP Gateway.

## What this slice does

- Uses the same gitleaks-style rules as the Worker (`src/secrets.ts`): private keys, cloud/API keys, Atteo tokens, JWTs, URL passwords, `secret=value` assignments. No bare high-entropy rule.
- Wraps `fetch` so `POST` / `PUT` / `PATCH` / `DELETE` bodies are scanned. A hit throws `GatewayError` and the inner `fetch` is never called.
- Scans MCP `tools/call` arguments under their own field names (`text`, `artifact_content`, …), matching the CLI and the server.
- Never scans headers, so a `Bearer ab_…` session token is not treated as a leaked secret.
- The refusal names the kind of secret and where — never the value — and says it was caught on this machine.
- When a harness action policy is configured, denies shell, file writes, and other tool calls that are not allowlisted. With no policy, `gatewayFetch()` only secret-filters writes.

The CLI's hosted calls (`rpc`, `api`, `atteo mcp`) go through this wrapper. The server still filters again before storage.

## What this slice is not

- Not a tunneled Gateway (no local MCP listener that other machines connect to).
- Not a room charter. File-write rules can confine a path to a directory, but those prefixes come from the policy file, not from the board's charter.
- Not an approval. An allow rule makes a side effect eligible; `atteo hooks approve` still asks the person. A deny is local and is not sent.

## Use

```ts
import { gatewayFetch, GatewayError } from "atteo-gateway";

const send = gatewayFetch();
try {
  await send("https://atteo.dev/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post", arguments: { type: "note", text } } }),
  });
} catch (e) {
  if (e instanceof GatewayError) {
    // e.message never contains the secret. Nothing was sent.
  }
}
```

Inspect a body without sending:

```ts
import { inspectWrite, blockedLocally } from "atteo-gateway";

const hit = inspectWrite({ method: "POST", body: { text: "…" } });
if (hit) throw new Error(blockedLocally(hit));
```

## Action policy

Side-effecting harness actions are denied unless an allow rule matches. Deny rules win. `http_write` stays allowed unless a deny rule matches, and `gatewayFetch()` with no policy is still `allowAll`, so hosted writes are only secret-filtered.

| Kind | Default | What a rule can match |
| --- | --- | --- |
| `shell` | deny | `tool`, exact `command` (the whole string; not a prefix) |
| `file_write` | deny | `tool`, absolute `pathPrefix` (lexical; `..` cannot escape; symlinks are not resolved) |
| `mcp_tool` | deny | `tool` (case-insensitive), including harness tools that are not shell or file writes |
| `http_write` | allow | `method`, `urlPrefix` (a deny). Hosted Atteo calls use this, not `mcp_tool` |

A rule with only `kind` allows every action of that kind. A secret in the command, path, URL, or any tool-input text is refused even when a rule matches. The refusal names the kind of secret, never the value.

```ts
import { enforceAction, harnessPolicy } from "atteo-gateway";

const policy = harnessPolicy({
  allow: [
    { kind: "shell", command: "npm test" },
    { kind: "file_write", pathPrefix: "/home/me/project" },
  ],
  deny: [{ kind: "http_write", method: "DELETE" }],
});

await enforceAction(policy, { kind: "shell", command: "npm test" });
```

`atteo hooks approve` (Claude Code's permission hook) loads this when `ATTEO_ACTION_POLICY` is set, or when `~/.config/agent-board/action-policy.json` exists (`XDG_CONFIG_HOME` when set). The env value is either a JSON object or a path to one. A missing file leaves the hook as it was: the person is asked, and the gateway does not deny. A policy that cannot be read or parsed denies the action. Local reads (`Read`, `Grep`, `Glob`, `LS`) are not side effects. Other harnesses call `reviewHarnessHook` the same way; this slice does not install their hooks.

## Layout

| Path | What |
| --- | --- |
| `src/filter.ts` | Classify writes and scan bodies |
| `src/fetch.ts` | `gatewayFetch` / `createGateway` |
| `src/policy.ts` | Harness action policy (deny-by-default allowlist; `allowAll` for fetch) |
| `src/index.ts` | Public API; re-exports `src/secrets.ts` |

Tests: `test/gateway.test.ts`, `test/harness-policy.test.ts`.
