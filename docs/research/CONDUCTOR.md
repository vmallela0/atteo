# Conductor: what to learn and how to leverage it (jxn #1276)

Researched 2026-10-03 from conductor.build (docs, changelog, pricing) and press. Not hands-on: I did not install the app, so UX notes come from docs and third-party write-ups (marked "secondary").

## Recommendations (ranked)

1. **Integrate, don't compete: Atteo is the cross-person layer above Conductor.** Conductor is one person's many agents; Atteo is many people's agents and their humans. Conductor now has multiplayer (up to 5 on Pro), but it is shared workspaces, not a chat log with approvals and per-person agents across tools. Position Atteo as "the room your Conductor agents report into".
2. **Top integration path: each Conductor workspace's agent joins an Atteo board through our MCP URL.** Likely works today with no Conductor change (see Leverage). We build one small thing: a one-click "Add Atteo to my Conductor repo" snippet (a `.mcp.json` block plus a setup-script line that sets the session name).
3. **Second path: a "Run in Conductor" button on a task.** The Conductor MCP can create a workspace and delegate a task. Needs a spike.
4. **Copy the attention model into web and app.** Conductor's sidebar shows two signals per row (git state and agent attention) plus one key to jump to the next thing needing you. We have the Inbox; the missing pieces are a dense desktop "next needing me" key and a per-agent state row.
5. **Copy the diff-comment loop into change cards.** Line comments become instructions to the agent, the agent can comment back, and a one-click revert notifies the agent. Our change cards are read-only summaries today.
6. **For Workspaces (Phase 2), take Conductor's lifecycle, not its isolation.** Setup, run and archive scripts, a port range per fork, archive then restore. Keep VM-per-board with a fork per task. Conductor itself moved from local worktrees to one cloud sandbox per workspace, which supports our direction.

## What Conductor is today (Oct 2026)

- Native Mac app (Melty Labs, CEO Charlie Holtz). Runs Claude Code, Codex, Cursor and OpenCode in parallel on your own subscriptions (Sign in with ChatGPT added Sept 29). Latest release 0.90.0 (Oct 2). Customers named: Notion, Linear, Ramp.
- Pricing: Free (local workspaces on your Mac), Pro $50/mo (Conductor Cloud with workspace hours, multiplayer up to 5, API, iOS app), Teams $60/user/mo, Enterprise custom (SSO/SCIM, DPA).
- **Workspace = one git worktree + branch + chat + diff.** Local worktrees live under `~/conductor/workspaces/<repo>/<name>` (secondary). Create from a branch, PR or issue.
- **Config:** `.conductor/settings.toml` (legacy `conductor.json` is ignored once settings.toml exists). Scripts: setup (after checkout), run (a button; several named run scripts since 0.70; concurrent or not), archive (cleanup before archiving). Env vars: `CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_PORT` (first of a 10-port range per workspace). Auto port forwarding for cloud (0.83).
- **Review and merge:** diff viewer with line comments sent to the agent, edit files directly in diffs (0.84), a Checks reference, a PR page (0.73), stacked PRs on GitHub (August), checkpoints (0.19, Nov 2025) and historical diffs (0.22). Archived workspaces stay readable and restorable (secondary).
- **Many agents at once:** attention sidebar (working, needs permission, unread) with a jump-to-next-needing-attention shortcut; PR-lifecycle states backlog, in progress, in review, done (secondary). Tool approvals are off by default, opt-in, with keyboard accept or deny.
- **Harness:** native Claude Code through the Agent SDK; Codex and Cursor SDKs bundled (secondary). You can point it at your own Claude Code binary.
- **Cloud (0.78, July 30):** each cloud workspace is a Vercel Sandbox (us-east-1; 8 vCPU, 16 GB RAM, 32 GB disk, later 64 GB; Node, Python, git preinstalled). GitHub only. Agents keep running when the laptop closes.
- **Multiplayer (early access 0.77):** share a workspace link, see who is active, prompt the same agent together. **iPhone app (Sept 14, iOS 26+):** remote control to watch agents, inspect code, check PRs and merge.
- **Conductor MCP and API (beta, 0.82):** hosted at `https://api.conductor.build/mcp`, OAuth or API key. Any agent can create workspaces, delegate tasks, follow progress, read results and leave inline diff comments. Also "Share your loadouts" (0.86).
- Uncertainty: pricing and cloud limits change monthly; I found no Linear integration in the pages I read (unverified either way); checkpoint mechanics are unclear (I did not read that changelog entry).

## Learn: ranked and concrete

### (a) UX and layout for web (desktop, dense) and app
1. **Two-signal agent rows.** In the side panel Agents list, show git state (branch, ahead/behind, CI) and attention state (working, needs OK, unread) as separate marks. Fits "show work, not chatter".
2. **Jump to next needing me**: one key on desktop, one tap on the Inbox badge on the phone. Cheap, we have the data.
3. **Keyboard approve and deny** (Enter, Backspace) on approval cards on web.
4. **Task states as columns** (backlog, in progress, in review, done), derived from task and change-card state, not a new model.
5. **Remote-control framing for iOS.** Their iPhone app is "watch, inspect, merge", not "code on the phone". That matches our "you're the decider" principle and validates Inbox, swipe approve and merge-from-card.
6. Avoid: their app is single-user and IDE-like. Everyday mode (people, not developers) is ground Conductor does not cover.

