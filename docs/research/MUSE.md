# Muse: standard vs developer support today (boards #1803, #1809, #1821)

Researched 2026-10-04 from Meta's public docs (muse.ai, dev.meta.ai, muse.ai/platform), Cursor's Muse Spark page, and a local install of Muse Code 1.4.2. Not hands-on with the consumer Muse app or Connector Platform review queue.

Meta uses "Muse" for two different products. This doc keeps them separate.

| | **Standard Muse** (consumer agent) | **Developer Muse** (Muse Code + Model API) |
|---|---|---|
| What it is | Personal AI agent on a Meta cloud VM | Terminal coding agent and API for Muse Spark |
| Where | iOS, Android, muse.ai, Mac, WhatsApp, Meta AI glasses (rollout varies) | `muse` CLI on macOS, Linux, Windows; `api.meta.ai` for direct model calls |
| Primary docs | muse.ai, Instagram Creators blog, Muse Help Center (connectors) | dev.meta.ai/docs/muse-code |
| Atteo connect tile today | "Copy message" → ask Muse to build a Custom Connector (streamable HTTP + OAuth) | `~/.config/muse/settings.json` + `muse mcp login`, or stdio `atteo mcp` |

Muse Spark is the model family both use. Cursor also offers Muse Spark 1.3 as a model picker option (not Muse Code); that is a third surface and is noted only where it matters for MCP/headless.

## Recommendations for Atteo

1. **Treat standard Muse and Muse Code as separate integration paths.** Consumer Muse has no MCP settings UI; our existing copy-message tile (html.ts) is the right shape. Muse Code is a normal local MCP client and fits `atteo harness muse` + dispatch like Claude Code or Cursor Agent.
2. **Platform connectors are a long bet.** Meta's Connector Platform (muse.ai/platform) accepts hosted MCP or raw APIs and lists approved connectors in Settings → Connectors. Submission is a full review (security, legal, E2E QA). Atteo could file, but approval is uncertain and unrelated to today's board MCP URL.
3. **Use `muse exec` for headless forks, not `muse serve`, unless you need a long-lived protocol host.** `muse exec` is one prompt, one exit code — the same contract as `cursor-agent -p` and `claude -p`. `muse serve` is for apps that hold sessions open.
4. **Background on standard Muse ≠ background on Muse Code.** Consumer Muse is designed to run tasks on its cloud VM and check back. Muse Code background work (shell tasks, subagents, workflows) needs an interactive TUI session or `muse serve`; `muse exec` runs one turn and exits.
5. **MCP on Muse Code is powerful but unsandboxed.** MCP tools run outside the shell sandbox. Pair with `--disable-approval` only where the sandbox still matters; never assume MCP is contained.

## Standard Muse (consumer agent)

### What it is today

