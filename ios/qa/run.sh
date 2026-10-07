#!/usr/bin/env bash
# The app's QA, against a LOCAL server (never production): seeds believable data, starts theo's encrypted-board peer,
# and runs every UI test on the simulator. Screenshots land in the result bundle.
# Usage: (npx wrangler dev --port 8788 running) ios/qa/run.sh [more xcodebuild args, e.g. -only-testing:AtteoUITests/TypingUITests]
# BASE=http://localhost:<port> and SIM="<simulator name>" pick another local server and simulator.
#
# Faster runs (vedu #2790):
#   - Builds once: build-for-testing into QA_DERIVED (default ios/.qa-build), then test-without-building. QA_BUILD=0 reuses
#     the last build as is (nothing changed in the app since); QA_BUILD=1 (default) rebuilds incrementally first.
#   - xcodegen runs only when project.yml or the set of source files changed since the last generate.
#   - QA_PARALLEL=N runs test classes on N clones of the simulator at once (default 1, off). Measured Oct 5 on a busy Mac:
#     2 clones took 990s against 628s serial, and two classes collided on the shared seeded boards
#     (NewMessagesUITests counted another test's message). Use it only on an otherwise idle Mac, and expect that collision
#     until the seed gives each worker its own boards.
#   - Encrypted boards (E2E 1c): the phone pins theo's laptop key, which enc-peer.mjs keeps in .qa-build. If that key was
#     removed (an older seed, a deleted .qa-build), the phone rightly won't hand theo the key any more: start the
#     simulator's pins over with `xcrun simctl keychain "$SIM" reset`.
#   - Test timeouts: a test that runs past QA_TEST_ALLOWANCE seconds (default 300) is stopped and reported as failed,
#     instead of a frozen app (or XCTest stuck symbolicating a failure) holding the whole run for many minutes.
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE="${BASE:-http://localhost:8788}"
case "$BASE" in http://localhost*|http://127.0.0.1*) ;; *) echo "QA runs against a local server only"; exit 1 ;; esac
out=$(mktemp -d)
ADMIN_KEY=$(grep '^ADMIN_KEY=' .dev.vars | cut -d= -f2-) BASE="$BASE" node ios/qa/seed.mjs > "$out/seed.json"
j() { python3 -c "import json,sys;d=json.load(open('$out/seed.json'));print($1)"; }
node ios/qa/enc-peer.mjs "$BASE" "$(j "d['other']")" "$(j "d['enc']")" > "$out/peer.log" 2>&1 &
cd ios

# xcodegen only when its inputs changed: project.yml plus the list of source files (it bakes the file list in).
stamp=$( { cat project.yml; find AgentSoup AtteoTests AgentSoupUITests -type f \( -name '*.swift' -o -name '*.xcstrings' -o -name '*.plist' -o -name '*.json' \) 2>/dev/null | sort; } | shasum | cut -c1-16)
if [ "$(cat .qa-xcodegen-stamp 2>/dev/null)" != "$stamp" ] || [ ! -d Atteo.xcodeproj ]; then
  xcodegen generate -q >/dev/null && echo "$stamp" > .qa-xcodegen-stamp
fi

derived="${QA_DERIVED:-$PWD/.qa-build}"
dest="platform=iOS Simulator,name=${SIM:-iPhone 17 Pro}"
if [ "${QA_BUILD:-1}" != 0 ] || ! ls "$derived"/Build/Products/*.xctestrun >/dev/null 2>&1; then
  # netrc, not keychain: a headless keychain lookup hangs the Sentry binary downloads forever.
  xcodebuild build-for-testing -project Atteo.xcodeproj -scheme Atteo -destination "$dest" -derivedDataPath "$derived" -packageAuthorizationProvider netrc -quiet 2>&1 \
    | grep -E "error:|BUILD FAILED" | grep -v "exit code 0 but produced no further output" || true # -quiet's note on a clean build
fi
xctestrun=$(ls -t "$derived"/Build/Products/*.xctestrun | head -1)

par=()
if [ "${QA_PARALLEL:-1}" -gt 1 ]; then par=(-parallel-testing-enabled YES -parallel-testing-worker-count "$QA_PARALLEL"); fi
allow="${QA_TEST_ALLOWANCE:-300}"

# Anything else the seed hands the tests (its "env" object): TEST_RUNNER_AGENT_SOUP_<KEY>.
extra=$(j "' '.join('TEST_RUNNER_AGENT_SOUP_%s=%s' % (k.upper(), v) for k, v in d.get('env', {}).items())")
env $extra TEST_RUNNER_AGENT_SOUP_SERVER="$BASE" TEST_RUNNER_AGENT_SOUP_TOKEN="$(j "d['app']")" TEST_RUNNER_AGENT_SOUP_OTHER_TOKEN="$(j "d['other']")" TEST_RUNNER_AGENT_SOUP_OTHER_APP="$(j "d.get('otherApp', '')")" \
TEST_RUNNER_AGENT_SOUP_TICK="$(j "d['b1']+':'+str(d['sub'])")" TEST_RUNNER_AGENT_SOUP_ENC=1 \
  xcodebuild test-without-building -xctestrun "$xctestrun" -destination "$dest" -resultBundlePath "$out/qa.xcresult" \
    -test-timeouts-enabled YES -default-test-execution-time-allowance "$allow" -maximum-test-execution-time-allowance "$((allow * 2))" \
    ${par[@]+"${par[@]}"} "$@" 2>&1 | grep -E "Test [Cc]ase.*(passed|failed)|error:|TEST (SUCCEEDED|FAILED)|EXECUTE FAILED" # parallel runs say "Test case … on 'Clone N'"
echo "results: $out/qa.xcresult"
