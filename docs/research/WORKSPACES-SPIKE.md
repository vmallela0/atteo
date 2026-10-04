# Workspaces P0 spike: Cloudflare Sandbox SDK (jxn #1409, PRD #1132 §5)

Spiked 2026-10-04 by opus-a, on a local machine only: no deploy, no Cloudflare account changes. The spike Worker, its image and the timing script are in [`workspaces-spike/`](workspaces-spike/). The PRD's §5 choice turns on three questions: how fast a workspace wakes, what survives sleep, and whether egress and secrets can be controlled from outside the VM.

**Caveat first.** Local Containers dev (`wrangler dev` with a container) did not start a container on this machine, and the official `minimal` example failed the same way (see [Local dev blocker](#local-dev-blocker)). So:

- the timings below come from **plain Docker** running the spike's own image;
- the lifecycle and egress answers come from the platform API (`ctx.container`), the SDK's examples and source, and Cloudflare's docs (as of Sep 30, 2026). The spike Worker implements them, but it hasn't run.

Each claim below says which kind it is.

## Answers

### 1. Wake time with a real repo (measured, Docker)

Each run uses a new container (2 CPUs, 4 GB) with `npm ci`. "Restore" unpacks a tarball of the saved directory, which is what `DirectoryBackup` or a container snapshot gives back. Times are medians of 2–3 runs. Single outliers (a 17 s container start, a 14 s install) came from other agents loading the machine.

| Repo | Cold: clone + `npm ci`, empty cache | Warm: clone + restore npm cache + `npm ci` | Restore `/workspace` (checkout + `node_modules`) + `git fetch` |
|---|---|---|---|
| Atteo (this repo, 546 MB with `node_modules`; npm cache 99 MB) | **≈13.5 s** (start 0.5, clone 1.9\*, install 11.2) | **≈8.5 s** (start 0.4, clone 1.8\*, cache 0.8, install 5.5) | **≈4 s** (start 0.4, unpack 3.5 of a 278 MB tgz, fetch 0.3) |
| cloudflare/sandbox-sdk (215 MB; npm cache 64 MB), cloned from GitHub | **≈10 s** (start 0.4, clone 1.9, install 7.9) | **≈6 s** (start 0.4, clone 1.6, cache 0.6, install 3.5) | **≈2.7 s** (start 0.4, unpack 1.7 of a 64 MB tgz, fetch 0.6) |

\* Atteo is private, so it was cloned from a local bare mirror (no network for git). Over HTTPS, add about 1–3 s.

Saving on sleep costs time too: tarring `/workspace` took 6 s (sandbox-sdk) and 15 s (Atteo), and the npm cache 1.5–2.5 s.

**For §5:**
- Keep `/workspace`, including `node_modules`, across sleep. A wake that restores it takes about 3–4 s plus the platform's start time, against 10–14 s for a cold clone and install. Keeping only the npm cache gets you to 6–9 s.
- The instance types are smaller than this test machine: `standard-1` has ½ vCPU and `standard-3` has 2. Installs are partly CPU-bound, so expect them to be slower on `standard-1`. The platform's real start and snapshot-restore times need an account to measure (see the end of this doc).

### 2. What survives sleep (platform docs + API; not run)

"Sleep" is the instance stopping: the inactivity timeout ends (at most 6 h) or the Durable Object calls `destroy()`.

| Kept? | What |
|---|---|
| Never | Processes, memory, open terminals, network connections. A dev server has to start again. |
| Not by itself | The container's disk. The next instance starts from the image. |
| Yes, with `snapshotContainer()` (public beta) | The whole writable root filesystem: checkout, `node_modules`, caches, and anything else written, including a token left in `.git/config`. Not mounts, memory or processes. The next start passes `start({ containerSnapshot: { id } })`. Max 20 GB. **Expires 30 days** after it's created or last restored. It starts in place of the image, so moving to a new image means starting without it. |
| Yes, with `DirectoryBackup` (SDK) | One directory, streamed to R2 in parallel parts, with exclude patterns or `.gitignore`. It restores into any container, **including one on a newer image**. The container can reach only the one R2 object each operation needs. Its lifetime is set by us, not a 30-day TTL. |
| Yes | Durable Object storage: rules, the snapshot or backup id, session state. An R2 bucket mounted with `S3Mount` (but the mount ends with the instance). |

Two platform facts change the design:

- **Code running inside doesn't count as activity.** If no request arrives, the instance stops when the timeout ends, even in the middle of a build. The Durable Object stays active while it handles a request (an `exec` whose output we stream counts), runs an alarm, or holds a WebSocket open. A long agent run needs an alarm or a held request to keep it awake.
- **The inactivity timeout doesn't survive a Durable Object restart** (a deploy, for example). Set it again in the constructor when the instance is already running. The spike does this on every start, and production needs the constructor case as well.

**For §5:** take a snapshot on sleep for the fastest wake, and also make a `DirectoryBackup` of `/workspace` (say daily, or before an image upgrade) as the durable copy. That covers the 30-day expiry and image upgrades.

### 3. Egress allowlist and secrets outside the VM (API + SDK `outbound-workspace` example; not run)

**Yes, for HTTP(S).** The mechanism, implemented in `workspaces-spike/src/index.ts`:

- `start({ enableInternet: false })`, then `interceptAllOutboundHttp(egress)` and `interceptOutboundHttps("*", egress)`. Here `egress` is a `WorkerEntrypoint` (with `props: { board }`) that reads the board's rules from Durable Object storage on every request: allowed hosts go out, everything else gets a 403. **Rules change without a restart.**
- **Secrets are added in the Worker, never inside the container.** The handler sets `Authorization: Bearer …` for a matching host, and only over HTTPS. The container never holds the token. For git, the token belongs in the handler for `github.com`, not in the clone URL, because a URL token ends up in `.git/config` and in snapshots.
- Only ports 80 and 443 leave the container. Anything else times out: git over SSH, a database port, a bare-IP HTTPS request. Cloudflare re-signs HTTPS with a Containers CA, so every `exec` has to trust `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. The spike passes `CURL_CA_BUNDLE`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` and `npm_config_cafile` on each `exec`, because `exec()` doesn't inherit `start()`'s env.

**A conflict with the PRD (needs a decision).** The PRD says "an agent gets only its own person's secrets". Inside one container that can't hold. Every process shares the same Linux system with root capabilities, and Cloudflare's security docs call the sandbox "the smallest unit of trust". The handler can keep a secret out of the container, but it can't tell which member's agent sent a request. So with one VM per board, anyone working in that board's workspace can **use** (not read) every secret the handler adds. The options:

1. Board secrets only in the shared workspace. Per-person secrets only in that person's own fork, so a fork is a Durable Object with its own container and rules.
2. A per-command token: the Worker sets a short-lived header on that `exec`'s requests. This isn't possible today, because the intercept is set per container run, not per process.
3. Accept "use but not read" for board members, and keep risky hosts behind approvals.

Option 1 matches the PRD's "forkable per task" and is what I'd recommend.

## Local dev blocker

Setup: WSL2 (kernel 6.18), native Docker 26.1.5 (API 1.45), wrangler 4.146.0, workerd 1.20261001.1. `wrangler dev` builds the image and starts the `cloudflare/proxy-everything` networking sidecar, which publishes its ingress port. It never creates the app container. The first container call (`interceptAllOutboundHttp` or `setInactivityTimeout`) fails after 20 s with `kj/timer.c++:30: overloaded: operation timed out`, and `exec()` then reports that the container isn't running.

The SDK's own `examples/minimal` fails the same way. Setting `DOCKER_HOST=unix:///var/run/docker.sock` (the docs' fix for "internal error") changed nothing. The sidecar's ingress port answers from the host over both IPv4 and IPv6. This looks like a workerd and Docker-in-WSL issue, not the spike's code. Worth retrying on a Mac with Docker Desktop, or on an account.

## What needs a real account (and jxn's OK to deploy)

- Real start time per instance type, and `snapshotContainer()` create and restore time and size for an Atteo-sized workspace (about 550 MB).
- `DirectoryBackup` throughput to R2, and restore time into a new instance.
- `git clone` and `npm ci` through `interceptOutboundHttps` with the Containers CA, and the allowlist actually blocking hosts.
- Behaviour of a long `exec` (more than a few minutes) held by a streaming request, and of an alarm keeping a background run awake.

**Cost (from the price list, not measured).** A `standard-1` instance (½ vCPU, 4 GiB, 8 GB) awake costs about **$0.04/h** idle and **$0.07/h** with its CPU fully busy. Memory is $0.036/h (billed on what's provisioned), CPU is up to $0.036/h (billed on use), and disk is $0.002/h. The Workers Paid plan includes 25 GiB-hours of memory, which is about 6 h of `standard-1` a month. At 40 h a month, one Max workspace costs about $2–3, well inside $39. Snapshots and R2 storage are extra and small.

## Run the spike

```sh
cd docs/research/workspaces-spike
npm install
npx wrangler dev --port 8798 --inspector-port 9298   # needs working local Containers; never `wrangler deploy` without jxn's OK
# then: POST /ws/<board>/exec {argv}, PUT /ws/<board>/rules {allow, secrets}, POST /ws/<board>/sleep {mode: plain|snapshot|backup}
./measure.sh                                        # the Docker timings above (any machine with Docker)
```