Meta's personal AI agent, launched September 2026. It runs on a dedicated secure VM in Meta's cloud (not on the user's phone or laptop). It is proactive: it remembers goals, works across connected apps, and is meant to act without the user watching every step. US rollout on iOS, Android, and muse.ai; Mac desktop control and glasses integration announced at Connect 2026. Free tier with paid plans for heavier use.

Sources: [Introducing Muse (Instagram Creators)](https://creators.instagram.com/blog/introducing-muse-personal-ai-agent/), [TechCrunch Connect roundup](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/).

### Connectors

Three paths, only two relevant to third parties:

| Path | Who builds it | Atteo fit |
|---|---|---|
| **Platform connectors** | Meta + launch partners (email, calendar, GitHub, Notion, retailers, travel, etc.) | Listed in Settings → Connectors; Meta-curated; no self-serve add |
| **Connector Platform** (muse.ai/platform) | Third parties submit hosted **MCP** or **raw API** (+ OpenAPI) | Full review; approved connectors appear in Settings → Connectors and are discoverable by the agent |
| **Custom Connectors** | Muse writes an MCP client itself in chat, tests it on its VM, saves as a reusable skill | **Works today for Atteo** — our connect tile message asks for streamable HTTP + OAuth to the board MCP URL |

There is **no** "Add MCP server" field in Muse Settings. Users connect custom services by asking Muse in chat. Built-in connectors use Meta's approval and HITL rules (read/write/sensitive-write; sensitive writes always require per-use approval).

Connector Platform submission asks for: product overview, business verification, data-processing questionnaire, endpoint + auth (API key, OAuth PKCE, or other), test credentials, and per-tool read/write/sensitive classification in documentation.

Sources: [Connector guidelines](https://muse.ai/platform/docs), [SealGate Muse doc](https://sealgate.ai/docs/connect-clients/muse) (third-party but consistent with Meta's public shape).

### MCP

- **End users:** no MCP config surface. Custom Connectors are MCP clients Muse builds at runtime on its cloud computer; they must reach **public** URLs (localhost will not work).
- **Platform program:** submit a **hosted MCP server** or document a raw API. Meta tests the live endpoint.
- **Auth:** OAuth (including dynamic client registration in Muse Code; consumer flow is browser sign-in when Muse builds the connector). Remote MCP OAuth is supported in Muse Code via `muse mcp login <server>`.

Atteo's tile message (html.ts) matches this: streamable HTTP board URL, OAuth, saved as a skill.

### Headless one-shot command

**No public CLI or API to run standard Muse as a one-shot headless agent.** It is a consumer product (app / web / glasses). Developers who want headless agent loops use **Muse Code** (`muse exec`) or call **Muse Spark** through the Model API directly.

### Background runs

**Yes, by design.** Meta positions Muse as working in the background on the user's VM and checking back when finished (Connect 2026, creators blog). Long-running tasks, email/calendar work, and connector actions can continue while the user does something else. A separate **Sentinel** agent enforces approval on connector actions (read-only mode, per-action, per-task, or time-window grants in Settings).

This is not the same as a developer "dispatch loop": there is no documented webhook or mailbox poll API for standard Muse.

## Developer Muse (Muse Code + Model API)

### What it is today

**Muse Code** — Meta's coding agent for terminal and CI, default model `muse-spark-1.2` (docs also reference 1.1 on the API). Install: `curl -fsSL https://dev.meta.ai/install.sh | sh` → `muse` on PATH. Verified locally: **Muse Code 1.4.2**.

**Meta Model API** — OpenAI-compatible (`api.meta.ai/v1`) and Anthropic Messages-compatible endpoints for building your own agents on Muse Spark. Separate from the Muse Code binary.

Platforms: macOS, Linux, Windows (PowerShell, no voice on Windows, no session messaging on Windows).

Source: [Muse Code overview](https://dev.meta.ai/docs/muse-code).

### Connectors

Muse Code does not use the consumer "Connectors" catalog. Integration is:

- **MCP servers** in user settings (see below)
- **Skills** (bundled, user, project, plugin) — including `/migrate` from Claude Code or Codex
- **Hooks** (project `/.muse/hooks.json`, user settings, managed path)
- **Session messaging** between named interactive sessions on the same machine (macOS/Linux)
- **Workflows** — multi-agent orchestration when the build includes the workflow engine (not on all artifacts; e.g. public `aarch64-apple-darwin` package lacks it per docs)

### MCP

Configured in `~/.config/muse/settings.json` (`schema_version: 1` required). Block: `mcp_servers`.

| Field | Values |
|---|---|
| `transport` | `stdio` (`command`, `args`, `env`) or `streamable_http` (`url`, `headers`) |
| `enabled` | boolean |
| `mode` | `required` (default; abort if server fails) or `optional` (warn and skip) |
| Env | `${VAR}` interpolation; stdio servers receive `MUSE_SESSION_ID` |

Commands:

```bash
muse mcp login <server>    # OAuth for remote MCP
muse mcp logout <server>
```

In an interactive session: `/mcp` lists connected servers and tools.

**Important:** MCP tools are **not sandboxed** (unlike shell commands). Read-only server declarations can skip approval under on-request mode.

Atteo wiring (stdio, local CLI):

```json
{
  "schema_version": 1,
  "mcp_servers": {
    "atteo": {
      "transport": "stdio",
      "command": "atteo",
      "args": ["mcp"],
      "enabled": true
    }
  }
}
```

Or streamable HTTP to the board URL + `muse mcp login atteo` (matches consumer Custom Connector transport).

Source: [Extending and automating — MCP](https://dev.meta.ai/docs/muse-code/extending), [Configuration](https://dev.meta.ai/docs/muse-code/configuration).

### Headless one-shot command

**Yes — `muse exec`.** This is the real headless surface for Muse Code.

```bash
muse exec "Update the changelog and run the tests."
muse exec --prompt-file ./task.txt
muse exec --json "Refactor auth and run tests."   # JSONL on stdout
muse exec --session-id <uuid> "Continue the task."
```

| Flag | Role |
|---|---|
| `--disable-approval` | Unattended; keeps sandbox (preferred for CI) |
| `--yolo` | Disables approval **and** sandbox; also trusts workspace — only in disposable containers |
| `--trust-workspace` | Load project `AGENTS.md`, skills, rules for this run |
| `--max-model-steps <N>` | Cap model steps |
| `--no-session-log` | No retained session (no resume / peer messaging) |

Exit codes: `0` turn completed, `1` failed/cancelled/capped, `2` usage error, `130`/`143` signals. Exit `0` does not mean tests passed — gate on your own checks.

Auth for CI: `META_API_KEY` in the environment (no browser). Linux CI needs bubblewrap for the sandbox.

Also: **`muse serve`** exposes a versioned session protocol (+ TypeScript SDK `@muse-code/sdk`) for long-running programmatic control — not a one-shot command.

Atteo harness preset (added in this PR): `muse exec <prompt> --disable-approval --trust-workspace`.

Source: [Extending — Headless and CI](https://dev.meta.ai/docs/muse-code/extending), [Auth](https://dev.meta.ai/docs/muse-code/auth).

### Background runs

Several mechanisms; they target **interactive or served** sessions, not a fire-and-forget `exec`:

| Mechanism | What it does |
|---|---|
| **Background shell tasks** | Long commands/monitors; `/tasks`, `/stop` (stops tasks/terminals, not all subagents) |
| **Subagents** | Lead spawns bounded child agents; `/subagents`, native subagent tools; optional Git worktree isolation per child |
| **Workflows** | Parallel/staged multi-agent runs; `/workflows` control room; continues in background, delivers result to conversation (when build supports it) |
| **Observer agents** | Four background quality observers (memory, skill, goal, verification) — on by default, add token cost |
| **Session messaging** | Peer messages between live interactive sessions on same machine (steer / queue / notify); **not** on Windows, headless, or `--no-session-log` |

`muse exec` runs one prompt to completion and exits; it does not host background tasks after exit. For parallel board work, run multiple terminals or use `muse serve`.

Source: [Working with the agent](https://dev.meta.ai/docs/muse-code/interactive), [Session messaging](https://dev.meta.ai/docs/muse-code/session-messaging), [Workflows](https://dev.meta.ai/docs/muse-code/workflows).

## Muse Spark in Cursor (related, not Muse Code)

Cursor added Muse Spark 1.3 as a model provider (agent tools in IDE/CLI). Teams/Enterprise may need to enable the Meta provider. This is **model selection**, not the Muse consumer agent or Muse Code binary.

Cursor Agent CLI (`cursor-agent -p`) supports MCP via `.cursor/mcp.json` and `agent mcp` subcommands. Headless MCP tool injection in `-p` mode has had reported gaps (forum); `--force` / `--trust` / `--approve-mcps` are documented mitigations. Our existing `cursor` harness preset covers this path.

Source: [Cursor Muse Spark 1.3](https://cursor.com/docs/models/muse-spark-1-3), [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters).

## Atteo integration summary

| Client | Connectors | MCP | Headless one-shot | Background |
|---|---|---|---|---|
| Standard Muse | Platform + Custom (chat-built) | Custom Connector = MCP client on Meta's VM; no user MCP settings | **No** | Yes (cloud VM; checks back) |
| Muse Code | MCP, skills, hooks, workflows | `mcp_servers` in settings; `muse mcp login` | **`muse exec`** | Tasks, subagents, workflows, observers (interactive/serve) |
| Muse Spark in Cursor | Cursor marketplace / `mcp.json` | Yes (IDE + `cursor-agent`) | `cursor-agent -p` | Cloud Agents, worker mode (Cursor product; separate from Meta) |

**Smallest paths for Atteo today:**

1. **Muse Code + dispatch:** `atteo harness muse && atteo dispatch --install` (stdio `atteo mcp` in settings).
2. **Standard Muse:** keep the copy-message Custom Connector flow; optional future Connector Platform submission.
3. **Do not assume** standard Muse can poll `atteo mailbox` or run `atteo dispatch` — no headless CLI.

## Open questions / unverified

- Whether Atteo's OAuth + DCR works end-to-end when Muse builds a Custom Connector (tile assumes yes; not tested in this research).
- Connector Platform review time and whether a board MCP URL qualifies as "value beyond browser" for approval.
- Consumer Muse Mac desktop agent availability and API surface (announced; details thin in public docs).
- Workflow availability on the Linux `muse` binary used in CI vs macOS artifacts.

## Sources

- https://dev.meta.ai/docs/muse-code
- https://dev.meta.ai/docs/muse-code/extending (MCP, headless/CI)
- https://dev.meta.ai/docs/muse-code/configuration
- https://dev.meta.ai/docs/muse-code/interactive
- https://dev.meta.ai/docs/muse-code/session-messaging
- https://dev.meta.ai/docs/muse-code/workflows
- https://dev.meta.ai/docs/muse-code/auth
- https://muse.ai/platform/docs (Connector Platform guidelines)
- https://creators.instagram.com/blog/introducing-muse-personal-ai-agent/
- https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/
- https://cursor.com/docs/models/muse-spark-1-3
- https://cursor.com/docs/cli/reference/parameters
- https://sealgate.ai/docs/connect-clients/muse (third-party; cross-checked against Meta docs)
- Local: `muse --version` → 1.4.2; `muse exec --help`
