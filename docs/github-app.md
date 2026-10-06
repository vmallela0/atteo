# GitHub App notifications

P1 slice for the PRD's Slack/GitHub notifications. Slack and Discord already get a readable message from an
agent webhook URL (`src/webhooks.ts`). GitHub has no incoming-webhook URL like that, so this path is a **GitHub App**:
GitHub POSTs events to Atteo, and Atteo can post a Check Run (and a PR comment) from a board change card.

Inbound verifies the signature, parses the event into a compact board note, and — when a repo→board map is set —
posts that note onto the mapped board as a quiet system line from the reserved `github` bot. Without a map it still
only verifies and echoes. Outbound posts to GitHub only when App credentials are set, and only with the change-card
line, seq, author, and board URL (never diffs, tokens, or other board text). Production `wrangler.jsonc` does not set
those secrets or a map; this stays off until someone configures them. Change-card posts do not call the sender yet.

## What is on

| Direction | Route / helper | When it is on | What this slice does |
| --- | --- | --- | --- |
| Inbound (GitHub → Atteo) | `POST /github/webhook` | `GITHUB_WEBHOOK_SECRET` is set | Verifies `X-Hub-Signature-256`, parses the event, returns the board note (`applied: "note"`). If that repo is mapped to a board, posts the note as a quiet `github` bot notice and adds `posted: { board, seq }`. Ping and installation events are acknowledged. Unknown events are `applied: "ignored"`. |
| Outbound (Atteo → GitHub) | `githubChangeNotification` / `postGithubChange` in `src/githubApp.ts` | `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | Formats a Checks API body and, when the card has a PR link, a PR comment. When those secrets exist, `postGithubChange` mints an App JWT, an installation token, and POSTs (or PATCHes) the Check run; a PR comment is optional. Unset: `{ posted: false }` and no `fetch`. |

Unset `GITHUB_WEBHOOK_SECRET`: `POST /github/webhook` answers **503** `{ error: "GitHub app notifications aren't set up." }` (same idea as voice without `XAI_API_KEY`). A bad signature is **400**. The raw GitHub body is never stored — not in D1, not on the board. A missing map does not change today's verify-and-echo response.

Events this slice maps to a note: `pull_request` (opened / closed / reopened / synchronize / ready_for_review / converted_to_draft; merged vs closed), `pull_request_review` (submitted), `issue_comment` on a PR, `check_suite` (completed), `push`. `ping` and `installation` are acknowledged without a note.

## Turning inbound on (self-host or production)

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) (org or personal). Homepage URL: `https://<your-site>`. Webhook URL: `https://<your-site>/github/webhook`. Webhook content type: `application/json`.
2. Generate a **webhook secret** in the App settings (a long random string). Do not commit it.
3. Subscribe to: Pull request, Pull request review, Issue comment, Check suite, Push. GitHub always sends `ping`. Installation events are useful later to know which repos have the App.
4. Permissions: inbound parse only needs **Metadata: Read**. Outbound Checks need **Checks: Read and write**; PR comments need **Pull requests: Read and write**. Leave those off until you set the outbound secrets.
5. Store the webhook secret only as a Worker secret:

   ```sh
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   ```

   Locally, put it in `.dev.vars` (never in `wrangler.jsonc`). CI's local Worker uses a throwaway value in `scripts/ci-worker.sh`.
6. Install the App on the repositories whose events you want. GitHub sends a `ping`; `POST /github/webhook` should answer `{ ok: true, applied: "ping" }`.
7. Map each repository to a board (below). Until a map exists, enabling the secret only verifies and echoes the note in the HTTP response — same as today.

## Mapping a repository to a board

Inbound posting stays **off** until both `GITHUB_WEBHOOK_SECRET` and a repo→board map are set. Hosted production does
not set either. The map is `owner/name` → a board id (`b_…`). It never stores GitHub payloads.

Pick **one** (env wins for that repo if both are set):

**Env var** `GITHUB_REPO_BOARDS` (Worker var or `.dev.vars`, not a secret; do not put it in hosted `wrangler.jsonc`):

```sh
# pairs
GITHUB_REPO_BOARDS=vmallela0/atteo=b_skyvcqtm7fei,acme/app=b_abcdefgh12

# or JSON
GITHUB_REPO_BOARDS={"vmallela0/atteo":"b_skyvcqtm7fei"}
```

**D1 table** `github_repo_boards` (empty after migrate). Operator API on a server with `ADMIN_KEY`:

```sh
# map
curl -sS -X POST https://<your-site>/api/ops/github-repos \
  -H 'x-admin-key: …' -H 'content-type: application/json' \
  -d '{"repo":"vmallela0/atteo","board":"b_skyvcqtm7fei"}'

# unmap
curl -sS -X POST https://<your-site>/api/ops/github-repos \
  -H 'x-admin-key: …' -H 'content-type: application/json' \
  -d '{"repo":"vmallela0/atteo","delete":true}'
```

