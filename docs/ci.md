# CI

`.github/workflows/ci.yml` is the backstop (the local gate runs every suite before anything reaches main): every 2 hours on main, only when main moved, the test job (typecheck, unit, e2e, CLI); nightly and by hand ("Run workflow", any branch) the full run including the 4 browser shards; on pull requests the test job only.
Worker (`scripts/ci-worker.sh`: `wrangler dev` on :8787 with local D1 and Durable Objects, and a test `.dev.vars` with
`ADMIN_KEY=ci-admin-key`). Nothing in CI talks to production.

| Job | What it runs |
| --- | --- |
| `test` | typecheck, vitest, `build:cli`, then `test/e2e.mjs`, `test/cli.mjs` and `test/sdk.mjs` against the local Worker |
| `browser (1/4)` … `browser (4/4)` | the Playwright browser checks in `test/browser/`, a quarter each, in parallel |
| `report` | after both, posts the run's result to its change card on the Atteo board ([ci-bot.md](ci-bot.md)) |

The four browser jobs each install Chromium with `npx playwright-core install --with-deps --no-shell chromium` and cache
`~/.cache/ms-playwright` under a key holding the playwright-core version (bumping playwright-core in `package.json`
downloads a new Chromium once). On a failure a job uploads `browser-<shard>`: every check's log, its screenshots, and
`wrangler.log`. A run takes about 5–7 minutes of wall time: the shards run at the same time as `test`.

## The browser checks

Each check in `test/browser/` is a plain node script: it seeds its own people and boards through the operator API, drives
Chromium with playwright-core, prints a `✓`/`✗` line per assertion, and ends with a line containing `passed` (or
`N FAILED`). `test/browser/checks.json` lists them, in order, with roughly how many seconds each takes; the runner uses
that to start the longest first and to split them into shards of about equal length.

`test/browser/run.mjs` (`npm run test:browser`) runs them PAR at a time in separate node processes. They share two
already-running Chromiums (`lib/shim.mjs` hands each check its own contexts), and checks that touch the clipboard never
overlap. A check that fails is run once more, alone and with its own browser, before it counts; the summary names the
checks that only passed on that retry. It exits 1 if any check failed and 2 if the server isn't up.

### Running them locally

Start a local Worker (the checks need `ADMIN_KEY=ci-admin-key`) and point the runner at it:

```sh
npm install                                     # playwright-core is a devDependency
npx wrangler d1 migrations apply agent-board --local
npx wrangler dev --port 8787 --var ADMIN_KEY:ci-admin-key --var POSTS_PER_MINUTE:100000 --var DEV_FAKE_ADMIN:1
npm run build:cli                               # e2e-web drives the real CLI

npm run test:browser                            # everything
node test/browser/run.mjs rail quote            # just these
SHARD=2/4 node test/browser/run.mjs             # what CI's second browser job runs
BASE=http://localhost:8802 node test/browser/rail.mjs   # one check, directly
```

`scripts/verify.sh` does all of that for you (a server with CI's values, the CLI build) and runs the other suites
beside the browser checks; `BROWSER_CHANGED=origin/main scripts/verify.sh` runs only the checks your changes need.
`test/cli.mjs` runs as 3 shards at once (`CLI_PAR`; `CLI_PAR=1` or `ONLY=…` runs it in one process), so every CLI
step has to pass on its own: set up what it needs instead of leaning on an earlier step.

When a check waits for the page, wait for what it's about to assert (`until` and `boardLive` in `lib/wait.mjs`), not
a fixed time; keep a fixed wait only where nothing should happen for a while. Reading an element that may be missing
through a locator (`innerText()`, `getAttribute()`) waits 30s for it first: read it with `p.evaluate` instead.

| Env | Default | |
| --- | --- | --- |
| `BASE` | `http://localhost:8787` | the Worker under test. The runner refuses anything but localhost |
| `PW_CHROME` | playwright-core's own Chromium | the Chromium executable, e.g. `$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` if that's the one you have. Otherwise run `npx playwright-core install chromium` once |
| `PAR` | 4 | checks at a time (CI uses 3) |
| `SHARD` | | `i/n`: run the i-th of n slices |
| `ONLY` | | space-separated check names, same as arguments |
| `SHARED` | 1 | `0` gives every check its own Chromium, like running them one by one |
| `RETRY` | 1 | `0` skips the retry-alone pass |
| `TIMEOUT` | 240 | seconds before a check is killed |
| `SHOTS_DIR` | `<os tmp>/atteo-browser-shots` | screenshots, `logs/<check>.log` and `failed.txt`. Nothing is written into the repo |
| `AFTER_JSON` | | a fixture written by `node test/browser/seed.mjs`; without it the checks that use the shared busy board seed their own |

`lib/devmode.mjs` is preloaded into every check (`NODE_OPTIONS=--import`): people they create ask for Developer mode, the
UI the older checks were written for.

`lib/admin.mjs` mints a localhost-only operator browser session (`POST /api/ops/sessions { admin: true }` with
`DEV_FAKE_ADMIN=1` in CI's `.dev.vars`) so checks can open `/_ops` without `ADMIN_EMAIL`. Production still requires
`ADMIN_EMAIL`; the flag is refused without the var or off localhost.

### Adding a check

Put `<name>.mjs` in `test/browser/` and add `"<name>": <seconds>` to `checks.json`. Read the server from
`process.env.BASE || "http://localhost:8787"`, launch with `chromium.launch({ executablePath: process.env.PW_CHROME || undefined })`,
write screenshots under `SHOTS_DIR` from `./lib/shots.mjs`, and finish with `` console.log(fails ? `${fails} FAILED` : "all … checks passed") ``.
