# Approval hooks in other harnesses (jxn: "what about harnesses that aren't Claude Code?")

Researched 2026-10-04 from each harness's official docs, plus GitHub issues and forum threads where the docs are silent or wrong. Checked locally: Codex CLI 0.160.0 (`~/.local/bin/codex`) and the OpenCode plugin/SDK type definitions (`@opencode-ai/plugin` 1.14.29 in `~/.config/opencode`). `muse`, `gemini`, `cursor-agent`, `aider` and `cline` aren't installed on this machine. Nothing below was run end to end.

## What we have today

`atteo hooks install --approvals` (cli/src/hooks.ts, `installApprovals` / `approveHook`) writes a Claude Code **`PermissionRequest`** hook. It isn't a `PreToolUse` hook, and the difference matters below. The hook goes in `~/.claude/settings.json` with matcher `*` and `timeout: 600`. The hook command `atteo hooks approve`:

- reads `tool_name`, `tool_input` and `cwd` from stdin
- calls `request_approval`, then long-polls `GET /api/approvals/<id>?wait=…` for up to `APPROVAL_WAIT_S` (540 s)
- prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message":…}}}`
- answers deny on its own timer before the harness's 600 s hook timeout runs out
- exits non-zero on any error (not signed in, offline, the server blocks the request), so Claude Code falls back to asking in its terminal

**Rule to keep for every harness:** our own wait has to end before the harness's hook timeout. Almost every harness below **fails open** when a hook times out or crashes (Cursor unless `failClosed: true`; Gemini treats an "other exit code" as a warning and carries on; Grok Build fails open; Codex says hook errors "don't block"). The hook answering `deny` on its own timer is what makes unattended use safe.

## Summary

