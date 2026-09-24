#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "uid-isolation must not run as root" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "uid-isolation requires Linux" >&2; exit 1; }
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || { echo "uid-isolation requires a disposable hosted runner" >&2; exit 1; }
if getent group workbuddy >/dev/null; then echo "workbuddy group already exists" >&2; exit 1; fi
if getent passwd omp >/dev/null; then echo "omp user already exists" >&2; exit 1; fi
: "${GITHUB_WORKSPACE:?}" "${RUNNER_TEMP:?}" "${HOST:?}" "${PORT:?}" "${DB_PATH:?}" "${STATIC_ROOT:?}" "${OMP_BIN:?}" "${OMP_STATE_DIR:?}" "${SANDBOX_ROOT:?}" "${MODEL_UPSTREAM_BASE_URL:?}" "${MODEL_UPSTREAM_API_KEY:?}" "${FAKE_UPSTREAM_PORT:?}"
cd "$GITHUB_WORKSPACE"
fake_omp="$GITHUB_WORKSPACE/server/test/support/fake-omp.mjs"
real_omp="$GITHUB_WORKSPACE/var/omp/omp"
[ "$OMP_BIN" = "$real_omp" ] || { echo "OMP_BIN must be ${real_omp}" >&2; exit 1; }
test -x "$fake_omp" && test -x "$real_omp" && test -d smoke/fixtures/sandbox/u1
node_bin="$(command -v node)"
test -x "$node_bin"
node_dir="$(dirname "$node_bin")"
runner="$(id -un)"
case "$runner" in ''|*[!a-zA-Z0-9_-]*) echo "unsafe runner identity" >&2; exit 1 ;; esac
case "$node_dir" in *:*|*\\*|*\"*|*'
'*) echo "unsafe Node directory for sudo secure_path" >&2; exit 1 ;; esac
sudoers_path() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value// /\\ }"
  value="${value//#/\\#}"
  value="${value//,/\\,}"
  value="${value//:/\\:}"
  printf '%s' "$value"
}
case "$fake_omp$real_omp" in *'
'*) echo "unsafe omp binary path" >&2; exit 1 ;; esac
fake_rule="$(sudoers_path "$fake_omp")"
real_rule="$(sudoers_path "$real_omp")"
job_root="${RUNNER_TEMP}/workbuddy-uid-isolation"
uid_tmp="${job_root}/tmp"
proof_home="${job_root}/proof home:colon"
[ "$SANDBOX_ROOT" = "$job_root/sandbox" ] && [ "$OMP_STATE_DIR" = "$job_root/omp-state" ] && [ "$(dirname "$DB_PATH")" = "$job_root/private" ] || { echo "uid-isolation paths must be job-owned" >&2; exit 1; }
term_wait="${CI_TERM_WAIT:-40}"; kill_wait="${CI_KILL_WAIT:-8}"; ready_sleep="${CI_READY_SLEEP:-0.25}"
for v in "$term_wait" "$kill_wait"; do case "$v" in ''|*[!0-9]*) echo "invalid bound" >&2; exit 2 ;; esac; done
for v in "$ready_sleep"; do case "$v" in ''|*[!0-9.]*|*.*.*) echo "invalid bound" >&2; exit 2 ;; esac; done
primary_rc=0; cleanup_rc=0; pending=0; phase_pid=""; phase_kind=""
mkdir -p "$job_root" "$uid_tmp" "$proof_home" "$SANDBOX_ROOT/u1" "$OMP_STATE_DIR" "$(dirname "$DB_PATH")"
touch "$DB_PATH"
chmod 0600 "$DB_PATH"
chmod 0700 "$(dirname "$DB_PATH")"
sudo groupadd workbuddy
sudo useradd -m -G workbuddy omp
sudo usermod -aG workbuddy "$runner"
command -v setfacl >/dev/null || { echo "setfacl is required to grant omp execute traversal on the runner home" >&2; exit 1; }
runner_home="$(getent passwd "$runner" | awk -F: '{print $6}')"
[ -n "$runner_home" ] && [ -d "$runner_home" ] || { echo "runner home unavailable" >&2; exit 1; }
case "$GITHUB_WORKSPACE" in "$runner_home"/*) ;; *) echo "workspace is not under runner home" >&2; exit 1; esac
case "$RUNNER_TEMP" in "$runner_home"/*) ;; *) echo "RUNNER_TEMP is not under runner home" >&2; exit 1; esac
sudo setfacl -m u:omp:--x "$runner_home"
sudoers_src="${job_root}/workbuddy-omp.sudoers"
{
  printf 'Defaults:%s secure_path="%s:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"\n' "$runner" "$node_dir"
  printf '%s ALL=(omp) NOPASSWD: SETENV: %s\n' "$runner" "$fake_rule"
  printf '%s ALL=(omp) NOPASSWD: SETENV: %s\n' "$runner" "$real_rule"
  printf '%s ALL=(omp) NOPASSWD: SETENV: /usr/bin/env\n' "$runner"
} > "$sudoers_src"
sudo visudo -c -f "$sudoers_src"
sudo install -m 0440 "$sudoers_src" /etc/sudoers.d/workbuddy-omp
# GitHub-hosted runners can ship this pre-existing sudoers file with a mode other than 0440.
# Normalize only that file before validating the complete sudoers configuration.
if sudo test -f /etc/sudoers.d/runner; then
  sudo chmod 0440 /etc/sudoers.d/runner
fi
sudo visudo -c
sudo chgrp workbuddy "$RUNNER_TEMP" "$job_root" "$uid_tmp" "$SANDBOX_ROOT" "$OMP_STATE_DIR"
sudo chmod g+x "$RUNNER_TEMP"
sudo chmod 2770 "$job_root" "$uid_tmp" "$SANDBOX_ROOT" "$OMP_STATE_DIR"
cp -R smoke/fixtures/sandbox/u1/. "$SANDBOX_ROOT/u1/"
sudo chgrp -R workbuddy "$SANDBOX_ROOT/u1"
sudo find "$SANDBOX_ROOT/u1" -type d -exec chmod 2770 {} +
honor_cancel() { [ "$pending" -eq 0 ] || { trap 'pending=1' TERM INT; pending=1; primary_rc=143; exit 143; }; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
galive() { [ -n "${1:-}" ] && kill -0 -- "-$1" 2>/dev/null; }
wait_until() { n=0; while [ "$n" -lt "$1" ] && "$2" "$3"; do sleep "$ready_sleep"; n=$((n + 1)); done; }
owned_pids() {
  local status
  if pids="$(pgrep -u omp)"; then return 0; else
    status=$?
    if [ "$status" -eq 1 ]; then pids=""; return 0; fi
    cleanup_rc=1; echo "cleanup failed: cannot inspect omp uid processes" >&2; return "$status"
  fi
}
stop_phase() {
  local p="$1" grace="${2:-$term_wait}"; [ -n "$p" ] || return 0
  if galive "$p"; then
    kill -TERM -- "-$p" 2>/dev/null || { echo "cleanup failed: TERM did not reach PGID ${p}" >&2; cleanup_rc=1; }
    wait_until "$grace" galive "$p"
    if galive "$p"; then
      cleanup_rc=1; echo "cleanup failed: KILL escalation for PGID ${p}" >&2
      kill -KILL -- "-$p" 2>/dev/null || echo "cleanup failed: KILL did not reach PGID ${p}" >&2
      wait_until "$kill_wait" galive "$p"
    fi
    galive "$p" && { echo "cleanup failed: PGID ${p} still present" >&2; cleanup_rc=1; }
  elif alive "$p"; then
    cleanup_rc=1; echo "cleanup failed: phase PGID contract failed (pid ${p})" >&2
    kill -TERM "$p" 2>/dev/null || true; wait_until "$grace" alive "$p"
    alive "$p" && { echo "cleanup failed: KILL escalation for PID ${p}" >&2; kill -KILL "$p" 2>/dev/null || true; wait_until "$kill_wait" alive "$p"; }
  fi
  if galive "$p" || alive "$p"; then return 0; fi
  wait "$p" 2>/dev/null || true
}
reap_phase() {
  local grace="$term_wait"
  [ -n "$phase_pid" ] || return 0
  [ "$pending" -eq 1 ] && [ "$phase_kind" = smoke ] && grace=$((4 * (term_wait + kill_wait) + 2))
  if galive "$phase_pid" || alive "$phase_pid"; then
    stop_phase "$phase_pid" "$grace"
  fi
  if galive "$phase_pid" || alive "$phase_pid"; then
    echo "cleanup failed: phase group still present (PGID ${phase_pid})" >&2
    cleanup_rc=1
    return 0
  fi
  wait "$phase_pid" 2>/dev/null || true
  phase_pid=""
  phase_kind=""
}
reap_owned() {
  local pids pid n
  owned_pids || return 0
  [ -z "$pids" ] && return 0
  cleanup_rc=1
  echo "cleanup failed: omp uid residue after phase" >&2
  for pid in $pids; do
    case "$pid" in ''|*[!0-9]*) cleanup_rc=1; continue ;; esac
    sudo -n -u omp -- /usr/bin/env /bin/kill -TERM "$pid" || true
  done
  n=0
  while [ "$n" -lt "$term_wait" ]; do
    owned_pids || return 0
    [ -n "$pids" ] || break
    sleep 0.05; n=$((n + 1))
  done
  owned_pids || return 0
  if [ -n "$pids" ]; then
    echo "cleanup failed: KILL escalation for omp uid residue" >&2
    for pid in $pids; do
      case "$pid" in ''|*[!0-9]*) continue ;; esac
      sudo -n -u omp -- /usr/bin/env /bin/kill -KILL "$pid" || true
    done
    n=0
    while [ "$n" -lt "$kill_wait" ]; do
      owned_pids || return 0
      [ -n "$pids" ] || break
      sleep 0.05; n=$((n + 1))
    done
  fi
  owned_pids || return 0
  [ -z "$pids" ] || echo "cleanup failed: omp uid residue remains" >&2
}
on_exit() {
  local ec=$?
  trap 'pending=1' TERM INT; trap - EXIT
  reap_phase
  reap_owned
  [ "$pending" -eq 1 ] && primary_rc=143
  if [ "$primary_rc" -eq 0 ] && [ "$ec" -ne 0 ]; then primary_rc=$ec; fi
  if [ "$primary_rc" -ne 0 ]; then exit "$primary_rc"; fi
  exit "$cleanup_rc"
}
run_phase() {
  phase_kind="$1"; shift
  set -m
  "$@" &
  phase_pid=$!
  set +m
  trap 'trap '\''pending=1'\'' TERM INT; pending=1; honor_cancel' TERM INT
  honor_cancel
  if alive "$phase_pid" && ! galive "$phase_pid"; then echo "phase PGID contract failed (pid ${phase_pid})" >&2; cleanup_rc=1; fi
  if wait "$phase_pid"; then
    phase_rc=0
  else
    phase_rc=$?
  fi
  trap 'pending=1' TERM INT
  if [ "$pending" -eq 1 ]; then
    primary_rc=143
    reap_phase
    return 0
  fi
  if [ "$phase_rc" -ne 0 ]; then
    primary_rc="$phase_rc"
  fi
  if galive "$phase_pid"; then
    echo "cleanup failed: phase group still present after leader exit (PGID ${phase_pid})" >&2
    cleanup_rc=1
    reap_phase
    return 0
  fi
  wait "$phase_pid" 2>/dev/null || true
  phase_pid=""
  phase_kind=""
}
trap on_exit EXIT; trap 'pending=1' TERM INT; honor_cancel
preflight="$(env -i PATH="$PATH" HOME="$proof_home" sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env)"
printf '%s\n' "$preflight"
printf '%s\n' "$preflight" | grep -Fx "HOME=${proof_home}" >/dev/null || { echo "preflight HOME preservation failed" >&2; primary_rc=1; exit 1; }
honor_cancel
export TMPDIR="$uid_tmp"
run_phase test sg workbuddy -c 'umask 007; cd "${GITHUB_WORKSPACE}/server" && WORKBUDDY_UID_TEST=1 OMP_USER=omp ../node_modules/.bin/vitest run test/linux/uid-isolation.test.ts --coverage=false'
honor_cancel
reap_owned
[ "$cleanup_rc" -eq 0 ] || exit 1
[ "$primary_rc" -eq 0 ] || exit "$primary_rc"
run_phase smoke sg workbuddy -c 'umask 007; OMP_USER=omp bash .github/scripts/ci-compiled-server.sh smoke'
honor_cancel
reap_owned
