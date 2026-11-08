#!/usr/bin/env bash
# omp-fetch.sh 行为用例：脚本副本 + PATH 前置假 curl / uname，不发网络请求，不碰仓内 var/omp。
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0
good="good-omp-bytes"
if command -v sha256sum >/dev/null 2>&1; then
  digest="$(printf '%s' "$good" | sha256sum | awk '{print $1}')"
else
  digest="$(printf '%s' "$good" | shasum -a 256 | awk '{print $1}')"
fi

mkdir -p "$tmp/bin"
cat > "$tmp/bin/uname" <<'EOF'
#!/usr/bin/env bash
echo "${FAKE_UNAME:-Linux x86_64}"
EOF
# 每次调用记一行 CALL 再逐行记 argv；按 URL 取 FAKE_PRIMARY / FAKE_API（ok|bad|fail|exit:N|block|swallow）。
# exit:N 以退出码 N 结束；block 先写就绪标记 $CURL_LOG.ready，再阻塞（sleep 30 封顶，泄漏也会自己结束）；
# swallow 先把 INT/HUP/TERM 设成「杀掉 sleep 后 exit 0」，再写就绪标记并阻塞，模拟信号没打断下载、curl 正常结束。
cat > "$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo CALL >> "$CURL_LOG"
out=""; prev=""
for a in "$@"; do
  printf '%s\n' "$a" >> "$CURL_LOG"
  [ "$prev" = "--output" ] && out="$a"
  prev="$a"
done
url="${*: -1}"
case "$url" in
  https://api.github.com/*) mode="${FAKE_API:-fail}" ;;
  https://github.com/*/releases/download/*) mode="${FAKE_PRIMARY:-fail}" ;;
  *) exit 2 ;;
esac
case "$mode" in
  ok) printf '%s' good-omp-bytes > "$out" ;;
  bad) printf '%s' tampered-bytes > "$out" ;;
  exit:*) exit "${mode#exit:}" ;;
  block) : > "$CURL_LOG.ready"; exec sleep 30 ;;
  swallow)
    trap 'kill "$s" 2>/dev/null; exit 0' INT HUP TERM
    sleep 30 & s=$!
    : > "$CURL_LOG.ready"; wait "$s"; exit 0 ;;
  *) printf 'x' > "$out"; exit 22 ;;
esac
EOF
chmod +x "$tmp/bin/uname" "$tmp/bin/curl"

