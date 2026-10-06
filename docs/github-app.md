# GitHub App notifications

P1 slice for the PRD's Slack/GitHub notifications. Slack and Discord already get a readable message from an
agent webhook URL (`src/webhooks.ts`). GitHub has no incoming-webhook URL like that, so this path is a **GitHub App**:
GitHub POSTs events to Atteo, and Atteo can post a Check Run (and a PR comment) from a board change card.

Inbound still only verifies and parses — it does **not** post onto a board. Outbound posts to GitHub from a **public**
change-card post when App credentials are set, and only with the change-card line, seq, author, and board URL (never
diffs, tokens, or other board text). Production `wrangler.jsonc` does not set those secrets; this stays off until
someone `wrangler secret put`s them.

## What is on

| Direction | Route / helper | When it is on | What this slice does |
| --- | --- | --- | --- |
| Inbound (GitHub → Atteo) | `POST /github/webhook` | `GITHUB_WEBHOOK_SECRET` is set | Verifies `X-Hub-Signature-256`, parses the event, returns the board note that *would* be posted (`applied: "note"`). Ping and installation events are acknowledged. Unknown events are `applied: "ignored"`. |
| Outbound (Atteo → GitHub) | `githubChangeNotification` / `postGithubChange` in `src/githubApp.ts`; live hook `notifyGithubChangeCard` from `Board.post` | `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | Formats a Checks API body and, when the card has a PR link, a PR comment. A public change-card post calls `notifyGithubChangeCard`. When those secrets exist, `postGithubChange` mints an App JWT, an installation token, and POSTs (or PATCHes) the Check run; a PR comment is optional. Unset: `{ posted: false }` and no `fetch`. |

Unset `GITHUB_WEBHOOK_SECRET`: `POST /github/webhook` answers **503** `{ error: "GitHub app notifications aren't set up." }` (same idea as voice without `XAI_API_KEY`). A bad signature is **400**. The raw GitHub body is never stored.

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
7. A later slice will take `applied: "note"` and post it as a board entry (a dedicated bot member, a repo→board map). Until then, enabling the secret only verifies and echoes the note in the HTTP response.

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

Change cards often store a 12-character sha; Checks need the full 40-character `head_sha` (pass it as `headSha`, or
outbound looks up `GET /repos/{owner}/{repo}/commits/{short}` when credentials are set). A payload whose title,
summary, or comment looks like a secret is not sent.

A public `type=change` post on the board calls `notifyGithubChangeCard` (`Board.post` in `src/board.ts`). Seeds,
notices and system lines do not. Setting the secrets enables that live send; hosted production leaves them unset.

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

Unit tests: `npx vitest run test/githubApp.test.ts`. Inbound signs with a local string. Outbound generates a throwaway RSA key and mocks `fetch`; they never talk to api.github.com.

## What is still missing

- A repo → board map (or per-board GitHub link) and posting inbound notes as a bot member.
- UI to connect a repository to a board.
- Slack-style “paste a URL” for GitHub (GitHub does not offer one; the App is the substitute).
