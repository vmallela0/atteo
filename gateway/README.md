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
- Not a reader of the hosted board charter. File-write scope is opt-in in the local policy file (`charter.scope_paths`). The hosted charter may store the same directories as advisory `scope_paths`; this gateway does not fetch them.
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

### Charter scope (opt-in)

Enforcement lives in this file. The hosted charter may list the same paths as advisory `scope_paths` (owners can save them with `POST /api/boards/:id/charter`); they do not enforce a remote sandbox. Add `charter` here only when this machine should enforce them. Each entry of `scope_paths` is compiled to an allow rule `{ "kind": "file_write", "pathPrefix": "<normalized absolute directory>" }` (duplicates collapse; `..` is lexical). While `charter` is present, a file write outside every one of those directories is denied, including when a broader `file_write` allow would have matched. Deny rules still win inside the scope. Shell commands and other tools are unchanged: a charter path does not allow them. An empty `scope_paths` list allows no file write. A charter block that is not a list of absolute directories below the filesystem root (at most 32, each at most 4096 characters) makes the whole document invalid, so nothing in it is enforced as an allow. `board`, when set, is a board id (`b_` plus 8–32 letters or digits) naming which room the paths were copied for. It is not fetched.

Who may set these paths on the shared charter is still open. Owners can save them today, same as the rest of the charter, but absolute paths differ per machine, and copying a remote list onto this allowlist would widen it, so the gateway does not pull one. Copy `scope_paths` from `GET /api/boards/:id/charter` into this file only when this machine should enforce them. The person who can write this file sets the paths.

```json
{
  "charter": {
    "board": "b_7qh6ar3styu7",
    "scope_paths": ["/home/me/checkout"]
  }
}
```

That one path is the allow rule `{ "kind": "file_write", "pathPrefix": "/home/me/checkout" }`. A write to `/home/me/checkout/src/a.ts` may proceed to the person's approval. A write to `/home/me/checkout-evil` or `/etc/passwd` is denied on this machine.

`atteo hooks install --approvals` installs a `PreToolUse` policy check (`atteo hooks policy`) as well as the `PermissionRequest` approval hook (`atteo hooks approve`). The policy check denies disallowed actions before execution, including tools already permitted by Claude Code, and asks for approval for allowlisted side effects. Re-run the install command to add the policy check to an existing installation. Both hooks load this when `ATTEO_ACTION_POLICY` is set, or when `~/.config/agent-board/action-policy.json` exists (`XDG_CONFIG_HOME` when set). The env value is either a JSON object or a path to one. When that JSON includes `charter.scope_paths`, both hooks enforce it: a file write inside a prefix can be asked, and one outside is denied without being sent. An absent default file leaves the approval hook as it was: the person is asked, and the gateway does not deny. An explicitly configured missing file denies the action. A policy that cannot be read or parsed denies the action. Local reads (`Read`, `Grep`, `Glob`, `LS`) are not side effects. Unknown tools and multi-file patches need an explicit `mcp_tool` rule; supplying a `path` or `command` does not give them file or shell permissions. Other harnesses call `reviewHarnessHook` before every tool execution the same way; this slice does not install their hooks.

## Layout

| Path | What |
| --- | --- |
| `src/filter.ts` | Classify writes and scan bodies |
| `src/fetch.ts` | `gatewayFetch` / `createGateway` |
| `src/policy.ts` | Harness action policy (deny-by-default allowlist; opt-in `charter.scope_paths`; `allowAll` for fetch) |
| `src/index.ts` | Public API; re-exports `src/secrets.ts` |

Tests: `test/gateway.test.ts`, `test/harness-policy.test.ts`.
