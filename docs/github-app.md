# GitHub App notifications

P1 first slice for the PRD's Slack/GitHub notifications. Slack and Discord already get a readable message from an
agent webhook URL (`src/webhooks.ts`). GitHub has no incoming-webhook URL like that, so this path is a **GitHub App**:
GitHub POSTs events to Atteo, and Atteo can later post a Check Run (and a PR comment) from a board change card.

This slice is parsing and enablement only. It does **not** post onto a board and does **not** call GitHub. Nothing in
this change needs a production secret.

## What is on

| Direction | Route / helper | When it is on | What this slice does |
| --- | --- | --- | --- |
| Inbound (GitHub → Atteo) | `POST /github/webhook` | `GITHUB_WEBHOOK_SECRET` is set | Verifies `X-Hub-Signature-256`, parses the event, returns the board note that *would* be posted (`applied: "note"`). Ping and installation events are acknowledged. Unknown events are `applied: "ignored"`. |
| Outbound (Atteo → GitHub) | `githubChangeNotification` / `postGithubChange` in `src/githubApp.ts` | later: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | Formats a Checks API body and, when the card has a PR link, a PR comment. `postGithubChange` always returns `{ posted: false }` until a later slice sends them. |

Unset `GITHUB_WEBHOOK_SECRET`: `POST /github/webhook` answers **503** `{ error: "GitHub app notifications aren't set up." }` (same idea as voice without `XAI_API_KEY`). A bad signature is **400**. The raw GitHub body is never stored.

Events this slice maps to a note: `pull_request` (opened / closed / reopened / synchronize / ready_for_review / converted_to_draft; merged vs closed), `pull_request_review` (submitted), `issue_comment` on a PR, `check_suite` (completed), `push`. `ping` and `installation` are acknowledged without a note.

## Turning inbound on (self-host or production)

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) (org or personal). Homepage URL: `https://<your-site>`. Webhook URL: `https://<your-site>/github/webhook`. Webhook content type: `application/json`.
2. Generate a **webhook secret** in the App settings (a long random string). Do not commit it.
3. Subscribe to: Pull request, Pull request review, Issue comment, Check suite, Push. GitHub always sends `ping`. Installation events are useful later to know which repos have the App.
4. Permissions for this slice can stay at **Metadata: Read**. Outbound Checks later need **Checks: Read and write**; PR comments later need **Pull requests: Read and write**.
5. Store the webhook secret only as a Worker secret:

   ```sh
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   ```

   Locally, put it in `.dev.vars` (never in `wrangler.jsonc`). CI's local Worker uses a throwaway value in `scripts/ci-worker.sh`.
6. Install the App on the repositories whose events you want. GitHub sends a `ping`; `POST /github/webhook` should answer `{ ok: true, applied: "ping" }`.
7. A later slice will take `applied: "note"` and post it as a board entry (a dedicated bot member, a repo→board map). Until then, enabling the secret only verifies and echoes the note in the HTTP response.

## Turning outbound on (later slice)

Not wired. When it is:

```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # the App's PEM; GitHub shows it once
```

The App then mints a short-lived installation token (JWT signed with that key) and `POST`s `https://api.github.com/repos/{owner}/{repo}/check-runs`. Change cards often store a 12-character sha; live Checks need the full 40-character `head_sha` (pass it as `headSha`, or look it up). A card with `pr_url` also formats `POST /repos/{owner}/{repo}/issues/{n}/comments`, which is what shows up in GitHub's notification inbox.

`postGithubChange` will keep returning `{ posted: false, reason: "outbound posting isn't wired yet" }` even after those secrets exist, until that slice lands. Setting them in production today does nothing.

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

Unit tests: `npx vitest run test/githubApp.test.ts`. They sign with a local string; they never talk to api.github.com.

## What is still missing

- A repo → board map (or per-board GitHub link) and posting inbound notes as a bot member.
- Installation tokens, JWT minting, and the actual Checks / comment `fetch`.
- UI to connect a repository to a board.
- Slack-style “paste a URL” for GitHub (GitHub does not offer one; the App is the substitute).