| Harness | Pre-run hook that can decide | Fires when | Allow skips the prompt? | Deny works? | Timeout (unit, default) | Long human wait OK? | Fit |
|---|---|---|---|---|---|---|---|
| **Claude Code** (today) | `PermissionRequest` | only when it would prompt | yes | yes | s, we set 600 | yes | shipped |
| **OpenAI Codex CLI** | `PermissionRequest` (also `PreToolUse`) | only when it would prompt | yes | yes | **s, 600 default** | yes | **same wire format as ours** |
| **Cursor** (IDE + `cursor-agent`) | `beforeShellExecution`, `beforeMCPExecution`, `preToolUse` | every call | **no** (allow/ask ignored; known bug) | yes (JSON or exit 2) | s, "platform default" | set it explicitly; no stated max | gate (deny-only) |
| **Gemini CLI** | `BeforeTool` | every call | yes (implemented; documented only in issue #28046) | yes (JSON or exit 2) | **ms, 60000** | set 600000; no stated max | gate (allow + deny) |
| **OpenCode** | `permission.asked` event + SDK reply; or `tool.execute.before` (throw = deny) | asked: only when it would prompt; before: every call | yes (reply `once`) | yes (`reject` / throw) | none documented | yes (async JS) | plugin file, not JSON |
| **Muse Code** | `PermissionRequest`, `PreToolUse` | per name, like Claude | reportedly | reportedly | not published | unknown | wait for the schema |
| **Grok Build** (xAI CLI) | `PreToolUse` (the only event that can block) | every call | n/a (no prompt to skip) | yes (`decision:"deny"`, exit 2) | s, **5** | set it; no stated max | gate (deny-only), later |
| **Cline** | `PreToolUse` | every call | no | only `cancel:true`, which ends the whole task | not published | unknown | poor |
| **Aider** | none | n/a | n/a | n/a | n/a | n/a | none (`--yes-always` or a human only) |
| **Grok Bot** (cloud agent) | none for local tools; Sentinel approvals live inside xAI | n/a | n/a | n/a | n/a | n/a | none |
| **MCP elicitation** | n/a: a server asks *its own* user, in the client's UI | only inside Atteo's own tool calls | n/a | n/a | n/a | n/a | can't gate shell/edit |

### Two families, and why it matters

1. **Fires only when the harness would have prompted**: Claude `PermissionRequest`, Codex `PermissionRequest`, and OpenCode's `permission.asked` event. These drop straight into our model. The harness's own allow rules and sandbox still decide what's safe, and only the actual prompts reach the person's phone.
2. **Fires on every tool call**: Cursor `beforeShellExecution`/`preToolUse`, Gemini `BeforeTool`, Codex `PreToolUse`, OpenCode `tool.execute.before`, Grok `PreToolUse`. With no filter, every `ls` and file read becomes a notification on the phone. Supporting these needs **(a)** a `matcher` limited to shell, write and MCP tools, and **(b)** a small read-only allowlist inside the hook (`git status`, `ls`, `cat`, `rg`, …) that answers allow at once without asking Atteo. That's a real (small) piece of work, not just a config line, and the allowlist is a security surface of its own: it has to parse compound commands (`;`, `&&`, `|`, `$(…)`) conservatively.

## Per harness

### OpenAI Codex CLI: best fit

- **Hooks:** Codex reads `~/.codex/hooks.json`, `[hooks]` tables in `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, and hooks from plugins. Hooks are on by default (`[features] hooks = true`; locally, `codex features list` shows `hooks stable true`). The events include `PreToolUse`, **`PermissionRequest`** and `PostToolUse`. [Hooks docs](https://learn.chatgpt.com/docs/hooks) (moved from developers.openai.com/codex/hooks)
- **`PermissionRequest`** "runs only when Codex is about to display an approval prompt" (shell escalation, network approval, and so on). Its stdin has `turn_id`, `tool_name` (`Bash`, `apply_patch`, or `mcp__server__tool`), `tool_input` (`tool_input.command` for Bash and apply_patch) and an optional `tool_input.description`, plus `session_id`, `cwd` and `hook_event_name`.
- **Output:** the shape is **identical to what `approveHook()` already prints**:
  ```json
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Blocked by repository policy."}}}
  ```
  Any `deny` wins over the other hooks, and an `allow` skips the prompt. If no hook decides, the normal prompt appears.
- **`PreToolUse`** covers Bash, apply_patch/Edit/Write and MCP tools, but not hosted tools like WebSearch. It answers with `hookSpecificOutput.permissionDecision` = `allow`/`deny` (or exit 2). `ask` is "parsed but not supported yet" and fails closed.
- **Timeout:** the `timeout` field is in seconds, **default 600**, which is what we already write for Claude. A wait of several minutes is fine.
- **Trust (a UX step):** a hook that isn't managed has to be *reviewed and trusted* before it runs. The trust is keyed to a hash of the hook definition, so a new or changed hook is skipped until the user trusts it in `/hooks` in the TUI. Our installed command string must therefore stay **stable from one install to the next** (the absolute node and cli paths change when node is upgraded, which would make users trust it again). `--dangerously-bypass-hook-trust` skips review for *every* hook in that run, so don't recommend it. Hooks managed through `requirements.toml` or MDM are trusted automatically, which only matters for admins. [Hooks docs](https://learn.chatgpt.com/docs/hooks), [openai/codex#21615](https://github.com/openai/codex/issues/21615) (no supported way for an installer to request trust)
- **Headless:** `codex exec` defaults to `approval_policy = never`, so **PermissionRequest never fires there**. Codex never prompts; whatever the sandbox allows runs, and the rest fails. [Approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security). In principle the unattended path is `codex exec -c approval_policy=on-request` plus our hook, with the hook as the only "UI". **No doc confirms that this works. It needs one local test** with a throwaway `CODEX_HOME`. Interactive Codex (TUI, app, `remote-control`) works as documented.
- Related things that don't replace the hook: `approvals_reviewer = "auto_review"` / `--approve-for-me` hands approvals to an automatic *agent* reviewer, not a person. Locally, `exec_permission_approvals` is a feature flag still "under development".

### Cursor (IDE and `cursor-agent` CLI)

- **Hooks:** `~/.cursor/hooks.json` (user), `<project>/.cursor/hooks.json`, enterprise system paths, and team hooks pushed from the cloud. The format is `{"version":1,"hooks":{"beforeShellExecution":[{"command":"…","timeout":600,"failClosed":true}]}}`. A hook can also take a `matcher` regex and `type: "command"|"prompt"`. [Cursor hooks docs](https://cursor.com/docs/hooks)
- **Input:** `beforeShellExecution` gets `{command, cwd, sandbox}`, `beforeMCPExecution` gets `{tool_name, tool_input, mcp_server_name}`, and `preToolUse` gets `{tool_name, tool_input, tool_use_id, cwd}`. All of them also get `conversation_id`, `generation_id`, `model`, `hook_event_name`, `workspace_roots`, `user_email` and `transcript_path`.
- **Output:** `{"permission":"allow"|"deny"|"ask","user_message":…,"agent_message":…}`. Exit 2 means deny, and other exit codes fail open unless `failClosed: true`.
- **Caveats:**
  - **Only `deny` is honored.** `allow` and `ask` are ignored: Cursor's own allow-list and auto-run settings still decide. The docs themselves say "'ask' … not enforced for `preToolUse` today". [Forum: allow/ask ignored](https://forum.cursor.com/t/beforeshellexecution-hook-permissions-allow-ask-ignored-allow-list-takes-precedence/144244), [Forum: allow doesn't auto-approve MCP](https://forum.cursor.com/t/hooks-return-allow-but-mcp-tool-still-requires-manual-approval-gets-skipped/155434)
  - So Atteo can only act as a **gate**: the hook waits for the person, and approve returns `allow` (Cursor then does whatever it would have done anyway), while deny or timeout returns `deny`. For an unattended agent (`cursor-agent -p --force` / auto-run) that's exactly what we want: everything auto-runs except what the person turns down. In the interactive IDE the person may see Cursor's own prompt *after* approving on their phone.
- **CLI coverage:** Cursor staff confirmed (Apr 2026) that `cursor-agent` fires `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`, `postToolUse`, `stop` and `sessionStart`. `beforeMCPExecution` and `preToolUse` were **not** on that list, so gating MCP tools from the CLI is unconfirmed. [Forum: CLI events](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316)
- **Timeout:** the docs only say `timeout` is in seconds with a "platform default" and give no maximum. Set 600 and keep our wait at 540.

### Google Gemini CLI

- **Hooks:** a `hooks` block in `.gemini/settings.json` (project), `~/.gemini/settings.json` (user) or `/etc/gemini-cli/settings.json` (system), and also from extensions. Format: `{"hooks":{"BeforeTool":[{"matcher":"run_shell_command|write_file|replace","hooks":[{"type":"command","command":"…","timeout":600000}]}]}}`. The matcher is a regex over tool names. `/hooks enable|disable` manages them. Project hooks are fingerprinted, so a changed one comes back as untrusted. The docs don't say whether user-level hooks are fingerprinted too. [Hooks](https://geminicli.com/docs/hooks/), [Hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)
- **`BeforeTool` input:** `tool_name`, `tool_input`, `mcp_context` (for MCP tools) and `original_request_name`.
- **Output:** `{"decision":"allow"|"deny","reason":"…"}` (`block` is an alias for deny; the reason goes back to the model as a tool error), or exit 2 with stderr as the reason. Other exit codes are a warning and the call **continues** (fails open). `hookSpecificOutput.tool_input` can also rewrite the arguments.
- **Allow skips the confirmation prompt, and `ask` exists:** neither is in the reference. Issue #28046 (Jun 2026, code refs `scheduler.ts:646`, `hookAggregator.ts`) says `allow` bypasses the interactive prompt and `ask` forces it. [google-gemini/gemini-cli#28046](https://github.com/google-gemini/gemini-cli/issues/28046)
- **Timeout:** **milliseconds**, default 60000. Write `600000` and keep our wait at 540 s. No maximum is documented.
- **Policy engine:** TOML rules in `~/.gemini/policies/*.toml` decide `allow`/`deny`/`ask_user`. There's no hook in it for an external checker, and in non-interactive mode `ask_user` becomes `deny`. [Policy engine](https://geminicli.com/docs/reference/policy-engine/). The policy engine is static, so a hook is the only way to bring in a person.
- **Headless (`gemini -p`):** the docs don't say whether hooks fire there. Needs a test.

### OpenCode

- **Plugins** are JS/TS modules loaded from `~/.config/opencode/plugins/`, `.opencode/plugins/`, or npm packages listed in `opencode.json` under `"plugin"`. Each one is `export const P = async ({ client, $, directory, … }) => ({ …hooks })`. [Plugins](https://opencode.ai/docs/plugins/)
- **`permission.ask`** is declared in the types (`(input: Permission, output: {status: "ask"|"deny"|"allow"})` in the local `@opencode-ai/plugin` 1.14.29), but **nothing calls it**. [anomalyco/opencode#47674](https://github.com/anomalyco/opencode/issues/47674) (Sep 2026, assigned and still open)
- **Path A, matching our model:** an `event` hook watches for the permission event, which is called **`permission.asked`** in SDK v2 and `permission.updated` in the v1 types the plugin imports, so check which one the installed version emits. The event carries `{id, sessionID, permission, patterns, metadata, tool}`. The plugin creates an Atteo approval, waits, and then replies through the SDK client: v1 `client.postSessionIdPermissionsPermissionId({ path:{id, permissionID}, body:{response:"once"|"reject"} })`, or v2 `POST /permission/{requestID}/reply {reply, message}`. This fires only when OpenCode would prompt. The TUI prompt should stay visible, with whichever answer comes first (terminal or Atteo) winning; that's expected but not verified. No timeout is documented, and the event handler is async. [SDK](https://opencode.ai/docs/sdk/), plus the local `@opencode-ai/sdk` types.
- **Path B, a gate on every call:** `tool.execute.before: async (input:{tool,sessionID,callID}, output:{args})` can `await` Atteo and `throw` to deny. It's deny-only, so allowing just returns. No timeout is documented. It also has the every-call problem described above, and a known quirk where permission rules match the rewritten command ([#35882](https://github.com/anomalyco/opencode/issues/35882)).
- **Permissions config:** `permission.{bash,edit,webfetch,…}` = `allow`/`ask`/`deny` with wildcard patterns, and `opencode run --auto` approves anything that isn't denied. [Permissions](https://opencode.ai/docs/permissions/)
- **How it would install:** we'd ship a `.js` file to `~/.config/opencode/plugins/atteo-approvals.js` instead of editing JSON. The file would shell out to `atteo hooks approve`, or call the API directly.

### Muse Code (`muse`)

- **What Meta's docs say:** events include `PreToolUse` and **`PermissionRequest`**. Hooks come from `<project>/.muse/hooks.json` (needs workspace trust), a `hooks` block in `~/.config/muse/settings.json`, and `managed_hooks_path`. They "run outside the sandbox". Approval modes are `--approval-mode on-request|untrusted|never` and `--approval-judge on|off`; the judge is a built-in reviewer model. "A headless run has no interactive UI for answering a human approval prompt." [Extending](https://dev.meta.ai/docs/muse-code/extending), [Configuration](https://dev.meta.ai/docs/muse-code/configuration), [Permissions](https://dev.meta.ai/docs/muse-code/permissions)
- **Wire format:** Meta hasn't published it. [rulesync#2790](https://github.com/dyoshikawa/rulesync/issues/2790) (Aug 2026) says the per-hook schema and the `approval-policy.json` schema aren't published. A third-party report against v0.2.1 says hooks actually register as plugin capabilities (`.muse-plugin/plugin.json`, `MUSE_EXPERIMENTAL_PLUGINS=1 muse plugins install/approve`). The same report gives stdin as `hook_event_name, tool_name, tool_input, session_id, permission_mode, cwd` and output as `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`), which is Claude's *PreToolUse* shape, not our PermissionRequest shape. It also says `{}` means allow, an unknown key fails the hook, and the environment is cleared. [ACP: where Muse hooks live](https://agenticcontrolplane.com/blog/muse-code-acp-integration)
- **The cleared environment matters for us:** `atteo hooks approve` needs its credentials and `ATTEO_*` settings, so it has to find them on disk, not in the environment.
- **Local:** MUSE.md says 1.4.2 was "verified locally", but `muse` isn't on this machine now, so nothing could be checked.
- **Verdict:** wait until Meta publishes the schema, or until a `muse hooks run --fixture` test on a real install confirms the format.

### Grok Build (xAI's coding CLI) and Grok Bot

- **"Grok Bot"** (xAI's cloud agent; see GROK-BOT-PLUGIN.md) has **no hook surface** for its tools; its own approvals stay inside xAI's product. The harness that matters here is **Grok Build** (`grok` CLI).
- **Hooks:** `~/.grok/hooks/*.json` and `<project>/.grok/hooks/*.json`. It **also reads `.claude/settings.json` and `.cursor/hooks.json`**. Hook types are `command` and **`http`** (a POST to a URL). `PreToolUse` is the only event that can block. A third-party report and Grok's GitHub user guide ([permissions-and-safety](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md), not fetched) say it fires in every permission mode, including `--always-approve`; docs.x.ai doesn't say. Its stdin is camelCase: `hookEventName, sessionId, cwd, workspaceRoot, toolName, toolInput`. The output is a top-level `{"decision":"deny","reason":…}` (or `allow` / nothing), or exit 2. Timeout is in seconds, **default 5**, and crashes and timeouts fail open. [docs.x.ai/build/features/hooks](https://docs.x.ai/build/features/hooks)
- **Problem with Claude hooks:** Grok runs Claude's hooks but doesn't parse `hookSpecificOutput`, so their verdicts are dropped (Grok Build 1.0, Aug 2026). [ACP: Grok Build](https://agenticcontrolplane.com/blog/grok-build-acp-integration). Our **`PermissionRequest`** hook never fires under Grok because Grok has no such event, so nothing interferes today. **But if we ever add a Claude `PreToolUse` hook, Grok would run it and ignore what it says.**
- **Fit:** a deny-only gate, like Cursor, and in the "every call" family. The `http` hook type could someday point straight at an Atteo endpoint (a server-side long-poll), but the default 5 s timeout has to be raised.

### Cline, Aider

- **Cline:** `PreToolUse` hooks live in `~/Documents/Cline/Rules/Hooks/` or `.clinerules/hooks/` (macOS and Linux only). The output is `{cancel, contextModification, errorMessage}`. The only refusal, `cancel: true`, **aborts the whole task**; there's no per-call deny and no approve. Not useful for us. [Cline v3.36 hooks](https://cline.bot/blog/cline-v3-36-hooks), [cline#14697](https://github.com/cline/cline/issues/14697)
- **Aider:** no hooks. Confirmations go to a human in the terminal or are skipped with `--yes-always`. [Options](https://aider.chat/docs/config/options.html)

## MCP elicitation: can Atteo's MCP server ask the person instead?

**Not for this.** With elicitation, a server can ask *the user of that client, in that client's UI*, for input while it's handling one of its **own** requests (a form, or a URL to open). [Spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation). The `2026-07-28` revision keeps form and URL modes but delivers the request as an `InputRequiredResult` that the client retries (multi-round-trip, stateless), not as a nested server-to-client request. [Spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)

- The harness never routes its Bash, edit or other MCP tools through Atteo's server, so elicitation **can't gate them**.
- The answer comes from whoever is at the terminal or IDE, which is exactly the person who *isn't* watching in our use case. Even URL mode needs the client to show the URL and get consent before opening it.
- Support exists: Claude Code declares `elicitation: {form, url}` on 2026-07-28 connections ([Claude Code MCP](https://code.claude.com/docs/en/mcp)), and Codex has `tool_call_mcp_elicitation` stable (local `codex features list`).
- One side use (not part of this): when someone *is* at the terminal, `request_approval` could offer an in-terminal form answer as a fallback alongside the phone.

## Recommendation

Support these next with `atteo hooks install --approvals --agent <name>`. `claude` stays the default.

1. **`codex`: do first; almost no work.**
   - The input and output match `approveHook()` exactly, and the default timeout is 600 s.
   - `installApprovals` gets a codex branch that reads and merges `~/.codex/hooks.json` (honoring `CODEX_HOME`), dropping our old group by matching `APPROVE_CMD` exactly as the Claude branch does. It then writes `hooks.PermissionRequest = [{matcher:"*", hooks:[{type:"command", command:"<node> <cli> hooks approve", timeout:600}]}]`.
   - `approveHook()` stays as it is; the only change is to say "Codex wants to use …" in `details`, based on `hook_event_name` and `turn_id`.
   - The install message has to say: **"Open codex once, run /hooks, and trust 'atteo hooks approve'."** Keep the command string stable. It might be worth installing a fixed wrapper path (for example `~/.atteo/bin/atteo-approve`) so that upgrading node doesn't change the hash and force a re-trust.
   - Before shipping, one local test should confirm (a) the interactive TUI path, (b) that `matcher: "*"` (or no matcher) also covers `apply_patch` and MCP tools, since the docs' only example uses `"Bash"`, and (c) whether `codex exec -c approval_policy=on-request` hands its prompts to the hook.
2. **`cursor`: second. It works in the CLI, and deny is all a gate needs.**
   - Merge `~/.cursor/hooks.json` (`version: 1`) with `beforeShellExecution` (plus `beforeMCPExecution` and `preToolUse` for the IDE), each with `{command, timeout: 600, failClosed: true}`.
   - `approveHook` needs a Cursor output mode: read `command` and `cwd` (or `tool_name`/`tool_input`) from stdin and print `{"permission":"allow"|"deny","user_message":…,"agent_message":…}`.
   - Because Cursor fires on every shell call, this needs the read-only allowlist and matcher described above.
   - The docs should say plainly that approving on Atteo only *removes the block*. Cursor's own auto-run setting still decides, so this is meant for `cursor-agent --force` and auto-run agents.
3. **`gemini`: third.**
   - It's a JSON config edit like the other two, honors allow and deny cleanly, and allow really does skip the prompt.
   - Merge `~/.gemini/settings.json` → `hooks.BeforeTool = [{matcher:"run_shell_command|write_file|replace|mcp_.*", hooks:[{name:"atteo-approvals", type:"command", command:…, timeout:600000}]}]`, and print `{"decision":"allow"}` or `{"decision":"deny","reason":…}`.
   - Every call fires, so the allowlist is needed here too.
   - Check whether hooks fire under `gemini -p`.
4. **Later:**
   - **OpenCode:** a plugin file; Path A (`permission.asked` + SDK reply) matches our model best, but the event name differs between versions and no timeout is documented.
   - **Muse Code:** wait for Meta to publish the schema.
   - **Grok Build:** deny-only; 5 s default timeout; one day possibly the `http` hook type pointed at Atteo.
   - **Not doing:** Cline (cancel aborts the task) and Aider (no hooks).

**Code shape:**
- `hooks approve` learns `--agent <name>` (claude, codex, cursor, gemini), set in the installed command line, so one hook function serves every harness.
- Normalize the input to `{tool, what, cwd}`, run the existing `request_approval` + long-poll loop, and print per agent. Claude and Codex share one printer.
- `APPROVAL_WAIT_S` must stay below every harness's configured timeout.
- Errors keep exiting non-zero. That falls back to the harness's own prompt in Claude, Codex and Cursor (with fail-open), and in Gemini the call continues. Where falling open isn't acceptable (Cursor), `failClosed: true` turns errors into a block.

## Sources

- Codex: https://learn.chatgpt.com/docs/hooks · https://learn.chatgpt.com/docs/agent-approvals-security · https://github.com/openai/codex/issues/21615 · local `codex --version` (0.160.0), `codex features list`, `codex exec --help`
- Cursor: https://cursor.com/docs/hooks · https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316 · https://forum.cursor.com/t/beforeshellexecution-hook-permissions-allow-ask-ignored-allow-list-takes-precedence/144244 · https://forum.cursor.com/t/hooks-return-allow-but-mcp-tool-still-requires-manual-approval-gets-skipped/155434
- Gemini CLI: https://geminicli.com/docs/hooks/ · https://geminicli.com/docs/hooks/reference · https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md · https://github.com/google-gemini/gemini-cli/issues/28046 · https://geminicli.com/docs/reference/policy-engine/
- OpenCode: https://opencode.ai/docs/plugins/ · https://opencode.ai/docs/permissions/ · https://opencode.ai/docs/sdk/ · https://github.com/anomalyco/opencode/issues/47674 · https://github.com/anomalyco/opencode/issues/35882 · local `~/.config/opencode/node_modules/@opencode-ai/{plugin,sdk}` type definitions
- Muse Code: https://dev.meta.ai/docs/muse-code/extending · https://dev.meta.ai/docs/muse-code/configuration · https://dev.meta.ai/docs/muse-code/permissions · https://github.com/dyoshikawa/rulesync/issues/2790 · https://agenticcontrolplane.com/blog/muse-code-acp-integration (third-party)
- Grok Build: https://docs.x.ai/build/features/hooks · https://agenticcontrolplane.com/blog/grok-build-acp-integration (third-party)
- Cline / Aider: https://cline.bot/blog/cline-v3-36-hooks · https://github.com/cline/cline/issues/14697 · https://aider.chat/docs/config/options.html
- MCP: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation · https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation · https://code.claude.com/docs/en/mcp
