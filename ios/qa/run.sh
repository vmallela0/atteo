#!/usr/bin/env bash
# The app's QA, against a LOCAL server (never production): seeds believable data, starts theo's encrypted-board peer,
# and runs every UI test on the simulator. Screenshots land in the result bundle.
# Usage: (npx wrangler dev --port 8788 running) ios/qa/run.sh [more xcodebuild args, e.g. -only-testing:AtteoUITests/TypingUITests]
# BASE=http://localhost:<port> and SIM="<simulator name>" pick another local server and simulator.
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE="${BASE:-http://localhost:8788}"
case "$BASE" in http://localhost*|http://127.0.0.1*) ;; *) echo "QA runs against a local server only"; exit 1 ;; esac
out=$(mktemp -d)
ADMIN_KEY=$(grep '^ADMIN_KEY=' .dev.vars | cut -d= -f2-) BASE="$BASE" node ios/qa/seed.mjs > "$out/seed.json"
j() { python3 -c "import json,sys;d=json.load(open('$out/seed.json'));print($1)"; }
node ios/qa/enc-peer.mjs "$BASE" "$(j "d['other']")" "$(j "d['enc']")" > "$out/peer.log" 2>&1 &
cd ios
# Anything else the seed hands the tests (its "env" object): TEST_RUNNER_AGENT_SOUP_<KEY>.
extra=$(j "' '.join('TEST_RUNNER_AGENT_SOUP_%s=%s' % (k.upper(), v) for k, v in d.get('env', {}).items())")
env $extra TEST_RUNNER_AGENT_SOUP_SERVER="$BASE" TEST_RUNNER_AGENT_SOUP_TOKEN="$(j "d['app']")" TEST_RUNNER_AGENT_SOUP_OTHER_TOKEN="$(j "d['other']")" TEST_RUNNER_AGENT_SOUP_OTHER_APP="$(j "d.get('otherApp', '')")" \
TEST_RUNNER_AGENT_SOUP_TICK="$(j "d['b1']+':'+str(d['sub'])")" TEST_RUNNER_AGENT_SOUP_ENC=1 \
  xcodebuild test -project Atteo.xcodeproj -scheme Atteo -destination "platform=iOS Simulator,name=${SIM:-iPhone 17 Pro}" -resultBundlePath "$out/qa.xcresult" "$@" 2>&1 | grep -E "Test Case.*(passed|failed)|error:|TEST (SUCCEEDED|FAILED)"
echo "results: $out/qa.xcresult"
