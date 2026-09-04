#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
helper="$root/.github/scripts/ci-compiled-server.sh"
installer="$root/.github/scripts/ci-install-hurl.sh"
wf="$root/.github/workflows/ci.yml"
BASH_RUN=bash
command -v /opt/homebrew/bin/bash >/dev/null 2>&1 && BASH_RUN=/opt/homebrew/bin/bash
pass=0; fail=0
record() {
  if [ "$2" -eq "$3" ]; then echo "PASS $1 (rc=$2)"; pass=$((pass+1))
  else echo "FAIL $1 (rc=$2 want=$3)"; fail=$((fail+1)); fi
}
expect_txt() {
  if printf '%s\n' "$2" | grep -F -- "$3" >/dev/null; then echo "PASS $1"; pass=$((pass+1))
  else echo "FAIL $1"; fail=$((fail+1)); fi
}
reject_txt() {
  if printf '%s\n' "$2" | grep -F -- "$3" >/dev/null; then echo "FAIL $1"; fail=$((fail+1))
  else echo "PASS $1"; pass=$((pass+1)); fi
}
scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin" "$scratch/rt" "$scratch/static" "$scratch/install"
write_bin() { printf '%s\n' "$2" > "$scratch/bin/$1"; chmod +x "$scratch/bin/$1"; }
term_node() {
  printf '%s\n' '#!/bin/sh' 'echo $$ > "$RUNNER_TEMP/node.pid"' \
    "trap \"exit $1\" TERM" 'while true; do sleep 0.05; done' > "$scratch/bin/node"
  chmod +x "$scratch/bin/node"
}
run_helper() {
  PATH="$scratch/bin:/usr/bin:/bin" RUNNER_TEMP="$scratch/rt" HOST=127.0.0.1 PORT=18016 \
    SMOKE_BASE_URL=http://127.0.0.1:18016 UI_WALK_BASE_URL=http://127.0.0.1:18016 \
    DB_PATH="$scratch/rt/app.db" STATIC_ROOT="$scratch/static" EXPECT_TARGET="$1" \
    "$BASH_RUN" "$helper" "$1"
}
grep -F -q 'bash .github/scripts/ci-compiled-server.sh smoke' "$wf" \
  && grep -F -q 'bash .github/scripts/ci-compiled-server.sh ui-walk' "$wf" \
  && grep -F -q 'bash .github/scripts/ci-install-hurl.sh' "$wf" \
  && ! grep -F -q 'harness.out' "$helper" && ! grep -F -q 'pipe.rc' "$helper" \
  && echo "PASS workflow invokes exact helpers" && pass=$((pass+1)) \
  || { echo "FAIL workflow helper wiring"; fail=$((fail+1)); }
