#!/usr/bin/env bash
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
pid=""; hpid=""; primary_rc=0; cleanup_rc=0; wrapper_term=0; killed=0; wait_rc=0; pending=0
sanitize() { sed -E -e 's/[0-9a-fA-F]{64}/[redacted]/g' -e 's/"password":"[^"]*"/"password":"[redacted]"/g'; }
dump_logs() { echo "----- server log (failure) -----" >&2; [ -f "$log" ] && sanitize < "$log" | tail -n 80 >&2; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
galive() { [ -n "${1:-}" ] && kill -0 -- "-$1" 2>/dev/null; }
wait_until() { n=0; while [ "$n" -lt "$1" ] && "$2" "$3"; do sleep "$ready_sleep"; n=$((n + 1)); done; }
honor_cancel() { [ "$pending" -eq 0 ] || { trap 'pending=1' TERM INT; pending=1; primary_rc=143; exit 143; }; }
stop() {
  local p="$1"; [ -n "$p" ] || return 0
  if galive "$p"; then
    kill -TERM -- "-$p" 2>/dev/null || { echo "cleanup failed: TERM did not reach PGID ${p}" >&2; cleanup_rc=1; }
    wait_until "$term_wait" galive "$p"
    if galive "$p"; then
      killed=1; cleanup_rc=1; echo "cleanup failed: KILL escalation for PGID ${p}" >&2
      kill -KILL -- "-$p" 2>/dev/null || echo "cleanup failed: KILL did not reach PGID ${p}" >&2
      wait_until "$kill_wait" galive "$p"
    fi
    galive "$p" && { echo "cleanup failed: PGID ${p} still present" >&2; cleanup_rc=1; }
  elif alive "$p"; then
    cleanup_rc=1; echo "cleanup failed: harness PGID contract failed (pid ${p})" >&2
    kill -TERM "$p" 2>/dev/null || true; wait_until "$term_wait" alive "$p"
    alive "$p" && { killed=1; echo "cleanup failed: KILL escalation for PID ${p}" >&2; kill -KILL "$p" 2>/dev/null || true; wait_until "$kill_wait" alive "$p"; }
  fi
  galive "$p" || alive "$p" || wait "$p" 2>/dev/null || true
}
reap() {
  stop "$hpid"; { galive "$hpid" || alive "$hpid"; } || hpid=""
  [ -n "$pid" ] || return 0
  if alive "$pid"; then
    if kill -TERM "$pid" 2>/dev/null; then wrapper_term=1; wait_until "$term_wait" alive "$pid"; fi
    alive "$pid" && { killed=1; cleanup_rc=1; echo "cleanup failed: KILL escalation for PID ${pid}" >&2; kill -KILL "$pid" 2>/dev/null || true; wait_until "$kill_wait" alive "$pid"; }
  fi
  if alive "$pid"; then echo "cleanup failed: PID ${pid} still present" >&2; cleanup_rc=1; return; fi
  if wait "$pid" 2>/dev/null; then wait_rc=0; else wait_rc=$?; fi; pid=""
  if [ "$killed" -eq 1 ]; then cleanup_rc=1
  elif [ "$wrapper_term" -eq 1 ]; then [ "$wait_rc" -eq 0 ] || { echo "cleanup failed: server exited with status ${wait_rc}" >&2; cleanup_rc=1; }
  else echo "cleanup failed: server exited before wrapper teardown (wait ${wait_rc})" >&2; cleanup_rc=1; fi
}
on_exit() {
  ec=$?
  trap 'pending=1' TERM INT; trap - EXIT; reap
  if [ -z "$pid" ] && [ -z "$hpid" ]; then trap 'exit 143' TERM INT; fi; [ "$pending" -eq 1 ] && primary_rc=143
  [ "$primary_rc" -eq 0 ] && [ "$ec" -ne 0 ] && primary_rc=$ec
  [ "$primary_rc" -ne 0 ] && exit "$primary_rc"; exit "$cleanup_rc"
}
trap on_exit EXIT; trap 'pending=1' TERM INT; honor_cancel
node server/dist/server.js >"$log" 2>&1 &
pid=$!; honor_cancel; sleep "$start_wait"; honor_cancel
if ! alive "$pid"; then dead_pid=$pid; wait "$pid" 2>/dev/null || true; pid=""; echo "server exited early (pid ${dead_pid})" >&2; dump_logs; primary_rc=1; exit 1; fi
ready=0; attempts=0
while [ "$attempts" -lt "$ready_attempts" ]; do
  honor_cancel; alive "$pid" || { echo "server exited before readiness (pid ${pid})" >&2; break; }
  curl -fsS --connect-timeout 1 --max-time 2 "${origin}/api/healthz" >/dev/null 2>&1 && { ready=1; break; }
  attempts=$((attempts + 1)); sleep "$ready_sleep"; done
honor_cancel
if [ "$ready" -ne 1 ]; then echo "readiness failed against /api/healthz (pid ${pid})" >&2; dump_logs; primary_rc=1; exit 1; fi
set +e; set -m; honor_cancel
( make "$target" 2>&1 | sanitize; s0=${PIPESTATUS[0]} s1=${PIPESTATUS[1]}; [ "$s0" -ne 0 ] && exit "$s0"; [ "$s1" -ne 0 ] && exit "$s1"; exit 0 ) &
hpid=$!; trap 'trap '\''pending=1'\'' TERM INT; pending=1; honor_cancel' TERM INT; honor_cancel; set +m; galive "$hpid" || { echo "harness PGID contract failed (pid ${hpid})" >&2; cleanup_rc=1; }
if wait "$hpid"; then primary_rc=0; else primary_rc=$?; fi; trap 'pending=1' TERM INT; honor_cancel
if galive "$hpid"; then echo "cleanup failed: harness group still present after leader exit (PGID ${hpid})" >&2; cleanup_rc=1; fi
set -e
if [ "$primary_rc" -ne 0 ]; then dump_logs; exit "$primary_rc"; fi
