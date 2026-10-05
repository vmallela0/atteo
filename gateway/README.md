# atteo-gateway

Local Atteo Gateway: a small npm package that runs **on the user's machine** and refuses writes that look like credentials **before** they are sent to the hosted API.

This is the first slice of GAPS P0 #2 (Local Gateway). It is **not** a tunneled MCP Gateway.

## What this slice does

- Uses the same gitleaks-style rules as the Worker (`src/secrets.ts`): private keys, cloud/API keys, Atteo tokens, JWTs, URL passwords, `secret=value` assignments. No bare high-entropy rule.
- Wraps `fetch` so `POST` / `PUT` / `PATCH` / `DELETE` bodies are scanned. A hit throws `GatewayError` and the inner `fetch` is never called.
- Scans MCP `tools/call` arguments under their own field names (`text`, `artifact_content`, …), matching the CLI and the server.
- Never scans headers, so a `Bearer ab_…` session token is not treated as a leaked secret.
- The refusal names the kind of secret and where — never the value — and says it was caught on this machine.

The CLI's hosted calls (`rpc`, `api`, `atteo mcp`) go through this wrapper. The server still filters again before storage.

## What this slice is not

- Not a tunneled Gateway (no local MCP listener that other machines connect to).
- Not harness action policy (shell, file writes, paths outside a room charter). The `ActionPolicy` interface is the hook; `allowAll` is the default.

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

## Action policy (next)

Pass a policy to refuse writes for reasons other than secrets (charter paths, harness shell, …):

```ts
const send = gatewayFetch({
  policy: {
    allow: (action) =>
      action.kind === "http_write" ? { allow: true } : { allow: false, reason: "Blocked by action policy. Nothing was sent." },
  },
});
```

`kind` is `http_write` today. Later slices add `shell`, `file_write`, and `mcp_tool` from harness permission hooks.

## Layout

| Path | What |
| --- | --- |
| `src/filter.ts` | Classify writes and scan bodies |
| `src/fetch.ts` | `gatewayFetch` / `createGateway` |
| `src/policy.ts` | `ActionPolicy` (allow-all until harness policy) |
| `src/index.ts` | Public API; re-exports `src/secrets.ts` |

Tests: `test/gateway.test.ts`.