write_bin hurl $'#!/bin/sh\necho hurl 8.0.1 fake\nexit 0'
write_bin curl $'#!/bin/sh\nexit 0'
write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\necho fake make ok\nexit 0'
pwned="$scratch/pwned"
set +e; "$BASH_RUN" "$helper" "ui-walk;touch $pwned" >/dev/null 2>&1; rc=$?; set -e
record "mode allowlist rejects injection" "$rc" 2
[ ! -e "$pwned" ]
term_node 0; set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e
record "smoke TERM exit 0" "$rc" 0
term_node 0; set +e; run_helper ui-walk >/dev/null 2>&1; rc=$?; set -e
record "ui-walk TERM exit 0" "$rc" 0
term_node 1; set +e; out=$(run_helper smoke 2>&1); rc=$?; set -e
record "smoke TERM exit 1" "$rc" 1
expect_txt "TERM exit 1 diagnostic" "$out" "cleanup failed: server exited with status 1"
write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\nsleep 0.35; exit 42'
write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\nsleep 0.5; echo fake make ok; exit 0'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e
record "spontaneous exit 42" "$rc" 1
write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\nsleep 0.35; exit 0'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e
record "spontaneous exit 0" "$rc" 1
write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\ntrap "" TERM\nwhile true; do sleep 0.05; done'
write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\necho fake make ok; exit 0'
set +e; out=$(run_helper smoke 2>&1); rc=$?; set -e
record "KILL escalation" "$rc" 1
expect_txt "KILL diagnostic" "$out" "KILL escalation"
term_node 1; write_bin make $'#!/bin/sh\necho make failed; exit 7'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e
record "primary 7 beats cleanup" "$rc" 7
term_node 0; write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\necho fake make ok; exit 0'
write_bin sed $'#!/bin/sh\ncat >/dev/null; exit 1'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e
record "sanitizer failure" "$rc" 1
rm -f "$scratch/bin/sed"
hex=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
term_node 0
python3 - "$scratch/bin/make" "$hex" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1]); hexv = sys.argv[2]
path.write_text("#!/bin/sh\necho 'actual: string <%s>'\nprintf '%%s\\n' '{\"password\":\"demo\"}'\nexit 4\n" % hexv)
PY
chmod +x "$scratch/bin/make"
set +e; out=$(run_helper smoke 2>&1); rc=$?; set -e
record "redact path nonzero" "$rc" 4
reject_txt "64-hex absent" "$out" "$hex"
reject_txt 'exact password JSON absent' "$out" '{"password":"demo"}'
expect_txt 'password redacted token' "$out" '"password":"[redacted]"'
rm -f "$scratch/rt/node.pid"
write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\nprintf "%s\n" "{\"event\":\"server_start_failed\"}"\nexit 1'
set +e; out=$(run_helper smoke 2>&1); rc=$?; set -e
record "early exit before probe" "$rc" 1
expect_txt "early-exit diagnostic" "$out" "server exited early"
expect_txt "early-exit failure log" "$out" "----- server log (failure) -----"
alive_pid() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
alive_pid "$scratch/rt/node.pid" && { echo "FAIL early-exit PID still live"; fail=$((fail+1)); } || { echo "PASS early-exit PID cleared"; pass=$((pass+1)); }
write_bin curl $'#!/bin/sh\nexit 1'
term_node 0; write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\necho fake make ok; exit 0'
set +e; out=$(CI_READY_ATTEMPTS=2 CI_READY_SLEEP=0.05 run_helper smoke 2>&1); rc=$?; set -e
record "never-ready live child" "$rc" 1
expect_txt "never-ready diagnostic" "$out" "readiness failed against /api/healthz"
alive_pid "$scratch/rt/node.pid" && { echo "FAIL never-ready child still live"; fail=$((fail+1)); } || { echo "PASS never-ready child reaped"; pass=$((pass+1)); }
write_bin curl $'#!/bin/sh\nexit 0'; term_node 0; write_bin make $'#!/bin/sh\nexit 33'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e
record "pre-status/child 33 not green" "$rc" 33
write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\necho $$ > "$RUNNER_TEMP/make.pid"\ntrap "" TERM\nwhile true; do sleep 0.05; done'
sleep 30 & sentinel=$!; rm -f "$scratch/rt/node.pid" "$scratch/rt/make.pid"
set +e
PATH="$scratch/bin:/usr/bin:/bin" RUNNER_TEMP="$scratch/rt" HOST=127.0.0.1 PORT=18016 SMOKE_BASE_URL=http://127.0.0.1:18016 UI_WALK_BASE_URL=http://127.0.0.1:18016 DB_PATH="$scratch/rt/app.db" STATIC_ROOT="$scratch/static" EXPECT_TARGET=smoke CI_TERM_WAIT=2 CI_READY_SLEEP=0.05 exec "$BASH_RUN" "$helper" smoke >"$scratch/cancel.out" 2>&1 &
wp=$!
n=0; while [ "$n" -lt 80 ] && [ ! -f "$scratch/rt/make.pid" ]; do sleep 0.05; n=$((n+1)); done
child=""; [ -f "$scratch/rt/node.pid" ] && child=$(cat "$scratch/rt/node.pid")
mpid=""; [ -f "$scratch/rt/make.pid" ] && mpid=$(cat "$scratch/rt/make.pid")
reap_test() { kill -KILL "$1" 2>/dev/null || true; [ -n "$2" ] && kill -KILL "$2" 2>/dev/null || true; [ -n "$3" ] && kill -KILL "$3" 2>/dev/null || true; k=0; while [ "$k" -lt 40 ] && kill -0 "$1" 2>/dev/null; do sleep 0.05; k=$((k+1)); done; }
if [ -z "$mpid" ]; then echo "FAIL cancel never started harness"; fail=$((fail+1)); reap_test "$wp" "$child" ""
else
  kill -TERM "$wp" 2>/dev/null || true
  n=0; while [ "$n" -lt 80 ] && kill -0 "$wp" 2>/dev/null; do sleep 0.05; n=$((n+1)); done
  if kill -0 "$wp" 2>/dev/null; then echo "FAIL cancel wrapper hung"; fail=$((fail+1)); reap_test "$wp" "$child" "$mpid"
  else
    wait "$wp"; rc=$?; record "wrapper cancel" "$rc" 143
    expect_txt "cancel KILL diagnostic" "$(cat "$scratch/cancel.out")" "KILL escalation for PGID"
    [ -n "$child" ] && kill -0 "$child" 2>/dev/null && { echo "FAIL cancel left owned child"; fail=$((fail+1)); } || { [ -n "$child" ] && echo "PASS cancel reaped owned child" && pass=$((pass+1)); }
    kill -0 "$mpid" 2>/dev/null && { echo "FAIL cancel left harness"; fail=$((fail+1)); } || { echo "PASS cancel reaped harness"; pass=$((pass+1)); }
  fi
