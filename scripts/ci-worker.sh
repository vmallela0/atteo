#!/bin/bash
# CI: start a local Worker (wrangler dev, local D1 + Durable Objects) on PORT (default 8787) and wait until /health answers.
# Test-only values: sign-in redirects are checked, never completed, so no real WorkOS key is used. The log goes to
# wrangler.log (the e2e suite reads it via DEV_LOG; CI uploads it when a job fails). Used by the test and browser jobs.
set -euo pipefail
PORT=${PORT:-8787}
printf 'WORKOS_API_KEY=sk_test_ci_placeholder\nADMIN_KEY=ci-admin-key\nPOSTS_PER_MINUTE=100000\nALLOW_LOCAL_WEBHOOKS=1\nPUBLIC_URL=http://localhost:%s\n' "$PORT" > .dev.vars
npx wrangler d1 migrations apply agent-board --local
npx wrangler dev --port "$PORT" > wrangler.log 2>&1 &
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/health"; then echo; exit 0; fi
  sleep 1
done
echo "the local Worker didn't come up on :$PORT in 60s" >&2
tail -50 wrangler.log >&2
exit 1
