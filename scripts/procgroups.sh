# Sourced by scripts/verify.sh: run each local server and suite in its own process group, so stopping it stops
# everything it started (npx → sh → wrangler's node → two workerd and esbuild; a suite's chromium), not just the
# first pid. Killing npx alone left the rest running, and each leak held RAM on a tmpfs /tmp (#3552).
# Plain bash job control (set -m), so it works with macOS's bash 3.2 too (no setsid there).
# test/procgroups.test.ts covers a normal exit, a failed one, TERM, and a child that ignores TERM.

group_pids=()

# in_group <command...>: runs it in the background in a process group of its own, stdin from /dev/null (with job
# control on, bash no longer does that for background jobs, and wrangler dev would stop on reading the terminal).
# Its pid, which is also the group's id, is left in $group_pid.
in_group() {
  set -m
  "$@" </dev/null &
  group_pid=$!
  set +m
  group_pids+=("$group_pid")
}

# group_alive <pgid>: anything in that group still running (zombies waiting to be reaped don't count).
group_alive() {
  ps -A -o pgid= -o stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { found = 1 } END { exit !found }'
}

# stop_groups [grace seconds, default 5]: TERM every group, wait until they're gone or the grace runs out, KILL
# whatever is left, and reap the leaders.
stop_groups() {
  local grace=${1:-5} g i alive
  [ ${#group_pids[@]} -eq 0 ] && return 0
  for g in "${group_pids[@]}"; do kill -TERM -- "-$g" 2>/dev/null; done
  for ((i = 0; i < grace * 10; i++)); do
    alive=0
    for g in "${group_pids[@]}"; do group_alive "$g" && { alive=1; break; }; done
    [ $alive = 0 ] && break
    sleep 0.1
  done
  for g in "${group_pids[@]}"; do kill -KILL -- "-$g" 2>/dev/null; wait "$g" 2>/dev/null; done
  group_pids=()
  return 0
}