fi
set -e
if kill -0 "$sentinel" 2>/dev/null; then echo "PASS cancel sentinel survived"; pass=$((pass+1)); kill -TERM "$sentinel" 2>/dev/null || true; wait "$sentinel" 2>/dev/null || true; else echo "FAIL cancel sentinel died"; fail=$((fail+1)); fi
term_node 1; write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\necho fake make ok; exit 0'
sleep 30 & sentinel=$!
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e
if kill -0 "$sentinel" 2>/dev/null; then echo "PASS sentinel survived"; pass=$((pass+1)); kill -TERM "$sentinel" 2>/dev/null || true; wait "$sentinel" 2>/dev/null || true; else echo "FAIL sentinel died"; fail=$((fail+1)); fi
record "TERM exit 1 with sentinel" "$rc" 1
printf '%s\n' '#!/bin/sh' 'while [ "$#" -gt 0 ] && [ "$1" != "--output" ]; do shift; done' '[ "$1" = "--output" ] && shift && : > "$1"' 'exit 0' > "$scratch/install/curl"
printf '%s\n' '#!/bin/sh' 'echo 0000000000000000000000000000000000000000000000000000000000000000' > "$scratch/install/sha256sum"
printf '%s\n' '#!/bin/sh' 'echo TAR_RAN > "${RUNNER_TEMP}/tar-ran"' 'exit 0' > "$scratch/install/tar"; chmod +x "$scratch/install/"*
set +e
out=$(PATH="$scratch/install:/bin:/usr/bin" RUNNER_TEMP="$scratch/rt" "$BASH_RUN" "$installer" 2>&1)
rc=$?
set -e
record "hurl digest mismatch" "$rc" 1
[ ! -f "$scratch/rt/tar-ran" ] && echo "PASS tar skipped" && pass=$((pass+1)) || { echo "FAIL tar ran"; fail=$((fail+1)); }
echo "$out" | grep -q "digest mismatch" && echo "PASS digest diagnostic" && pass=$((pass+1)) || { echo "FAIL digest diagnostic"; fail=$((fail+1)); }
echo "ci-harness oracle: $pass PASS / $fail FAIL"
[ "$fail" -eq 0 ]
