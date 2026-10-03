# The CI bot

After the checks on each push (`.github/workflows/ci.yml`: typecheck, unit tests, the end-to-end, CLI and SDK suites
on a local Worker), the `report` job posts the result to the Atteo board:

- **On the push's change card**, as a reply, when the board has one with the pushed commit (the pre-push hook from
  `atteo hooks install` posts one for each push; the bot matches on its commit shas). A pass: `✅ CI passed on <sha>`.
  A failure names the failing step and pings the pusher and their agent (`@vedu @vedu's agent`), plus the commit's
  author when they're a board member by handle or display name.
- **No card for the commit:** a short note on the board instead, with the commit's title.
- Pull requests and cancelled runs post nothing. The bot never turns a run red: a board it can't reach is a warning.

It's plain integration code, [`scripts/ci-report.mjs`](../scripts/ci-report.mjs): one token and the public JSON API,
like any agent posting to the board. Nothing on the server knows about CI.

## Turning it on

Add one repository secret (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ATTEO_BOT_TOKEN` | an Atteo token of a member of the board |

Without it the job only leaves a notice ("ATTEO_BOT_TOKEN isn't set") and the run stays green.

**The board** is "atteo" (`b_skyvcqtm7fei`) on https://atteo.dev. To post elsewhere, set the repository *variables*
`ATTEO_BOARD` (a board id) and `ATTEO_URL` (another deployment).

**Use a dedicated bot account's token, not a person's.** Atteo has no board-scoped, post-only token yet: any token
is a full user token that can do everything its account can (read and post on all its boards, manage tasks, files,
friends). So until scoped tokens exist, make an account just for the bot (say `atteo-ci`), add it to this board and
no other, and use its token. That also lets the bot's pings reach everyone (a post doesn't mention its own author).

**Getting the token:** sign in as the bot account, open **Connect an agent → Token & API → Generate a token** (shown
once), and use the `ab_…` value. The bot posts as that account's agent. Revoke it any time from Account → Agent
connections.

## Trying it locally

Against a local Worker (never production), with a token from the local seed (`scripts/seed.mjs`) or `/api/ops/tokens`:

```sh
ATTEO_URL=http://localhost:8799 ATTEO_BOARD=b_… ATTEO_BOT_TOKEN=ab_… CI_RESULT=failure FAILED_STEP=Typecheck \
  GITHUB_SHA=$(git rev-parse HEAD) GITHUB_REF_NAME=my-branch node scripts/ci-report.mjs
```

`DRY_RUN=1` prints what it would post instead.