### (b) Infrastructure for Workspaces
1. **Setup, run, archive as a repo file** (for example `.atteo/workspace.toml`), run in the VM at fork. Same three hooks, proven shape. Also read `.conductor/settings.toml` scripts if present so a repo set up for Conductor works for us at once.
2. **Ports:** a reserved range per fork (their 10) with an env var like `ATTEO_PORT`, plus forwarded preview URLs posted on the board. Needed as soon as two forks run dev servers in one VM.
3. **Archive and restore:** on done, commit uncommitted work to the branch, snapshot, keep readable; restore on demand. The change card stays while VM time stops.
4. **Isolation choice:** they used worktrees locally and a sandbox per workspace in the cloud. Our VM per board with a worktree per task is cheaper but shares CPU; consider a sandbox per task only for tasks needing a full dev stack. Size against their 8 vCPU / 16 GB per workspace.
5. **Secrets and MCP in the sandbox:** they added cloud MCP servers in Settings (0.82). We should inject the board's MCP URL and token into every fork automatically.

### (c) Review and merge for change cards
1. **Line comments become agent input**: a reply on the card that the claiming agent receives; the agent can post inline comments back.
2. **One-click revert that tells the agent** what was reverted.
3. **Checks on the card** (CI plus agent self-checks) before the Merge button.
4. **Stacked PRs** for dependent tasks: a chain of cards, each reviewable alone.
5. **Edit in the diff** for small fixes without a round trip to the agent.

## Leverage: integration paths

| Path | Works today? | What we build |
|---|---|---|
| A. Workspace agent joins an Atteo board via our MCP URL | Likely yes. Conductor's docs say MCP config is the agent's own: Claude Code user scope or project `.mcp.json`, Codex `~/.codex/config.toml` or `.codex/config.toml` (Streamable HTTP URLs supported), Cursor `.cursor/mcp.json`. Our MCP is a URL plus token, so a committed `.mcp.json` works. Not yet tested by us. | Paste-in snippet; session name from the workspace (for example `vedu/ws-checkout-fix`) set in the setup script; token via env var, not committed; a docs page. Verify in a real Conductor workspace first. |
| B. "Run in Conductor" from a task | Partly. The Conductor MCP can create a workspace and delegate a task. No `conductor://` deep link found. | Spike: our agent holds the Conductor MCP; the task card gets "Run in Conductor"; the workspace's agent claims the task over our MCP. Needs the user's own OAuth to Conductor and our approval flow. |
| C. Atteo above Conductor | Yes via A. The Conductor MCP in the other direction lets an Atteo agent drive Conductor workspaces. | Positioning and copy: "Conductor = my agents on my machine; Atteo = our agents across machines". Report Conductor PR state back as change cards. |
| D. Use Conductor as our Workspaces runtime | No. Closed Mac app with its own cloud; no self-hosting found. | Nothing. Do not build on it. |

Open questions to check on an install: does a Conductor cloud workspace accept an arbitrary remote MCP URL with a bearer header (0.82 says cloud MCPs are set in Settings; auth unclear)? Can a workspace set an env var for the session name? Is there a deep link?

## Competitive notes
- **Overlap:** parallel coding agents with isolation, diff review, PR creation, mobile remote control, cloud sandboxes, and now multiplayer plus an MCP and API. Their cloud, iOS and MCP moves (July to Oct 2026) sit inside our Phase 2 and iOS plans, so expect them to head our way.
- **Complement:** no persistent shared log of typed entries, no cross-person approvals and human decisions, no agents from other people's machines and tools in one room, no Everyday (non-developer) mode. It is code only; Atteo is anything a team's agents do.
- **Risk:** Teams plan could grow chat. Our moat is the board as the record and the people-first model; do not rebuild an IDE.
- **Pricing signal:** $50 to $60 per seat for cloud hours; check our VM-per-board cost against it.

## Sources
- https://www.conductor.build/ , /pricing , /docs/ , /docs/cloud/faq
- https://www.conductor.build/changelog (0.19, 0.22, 0.70 to 0.90) and /changelog/0.82.0-conductor-mcp
- https://www.conductor.build/docs/reference/conductor-json
- https://www.conductor.build/docs/guides/configure-mcp-servers
- https://www.conductor.build/docs/api/mcp
- https://docs.conductor.build/core/scripts (env vars; seen only as a search snippet)
- https://vercel.com/customers/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox
- https://runtimewire.com/article/conductor-iphone-app-cloud-coding-agents
- https://github.com/deathemperor/infinitus/issues/270 (secondary teardown: attention sidebar, diff comments, lifecycle, SDK harness)
