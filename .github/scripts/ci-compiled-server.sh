#!/usr/bin/env bash
# Own one compiled server for CI smoke|ui-walk. Wait status is part of the verdict.
set -euo pipefail
mode="${1-}"
case "$mode" in
  smoke) target=smoke; state_name=workbuddy-smoke; prove_hurl=1 ;;
  ui-walk) target=ui-walk; state_name=workbuddy-ui-walk; prove_hurl=0 ;;
  *) echo "usage: $0 smoke|ui-walk" >&2; exit 2 ;;
esac
: "${HOST:?}" "${PORT:?}" "${DB_PATH:?}" "${STATIC_ROOT:?}" "${RUNNER_TEMP:?}"
start_wait="${CI_START_WAIT:-0.1}"; ready_attempts="${CI_READY_ATTEMPTS:-40}"
ready_sleep="${CI_READY_SLEEP:-0.25}"; term_wait="${CI_TERM_WAIT:-20}"; kill_wait="${CI_KILL_WAIT:-8}"
for v in "$ready_attempts" "$term_wait" "$kill_wait"; do case "$v" in ''|*[!0-9]*) echo "invalid bound" >&2; exit 2 ;; esac; done
for v in "$start_wait" "$ready_sleep"; do case "$v" in ''|*[!0-9.]*|*.*.*) echo "invalid bound" >&2; exit 2 ;; esac; done
[ "$prove_hurl" -eq 1 ] && { command -v hurl >/dev/null; hurl --version; }
state="${RUNNER_TEMP}/${state_name}"; mkdir -p "$state"
log="${state}/server.log"; origin="http://${HOST}:${PORT}"
pid=""; primary_rc=0; cleanup_rc=0; wrapper_term=0; killed=0; wait_rc=0
sanitize() { sed -E -e 's/[0-9a-fA-F]{64}/[redacted]/g' -e 's/"password":"[^"]*"/"password":"[redacted]"/g'; }
dump_logs() { echo "----- server log (failure) -----" >&2; [ -f "$log" ] && sanitize < "$log" | tail -n 80 >&2; }
pid_alive() { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }
wait_dead() { n=0; while [ "$n" -lt "$1" ] && pid_alive; do sleep "$ready_sleep"; n=$((n + 1)); done; }
wait_child() {
  wait_rc=0; [ -n "$pid" ] || return 0
  if wait "$pid"; then wait_rc=0; else wait_rc=$?; fi
  pid=""; return 0
}
reap() {
  [ -n "$pid" ] || return 0
  if pid_alive; then
    if kill -TERM "$pid" 2>/dev/null; then wrapper_term=1; wait_dead "$term_wait"; fi
    if pid_alive; then
      killed=1; cleanup_rc=1
      echo "cleanup failed: KILL escalation for PID ${pid}" >&2
      kill -KILL "$pid" 2>/dev/null || true; wait_dead "$kill_wait"
    fi
  fi
  if pid_alive; then echo "cleanup failed: PID ${pid} still present" >&2; cleanup_rc=1; pid=""; return; fi
  wait_child
  if [ "$killed" -eq 1 ]; then cleanup_rc=1
  elif [ "$wrapper_term" -eq 1 ]; then
    if [ "$wait_rc" -ne 0 ]; then echo "cleanup failed: server exited with status ${wait_rc}" >&2; cleanup_rc=1; fi
  else echo "cleanup failed: server exited before wrapper teardown (wait ${wait_rc})" >&2; cleanup_rc=1; fi
}
on_exit() {
  ec=$?; trap - EXIT TERM INT; reap
  [ "$primary_rc" -eq 0 ] && [ "$ec" -ne 0 ] && primary_rc=$ec
  [ "$primary_rc" -ne 0 ] && exit "$primary_rc"
  exit "$cleanup_rc"
}
trap on_exit EXIT; trap 'exit 143' TERM INT
node server/dist/server.js >"$log" 2>&1 &
pid=$!; sleep "$start_wait"
if ! pid_alive; then
  dead_pid=$pid; wait_child
  echo "server exited early (pid ${dead_pid})" >&2; dump_logs; primary_rc=1; exit 1
fi
ready=0; attempts=0
while [ "$attempts" -lt "$ready_attempts" ]; do
  pid_alive || { echo "server exited before readiness (pid ${pid})" >&2; break; }
  if curl -fsS --connect-timeout 1 --max-time 2 "${origin}/api/healthz" >/dev/null 2>&1; then ready=1; break; fi
  attempts=$((attempts + 1)); sleep "$ready_sleep"
done
if [ "$ready" -ne 1 ]; then
  echo "readiness failed against /api/healthz (pid ${pid})" >&2; dump_logs; primary_rc=1; exit 1
fi
set +e
make "$target" 2>&1 | sanitize
pipe_rc=("${PIPESTATUS[@]}")
set -e
if [ "${pipe_rc[0]}" -ne 0 ]; then primary_rc=${pipe_rc[0]}
elif [ "${pipe_rc[1]}" -ne 0 ]; then primary_rc=${pipe_rc[1]}
else primary_rc=0; fi
if [ "$primary_rc" -ne 0 ]; then dump_logs; exit "$primary_rc"; fi
