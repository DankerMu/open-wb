#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
helper="$root/.github/scripts/ci-compiled-server.sh"
installer="$root/.github/scripts/ci-install-hurl.sh"
wf="$root/.github/workflows/ci.yml"
BASH_RUN="${BASH:-bash}"; pass=0; fail=0
record() { if [ "$2" -eq "$3" ]; then echo "PASS $1 (rc=$2)"; pass=$((pass+1)); else echo "FAIL $1 (rc=$2 want=$3)"; fail=$((fail+1)); fi; }
expect_txt() { if printf '%s\n' "$2" | grep -F -- "$3" >/dev/null; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
reject_txt() { if printf '%s\n' "$2" | grep -F -- "$3" >/dev/null; then echo "FAIL $1"; fail=$((fail+1)); else echo "PASS $1"; pass=$((pass+1)); fi; }
scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin" "$scratch/rt" "$scratch/static" "$scratch/install"
write_bin() { printf '%s\n' "$2" > "$scratch/bin/$1"; chmod +x "$scratch/bin/$1"; }
term_node() { printf '%s\n' '#!/bin/sh' 'echo $$ > "$RUNNER_TEMP/node.pid"' "trap \"exit $1\" TERM" 'while true; do sleep 0.05; done' > "$scratch/bin/node"; chmod +x "$scratch/bin/node"; }
ok_make() { write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\necho fake make ok; exit 0'; }
alive_pid() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
pid_of() { [ -f "$1" ] && cat "$1" || true; }
assert_dead() { if alive_pid "$1"; then echo "FAIL $2"; fail=$((fail+1)); kill -KILL "$(cat "$1")" 2>/dev/null || true; else echo "PASS $2"; pass=$((pass+1)); fi; }
reap_pids() { for p in "$@"; do [ -n "${p:-}" ] && kill -KILL "$p" 2>/dev/null || true; k=0; while [ -n "${p:-}" ] && [ "$k" -lt 40 ] && kill -0 "$p" 2>/dev/null; do sleep 0.05; k=$((k+1)); done; done; }
ck_sent() { if kill -0 "$1" 2>/dev/null; then echo "PASS $2"; pass=$((pass+1)); kill -TERM "$1" 2>/dev/null || true; wait "$1" 2>/dev/null || true; else echo "FAIL $2"; fail=$((fail+1)); fi; }
with_h() { PATH="$scratch/bin:/usr/bin:/bin" RUNNER_TEMP="$scratch/rt" HOST=127.0.0.1 PORT=18016 SMOKE_BASE_URL=http://127.0.0.1:18016 UI_WALK_BASE_URL=http://127.0.0.1:18016 DB_PATH="$scratch/rt/app.db" STATIC_ROOT="$scratch/static" EXPECT_TARGET="${EXPECT_TARGET:-smoke}" CI_TERM_WAIT="${CI_TERM_WAIT:-2}" CI_KILL_WAIT="${CI_KILL_WAIT:-1}" CI_READY_SLEEP="${CI_READY_SLEEP:-0.05}" "$@"; }
run_helper() { EXPECT_TARGET="$1" with_h "$BASH_RUN" "${2:-$helper}" "$1"; }
waitf() { n=0; while [ "$n" -lt 80 ] && [ ! -f "$1" ]; do sleep 0.05; n=$((n+1)); done; }
waitp() { n=0; while [ "$n" -lt 80 ] && kill -0 "$1" 2>/dev/null; do sleep 0.05; n=$((n+1)); done; }
bg() { with_h exec "$BASH_RUN" "$1" smoke >"$2" 2>&1 & wp=$!; }
ed() { python3 -c 'import sys;s=open(sys.argv[1]).read();p,n=sys.argv[3],sys.argv[4];i=s.find(p);s=(s.replace(p,n,1) if sys.argv[2]=="r" else (s[:i+len(p)]+"\n"+n+"\n"+s[i+len(p):] if i>=0 else s)); open(sys.argv[5],"w").write(s)' "$1" "$2" "$3" "$4" "$5"; chmod +x "$5"; }
inj() { ed "${4:-$helper}" i "$2" "$3" "$1"; }
mark() { inj "$1" 'ec=$?' ': > "$RUNNER_TEMP/cleanup.mark"'; }
bar() { inj "$1" 'on_exit() {' ': > "$RUNNER_TEMP/cleanup.mark"; while [ ! -f "$RUNNER_TEMP/cleanup.go" ]; do sleep 0.05; done' "${2-}"; }
start_bg() { sleep 30 & sentinel=$!; rm -f "$scratch/rt/"*.pid "$scratch/rt/"*.mark "$scratch/rt/"*.go; set +e; bg "$1" "$2"; }
check_wf() { python3 -c 'exec("""import re,sys\nt=open(sys.argv[1]).read().splitlines();J={};c=None;i=0;s=None\nfor L in t:\n if re.match(r"^[ \\t]*#",L): continue\n m=re.match(r"^  ([A-Za-z0-9_-]+):\\s*$",L)\n if m:\n  c and s is not None and J[c]["s"].append(s);c=m.group(1);J[c]={"m":{},"s":[]};i=0;s=None;continue\n if not c: continue\n if not i:\n  mm=re.match(r"^    ([A-Za-z0-9_-]+):\\s*(.*)$",L)\n  if mm:\n   k,v=mm.group(1),mm.group(2)\n   if k=="steps": i=1\n   else: J[c]["m"][k]=v\n  continue\n if re.match(r"^      - ",L):\n  s is not None and J[c]["s"].append(s);s={"k":{},"r":[]};km=re.match(r"^      - ([A-Za-z0-9_-]+):\\s*(.*)$",L)\n  if km: s["k"][km.group(1)]=km.group(2)\n  continue\n if s is None: continue\n km=re.match(r"^        ([A-Za-z0-9_-]+):\\s*(.*)$",L)\n if km: s["k"][km.group(1)]=km.group(2);continue\n if L.startswith("          "): s["r"].append(L)\nc and s is not None and J[c]["s"].append(s)\nR={"smoke":["bash .github/scripts/ci-install-hurl.sh","bash .github/scripts/ci-compiled-server.sh smoke"],"ui-walk":["npx playwright install --with-deps chromium","bash .github/scripts/ci-compiled-server.sh ui-walk"]}\nok=1\nfor n,rs in R.items():\n j=J.get(n)\n if not j or "continue-on-error" in j["m"] or "if" in j["m"]: ok=0;break\n for rv in rs:\n  st=next((x for x in j["s"] if x["k"].get("run")==rv),None)\n  if not st or "if" in st["k"] or "continue-on-error" in st["k"]: ok=0;break\na=J.get("all-checks-passed");P="\\"result\\": *\\"(failure|cancelled|skipped)\\""\nv=next((x for x in (a["s"] if a else []) if any(P in y for y in x["r"])),None)\nsys.exit(0 if ok and a and a["m"].get("if")=="always()" and a["m"].get("needs")=="[fast-checks, unit-tests, anti-drift, secret-scan, sast, smoke, ui-walk]" and "continue-on-error" not in a["m"] and v and "if" not in v["k"] and "continue-on-error" not in v["k"] else 1)\n""")' "$1"; }
if check_wf "$wf" && ! grep -F -q 'harness.out' "$helper" && ! grep -F -q 'pipe.rc' "$helper"; then echo "PASS workflow invokes exact helpers"; pass=$((pass+1)); else echo "FAIL workflow helper wiring"; fail=$((fail+1)); fi
reject_mut() { python3 -c 'import sys;s=open(sys.argv[1]).read();open(sys.argv[2],"w").write(s.replace(sys.argv[3],sys.argv[4],1))' "$wf" "$scratch/wf.yml" "$2" "$3"; if check_wf "$scratch/wf.yml"; then echo "FAIL $1"; fail=$((fail+1)); else echo "PASS $1"; pass=$((pass+1)); fi; }
muts() { while [ $# -ge 3 ]; do reject_mut "$1" "$2" "$3"; shift 3; done; }
muts "aggregate mutant drop smoke" "sast, smoke, ui-walk" "sast, ui-walk" "aggregate mutant drop ui-walk" "sast, smoke, ui-walk" "sast, smoke" "aggregate mutant weaken always" "if: always()" "if: success()" "aggregate mutant weaken result guard" "failure|cancelled|skipped" "failure" \
 "smoke helper if" $'      - name: smoke compiled server\n' $'      - name: smoke compiled server\n        if: false\n' "smoke helper continue" $'      - name: smoke compiled server\n' $'      - name: smoke compiled server\n        continue-on-error: true\n' "ui helper if" $'      - name: ui-walk compiled server\n' $'      - name: ui-walk compiled server\n        if: false\n' "ui helper continue" $'      - name: ui-walk compiled server\n' $'      - name: ui-walk compiled server\n        continue-on-error: true\n' \
 "agg verifier if" $'      - name: verify all required jobs succeeded\n' $'      - name: verify all required jobs succeeded\n        if: false\n' "agg verifier continue" $'      - name: verify all required jobs succeeded\n' $'      - name: verify all required jobs succeeded\n        continue-on-error: true\n' "hurl install if" $'      - name: install hurl 8.0.1\n' $'      - name: install hurl 8.0.1\n        if: false\n' "hurl install continue" $'      - name: install hurl 8.0.1\n' $'      - name: install hurl 8.0.1\n        continue-on-error: true\n' \
 "playwright if" $'      - run: npx playwright install --with-deps chromium\n' $'      - if: false\n        run: npx playwright install --with-deps chromium\n' "playwright continue" $'      - run: npx playwright install --with-deps chromium\n' $'      - continue-on-error: true\n        run: npx playwright install --with-deps chromium\n' "smoke job continue" $'  smoke:\n    runs-on: ubuntu-latest\n' $'  smoke:\n    continue-on-error: true\n    runs-on: ubuntu-latest\n' "ui job continue" $'  ui-walk:\n    runs-on: ubuntu-latest\n' $'  ui-walk:\n    continue-on-error: true\n    runs-on: ubuntu-latest\n' \
 "agg job continue" $'  all-checks-passed:\n' $'  all-checks-passed:\n    continue-on-error: true\n' "smoke job if" $'  smoke:\n    runs-on: ubuntu-latest\n' $'  smoke:\n    if: false\n    runs-on: ubuntu-latest\n' "ui job if" $'  ui-walk:\n    runs-on: ubuntu-latest\n' $'  ui-walk:\n    if: false\n    runs-on: ubuntu-latest\n'
python3 -c "import sys;s=open(sys.argv[1]).read();open(sys.argv[2],'w').write(s.replace('      - name: smoke compiled server\\n','      - name: smoke compiled server\\n        # if: false\\n',1))" "$wf" "$scratch/cmt.yml"; if check_wf "$scratch/cmt.yml"; then echo "PASS comment if decoy"; pass=$((pass+1)); else echo "FAIL comment if decoy"; fail=$((fail+1)); fi
python3 -c "import sys;s=open(sys.argv[1]).read();s=s.replace('if: always()','if: success()',1).replace('sast, smoke, ui-walk','sast, ui-walk',1).replace('failure|cancelled|skipped','failure',1);open(sys.argv[2],'w').write(s+'      - run: |\n          echo    if: always()\n          echo    needs: [fast-checks, unit-tests, anti-drift, secret-scan, sast, smoke, ui-walk]\n          echo           if echo \"\$results\" | grep -Eq '\"'\"'\"result\": *\"(failure|cancelled|skipped)\"'\"'\"'; then\n')" "$wf" "$scratch/decoy.yml"
if check_wf "$scratch/decoy.yml"; then echo "FAIL aggregate same-job decoy"; fail=$((fail+1)); else echo "PASS aggregate same-job decoy"; pass=$((pass+1)); fi
write_bin hurl $'#!/bin/sh\necho hurl 8.0.1 fake\nexit 0'; write_bin curl $'#!/bin/sh\nexit 0'; ok_make
pwned="$scratch/pwned"; set +e; "$BASH_RUN" "$helper" "ui-walk;touch $pwned" >/dev/null 2>&1; rc=$?; set -e
record "mode allowlist rejects injection" "$rc" 2; [ ! -e "$pwned" ]
for m in smoke ui-walk; do term_node 0; set +e; run_helper "$m" >/dev/null 2>&1; rc=$?; set -e; record "$m TERM exit 0" "$rc" 0; done
term_node 1; set +e; out=$(run_helper smoke 2>&1); rc=$?; set -e; record "smoke TERM exit 1" "$rc" 1; expect_txt "TERM exit 1 diagnostic" "$out" "cleanup failed: server exited with status 1"
write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\nsleep 0.35; exit 42'
write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\nsleep 0.5; echo fake make ok; exit 0'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e; record "spontaneous exit 42" "$rc" 1
write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\nsleep 0.35; exit 0'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e; record "spontaneous exit 0" "$rc" 1
write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\ntrap "" TERM\nwhile true; do sleep 0.05; done'; ok_make
set +e; out=$(run_helper smoke 2>&1); rc=$?; set -e; record "KILL escalation" "$rc" 1; expect_txt "KILL diagnostic" "$out" "KILL escalation"
assert_dead "$scratch/rt/node.pid" "stubborn server dead after KILL"
sed 's/kill -KILL "$pid"/true/' "$helper" > "$scratch/mut-kill.sh"; rm -f "$scratch/rt/node.pid"
set +e; run_helper smoke "$scratch/mut-kill.sh" >/dev/null 2>&1; set -e
if alive_pid "$scratch/rt/node.pid"; then echo "PASS KILL no-op mutant caught"; pass=$((pass+1)); reap_pids "$(pid_of "$scratch/rt/node.pid")"; else echo "FAIL KILL no-op mutant not caught"; fail=$((fail+1)); fi
term_node 1; write_bin make $'#!/bin/sh\necho make failed; exit 7'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e; record "primary 7 beats cleanup" "$rc" 7
term_node 0; ok_make; write_bin sed $'#!/bin/sh\ncat >/dev/null; exit 1'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e; record "sanitizer failure" "$rc" 1; rm -f "$scratch/bin/sed"
hex=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
term_node 0; write_bin make "#!/bin/sh
echo 'actual: string <${hex}>'; printf '%s\n' '{\"password\":\"demo\"}'; exit 4"
set +e; out=$(run_helper smoke 2>&1); rc=$?; set -e; record "redact path nonzero" "$rc" 4
reject_txt "64-hex absent" "$out" "$hex"; reject_txt 'exact password JSON absent' "$out" '{"password":"demo"}'; expect_txt 'password redacted token' "$out" '"password":"[redacted]"'
rm -f "$scratch/rt/node.pid"
write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\nprintf "%s\n" "{\"event\":\"server_start_failed\"}"\nexit 1'
set +e; out=$(run_helper smoke 2>&1); rc=$?; set -e; record "early exit before probe" "$rc" 1
expect_txt "early-exit diagnostic" "$out" "server exited early"; expect_txt "early-exit failure log" "$out" "----- server log (failure) -----"
assert_dead "$scratch/rt/node.pid" "early-exit PID cleared"
write_bin curl $'#!/bin/sh\nexit 1'; term_node 0; ok_make
set +e; out=$(CI_READY_ATTEMPTS=2 run_helper smoke 2>&1); rc=$?; set -e; record "never-ready live child" "$rc" 1
expect_txt "never-ready diagnostic" "$out" "readiness failed against /api/healthz"; assert_dead "$scratch/rt/node.pid" "never-ready child reaped"
write_bin curl $'#!/bin/sh\nexit 0'; term_node 0; write_bin make $'#!/bin/sh\nexit 33'
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e; record "pre-status/child 33 not green" "$rc" 33
ign_make() { write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\necho $$ > "$RUNNER_TEMP/make.pid"\ntrap "" TERM HUP INT\nwhile true; do sleep 0.05; done'; }
stub() { write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\ntrap "" TERM\nwhile true; do sleep 0.05; done'; }
finish() { waitp "$wp"; child=$(pid_of "$scratch/rt/node.pid"); extra=$(pid_of "$3"); g=$(pid_of "$scratch/rt/hpid.mark"); if [ -z "$extra" ] || kill -0 "$wp" 2>/dev/null; then echo "FAIL $1"; fail=$((fail+1)); [ -n "$g" ] && kill -KILL -- "-$g" 2>/dev/null || true; reap_pids "$wp" "$child" "$extra"; else wait "$wp"; rc=$?; record "$1" "$rc" "$2"; [ -n "$child" ] && kill -0 "$child" 2>/dev/null && { echo "FAIL $1 left server"; fail=$((fail+1)); } || { echo "PASS $1 reaped server"; pass=$((pass+1)); }; kill -0 "$extra" 2>/dev/null && { echo "FAIL $1 left member"; fail=$((fail+1)); } || { echo "PASS $1 reaped member"; pass=$((pass+1)); }; fi; }
caught() { waitp "$wp"; child=$(pid_of "$scratch/rt/node.pid"); extra=$(pid_of "$3"); g=$(pid_of "$scratch/rt/hpid.mark"); live=0; { [ -n "$child" ] && kill -0 "$child" 2>/dev/null; } && live=1; { [ -n "$extra" ] && kill -0 "$extra" 2>/dev/null; } && live=1; kill -0 "$wp" 2>/dev/null && live=1; if [ "$live" -eq 1 ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; [ -n "$g" ] && kill -KILL -- "-$g" 2>/dev/null || true; reap_pids "$wp" "$child" "$extra"; }
mut() { python3 -c 'import sys;s=open(sys.argv[1]).read();m=sys.argv[2];q=lambda x:"trap "+chr(39)+x+chr(39)+" TERM INT";a=s.find("hpid=$!; ");b=s.find("; honor_cancel; set +m");s=(s[:a]+"hpid=$!; "+q("exit 143")+s[b:] if m=="nodisarm" else s[:s.find("else primary_rc=$?; fi")]+"else primary_rc=$?; fi"+s[s.find("; honor_cancel",s.find("else primary_rc=$?; fi")):] if m=="norestore" else s[:a]+"hpid=$!"+s[b:]); s=s.replace(q("pending=1")+"; trap - EXIT","trap - EXIT",1).replace(q("exit 143")+"; ","",1) if m=="pending" else s; open(sys.argv[3],"w").write(s)' "$helper" "$1" "$2"; chmod +x "$2"; }
ign_make; mark "$scratch/hc.sh"; start_bg "$scratch/hc.sh" "$scratch/cancel.out"; waitf "$scratch/rt/make.pid"
[ -n "$(pid_of "$scratch/rt/make.pid")" ] || { echo "FAIL cancel never started harness"; fail=$((fail+1)); reap_pids "$wp" "$(pid_of "$scratch/rt/node.pid")"; }
kill -TERM "$wp" 2>/dev/null || true; waitf "$scratch/rt/cleanup.mark"; kill -TERM "$wp" 2>/dev/null || true; kill -INT "$wp" 2>/dev/null || true
finish "wrapper cancel" 143 "$scratch/rt/make.pid"; expect_txt "cancel KILL diagnostic" "$(cat "$scratch/cancel.out")" "KILL escalation for PGID"
[ -f "$scratch/rt/cleanup.mark" ] && { echo "PASS repeated cancel during cleanup"; pass=$((pass+1)); } || { echo "FAIL repeated cancel during cleanup"; fail=$((fail+1)); }
set -e; ck_sent "$sentinel" "cancel sentinel survived"
term_node 0; write_bin node $'#!/bin/sh\necho $$ > "$RUNNER_TEMP/node.pid"\ntrap "" TERM HUP INT\nwhile true; do sleep 0.05; done'
inj "$scratch/h-srv.sh" 'node server/dist/server.js >"$log" 2>&1 &' 'n=0; while [ ! -f "$RUNNER_TEMP/node.pid" ] && [ "$n" -lt 80 ]; do sleep 0.05; n=$((n+1)); done; kill -s TERM $$'
start_bg "$scratch/h-srv.sh" "$scratch/srv.out"; waitf "$scratch/rt/node.pid"; finish "server handoff cancel" 143 "$scratch/rt/node.pid"
set -e; ck_sent "$sentinel" "server handoff sentinel survived"
write_bin curl $'#!/bin/sh\nexit 0'; term_node 0; ign_make
inj "$scratch/h-har.sh" ') &' 'n=0; while [ ! -f "$RUNNER_TEMP/make.pid" ] && [ "$n" -lt 80 ]; do sleep 0.05; n=$((n+1)); done; kill -s TERM $$'
start_bg "$scratch/h-har.sh" "$scratch/har.out"; waitf "$scratch/rt/make.pid"; finish "harness handoff cancel" 143 "$scratch/rt/make.pid"
set -e; ck_sent "$sentinel" "harness handoff sentinel survived"
inj "$scratch/h-wait.sh" 'set +m; galive "$hpid" || { echo "harness PGID contract failed (pid ${hpid})" >&2; cleanup_rc=1; }' 'echo "$hpid" > "$RUNNER_TEMP/hpid.mark"; n=0; while [ ! -f "$RUNNER_TEMP/make.pid" ] && [ "$n" -lt 80 ]; do sleep 0.05; n=$((n+1)); done; kill -s TERM $$'
start_bg "$scratch/h-wait.sh" "$scratch/wait.out"; waitf "$scratch/rt/hpid.mark"; waitf "$scratch/rt/make.pid"; finish "post-hpid wait cancel" 143 "$scratch/rt/make.pid"
set -e; ck_sent "$sentinel" "post-hpid wait sentinel survived"
term_node 0
write_bin make $'#!/bin/sh\n[ "$1" = "$EXPECT_TARGET" ] || exit 9\n( exec </dev/null >/dev/null 2>&1; trap "" TERM HUP INT; while true; do sleep 0.05; done ) &\necho $! > "$RUNNER_TEMP/desc.pid"\nexit 0'
start_bg "$helper" "$scratch/lead.out"; waitf "$scratch/rt/desc.pid"; extra=$(pid_of "$scratch/rt/desc.pid"); [ -n "$extra" ] && kill -0 "$extra" 2>/dev/null && kill -0 "$wp" 2>/dev/null || { echo "FAIL leader-exit identity"; fail=$((fail+1)); reap_pids "$wp" "$extra" "$(pid_of "$scratch/rt/node.pid")"; }
finish "leader-exit leftover group" 1 "$scratch/rt/desc.pid"; expect_txt "leader-exit group diagnostic" "$(cat "$scratch/lead.out")" "harness group still present after leader exit"
set -e; ck_sent "$sentinel" "leader-exit sentinel survived"
term_node 0; ok_make
inj "$scratch/hl.sh" '[ "$pending" -eq 1 ] && primary_rc=143' ': > "$RUNNER_TEMP/finalize.mark"; while [ ! -f "$RUNNER_TEMP/finalize.go" ]; do sleep 0.05; done'
start_bg "$scratch/hl.sh" "$scratch/late.out"; waitf "$scratch/rt/finalize.mark"; kill -TERM "$wp" 2>/dev/null || true; : > "$scratch/rt/finalize.go"
finish "late TERM cancel" 143 "$scratch/rt/node.pid"; set -e; ck_sent "$sentinel" "late TERM sentinel survived"
stub; ok_make; mark "$scratch/hn.sh"; start_bg "$scratch/hn.sh" "$scratch/nat.out"; waitf "$scratch/rt/cleanup.mark"
kill -TERM "$wp" 2>/dev/null || true; finish "cleanup first TERM" 143 "$scratch/rt/node.pid"
expect_txt "cleanup first TERM KILL" "$(cat "$scratch/nat.out")" "KILL escalation for PID"; set -e; ck_sent "$sentinel" "cleanup first TERM sentinel survived"
stub; ok_make; bar "$scratch/n0.sh"; start_bg "$scratch/n0.sh" "$scratch/n0.out"; waitf "$scratch/rt/cleanup.mark"
kill -TERM "$wp" 2>/dev/null || true; : > "$scratch/rt/cleanup.go"; finish "on_exit first TERM" 143 "$scratch/rt/node.pid"
set -e; ck_sent "$sentinel" "on_exit first TERM sentinel survived"
ign_make; bar "$scratch/nr.sh"; start_bg "$scratch/nr.sh" "$scratch/nr.out"; waitf "$scratch/rt/make.pid"
kill -TERM "$wp" 2>/dev/null || true; waitf "$scratch/rt/cleanup.mark"; kill -TERM "$wp" 2>/dev/null || true; kill -INT "$wp" 2>/dev/null || true; : > "$scratch/rt/cleanup.go"
finish "on_exit repeat TERM" 143 "$scratch/rt/make.pid"; set -e; ck_sent "$sentinel" "on_exit repeat TERM sentinel survived"
ign_make; mut nodisarm "$scratch/nd.sh"; bar "$scratch/ndb.sh" "$scratch/nd.sh"
start_bg "$scratch/ndb.sh" "$scratch/nd.out"; waitf "$scratch/rt/make.pid"; kill -TERM "$wp" 2>/dev/null || true; waitf "$scratch/rt/cleanup.mark"
kill -TERM "$wp" 2>/dev/null || true; kill -INT "$wp" 2>/dev/null || true; : > "$scratch/rt/cleanup.go"; caught "no-disarm mutant" x "$scratch/rt/make.pid"
set -e; ck_sent "$sentinel" "no-disarm sentinel survived"
ok_make; mut norestore "$scratch/nrst.sh"; bar "$scratch/nrstb.sh" "$scratch/nrst.sh"
start_bg "$scratch/nrstb.sh" "$scratch/nrst.out"; waitf "$scratch/rt/cleanup.mark"
kill -TERM "$wp" 2>/dev/null || true; : > "$scratch/rt/cleanup.go"; caught "no-restore mutant" x "$scratch/rt/node.pid"
set -e; ck_sent "$sentinel" "no-restore sentinel survived"
ign_make; mut pending "$scratch/h2.sh"
inj "$scratch/h2w.sh" 'set +m; galive "$hpid" || { echo "harness PGID contract failed (pid ${hpid})" >&2; cleanup_rc=1; }' 'echo "$hpid" > "$RUNNER_TEMP/hpid.mark"; n=0; while [ ! -f "$RUNNER_TEMP/make.pid" ] && [ "$n" -lt 80 ]; do sleep 0.05; n=$((n+1)); done; kill -s TERM $$' "$scratch/h2.sh"
start_bg "$scratch/h2w.sh" "$scratch/h2.out"; waitf "$scratch/rt/hpid.mark"; waitf "$scratch/rt/make.pid"
caught "pending-only mutant" x "$scratch/rt/make.pid"; set -e; ck_sent "$sentinel" "pending-only sentinel survived"
term_node 1; ok_make; sleep 30 & sentinel=$!
set +e; run_helper smoke >/dev/null 2>&1; rc=$?; set -e
ck_sent "$sentinel" "sentinel survived"; record "TERM exit 1 with sentinel" "$rc" 1
printf '%s\n' '#!/bin/sh' 'while [ "$#" -gt 0 ] && [ "$1" != "--output" ]; do shift; done' '[ "$1" = "--output" ] && shift && : > "$1"' 'exit 0' > "$scratch/install/curl"
printf '%s\n' '#!/bin/sh' 'echo 0000000000000000000000000000000000000000000000000000000000000000' > "$scratch/install/sha256sum"
printf '%s\n' '#!/bin/sh' 'echo TAR_RAN > "${RUNNER_TEMP}/tar-ran"' 'exit 0' > "$scratch/install/tar"; chmod +x "$scratch/install/"*
set +e; out=$(PATH="$scratch/install:/bin:/usr/bin" RUNNER_TEMP="$scratch/rt" "$BASH_RUN" "$installer" 2>&1); rc=$?; set -e
record "hurl digest mismatch" "$rc" 1; [ ! -f "$scratch/rt/tar-ran" ] && echo "PASS tar skipped" && pass=$((pass+1)) || { echo "FAIL tar ran"; fail=$((fail+1)); }
echo "$out" | grep -q "digest mismatch" && echo "PASS digest diagnostic" && pass=$((pass+1)) || { echo "FAIL digest diagnostic"; fail=$((fail+1)); }
echo "ci-harness oracle: $pass PASS / $fail FAIL"
[ "$fail" -eq 0 ]