n=0
prep_case() { # 新建 $c 并放入替换了摘要的脚本副本
  n=$((n+1)); c="$tmp/case$n"; mkdir -p "$c"
  sed -e "s/^SHA256_DARWIN_ARM64=.*/SHA256_DARWIN_ARM64=\"$digest\"/" \
    -e "s/^SHA256_LINUX_X64=.*/SHA256_LINUX_X64=\"$digest\"/" \
    "$root/scripts/omp-fetch.sh" > "$c/omp-fetch.sh"
  : > "$c/curl.log"
}
run_case() { # $@ 为额外环境（KEY=VAL），结果在 $c/{out,err,curl.log}、$rc
  prep_case
  (cd "$c" && env "$@" CURL_LOG="$c/curl.log" PATH="$tmp/bin:$PATH" bash ./omp-fetch.sh >out 2>err)
  rc=$?
}
gone() { ! kill -0 -- -"$pgid" 2>/dev/null; }
poll() { # $1 为判定函数；每 0.1 s 查一次，10 s 封顶
  local i=0
  while [ "$i" -lt 100 ]; do "$1" && return 0; sleep 0.1; i=$((i+1)); done
  return 1
}
ready() { [ -e "$c/curl.log.ready" ]; }
signal_case() { # 在独立进程组里起脚本，主地址 curl（模式 $2）阻塞时把 $1 送达整组；结果在 $rc、$reaped（1 = 整组在上限内退出）
  prep_case
  set -m
  ( cd "$c" && exec env FAKE_PRIMARY="$2" FAKE_API=ok CURL_LOG="$c/curl.log" PATH="$tmp/bin:$PATH" bash ./omp-fetch.sh >out 2>err ) &
  pgid=$!
  set +m
  reaped=0
  if poll ready; then kill -"$1" -- -"$pgid"; poll gone && reaped=1; fi
  [ "$reaped" -eq 1 ] || { echo "signal_case $1: timeout, killing group $pgid" >&2; kill -KILL -- -"$pgid" 2>/dev/null; }
  wait "$pgid"; rc=$?
}
seed_next() { mkdir -p "$tmp/case$((n+1))/var/omp"; printf '%s' "$1" > "$tmp/case$((n+1))/var/omp/omp"; }
verdict() { # 读前一条断言链的退出码；$1 描述
  if [ $? -eq 0 ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi
}
calls() { grep -c '^CALL$' "$c/curl.log"; }
call_args() { awk -v k="$1" '/^CALL$/{i++; next} i==k' "$c/curl.log"; }
call_url() { call_args "$1" | tail -n 1; }
has_arg() { call_args "$1" | grep -Fxq -- "$2"; }
no_leftovers() { [ ! -e "$c/var/omp/omp" ] && ! ls "$c"/var/omp/.omp-fetch.* >/dev/null 2>&1; }
installed() { [ -f "$c/var/omp/omp" ] && [ -x "$c/var/omp/omp" ] && [ "$(cat "$c/var/omp/omp")" = "$good" ]; }
no_auth() { ! grep -Fq Authorization "$c/curl.log"; }
fallback_line="omp-fetch: primary download failed; retrying via GitHub API asset"
primary_linux="https://github.com/can1357/oh-my-pi/releases/download/v18.12.3/omp-linux-x64"
interrupted_line() { echo "omp-fetch: primary download interrupted (curl exit $1); not falling back"; }

run_case FAKE_PRIMARY=ok
{ [ "$rc" -eq 0 ] && [ "$(calls)" -eq 1 ] && [ "$(call_url 1)" = "$primary_linux" ] && installed \
   && grep -Fq "omp-fetch: installed" "$c/out" && ! grep -Fq "$fallback_line" "$c/err" && no_auth; }
verdict "主地址成功：只调一次主地址、产出可执行文件、无回退行"

run_case FAKE_PRIMARY=fail FAKE_API=ok GITHUB_TOKEN=tok-sentinel
{ [ "$rc" -eq 0 ] && [ "$(calls)" -eq 2 ] && [ "$(call_url 1)" = "$primary_linux" ] \
   && [ "$(call_url 2)" = "https://api.github.com/repos/can1357/oh-my-pi/releases/assets/657108334" ] \
   && has_arg 2 "Accept: application/octet-stream" && has_arg 2 --fail && has_arg 2 --location \
   && has_arg 2 --retry && has_arg 2 --max-time && installed && grep -Fxq "$fallback_line" "$c/err" \
   && no_auth && ! grep -Fq tok-sentinel "$c/curl.log" "$c/out" "$c/err"; }
verdict "主地址失败、API 成功：经 assets/657108334 回退且不带凭证"

run_case FAKE_UNAME="Darwin arm64" FAKE_PRIMARY=fail FAKE_API=ok
{ [ "$rc" -eq 0 ] && [ "$(call_url 2)" = "https://api.github.com/repos/can1357/oh-my-pi/releases/assets/657108328" ] \
   && installed && no_auth; }
verdict "Darwin arm64 回退用资产 id 657108328"

run_case FAKE_PRIMARY=fail FAKE_API=bad
{ [ "$rc" -ne 0 ] && [ "$(calls)" -eq 2 ] && grep -Fq "digest mismatch: expected $digest, actual" "$c/err" \
   && no_leftovers && no_auth; }
verdict "回退内容摘要不符：非零、报 expected/actual、不留文件"

run_case FAKE_PRIMARY=fail FAKE_API=fail
{ [ "$rc" -ne 0 ] && no_leftovers && no_auth; }
verdict "两条都失败：非零、不留 var/omp/omp 与临时文件"

seed_next "$good"
run_case
{ [ "$rc" -eq 0 ] && [ "$(calls)" -eq 0 ] && grep -Fq "omp-fetch: skip download" "$c/out"; }
verdict "已存在且校验通过：不调 curl、打印 skip download"

seed_next old
run_case
{ [ "$rc" -ne 0 ] && [ "$(calls)" -eq 0 ] && [ ! -e "$c/var/omp/omp" ] \
   && grep -Fq "existing var/omp/omp failed verification" "$c/err"; }
verdict "已存在但校验不过：删除、非零、不调 curl"

run_case FAKE_UNAME="Linux aarch64"
{ [ "$rc" -ne 0 ] && [ "$(calls)" -eq 0 ] && grep -Fq "supported platform matrix:" "$c/err"; }
verdict "不支持平台：非零、打印矩阵、不调 curl"

for code in 130 143; do
  run_case FAKE_PRIMARY="exit:$code" FAKE_API=ok
  { [ "$rc" -eq "$code" ] && [ "$(calls)" -eq 1 ] && ! grep -Fq "$fallback_line" "$c/err" \
     && grep -Fxq "$(interrupted_line "$code")" "$c/err" && no_leftovers; }
  verdict "主地址 curl 以 $code 退出：同码退出、只调一次、不回退、不留文件"
done

bash -c 'trap "exit 7" INT; kill -INT $$; exit 0'
if [ $? -ne 7 ]; then
  echo "FAIL INT 探针：本进程入口已忽略 SIGINT，脚本设不了 INT trap，真实信号用例无法运行"; fail=$((fail+1))
else
  for pair in INT:130 TERM:143; do
    sig="${pair%:*}"; code="${pair#*:}"
    signal_case "$sig" block
    { [ "$reaped" -eq 1 ] && [ "$rc" -eq "$code" ] && [ "$(calls)" -eq 1 ] \
       && ! grep -Fq "$fallback_line" "$c/err" && no_leftovers && gone; }
    verdict "真实 $sig 送达进程组：$code 退出、只调一次、不回退、不留文件、整组退出"
  done
  for pair in INT:130 HUP:129; do
    sig="${pair%:*}"; code="${pair#*:}"
    signal_case "$sig" swallow
    { [ "$reaped" -eq 1 ] && [ "$rc" -eq "$code" ] && [ "$(calls)" -eq 1 ] && ! grep -Fq "$fallback_line" "$c/err" \
       && ! grep -Fq "omp-fetch: installed" "$c/out" && no_leftovers && gone; }
    verdict "真实 $sig 送达进程组、curl 吞掉信号正常结束：脚本自身 $code 退出、不安装、不留文件、整组退出"
  done
fi

echo "omp-fetch self-test: $pass PASS / $fail FAIL"
[ "$fail" -eq 0 ]
