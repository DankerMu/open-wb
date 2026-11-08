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
# 每次调用记一行 CALL 再逐行记 argv；按 URL 取 FAKE_PRIMARY / FAKE_API（ok|bad|fail）。
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
  *) printf 'x' > "$out"; exit 22 ;;
esac
EOF
chmod +x "$tmp/bin/uname" "$tmp/bin/curl"

n=0
run_case() { # $@ 为额外环境（KEY=VAL），结果在 $c/{out,err,curl.log}、$rc
  n=$((n+1)); c="$tmp/case$n"; mkdir -p "$c"
  sed -e "s/^SHA256_DARWIN_ARM64=.*/SHA256_DARWIN_ARM64=\"$digest\"/" \
    -e "s/^SHA256_LINUX_X64=.*/SHA256_LINUX_X64=\"$digest\"/" \
    "$root/scripts/omp-fetch.sh" > "$c/omp-fetch.sh"
  : > "$c/curl.log"
  (cd "$c" && env "$@" CURL_LOG="$c/curl.log" PATH="$tmp/bin:$PATH" bash ./omp-fetch.sh >out 2>err)
  rc=$?
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

echo "omp-fetch self-test: $pass PASS / $fail FAIL"
[ "$fail" -eq 0 ]