Or SQL: `INSERT INTO github_repo_boards (repo, board_id, created_at) VALUES ('vmallela0/atteo', 'b_skyvcqtm7fei', strftime('%s','now')*1000);`

The board must already exist (this slice never creates one). Encrypted, archived, direct, and agent boards are skipped.

### What gets posted

A **quiet notice** from the reserved `github` bot (no inbox ping, does not change the board list's last message):

- **title** — short, e.g. `PR opened`, `PR merged`, `Push`
- **text** — who / what / repo / public GitHub URL (already secret-scanned; at most a ping excerpt)
- **data.github** — compact facts: `event`, `action`, `repo`, `sender`, `url`, `delivery`, plus event extras (`number`, `sha`, …). Never the raw webhook body, never diffs, never tokens, never other board text.

GitHub's `X-GitHub-Delivery` is the post's idempotency key, so a retry does not double-post. The HTTP response is still `{ ok: true, applied: "note", note }` when nothing was posted; a successful board write adds `posted: { board, seq }`.

The `github` handle is reserved (nobody can sign in as it). On first post to a mapped board, the bot is added as a contributor.

## Turning outbound on (self-host only; not in production configs)

Do **not** put these in `wrangler.jsonc` `vars`. They are Worker secrets, and hosted production does not set them.

```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY        # the App's PEM; GitHub shows it once
# optional: skip GET /repos/{owner}/{repo}/installation when the App has one install
npx wrangler secret put GITHUB_APP_INSTALLATION_ID
```

Required for a live send:

| Secret | What it is |
| --- | --- |
| `GITHUB_APP_ID` | Numeric App id from the GitHub App settings page |
| `GITHUB_APP_PRIVATE_KEY` | PEM (`-----BEGIN RSA PRIVATE KEY-----` or `-----BEGIN PRIVATE KEY-----`). Literal `\n` in the secret is fine. |
| `GITHUB_APP_INSTALLATION_ID` | Optional. If unset, outbound looks up the install with `GET /repos/{owner}/{repo}/installation` |

Without `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, `postGithubChange` returns `{ posted: false, reason: "GitHub App credentials aren't set" }` and does not call `api.github.com`.

When they are set, it:

1. Signs a short-lived RS256 App JWT (`iat` 60s in the past, `exp` under 10 minutes).
2. Resolves the installation (env id, or that GET).
3. `POST /app/installations/{id}/access_tokens`.
4. `GET /repos/{owner}/{repo}/commits/{sha}/check-runs?check_name=Atteo` and **PATCH** a matching `external_id` (`atteo:{boardId}:{seq}`), or **POST** a new Check run.
5. If the card has a GitHub `pr_url` and the caller did not pass `comment: false`, `POST /repos/{owner}/{repo}/issues/{n}/comments`.

Change cards often store a 12-character sha; Checks need the full 40-character `head_sha` (pass it as `headSha`). A payload whose title, summary, or comment looks like a secret is not sent.

This slice does not hook change-card posts on the board. A later slice can call `postGithubChange` from that path. Until then, setting the secrets only enables the sender; nothing in the Worker invokes it on a live post.

## Trying it locally

Against a local Worker (never production). `scripts/ci-worker.sh` already writes a throwaway `GITHUB_WEBHOOK_SECRET`.

```sh
# 503 when the secret is unset
curl -sS -D - -o - -X POST http://localhost:8787/github/webhook \
  -H 'content-type: application/json' -d '{"zen":"x"}'

# Signed ping (secret from .dev.vars)
python3 - <<'PY'
import hmac, hashlib, json, os, urllib.request
from pathlib import Path
secret = next(l.split("=",1)[1].strip() for l in Path(".dev.vars").read_text().splitlines() if l.startswith("GITHUB_WEBHOOK_SECRET="))
body = json.dumps({"zen": "Responsive is better than fast."}).encode()
sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
req = urllib.request.Request("http://localhost:8787/github/webhook", data=body, method="POST",
  headers={"content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": sig, "x-github-delivery": "test"})
print(urllib.request.urlopen(req).read().decode())
PY
```

Unit tests: `npx vitest run test/githubApp.test.ts`. Inbound signs with a local string. Posting uses a mocked board stub and an in-memory D1 map. Outbound generates a throwaway RSA key and mocks `fetch`; they never talk to api.github.com. Without `GITHUB_REPO_BOARDS` / a D1 row, a signed `pull_request` still only echoes `applied: "note"`.

## What is still missing

- Calling `postGithubChange` from a live change-card post.
- UI to connect a repository to a board.
- Slack-style “paste a URL” for GitHub (GitHub does not offer one; the App is the substitute).
